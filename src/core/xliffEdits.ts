// Computes minimal text edits on an XLIFF file. Edits are offsets into the
// text that was parsed, so callers must parse the exact text they edit.

import { XliffDocument, XliffUnit } from './xliffParser';
import { detectEol, detectIndentUnit, lineIndentAt } from './text';
import { encodeXmlAttr, encodeXmlText } from './xml';

export interface TextEdit {
	start: number;
	end: number;
	newText: string;
}

/** Target states meaning "not translated yet" (XLIFF 1.2). */
export const PENDING_STATES = new Set([
	'new',
	'needs-translation',
	'needs-l10n',
	'needs-adaptation',
	'needs-review-translation',
	'needs-review-l10n',
	'needs-review-adaptation',
]);

export function setTargetEdits(text: string, unit: XliffUnit, value: string): TextEdit[] {
	const encoded = encodeXmlText(value);
	if (unit.targetInner) {
		const edits: TextEdit[] = [{ ...unit.targetInner, newText: encoded }];
		if (value !== '' && unit.targetState && unit.targetStateValue && PENDING_STATES.has(unit.targetState)) {
			edits.push({ ...unit.targetStateValue, newText: 'translated' });
		}
		return edits;
	}
	if (unit.targetElement) {
		return [{ ...unit.targetElement, newText: `<target>${encoded}</target>` }];
	}
	const anchor = unit.sourceElement;
	if (!anchor) {
		throw new Error(`trans-unit "${unit.key}" has no <source> element`);
	}
	const newText = `${detectEol(text)}${lineIndentAt(text, anchor.start)}<target>${encoded}</target>`;
	return [{ start: anchor.end, end: anchor.end, newText }];
}

export function setSourceEdits(unit: XliffUnit, value: string): TextEdit[] {
	const encoded = encodeXmlText(value);
	if (unit.sourceInner) {
		return [{ ...unit.sourceInner, newText: encoded }];
	}
	if (unit.sourceElement) {
		return [{ ...unit.sourceElement, newText: `<source>${encoded}</source>` }];
	}
	throw new Error(`trans-unit "${unit.key}" has no <source> element`);
}

export interface NewUnit {
	resname: string;
	id?: string;
	source: string;
	target: string;
	state?: string;
	platform?: string;
	platformAttr?: string;
}

/** A line to insert, `depth` levels below the content of its container. */
interface Line {
	depth: number;
	text: string;
}

function samePath(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((p, k) => p === b[k]);
}

export function hasGroup(doc: XliffDocument, groupPath: string[]): boolean {
	return doc.groups.some(g => samePath(g.path, groupPath));
}

/**
 * Closing tag before which content of `groupPath` goes: the deepest existing
 * group of the path, or </body>. `missing` are the groups still to create.
 */
function insertionPoint(doc: XliffDocument, groupPath: string[]): { closeStart: number; missing: string[] } {
	for (let n = groupPath.length; n > 0; n--) {
		const group = doc.groups.find(g => samePath(g.path, groupPath.slice(0, n)));
		if (group) {
			return { closeStart: group.closeTagStart, missing: groupPath.slice(n) };
		}
	}
	if (doc.bodyCloseStart === undefined) {
		throw new Error('No <body> element found');
	}
	return { closeStart: doc.bodyCloseStart, missing: groupPath };
}

function wrapInGroups(groups: string[], content: Line[]): Line[] {
	return [
		...groups.map((name, depth) => ({ depth, text: `<group resname="${encodeXmlAttr(name)}">` })),
		...content.map(l => ({ depth: l.depth + groups.length, text: l.text })),
		...groups.map((_, k) => ({ depth: groups.length - 1 - k, text: '</group>' })),
	];
}

/** Inserts lines at the end of the element closed at `closeStart`, following the file indentation. */
function insertBeforeClose(text: string, closeStart: number, lines: Line[]): TextEdit {
	const eol = detectEol(text);
	const step = detectIndentUnit(text);
	const closeIndent = lineIndentAt(text, closeStart);
	const block = lines.map(l => closeIndent + step.repeat(l.depth + 1) + l.text).join(eol);
	const lineStart = text.lastIndexOf('\n', closeStart - 1) + 1;
	if (/^[ \t]*$/.test(text.slice(lineStart, closeStart))) {
		return { start: lineStart, end: lineStart, newText: block + eol };
	}
	return { start: closeStart, end: closeStart, newText: eol + block + eol + closeIndent };
}

