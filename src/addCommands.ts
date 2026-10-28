// Creation of resnames, groups and XLIFF files: commands of the tree view
// and quick fix on unknown resnames.

import * as path from 'path';
import * as vscode from 'vscode';
import { TreeGroup, XliffFileSet, XliffProject } from './core/xliffIndex';
import { hasGroup, resnameProblem } from './core/xliffEdits';
import { usageKind } from './core/usages';
import { refOf, UnitRef, XliffModel } from './model';
import { XliffNode } from './tree';
import { XliffDetailPanel } from './panel';
import { SOURCE_SELECTOR } from './languageFeatures';

/** Argument of 4dXliff.addUnit from the quick fix: the resname used in a source file. */
interface UnknownResname {
	resname: string;
	sourcePath: string;
}

interface Location {
	fileSet: XliffFileSet;
	groupPath: string[];
}

export interface AddHooks {
	reveal(ref: UnitRef): Thenable<unknown>;
	/** Called once a language is added, to show what remains to translate. */
	languageAdded(lang: string): void;
}

export function registerAddCommands(context: vscode.ExtensionContext, model: XliffModel, hooks: AddHooks): vscode.Disposable[] {
	const pickProject = async (nearPath?: string): Promise<XliffProject | undefined> => {
		const near = nearPath ? model.projectFor(nearPath) : undefined;
		if (near || model.index.projects.length <= 1) {
			return near ?? model.index.projects[0];
		}
		const picked = await vscode.window.showQuickPick(
			model.index.projects.map(project => ({ label: project.name, description: project.root, project })),
			{ title: '4D project' },
		);
		return picked?.project;
	};

	const askFileName = async (project: XliffProject): Promise<string | undefined> => {
		const value = await vscode.window.showInputBox({
			title: 'New XLIFF file',
			prompt: project.languages.length ? `Created in ${project.languages.map(l => `${l}.lproj`).join(', ')}` : undefined,
			placeHolder: 'Dialogs.xlf',
			validateInput: input => {
				const name = withExtension(input.trim());
				if (!input.trim()) {
					return 'Enter a file name';
				}
				if (/[\\/:*?"<>|]/.test(name)) {
					return 'Invalid file name';
				}
				return project.fileSets.some(s => s.name.toLowerCase() === name.toLowerCase()) ? `${name} already exists` : undefined;
			},
		});
		return value === undefined ? undefined : withExtension(value.trim());
	};

	const askLanguages = async (): Promise<string[] | undefined> => {
		const value = await vscode.window.showInputBox({
			title: 'Languages of the project',
			prompt: 'Source language first, separated by commas',
			value: 'en, fr',
			validateInput: input => parseLanguages(input).length ? undefined : 'Enter at least one language',
		});
		return value === undefined ? undefined : parseLanguages(value);
	};

	const addFile = async (project: XliffProject): Promise<XliffFileSet | undefined> => {
		const name = await askFileName(project);
		if (!name) {
			return undefined;
		}
		let languages = project.languages;
		if (!languages.length) {
			languages = await askLanguages() ?? [];
			if (!languages.length) {
				return undefined;
			}
		}
		return model.addFile(project, name, languages, project.languages.length ? project.sourceLanguage : languages[0]);
	};

	const pickLocation = async (project: XliffProject, title: string, resname?: string, nearPath?: string): Promise<Location | undefined> => {
		const NEW_FILE = Symbol('new file');
		const locations = rankLocations(project, resname, nearPath);
		const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { location?: Location; action?: symbol }>([
			...locations.map((location, index) => ({
				label: `${location.groupPath.length ? '$(symbol-namespace)' : '$(file-code)'} ${[location.fileSet.name, ...location.groupPath].join(' › ')}`,
				description: index === 0 && (resname || nearPath) ? 'suggested' : undefined,
				location,
			})),
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: '$(new-file) New XLIFF file…', action: NEW_FILE },
		], { title, placeHolder: 'File and group' });
		if (picked?.action === NEW_FILE) {
			const fileSet = await addFile(project);
			return fileSet && { fileSet, groupPath: [] };
		}
		return picked?.location;
	};

	const addUnit = async (arg?: XliffNode | UnknownResname): Promise<void> => {
		let location: Location | undefined;
		let resname: string | undefined;
		let nearPath: string | undefined;
		if (arg && 'kind' in arg) {
			if (arg.kind === 'file') {
				location = { fileSet: arg.fileSet, groupPath: [] };
			} else if (arg.kind === 'group') {
				location = { fileSet: arg.fileSet, groupPath: arg.group.path };
			}
		} else if (arg) {
			resname = arg.resname;
			nearPath = arg.sourcePath;
		}
		const project = location?.fileSet.project ?? await pickProject(nearPath);
		if (!project) {
			return;
		}

		if (!resname) {
			const prefix = location ? commonPrefix(groupAt(location)?.entries.map(e => e.resname) ?? []) : '';
			resname = await vscode.window.showInputBox({
				title: 'New resname',
				prompt: location ? `In ${[location.fileSet.name, ...location.groupPath].join(' › ')}` : undefined,
				value: prefix,
				valueSelection: [prefix.length, prefix.length],
				validateInput: input => resnameProblem(input) ?? existsIn(project, input),
			});
			if (!resname) {
				return;
			}
		}

		location ??= await pickLocation(project, `Where to create "${resname}"?`, resname, nearPath);
		if (!location) {
			return;
		}
		const source = await vscode.window.showInputBox({
			title: `Text of "${resname}"`,
			prompt: `In ${location.fileSet.project.sourceLanguage}. The other languages get the same text, marked as needing translation.`,
			validateInput: input => input ? undefined : 'Enter the text',
		});
		if (source === undefined) {
			return;
		}

		const entry = await model.addUnit(location.fileSet, location.groupPath, resname, source);
		if (!entry) {
			return;
		}
		XliffDetailPanel.show(context, model, refOf(entry));
		await hooks.reveal(refOf(entry));
		if (!nearPath) {
			await vscode.env.clipboard.writeText(`:xliff:${resname}`);
			vscode.window.setStatusBarMessage(`$(copy) "${resname}" created, :xliff:${resname} copied`, 4000);
		}
	};

	const addGroup = async (arg?: XliffNode): Promise<void> => {
		let parent: Location | undefined;
		if (arg?.kind === 'file') {
			parent = { fileSet: arg.fileSet, groupPath: [] };
		} else if (arg?.kind === 'group') {
			parent = { fileSet: arg.fileSet, groupPath: arg.group.path };
		} else {
			const project = await pickProject();
			parent = project && await pickLocation(project, 'Where to create the group?');
		}
		if (!parent) {
			return;
		}
		const { fileSet, groupPath } = parent;
		const name = await vscode.window.showInputBox({
			title: 'New group',
			prompt: `In ${[fileSet.name, ...groupPath].join(' › ')}`,
			validateInput: input => {
				if (!input.trim()) {
					return 'Enter a name';
				}
				const files = [...fileSet.files.values()];
				return files.every(f => hasGroup(f.doc, [...groupPath, input.trim()])) ? 'This group already exists' : undefined;
			},
		});
		if (name) {
			await model.addGroup(fileSet, [...groupPath, name.trim()]);
		}
	};

	const run = (action: (...args: any[]) => Promise<unknown>) => async (...args: any[]) => {
		try {
			await action(...args);
		} catch (err) {
			vscode.window.showErrorMessage(`4D XLIFF: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	return [
		vscode.commands.registerCommand('4dXliff.addUnit', run(addUnit)),
		vscode.commands.registerCommand('4dXliff.addGroup', run(addGroup)),
		vscode.commands.registerCommand('4dXliff.addLanguage', run(async (arg?: XliffNode) => {
			const project = arg?.kind === 'project' ? arg.project : await pickProject();
			if (!project) {
				return;
			}
			const lang = await vscode.window.showInputBox({
				title: 'Add a language',
				prompt: `Language code, e.g. de, es, fr-CA. Each file of ${project.sourceLanguage}.lproj is copied, every string marked as needing translation.`,
				validateInput: input => {
					const code = input.trim();
					if (!/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(code)) {
						return 'Enter a language code such as de or fr-CA';
					}
					return project.languages.some(l => l.toLowerCase() === code.toLowerCase()) ? `${code} already exists` : undefined;
				},
			});
			if (!lang) {
				return;
			}
			await model.addLanguage(project, lang.trim());
			hooks.languageAdded(lang.trim());
		})),
		vscode.commands.registerCommand('4dXliff.addFile', run(async (arg?: XliffNode) => {
			const project = arg?.kind === 'project' ? arg.project : await pickProject();
			if (project) {
				await addFile(project);
			}
		})),
		vscode.languages.registerCodeActionsProvider(SOURCE_SELECTOR, {
			provideCodeActions(document, _range, context) {
				return context.diagnostics
					.filter(d => d.source === '4D XLIFF' && d.code === 'unknown-resname')
					.map(d => {
						const resname = document.getText(d.range);
						const action = new vscode.CodeAction(`Create "${resname}" in the XLIFF files…`, vscode.CodeActionKind.QuickFix);
						action.diagnostics = [d];
						action.isPreferred = true;
						action.command = { command: '4dXliff.addUnit', title: action.title, arguments: [{ resname, sourcePath: document.uri.fsPath } satisfies UnknownResname] };
						return action;
					});
			},
		}, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
	];
}

function withExtension(name: string): string {
	return /\.(xlf|xliff)$/i.test(name) ? name : `${name}.xlf`;
}

function parseLanguages(input: string): string[] {
	return [...new Set(input.split(/[\s,;]+/).map(l => l.trim()).filter(Boolean))];
}

function existsIn(project: XliffProject, resname: string): string | undefined {
	const existing = project.resnames.get(resname);
	return existing ? `Already defined in ${existing[0].fileSet.name}` : undefined;
}

function groupAt(location: Location): TreeGroup | undefined {
	let group: TreeGroup | undefined = location.fileSet.root;
	for (const name of location.groupPath) {
		group = group?.groups.find(g => g.name === name);
	}
	return group;
}

/** "form1." for form1.ok, form1.cancel… */
function commonPrefix(resnames: string[]): string {
	if (!resnames.length) {
		return '';
	}
	let prefix = resnames[0];
	for (const name of resnames) {
		while (!name.startsWith(prefix)) {
			prefix = prefix.slice(0, -1);
		}
	}
	const dot = prefix.lastIndexOf('.');
	return dot >= 0 ? prefix.slice(0, dot + 1) : '';
}

/** Name that the place using a resname suggests: the form, "Menus", the method… */
function sourceHint(filePath: string): string | undefined {
	const kind = usageKind(filePath);
	if (kind === 'form') {
		return path.basename(path.dirname(filePath));
	}
	if (kind === 'menu' || kind === 'list' || kind === 'tip') {
		return path.basename(filePath, '.json');
	}
	return kind === 'method' ? path.basename(filePath, '.4dm') : undefined;
}

/**
 * Every file and group of the project, the most likely first: the group
 * holding resnames with the same prefix (form1.email next to form1.ok),
 * then the file or group named like the form or menu using it.
 */
function rankLocations(project: XliffProject, resname?: string, nearPath?: string): Location[] {
	const all: { location: Location; group: TreeGroup }[] = [];
	for (const fileSet of project.fileSets) {
		const walk = (group: TreeGroup) => {
			all.push({ location: { fileSet, groupPath: group.path }, group });
			group.groups.forEach(walk);
		};
		walk(fileSet.root);
	}
	const dot = resname?.lastIndexOf('.') ?? -1;
	const prefix = resname && dot > 0 ? resname.slice(0, dot + 1) : undefined;
	const hint = nearPath ? sourceHint(nearPath)?.toLowerCase() : undefined;
	const score = ({ location, group }: { location: Location; group: TreeGroup }) => {
		const siblings = prefix ? group.entries.filter(e => e.resname.startsWith(prefix)).length : 0;
		const names = [path.posix.basename(location.fileSet.name, path.posix.extname(location.fileSet.name)), ...location.groupPath].map(n => n.toLowerCase());
		// Form1.xlf › Form1 matches twice and comes before Form1.xlf.
		const named = hint ? names.filter(n => n === hint).length : 0;
		return siblings * 10 + named;
	};
	return all
		.map((item, index) => ({ item, index, score: score(item) }))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map(x => x.item.location);
}
