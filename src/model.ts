// Keeps the XLIFF index and the resname usages of the workspace up to date,
// and applies edits (translations, new resnames, groups and files) to the XLIFF files.

import * as path from 'path';
import * as vscode from 'vscode';
import { buildIndex, entryReference, LangFile, languageFileName, locateXliff, projectForPath, ResEntry, XliffFileSet, XliffIndex, XliffProject } from './core/xliffIndex';
import { parseXliff, XliffDocument, XliffUnit } from './core/xliffParser';
import { declarePrefixEdits, deleteUnitEdit, hasGroup, renameUnitEdits, insertGroupEdit, insertUnitEdit, newLanguageFile, newXliffFile, nextUnitId, setSourceEdits, setTargetEdits, splitByPlatformEdits, TextEdit } from './core/xliffEdits';
import { projectRootOfSource, renameUsageEdits, scanUsages, Usage, usageKind } from './core/usages';
import { detectEol, detectIndentUnit, offsetToLineCol } from './core/text';

/** Serializable reference to a resname, used in commands and webviews. */
export interface UnitRef {
	projectRoot: string;
	fileSetId: string;
	resname: string;
	platform?: string;
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
		return entries.find(e => e.fileSet.id === ref.fileSetId && e.platform === ref.platform)
			?? entries.find(e => e.platform === ref.platform)
			?? entries[0];
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
		await applyXliffEdits(new Map([[file.path, (text, doc) => setTargetEdits(text, findUnit(doc, entry, file.path), value)]]));
	}

	/** Changes <source> in every language, and the source language target when it was equal to the source. */
	async setSource(entry: ResEntry, value: string): Promise<void> {
		const sourceLang = entry.fileSet.project.sourceLanguage;
		const edits = new Map<string, (text: string, doc: XliffDocument) => TextEdit[]>();
		for (const lang of entry.byLang.keys()) {
			const file = entry.fileSet.files.get(lang)!;
			edits.set(file.path, (text, doc) => {
				const unit = findUnit(doc, entry, file.path);
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
		const model = entryReference(entry).unit;
		const source = model.source ?? '';
		// In the source language the target is the text itself, nothing to translate.
		const state = lang === entry.fileSet.project.sourceLanguage ? undefined : 'needs-translation';
		await applyXliffEdits(new Map([[file.path, (text, doc) => [...(model.platformAttr ? declarePrefixEdits(text, doc, model.platformAttr) : []), insertUnitEdit(text, doc, entry.groupPath, {
			resname: entry.resname,
			id: model.id,
			source,
			target: source,
			state,
			platform: model.platform,
			platformAttr: model.platformAttr,
		})]]]));
	}

	/**
	 * Renames a resname in every language (all its platform versions) and in
	 * the forms, menus, lists, tips and methods of the project using it.
	 */
	async renameEntry(entry: ResEntry, newName: string): Promise<ResEntry | undefined> {
		const oldName = entry.resname;
		const project = entry.fileSet.project;
		const taken = project.resnames.get(newName);
		if (taken) {
			throw new Error(`"${newName}" already exists in ${taken[0].fileSet.name}`);
		}
		const edits = new Map<string, (text: string) => TextEdit[]>();
		for (const file of entry.fileSet.files.values()) {
			if (file.doc.units.some(u => u.key === oldName)) {
				edits.set(file.path, text => parseXliff(text).units.filter(u => u.key === oldName).flatMap(u => renameUnitEdits(u, newName)));
			}
		}
		for (const filePath of new Set(this.usagesOf(entry).map(u => u.path))) {
			edits.set(filePath, text => renameUsageEdits(filePath, text, oldName, newName));
		}
		await applyFileEdits(edits);
		return this.waitFor(() => this.project(project.root)?.resnames.get(newName)?.find(e => e.fileSet.id === entry.fileSet.id && e.platform === entry.platform));
	}

	/** Removes the resname (only this platform version for a variant) from every language file. */
	async deleteEntry(entry: ResEntry): Promise<void> {
		const edits = new Map<string, (text: string, doc: XliffDocument) => TextEdit[]>();
		for (const lang of entry.byLang.keys()) {
			const file = entry.fileSet.files.get(lang)!;
			edits.set(file.path, (text, doc) => [deleteUnitEdit(text, findUnit(doc, entry, file.path))]);
		}
		await applyXliffEdits(edits);
		await this.waitFor(() => this.resolveExact(refOf(entry)) ? undefined : true);
	}

	/** Like resolve, without falling back on another file or platform. */
	resolveExact(ref: UnitRef): ResEntry | undefined {
		return this.project(ref.projectRoot)?.resnames.get(ref.resname)?.find(e => e.fileSet.id === ref.fileSetId && e.platform === ref.platform);
	}

	/**
	 * Gives a resname a different text per platform: the existing trans-unit
	 * becomes the win version and a copy the mac version, in every language.
	 */
	async splitByPlatform(entry: ResEntry): Promise<ResEntry | undefined> {
		const platforms: [string, string] = ['win', 'mac'];
		const id = nextUnitId([...entry.fileSet.files.values()].map(f => f.doc), `${entry.resname}_${platforms[1]}`);
		const edits = new Map<string, (text: string, doc: XliffDocument) => TextEdit[]>();
		for (const lang of entry.byLang.keys()) {
			const file = entry.fileSet.files.get(lang)!;
			edits.set(file.path, (text, doc) => splitByPlatformEdits(text, doc, findUnit(doc, entry, file.path), platforms, id));
		}
		await applyXliffEdits(edits);
		return this.waitFor(() => this.project(entry.fileSet.project.root)?.resnames.get(entry.resname)?.find(e => e.fileSet.id === entry.fileSet.id && e.platform === platforms[1]));
	}

	/** Resolves once the index satisfies `probe`, e.g. after an edit is indexed. */
	waitFor<T>(probe: () => T | undefined, timeout = 3000): Promise<T | undefined> {
		const now = probe();
		if (now) {
			return Promise.resolve(now);
		}
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				subscription.dispose();
				resolve(undefined);
			}, timeout);
			const subscription = this.onDidChange(() => {
				const value = probe();
				if (value) {
					clearTimeout(timer);
					subscription.dispose();
					resolve(value);
				}
			});
		});
	}

	private project(root: string): XliffProject | undefined {
		return this.index.projects.find(p => p.root === root);
	}

	/**
	 * Adds a resname to every language file of `fileSet`. The other languages
	 * get the source text, marked as needing translation.
	 */
	async addUnit(fileSet: XliffFileSet, groupPath: string[], resname: string, source: string): Promise<ResEntry | undefined> {
		const project = fileSet.project;
		const existing = project.resnames.get(resname);
		if (existing) {
			throw new Error(`"${resname}" already exists in ${existing[0].fileSet.name}`);
		}
		const id = nextUnitId([...fileSet.files.values()].map(f => f.doc), resname);
		const edits = new Map<string, (text: string, doc: XliffDocument) => TextEdit[]>();
		for (const file of fileSet.files.values()) {
			const state = file.lang === project.sourceLanguage ? undefined : 'needs-translation';
			edits.set(file.path, (text, doc) => [insertUnitEdit(text, doc, groupPath, { resname, id, source, target: source, state })]);
		}
		await applyXliffEdits(edits);
		return this.waitFor(() => this.project(project.root)?.resnames.get(resname)?.find(e => e.fileSet.id === fileSet.id));
	}

	/** Adds an empty group to the language files of `fileSet` that do not have it. */
	async addGroup(fileSet: XliffFileSet, groupPath: string[]): Promise<void> {
		const files = [...fileSet.files.values()].filter(f => !hasGroup(f.doc, groupPath));
		if (!files.length) {
			throw new Error(`Group "${groupPath.join(' › ')}" already exists in ${fileSet.name}`);
		}
		await applyXliffEdits(new Map(files.map(f => [f.path, (text, doc) => hasGroup(doc, groupPath) ? [] : [insertGroupEdit(text, doc, groupPath)]])));
		await this.waitFor(() => this.project(fileSet.project.root)?.fileSets.find(s => s.id === fileSet.id && [...s.files.values()].every(f => hasGroup(f.doc, groupPath))));
	}

	/** Creates an empty XLIFF file in each language folder, named like the other files of the project. */
	async addFile(project: XliffProject, setName: string, languages = project.languages, sourceLanguage = project.sourceLanguage): Promise<XliffFileSet | undefined> {
		const sameName = (s: XliffFileSet) => s.name.toLowerCase() === setName.toLowerCase();
		if (project.fileSets.some(sameName)) {
			throw new Error(`${setName} already exists`);
		}
		const sample = project.fileSets[0]?.files.values().next().value?.text ?? '';
		const original = path.posix.basename(setName, path.posix.extname(setName));
		const files: [vscode.Uri, string][] = [];
		for (const lang of languages) {
			const uri = vscode.Uri.file(path.join(project.resourcesDir, `${lang}.lproj`, ...languageFileName(project, setName, lang).split('/')));
			if (await exists(uri)) {
				throw new Error(`${uri.fsPath} already exists`);
			}
			files.push([uri, newXliffFile({ original, sourceLanguage, targetLanguage: lang, indent: detectIndentUnit(sample), eol: detectEol(sample || '\n') })]);
		}
		await this.writeNewFiles(files);
		return this.waitFor(() => this.project(project.root)?.fileSets.find(sameName));
	}

	/**
	 * Adds a language: a <lang>.lproj folder with a copy of each file of the
	 * source language, every string marked as needing translation.
	 */
	async addLanguage(project: XliffProject, lang: string): Promise<void> {
		if (project.languages.some(l => l.toLowerCase() === lang.toLowerCase())) {
			throw new Error(`${lang} already exists`);
		}
		if (!project.fileSets.length) {
			throw new Error('The project has no XLIFF file to translate yet');
		}
		const files: [vscode.Uri, string][] = [];
		for (const fileSet of project.fileSets) {
			const reference = fileSet.files.get(project.sourceLanguage) ?? fileSet.files.get(fileSet.referenceLanguage)!;
			const uri = vscode.Uri.file(path.join(project.resourcesDir, `${lang}.lproj`, ...languageFileName(project, fileSet.name, lang).split('/')));
			if (await exists(uri)) {
				throw new Error(`${uri.fsPath} already exists`);
			}
			files.push([uri, newLanguageFile(reference.text, reference.doc, lang)]);
		}
		await this.writeNewFiles(files);
		await this.waitFor(() => this.project(project.root)?.languages.includes(lang) ? true : undefined);
	}

	private async writeNewFiles(files: [vscode.Uri, string][]): Promise<void> {
		for (const [uri, text] of files) {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
			await this.updateFile(uri, text);
		}
	}
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
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

