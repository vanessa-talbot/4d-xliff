import * as vscode from 'vscode';
import { ResEntry } from './core/xliffIndex';
import { displayText } from './core/status';
import { refOf, UnitRef, unitLocation, usageLocation, XliffModel } from './model';
import { XliffNode, XliffTreeProvider } from './tree';
import { XliffDetailPanel } from './panel';
import { registerLanguageFeatures } from './languageFeatures';
import { XliffDiagnostics } from './diagnostics';

/** Commands receive a tree node (menus), a UnitRef (links, CodeLens) or nothing (palette). */
type UnitArg = XliffNode | UnitRef | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<{ model: XliffModel }> {
	const model = new XliffModel();
	const tree = new XliffTreeProvider(model);
	const treeView = vscode.window.createTreeView('4dXliff.files', { treeDataProvider: tree, showCollapseAll: true });
	const diagnostics = new XliffDiagnostics(model);

	const updateMessage = () => {
		treeView.message = tree.filterText ? `Filter: "${tree.filterText}"` : undefined;
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
		updateMessage();
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
			XliffDetailPanel.show(context, model, refOf(entry));
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
		const location = entry && unitLocation(entry, entry.fileSet.referenceLanguage);
		if (location) {
			await vscode.window.showTextDocument(location.uri, { selection: location.range });
		}
	});

	register('4dXliff.findUsages', async (arg: UnitArg) => {
		const entry = await resolveEntry(arg);
		const location = entry && unitLocation(entry, entry.fileSet.referenceLanguage);
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

	context.subscriptions.push(model, treeView, diagnostics, ...registerLanguageFeatures(model));
	await model.refresh();
	return { model };
}

async function pickEntry(model: XliffModel): Promise<ResEntry | undefined> {
	const multiProject = model.index.projects.length > 1;
	const picked = await vscode.window.showQuickPick(
		model.allEntries().map(entry => ({
			label: entry.resname,
			description: displayText(entry),
			detail: [multiProject ? entry.fileSet.project.name : undefined, entry.fileSet.name, ...entry.groupPath].filter(Boolean).join(' › '),
			entry,
		})),
		{ title: 'Resnames', placeHolder: 'Search a resname or a text', matchOnDescription: true, matchOnDetail: true },
	);
	return picked?.entry;
}

export function deactivate(): void {}