/**
 * Inserts a trans-unit at the end of the group `groupPath`, creating the
 * groups of the path that do not exist in this file.
 */
export function insertUnitEdit(text: string, doc: XliffDocument, groupPath: string[], unit: NewUnit): TextEdit {
	const { closeStart, missing } = insertionPoint(doc, groupPath);
	const state = unit.state ? ` state="${encodeXmlAttr(unit.state)}"` : '';
	const platform = unit.platform ? ` ${unit.platformAttr ?? 'd4:includeIf'}="${encodeXmlAttr(unit.platform)}"` : '';
	return insertBeforeClose(text, closeStart, wrapInGroups(missing, [
		{ depth: 0, text: `<trans-unit${platform} id="${encodeXmlAttr(unit.id ?? unit.resname)}" resname="${encodeXmlAttr(unit.resname)}">` },
		{ depth: 1, text: `<source>${encodeXmlText(unit.source)}</source>` },
		{ depth: 1, text: `<target${state}>${encodeXmlText(unit.target)}</target>` },
		{ depth: 0, text: '</trans-unit>' },
	]));
}

/** Inserts an empty group, and its missing parents, at the end of its parent group. */
export function insertGroupEdit(text: string, doc: XliffDocument, groupPath: string[]): TextEdit {
	if (hasGroup(doc, groupPath)) {
		throw new Error(`Group "${groupPath.join(' › ')}" already exists`);
	}
	const { closeStart, missing } = insertionPoint(doc, groupPath);
	return insertBeforeClose(text, closeStart, wrapInGroups(missing, []));
}

/**
 * id of a new trans-unit, following the style of the file: the next number
 * when all ids are numeric (4D components), the resname otherwise.
 */
export function nextUnitId(docs: XliffDocument[], resname: string): string {
	const ids = docs.flatMap(d => d.units.map(u => u.id)).filter((id): id is string => id !== undefined);
	if (ids.length && ids.every(id => /^\d+$/.test(id))) {
		return String(Math.max(...ids.map(Number)) + 1);
	}
	return resname;
}

/** Problem with a resname typed by the user, or undefined when it can be used. */
export function resnameProblem(resname: string): string | undefined {
	if (!resname) {
		return 'Enter a resname';
	}
	if (/\s/.test(resname)) {
		return 'Spaces cannot be used in a :xliff: reference';
	}
	const bad = /["'\\<>,;()&]/.exec(resname);
	return bad ? `"${bad[0]}" cannot be used in a :xliff: reference` : undefined;
}

export interface NewFileOptions {
	original: string;
	sourceLanguage: string;
	targetLanguage: string;
	indent?: string;
	eol?: string;
}

/** Content of an empty XLIFF 1.2 file, in the format 4D uses. */
export function newXliffFile({ original, sourceLanguage, targetLanguage, indent = '\t', eol = '\n' }: NewFileOptions): string {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<xliff xmlns="urn:oasis:names:tc:xliff:document:1.2" version="1.2">',
		`${indent}<file original="${encodeXmlAttr(original)}" source-language="${encodeXmlAttr(sourceLanguage)}" target-language="${encodeXmlAttr(targetLanguage)}" datatype="plaintext">`,
		`${indent.repeat(2)}<body>`,
		`${indent.repeat(2)}</body>`,
		`${indent}</file>`,
		'</xliff>',
		'',
	].join(eol);
}

/**
 * Renames a trans-unit. Its id follows when it is derived from the resname
 * (form1.ok, form1.ok_mac); numeric ids are kept.
 */
export function renameUnitEdits(unit: XliffUnit, newName: string): TextEdit[] {
	if (!unit.resname || !unit.resnameValue) {
		throw new Error(`trans-unit "${unit.key}" has no resname attribute`);
	}
	const edits: TextEdit[] = [{ ...unit.resnameValue, newText: encodeXmlAttr(newName) }];
	const { id, idValue, resname } = unit;
	if (id !== undefined && idValue && (id === resname || id.startsWith(`${resname}_`))) {
		edits.push({ ...idValue, newText: encodeXmlAttr(newName + id.slice(resname.length)) });
	}
	return edits;
}

