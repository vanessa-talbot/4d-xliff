// Groups the XLIFF files of a workspace into 4D projects and "file sets":
// Resources/en.lproj/Form1.xlf and Resources/fr.lproj/Form1.xlf are the
// same file set, Form1.xlf, available in two languages.

import * as path from 'path';
import { parseXliff, XliffDocument, XliffUnit } from './xliffParser';
import { lineStarts } from './text';

export interface SourceFile {
	path: string;
	text: string;
}

export interface LangFile {
	lang: string;
	path: string;
	/** Path relative to Resources, e.g. "fr.lproj/CommonFR.xlf". */
	label: string;
	text: string;
	doc: XliffDocument;
	lines: number[];
}

export interface ResEntry {
	resname: string;
	fileSet: XliffFileSet;
	groupPath: string[];
	byLang: Map<string, XliffUnit>;
}

export interface TreeGroup {
	name: string;
	path: string[];
	groups: TreeGroup[];
	entries: ResEntry[];
}

export interface XliffFileSet {
	/** Unique in the workspace: project root + relative name. */
	id: string;
	/** Path relative to the .lproj folder, without language suffix: "Common.xlf" for CommonFR.xlf. */
	name: string;
	project: XliffProject;
	files: Map<string, LangFile>;
	referenceLanguage: string;
	root: TreeGroup;
	entries: ResEntry[];
}

export interface XliffProject {
	root: string;
	name: string;
	resourcesDir: string;
	sourceLanguage: string;
	/** Source language first, then the others alphabetically. */
	languages: string[];
	fileSets: XliffFileSet[];
	resnames: Map<string, ResEntry[]>;
}

export interface XliffIndex {
	projects: XliffProject[];
}

export interface XliffLocation {
	root: string;
	resourcesDir: string;
	lang: string;
	/** Path relative to the .lproj folder, e.g. "CommonFR.xlf". */
	relName: string;
	/** relName without its language suffix, shared by all the languages: "Common.xlf". */
	setName: string;
}

/**
 * Removes the language code that some projects add to the file names:
 * CommonFR.xlf, Common_fr.xlf, Common-fr.xlf or Common.fr.xlf in fr.lproj.
 * Without separator the code must be uppercase, so that Messages.xlf in
 * es.lproj keeps its name.
 */
export function stripLanguageSuffix(relName: string, lang: string): string {
	const ext = path.posix.extname(relName);
	const stem = relName.slice(0, relName.length - ext.length);
	const keep = (length: number) => length > 0 && stem[length - 1] !== '/';
	for (const sep of ['_', '-', '.']) {
		const suffix = sep + lang.toLowerCase();
		if (stem.toLowerCase().endsWith(suffix) && keep(stem.length - suffix.length)) {
			return stem.slice(0, -suffix.length) + ext;
		}
	}
	const compact = lang.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
	if (compact && stem.endsWith(compact) && keep(stem.length - compact.length)) {
		return stem.slice(0, -compact.length) + ext;
	}
	return relName;
}

/** Recognizes <root>/Resources/<lang>.lproj/<relName>. */
export function locateXliff(filePath: string): XliffLocation | undefined {
	const rel = [path.basename(filePath)];
	let dir = path.dirname(filePath);
	while (dir !== path.dirname(dir)) {
		const base = path.basename(dir);
		if (base.toLowerCase().endsWith('.lproj')) {
			const resourcesDir = path.dirname(dir);
			if (path.basename(resourcesDir).toLowerCase() !== 'resources') {
				return undefined;
			}
			const lang = base.slice(0, -'.lproj'.length);
			const relName = rel.join('/');
			return { root: path.dirname(resourcesDir), resourcesDir, lang, relName, setName: stripLanguageSuffix(relName, lang) };
		}
		rel.unshift(base);
		dir = path.dirname(dir);
	}
	return undefined;
}

export interface IndexOptions {
	sourceLanguage?: string;
	/** Roots of 4D projects that may not have any XLIFF file yet. */
	projectRoots?: string[];
}

