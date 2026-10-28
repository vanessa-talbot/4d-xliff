// Keeps the XLIFF index and the resname usages of the workspace up to date,
// and applies translation edits to the XLIFF files.

import * as path from 'path';
import * as vscode from 'vscode';
import { buildIndex, LangFile, locateXliff, projectForPath, ResEntry, XliffFileSet, XliffIndex, XliffProject } from './core/xliffIndex';
import { parseXliff, XliffDocument, XliffUnit } from './core/xliffParser';
import { insertUnitEdit, setSourceEdits, setTargetEdits, TextEdit } from './core/xliffEdits';
import { projectRootOfSource, scanUsages, Usage, usageKind } from './core/usages';
import { offsetToLineCol } from './core/text';

/** Serializable reference to a resname, used in commands and webviews. */
export interface UnitRef {
	projectRoot: string;
	fileSetId: string;
	resname: string;
}

type FileKind = 'xlf' | 'usage' | 'project';

export class XliffModel implements vscode.Disposable {
	index: XliffIndex = { projects: [] };

	private readonly xlfTexts = new Map<string, string>();
	private readonly projectFiles = new Set<string>();
	private readonly usagesByFile = new Map<string, Usage[]>();
	private usagesByKey = new Map<string, Usage[]>();
	private rebuildTimer: NodeJS.Timeout | undefined;
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly disposables: vscode.Disposable[] = [this.emitter];

