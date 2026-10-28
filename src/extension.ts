import * as vscode from 'vscode';
import { entryReference, ResEntry, TreeGroup } from './core/xliffIndex';
import { displayText, isTranslated, translationStatus } from './core/status';
import { resnameProblem } from './core/xliffEdits';
import { entryLabel, refOf, UnitRef, unitLocation, usageLocation, XliffModel } from './model';
import { XliffNode, XliffTreeProvider } from './tree';
import { XliffDetailPanel } from './panel';
import { registerLanguageFeatures } from './languageFeatures';
import { XliffDiagnostics } from './diagnostics';
import { registerAddCommands } from './addCommands';

/** Commands receive a tree node (menus), a UnitRef (links, CodeLens) or nothing (palette). */
type UnitArg = XliffNode | UnitRef | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<{ model: XliffModel; tree: XliffTreeProvider }> {
	const model = new XliffModel();
	const tree = new XliffTreeProvider(model);
	const treeView = vscode.window.createTreeView('4dXliff.files', { treeDataProvider: tree, showCollapseAll: true });
	const diagnostics = new XliffDiagnostics(model);

	const updateMessage = () => {
		const lang = tree.translateLanguage;
		const parts = [
			lang ? `To translate${lang === '*' ? '' : ` in ${lang}`}: ${tree.shownEntries().length}` : undefined,
			tree.filterText ? `Filter: "${tree.filterText}"` : undefined,
		].filter(Boolean);
		treeView.message = parts.length ? parts.join(' · ') : undefined;
	};
	context.subscriptions.push(model.onDidChange(() => {
		updateMessage();
		leaveWhenDone();
	}));
	XliffDetailPanel.translateLanguage = () => tree.translateLanguage;

	/** Language to put the cursor in when the "to translate" view is on. */
	const focusLangFor = (entry: ResEntry): string | undefined => {
		const lang = tree.translateLanguage;
		if (lang === '*') {
			return entry.fileSet.project.languages.find(l => !isTranslated(translationStatus(entry, l)));
		}
		return lang && entry.fileSet.project.languages.includes(lang) ? lang : undefined;
	};

	/** Strings left to translate in `lang` ('*': in any language), whatever the text filter. */
	const remaining = (lang: string) => model.allEntries().filter(e => lang === '*'
		? e.fileSet.project.languages.some(l => !isTranslated(translationStatus(e, l)))
		: e.fileSet.project.languages.includes(lang) && !isTranslated(translationStatus(e, lang))).length;

	/** Leaves the "to translate" view once its last string is translated. */
	const leaveWhenDone = () => {
		const lang = tree.translateLanguage;
		if (lang && remaining(lang) === 0) {
			showToTranslate(undefined);
			vscode.window.showInformationMessage(`Everything is translated${lang === '*' ? '' : ` in ${lang}`}.`);
		}
	};

	const TRANSLATE_KEY = '4dXliff.translateLanguage';
	const showToTranslate = (lang: string | undefined) => {
		tree.setTranslateLanguage(lang);
		updateMessage();
		XliffDetailPanel.refresh();
		// Kept for the workspace, so that a reload keeps the "to translate" view.
		context.workspaceState.update(TRANSLATE_KEY, lang);
	};

	const resolveEntry = async (arg: UnitArg): Promise<ResEntry | undefined> => {
		if (arg && 'kind' in arg) {
			return arg.kind === 'unit' ? arg.entry : undefined;
		}
		if (arg && 'resname' in arg) {
			return model.resolve(arg);
		}
		return pickEntry(model);
	};

	const copy = async (text: string) => {
		await vscode.env.clipboard.writeText(text);
		vscode.window.setStatusBarMessage(`$(copy) Copied ${text}`, 2500);
	};

	const register = (id: string, callback: (...args: any[]) => unknown) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, callback));

	register('4dXliff.refresh', () => model.refresh());

	register('4dXliff.filter', async () => {
		const value = await vscode.window.showInputBox({
			title: 'Filter resnames',
			prompt: 'Part of a resname or of a translation',
			value: tree.filterText,
		});
		if (value !== undefined) {
			tree.setFilter(value);
			updateMessage();
		}
	});

	register('4dXliff.clearFilter', () => {
		tree.setFilter('');
		showToTranslate(undefined);
	});

	register('4dXliff.showToTranslate', async () => {
		const languages = [...new Set(model.index.projects.flatMap(p => p.languages))];
		const entries = model.allEntries();
		const count = (lang: string) => entries.filter(e => e.fileSet.project.languages.includes(lang) && !isTranslated(translationStatus(e, lang))).length;
		const sources = new Set(model.index.projects.map(p => p.sourceLanguage));
		const picked = await vscode.window.showQuickPick([
			...languages
				.sort((a, b) => Number(sources.has(a)) - Number(sources.has(b)) || a.localeCompare(b))
				.map(lang => ({ label: lang, description: `${count(lang)} to translate${sources.has(lang) ? ' · source' : ''}`, lang })),
			{ label: 'All languages', description: `${entries.filter(e => e.fileSet.project.languages.some(l => !isTranslated(translationStatus(e, l)))).length} incomplete`, lang: '*' },
		], { title: 'Show the strings to translate in' });
		if (picked && remaining(picked.lang) === 0) {
			vscode.window.showInformationMessage(`Nothing to translate${picked.lang === '*' ? '' : ` in ${picked.lang}`}.`);
		} else if (picked) {
			showToTranslate(picked.lang);
		}
	});

	register('4dXliff.stopTranslating', () => showToTranslate(undefined));

	register('4dXliff.nextToTranslate', async (ref?: UnitRef) => {
		const lang = tree.translateLanguage;
		if (!lang) {
			return;
		}
		const key = (e: { fileSetId: string; resname: string; platform?: string }) => `${e.fileSetId}\u0000${e.resname}\u0000${e.platform ?? ''}`;
		const order = new Map<string, number>();
		const walk = (group: TreeGroup) => {
			group.groups.forEach(walk);
			group.entries.forEach(e => order.set(key(refOf(e)), order.size));
		};
		model.index.projects.forEach(p => p.fileSets.forEach(s => walk(s.root)));
		// The current string may already be gone from the view once translated:
		// take the first one after its position, then wrap around.
		const current = ref ? key(ref) : '';
		const position = order.get(current) ?? -1;
		const candidates = tree.shownEntries().filter(e => key(refOf(e)) !== current);
		const next = candidates.find(e => (order.get(key(refOf(e))) ?? -1) > position) ?? candidates[0];
		if (!next) {
			vscode.window.showInformationMessage(`Everything is translated${lang === '*' ? '' : ` in ${lang}`}.`);
			return;
		}
		XliffDetailPanel.show(context, model, refOf(next), focusLangFor(next));
		const node = tree.nodeFor(next);
		if (node) {
			await treeView.reveal(node, { select: true, focus: false });
		}
	});

	register('4dXliff.copyXliffRef', async (arg: UnitArg) => {
		const entry = await resolveEntry(arg);
		if (entry) {
			await copy(`:xliff:${entry.resname}`);
		}
	});

	register('4dXliff.copyLocalizedString', async (arg: UnitArg) => {
		const entry = await resolveEntry(arg);
		if (entry) {
			await copy(`Localized string("${entry.resname}")`);
		}
	});

	register('4dXliff.showUnit', async (arg: UnitArg) => {
		const entry = await resolveEntry(arg);
		if (entry) {
			XliffDetailPanel.show(context, model, refOf(entry), focusLangFor(entry));
		}
	});

	register('4dXliff.openInFile', async (arg: UnitArg) => {
		if (arg && 'kind' in arg && arg.kind === 'file') {
			const file = arg.fileSet.files.get(arg.fileSet.referenceLanguage);
			if (file) {
				await vscode.window.showTextDocument(vscode.Uri.file(file.path));
			}
			return;
		}
		const entry = await resolveEntry(arg);
		const location = entry && unitLocation(entry, entryReference(entry).lang);
		if (location) {
			await vscode.window.showTextDocument(location.uri, { selection: location.range });
		}
	});

	register('4dXliff.splitByPlatform', async (arg: UnitArg) => {
		const entry = await resolveEntry(arg);
		if (!entry || entry.platform) {
			return;
		}
		const answer = await vscode.window.showWarningMessage(
			`Use a different text for "${entry.resname}" on mac and on win?`,
			{ modal: true, detail: 'The current trans-unit becomes the win version (d4:includeIf="win") and a copy is added for mac, in every language. Both keep the current texts until you change them.' },
			'Split',
		);
		if (answer !== 'Split') {
			return;
		}
		try {
			const mac = await model.splitByPlatform(entry);
			if (mac) {
				XliffDetailPanel.show(context, model, refOf(mac));
			}
		} catch (err) {
			vscode.window.showErrorMessage(`4D XLIFF: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	register('4dXliff.renameUnit', async (arg: UnitArg) => {
		const entry = await resolveEntry(arg);
		if (!entry) {
			return;
		}
		const oldName = entry.resname;
		const project = entry.fileSet.project;
		const dot = oldName.lastIndexOf('.');
		const newName = await vscode.window.showInputBox({
			title: `Rename "${oldName}"`,
			value: oldName,
			valueSelection: [dot + 1, oldName.length],
			validateInput: input => {
				if (input === oldName) {
					return 'Enter a new name';
				}
				const taken = project.resnames.get(input);
				return resnameProblem(input) ?? (taken ? `Already defined in ${taken[0].fileSet.name}` : undefined);
			},
		});
		if (!newName) {
			return;
		}
		const sameName = project.resnames.get(oldName) ?? [];
		const files = [...entry.fileSet.files.values()].filter(f => f.doc.units.some(u => u.key === oldName)).map(f => f.label);
		const usages = model.usagesOf(entry);
		const elsewhere = [...new Set(sameName.filter(e => e.fileSet !== entry.fileSet).map(e => e.fileSet.name))];
		const detail = [
			`XLIFF: ${files.join(', ')}${sameName.some(e => e.fileSet === entry.fileSet && e.platform) ? ' (mac and win versions)' : ''}.`,
			usages.length
				? `References (${usages.length}):\n${usages.slice(0, 10).map(u => `• ${u.context}`).join('\n')}${usages.length > 10 ? '\n…' : ''}`
				: 'No reference found in forms, menus or code.',
			usages.some(u => u.kind === 'form' || u.kind === 'menu') ? 'Close these forms and menus in 4D first, so that 4D does not save over the change.' : undefined,
			elsewhere.length ? `"${oldName}" is also defined in ${elsewhere.join(', ')}: that definition keeps its name.` : undefined,
			'Edit › Undo cancels the whole renaming.',
		].filter(Boolean).join('\n\n');
		const answer = await vscode.window.showWarningMessage(`Rename "${oldName}" to "${newName}"?`, { modal: true, detail }, 'Rename');
		if (answer !== 'Rename') {
			return;
		}
		try {
			const renamed = await model.renameEntry(entry, newName);
			if (renamed) {
				XliffDetailPanel.retarget(refOf(entry), refOf(renamed));
			}
			vscode.window.setStatusBarMessage(`$(edit) "${oldName}" renamed to "${newName}" (${usages.length} reference${usages.length === 1 ? '' : 's'})`, 5000);
		} catch (err) {
			vscode.window.showErrorMessage(`4D XLIFF: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	register('4dXliff.deleteUnit', async (arg: UnitArg) => {
		const entry = await resolveEntry(arg);
		if (!entry) {
			return;
		}
		const files = [...entry.byLang.keys()].map(lang => entry.fileSet.files.get(lang)!.label);
		const usages = model.usagesOf(entry);
		const otherPlatforms = model.lookup(entry.resname, entry.fileSet.project.root).filter(e => e !== entry && e.fileSet === entry.fileSet);
		const detail = [
			`It will be removed from ${files.join(', ')}.`,
			usages.length ? `It is still used in ${usages.length === 1 ? '1 place' : `${usages.length} places`}:\n${usages.slice(0, 8).map(u => `• ${u.context}`).join('\n')}${usages.length > 8 ? '\n…' : ''}` : undefined,
			entry.platform && otherPlatforms.length ? `The ${otherPlatforms.map(e => e.platform).join(', ')} version stays: on ${entry.platform}, 4D will no longer find "${entry.resname}".` : undefined,
		].filter(Boolean).join('\n\n');
		const answer = await vscode.window.showWarningMessage(`Delete "${entryLabel(entry)}"?`, { modal: true, detail }, 'Delete');
		if (answer !== 'Delete') {
			return;
		}
		try {
			await model.deleteEntry(entry);
			vscode.window.setStatusBarMessage(`$(trash) "${entryLabel(entry)}" deleted`, 4000);
		} catch (err) {
			vscode.window.showErrorMessage(`4D XLIFF: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	register('4dXliff.findUsages', async (arg: UnitArg) => {
		const entry = await resolveEntry(arg);
		const location = entry && unitLocation(entry, entryReference(entry).lang);
		if (entry && location) {
			await vscode.commands.executeCommand('editor.action.showReferences', location.uri, location.range.start, model.usagesOf(entry).map(usageLocation));
		}
	});

	register('4dXliff.revealInTree', async (arg: UnitArg) => {
		const entry = await resolveEntry(arg);
		if (!entry) {
			return;
		}
		let node = tree.nodeFor(entry);
		if (!node && tree.filterText) {
			tree.setFilter('');
			updateMessage();
			node = tree.nodeFor(entry);
		}
		if (node) {
			await treeView.reveal(node, { select: true, focus: true, expand: true });
		}
	});

	context.subscriptions.push(
		model,
		treeView,
		diagnostics,
		...registerLanguageFeatures(model),
		...registerAddCommands(context, model, {
			reveal: ref => vscode.commands.executeCommand('4dXliff.revealInTree', ref),
			languageAdded: lang => showToTranslate(lang),
		}),
	);
	await model.refresh();
	const savedLanguage = context.workspaceState.get<string>(TRANSLATE_KEY);
	if (savedLanguage && (savedLanguage === '*' || model.index.projects.some(p => p.languages.includes(savedLanguage)))) {
		showToTranslate(savedLanguage);
	}
	return { model, tree };
}

async function pickEntry(model: XliffModel): Promise<ResEntry | undefined> {
	const multiProject = model.index.projects.length > 1;
	const picked = await vscode.window.showQuickPick(
		model.allEntries().map(entry => ({
			label: entryLabel(entry),
			description: displayText(entry),
			detail: [multiProject ? entry.fileSet.project.name : undefined, entry.fileSet.name, ...entry.groupPath].filter(Boolean).join(' › '),
			entry,
		})),
		{ title: 'Resnames', placeHolder: 'Search a resname or a text', matchOnDescription: true, matchOnDetail: true },
	);
	return picked?.entry;
}

export function deactivate(): void {}