/** Removes a trans-unit, with its whole lines when it is alone on them. */
export function deleteUnitEdit(text: string, unit: XliffUnit): TextEdit {
	const lineStart = text.lastIndexOf('\n', unit.span.start - 1) + 1;
	const newline = text.indexOf('\n', unit.span.end);
	const lineEnd = newline < 0 ? text.length : newline + 1;
	if (/^[ \t]*$/.test(text.slice(lineStart, unit.span.start)) && /^[ \t\r]*\n?$/.test(text.slice(unit.span.end, lineEnd))) {
		return { start: lineStart, end: lineEnd, newText: '' };
	}
	return { start: unit.span.start, end: unit.span.end, newText: '' };
}

export const D4_NAMESPACE = 'http://www.4d.com/d4-ns';

/** Declares the prefix of a 4D attribute (d4:includeIf) on <xliff> when the file does not. */
export function declarePrefixEdits(text: string, doc: XliffDocument, attr: string): TextEdit[] {
	const prefix = attr.includes(':') ? attr.slice(0, attr.indexOf(':')) : undefined;
	if (!prefix || doc.rootPrefixes.includes(prefix) || !doc.rootElement) {
		return [];
	}
	const end = doc.rootElement.end - 1;
	return [{ start: end, end, newText: ` xmlns:${prefix}="${D4_NAMESPACE}"` }];
}

/**
 * Makes a trans-unit specific to one platform (d4:includeIf="win") and adds
 * a copy of it for another platform (mac) right after, with the id `copyId`.
 */
export function splitByPlatformEdits(text: string, doc: XliffDocument, unit: XliffUnit, platforms: [string, string], copyId: string, attr = 'd4:includeIf'): TextEdit[] {
	if (unit.platform) {
		throw new Error(`"${unit.key}" is already specific to ${unit.platform}`);
	}
	const raw = text.slice(unit.span.start, unit.span.end);
	const tagName = '<trans-unit';
	const withPlatform = (platform: string) => ` ${attr}="${encodeXmlAttr(platform)}"`;
	const copy = tagName + withPlatform(platforms[1]) + raw.slice(tagName.length).replace(/^([^>]*?\sid=)(["'])[^"']*\2/, `$1"${encodeXmlAttr(copyId)}"`);
	const insertAt = unit.span.start + tagName.length;
	return [
		...declarePrefixEdits(text, doc, attr),
		{ start: insertAt, end: insertAt, newText: withPlatform(platforms[0]) },
		{ start: unit.span.end, end: unit.span.end, newText: detectEol(text) + lineIndentAt(text, unit.span.start) + copy },
	];
}

/**
 * Content of the file of a new language, made from the file of the source
 * language: same groups, ids and platform versions; each target gets the
 * source text marked as needing translation (translate="no" units are kept).
 */
export function newLanguageFile(text: string, doc: XliffDocument, lang: string): string {
	const edits: TextEdit[] = [];
	if (doc.targetLanguageValue) {
		edits.push({ ...doc.targetLanguageValue, newText: encodeXmlAttr(lang) });
	} else if (doc.fileElement) {
		const end = doc.fileElement.end - 1;
		edits.push({ start: end, end, newText: ` target-language="${encodeXmlAttr(lang)}"` });
	}
	for (const unit of doc.units) {
		if (!unit.translatable || !unit.sourceElement) {
			continue;
		}
		// Raw source content, so that entities and inline markup are kept as is.
		const source = unit.sourceInner ? text.slice(unit.sourceInner.start, unit.sourceInner.end) : '';
		const target = `<target state="needs-translation">${source}</target>`;
		if (unit.targetElement) {
			edits.push({ ...unit.targetElement, newText: target });
		} else {
			const end = unit.sourceElement.end;
			edits.push({ start: end, end, newText: detectEol(text) + lineIndentAt(text, unit.sourceElement.start) + target });
		}
	}
	return applyTextEdits(text, edits);
}

export function applyTextEdits(text: string, edits: TextEdit[]): string {
	const sorted = [...edits].sort((a, b) => b.start - a.start);
	for (const e of sorted) {
		text = text.slice(0, e.start) + e.newText + text.slice(e.end);
	}
	return text;
}