	constructor() {
		const watcher = vscode.workspace.createFileSystemWatcher('**/*.{xlf,xliff,XLF,4dm,4DForm,4DProject,json}');
		this.disposables.push(
			watcher,
			watcher.onDidCreate(uri => this.updateFile(uri)),
			watcher.onDidChange(uri => this.updateFile(uri)),
			watcher.onDidDelete(uri => this.removeFile(uri)),
			vscode.workspace.onDidChangeTextDocument(e => this.updateFile(e.document.uri, e.document.getText())),
			vscode.workspace.onDidCloseTextDocument(doc => this.updateFile(doc.uri)),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('4dXliff')) {
					this.refresh();
				}
			}),
		);
	}

	dispose(): void {
		clearTimeout(this.rebuildTimer);
		this.disposables.forEach(d => d.dispose());
	}

	private config() {
		return vscode.workspace.getConfiguration('4dXliff');
	}

	private excludedFolders(): string[] {
		return this.config().get<string[]>('excludeFolders', []);
	}

	private excludeGlob(): string | undefined {
		const folders = this.excludedFolders();
		return folders.length ? `**/{${folders.join(',')}}/**` : undefined;
	}

	private kindOf(uri: vscode.Uri): FileKind | undefined {
		if (uri.scheme !== 'file') {
			return undefined;
		}
		const p = uri.fsPath;
		const excluded = new Set(this.excludedFolders());
		if (p.split(/[\\/]/).some(segment => excluded.has(segment))) {
			return undefined;
		}
		const lower = p.toLowerCase();
		if (lower.endsWith('.xlf') || lower.endsWith('.xliff')) {
			return locateXliff(p) ? 'xlf' : undefined;
		}
		if (lower.endsWith('.4dproject') && path.basename(path.dirname(p)) === 'Project') {
			return 'project';
		}
		return usageKind(p) ? 'usage' : undefined;
	}

	async refresh(): Promise<void> {
		const exclude = this.excludeGlob();
		const [xlfs, projects, sources] = await Promise.all([
			vscode.workspace.findFiles('**/Resources/**/*.{xlf,xliff}', exclude),
			vscode.workspace.findFiles('**/Project/*.4DProject', exclude),
			vscode.workspace.findFiles('**/Project/Sources/**/{*.4dm,*.4DForm,menus.json,lists.json,tips.json}', exclude),
		]);
		this.xlfTexts.clear();
		this.projectFiles.clear();
		this.usagesByFile.clear();
		for (const uri of projects) {
			this.projectFiles.add(uri.fsPath);
		}
		await Promise.all([
			...xlfs.filter(uri => this.kindOf(uri) === 'xlf').map(async uri => this.xlfTexts.set(uri.fsPath, await readText(uri))),
			...sources.map(async uri => this.usagesByFile.set(uri.fsPath, scanUsages(uri.fsPath, await readText(uri)))),
		]);
		this.rebuild();
	}

	private async updateFile(uri: vscode.Uri, text?: string): Promise<void> {
		const kind = this.kindOf(uri);
		if (!kind) {
			return;
		}
		if (kind === 'project') {
			this.projectFiles.add(uri.fsPath);
		} else {
			try {
				text ??= await readText(uri);
			} catch {
				return this.removeFile(uri);
			}
			if (kind === 'xlf') {
				if (this.xlfTexts.get(uri.fsPath) === text) {
					return;
				}
				this.xlfTexts.set(uri.fsPath, text);
			} else {
				this.usagesByFile.set(uri.fsPath, scanUsages(uri.fsPath, text));
			}
		}
		this.scheduleRebuild();
	}

	private removeFile(uri: vscode.Uri): void {
		const p = uri.fsPath;
		if (this.xlfTexts.delete(p) || this.usagesByFile.delete(p) || this.projectFiles.delete(p)) {
			this.scheduleRebuild();
		}
	}

	private scheduleRebuild(): void {
		clearTimeout(this.rebuildTimer);
		this.rebuildTimer = setTimeout(() => this.rebuild(), 200);
	}

	private rebuild(): void {
		clearTimeout(this.rebuildTimer);
		this.index = buildIndex(
			[...this.xlfTexts].map(([p, text]) => ({ path: p, text })),
			{
				sourceLanguage: this.config().get<string>('sourceLanguage') || undefined,
				projectRoots: [...this.projectFiles].map(p => path.dirname(path.dirname(p))),
			},
		);
		this.usagesByKey = new Map();
		for (const usages of this.usagesByFile.values()) {
			for (const u of usages) {
				const key = usageKey(projectRootOfSource(u.path) ?? '', u.resname);
				const list = this.usagesByKey.get(key) ?? [];
				list.push(u);
				this.usagesByKey.set(key, list);
			}
		}
		this.emitter.fire();
	}

	// --- Queries ---

	projectFor(filePath: string): XliffProject | undefined {
		return projectForPath(this.index, filePath);
	}

	allEntries(): ResEntry[] {
		return this.index.projects.flatMap(p => p.fileSets.flatMap(s => s.entries));
	}

	/** Entries named `resname`, in the project of `nearPath` when given. */
	lookup(resname: string, nearPath?: string): ResEntry[] {
		const project = nearPath ? this.projectFor(nearPath) : undefined;
		if (project) {
			return project.resnames.get(resname) ?? [];
		}
		return this.index.projects.flatMap(p => p.resnames.get(resname) ?? []);
	}

	resolve(ref: UnitRef): ResEntry | undefined {
		const project = this.index.projects.find(p => p.root === ref.projectRoot);
		const entries = project?.resnames.get(ref.resname) ?? [];
		return entries.find(e => e.fileSet.id === ref.fileSetId) ?? entries[0];
	}

	langFileAt(filePath: string): { fileSet: XliffFileSet; langFile: LangFile } | undefined {
		for (const project of this.index.projects) {
			for (const fileSet of project.fileSets) {
				for (const langFile of fileSet.files.values()) {
					if (langFile.path === filePath) {
						return { fileSet, langFile };
					}
				}
			}
		}
		return undefined;
	}

	usagesOf(entry: ResEntry): Usage[] {
		return this.usagesByKey.get(usageKey(entry.fileSet.project.root, entry.resname)) ?? [];
	}

	usageFiles(): Map<string, Usage[]> {
		return this.usagesByFile;
	}

	isIgnored(resname: string): boolean {
		return this.config().get<string[]>('ignoredResnames', []).some(pattern => {
			try {
				return new RegExp(pattern).test(resname);
			} catch {
				return false;
			}
		});
	}

	// --- Edits ---

	async setTarget(entry: ResEntry, lang: string, value: string): Promise<void> {
		const file = entry.fileSet.files.get(lang);
		if (!file) {
			throw new Error(`No ${lang} file for ${entry.fileSet.name}`);
		}
		await applyXliffEdits(new Map([[file.path, (text, doc) => setTargetEdits(text, findUnit(doc, entry.resname, file.path), value)]]));
	}

	/** Changes <source> in every language, and the source language target when it was equal to the source. */
	async setSource(entry: ResEntry, value: string): Promise<void> {
		const sourceLang = entry.fileSet.project.sourceLanguage;
		const edits = new Map<string, (text: string, doc: XliffDocument) => TextEdit[]>();
		for (const lang of entry.byLang.keys()) {
			const file = entry.fileSet.files.get(lang)!;
			edits.set(file.path, (text, doc) => {
				const unit = findUnit(doc, entry.resname, file.path);
				const result = setSourceEdits(unit, value);
				if (lang === sourceLang && unit.target !== undefined && unit.target === unit.source) {
					result.push(...setTargetEdits(text, unit, value));
				}
				return result;
			});
		}
		await applyXliffEdits(edits);
	}

	/** Adds the resname to a language file where it is missing, marked as needing translation. */
	async addToLanguage(entry: ResEntry, lang: string): Promise<void> {
		const file = entry.fileSet.files.get(lang);
		if (!file) {
			throw new Error(`No ${lang} file for ${entry.fileSet.name}`);
		}
		const model = entry.byLang.get(entry.fileSet.referenceLanguage)!;
		const source = model.source ?? '';
		await applyXliffEdits(new Map([[file.path, (text, doc) => [insertUnitEdit(text, doc, entry.groupPath, {
			resname: entry.resname,
			id: model.id,
			source,
			target: source,
			state: 'needs-translation',
		})]]]));
	}
}