function findUnit(doc: XliffDocument, entry: ResEntry, filePath: string): XliffUnit {
	const unit = doc.units.find(u => u.key === entry.resname && u.platform === entry.platform);
	if (!unit) {
		throw new Error(`"${entryLabel(entry)}" not found in ${filePath}`);
	}
	return unit;
}

type XliffEdits = Map<string, (text: string, doc: XliffDocument) => TextEdit[]>;

function applyXliffEdits(edits: XliffEdits): Promise<void> {
	return applyFileEdits(new Map([...edits].map(([filePath, compute]) => [filePath, (text: string) => compute(text, parseXliff(text))])));
}

/**
 * Applies edits computed on the current content of each file (open editors
 * included) as one operation, undone at once, then saves the files that had
 * no unsaved changes before.
 */
async function applyFileEdits(edits: Map<string, (text: string) => TextEdit[]>): Promise<void> {
	const workspaceEdit = new vscode.WorkspaceEdit();
	const toSave: vscode.TextDocument[] = [];
	for (const [filePath, compute] of edits) {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
		const text = document.getText();
		for (const e of compute(text)) {
			workspaceEdit.replace(document.uri, new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.newText);
		}
		if (!document.isDirty) {
			toSave.push(document);
		}
	}
	if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
		throw new Error('The files could not be modified');
	}
	await Promise.all(toSave.map(d => d.save()));
}

export function refOf(entry: ResEntry): UnitRef {
	return { projectRoot: entry.fileSet.project.root, fileSetId: entry.fileSet.id, resname: entry.resname, platform: entry.platform };
}

/** "Clipboard_1", or "Clipboard_1 (mac)" for a platform variant. */
export function entryLabel(entry: ResEntry): string {
	return entry.platform ? `${entry.resname} (${entry.platform})` : entry.resname;
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