function mostCommon(values: (string | undefined)[]): string | undefined {
	const counts = new Map<string, number>();
	for (const v of values) {
		if (v) {
			counts.set(v, (counts.get(v) ?? 0) + 1);
		}
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function buildIndex(files: SourceFile[], options: IndexOptions = {}): XliffIndex {
	const byRoot = new Map<string, { resourcesDir: string; files: (SourceFile & XliffLocation & { doc: XliffDocument })[] }>();
	for (const root of options.projectRoots ?? []) {
		byRoot.set(root, { resourcesDir: path.join(root, 'Resources'), files: [] });
	}
	for (const file of files) {
		const loc = locateXliff(file.path);
		if (!loc) {
			continue;
		}
		let bucket = byRoot.get(loc.root);
		if (!bucket) {
			bucket = { resourcesDir: loc.resourcesDir, files: [] };
			byRoot.set(loc.root, bucket);
		}
		bucket.files.push({ ...file, ...loc, doc: parseXliff(file.text) });
	}

	const projects: XliffProject[] = [];
	for (const [root, bucket] of byRoot) {
		const langs = new Set(bucket.files.map(f => f.lang));
		let sourceLanguage = options.sourceLanguage || mostCommon(bucket.files.map(f => f.doc.sourceLanguage)) || '';
		if (!langs.has(sourceLanguage) && langs.size) {
			sourceLanguage = langs.has('en') ? 'en' : [...langs].sort()[0];
		}
		const others = [...langs].filter(l => l !== sourceLanguage).sort();
		const project: XliffProject = {
			root,
			name: path.basename(root),
			resourcesDir: bucket.resourcesDir,
			sourceLanguage: sourceLanguage || 'en',
			languages: langs.has(sourceLanguage) ? [sourceLanguage, ...others] : others,
			fileSets: [],
			resnames: new Map(),
		};

		const sets = new Map<string, XliffFileSet>();
		for (const f of bucket.files) {
			const key = f.setName.toLowerCase();
			let set = sets.get(key);
			if (!set) {
				set = {
					id: `${root}|${key}`,
					name: f.setName,
					project,
					files: new Map(),
					referenceLanguage: '',
					root: { name: '', path: [], groups: [], entries: [] },
					entries: [],
				};
				sets.set(key, set);
			}
			set.files.set(f.lang, { lang: f.lang, path: f.path, label: `${f.lang}.lproj/${f.relName}`, text: f.text, doc: f.doc, lines: lineStarts(f.text) });
		}

		for (const set of sets.values()) {
			const ordered = project.languages.filter(l => set.files.has(l));
			set.referenceLanguage = ordered[0];
			fillEntries(set, ordered);
			project.fileSets.push(set);
			for (const entry of set.entries) {
				const list = project.resnames.get(entry.resname) ?? [];
				list.push(entry);
				project.resnames.set(entry.resname, list);
			}
		}
		project.fileSets.sort((a, b) => a.name.localeCompare(b.name));
		projects.push(project);
	}
	projects.sort((a, b) => a.name.localeCompare(b.name));
	return { projects };
}

function fillEntries(set: XliffFileSet, languages: string[]): void {
	const groupsByPath = new Map<string, TreeGroup>([['', set.root]]);
	const ensureGroup = (groupPath: string[]): TreeGroup => {
		const key = groupPath.join('\u0000');
		let group = groupsByPath.get(key);
		if (!group) {
			const parent = ensureGroup(groupPath.slice(0, -1));
			group = { name: groupPath[groupPath.length - 1], path: groupPath, groups: [], entries: [] };
			parent.groups.push(group);
			groupsByPath.set(key, group);
		}
		return group;
	};

	const reference = set.files.get(set.referenceLanguage);
	if (reference) {
		for (const g of [...reference.doc.groups].sort((a, b) => a.span.start - b.span.start)) {
			ensureGroup(g.path);
		}
	}

	const entries = new Map<string, ResEntry>();
	for (const lang of languages) {
		for (const unit of set.files.get(lang)!.doc.units) {
			let entry = entries.get(unit.key);
			if (!entry) {
				entry = { resname: unit.key, fileSet: set, groupPath: unit.groupPath, byLang: new Map() };
				entries.set(unit.key, entry);
				set.entries.push(entry);
				ensureGroup(unit.groupPath).entries.push(entry);
			}
			if (!entry.byLang.has(lang)) {
				entry.byLang.set(lang, unit);
			}
		}
	}
}

export function projectForPath(index: XliffIndex, filePath: string): XliffProject | undefined {
	let best: XliffProject | undefined;
	for (const p of index.projects) {
		if ((filePath === p.root || filePath.startsWith(p.root + path.sep)) && (!best || p.root.length > best.root.length)) {
			best = p;
		}
	}
	return best;
}