function usageKey(projectRoot: string, resname: string): string {
	return `${projectRoot}\u0000${resname}`;
}

async function readText(uri: vscode.Uri): Promise<string> {
	const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
	if (open) {
		return open.getText();
	}
	return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
}

function findUnit(doc: XliffDocument, key: string, filePath: string): XliffUnit {
	const unit = doc.units.find(u => u.key === key);
	if (!unit) {
		throw new Error(`"${key}" not found in ${filePath}`);
	}
	return unit;
}

/**
 * Applies edits computed on the current content of each file (open editors
 * included), then saves the files that had no unsaved changes before.
 */
async function applyXliffEdits(edits: Map<string, (text: string, doc: XliffDocument) => TextEdit[]>): Promise<void> {
	const workspaceEdit = new vscode.WorkspaceEdit();
	const toSave: vscode.TextDocument[] = [];
	for (const [filePath, compute] of edits) {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
		const text = document.getText();
		for (const e of compute(text, parseXliff(text))) {
			workspaceEdit.replace(document.uri, new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.newText);
		}
		if (!document.isDirty) {
			toSave.push(document);
		}
	}
	if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
		throw new Error('The XLIFF file could not be modified');
	}
	await Promise.all(toSave.map(d => d.save()));
}

export function refOf(entry: ResEntry): UnitRef {
	return { projectRoot: entry.fileSet.project.root, fileSetId: entry.fileSet.id, resname: entry.resname };
}

export function unitLocation(entry: ResEntry, lang: string): vscode.Location | undefined {
	const file = entry.fileSet.files.get(lang);
	const unit = entry.byLang.get(lang);
	if (!file || !unit) {
		return undefined;
	}
	return new vscode.Location(vscode.Uri.file(file.path), positionIn(file, unit.span.start));
}

export function positionIn(file: LangFile, offset: number): vscode.Position {
	const { line, character } = offsetToLineCol(file.lines, offset);
	return new vscode.Position(line, character);
}

export function usageLocation(u: Usage): vscode.Location {
	const start = new vscode.Position(u.line, u.character);
	return new vscode.Location(vscode.Uri.file(u.path), new vscode.Range(start, start.translate(0, u.length)));
}
