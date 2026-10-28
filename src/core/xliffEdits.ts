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
}

/**
 * Inserts a trans-unit at the end of the deepest existing group of `groupPath`,
 * or at the end of <body>.
 */
export function insertUnitEdit(text: string, doc: XliffDocument, groupPath: string[], unit: NewUnit): TextEdit {
	let closeStart: number | undefined;
	for (let n = groupPath.length; n > 0 && closeStart === undefined; n--) {
		const prefix = groupPath.slice(0, n);
		closeStart = doc.groups.find(g => g.path.length === n && g.path.every((p, k) => p === prefix[k]))?.closeTagStart;
	}
	closeStart ??= doc.bodyCloseStart;
	if (closeStart === undefined) {
		throw new Error('No <body> element found');
	}
	const eol = detectEol(text);
	const step = detectIndentUnit(text);
	const closeIndent = lineIndentAt(text, closeStart);
	const unitIndent = closeIndent + step;
	const childIndent = unitIndent + step;
	const state = unit.state ? ` state="${encodeXmlAttr(unit.state)}"` : '';
	const block = [
		`${unitIndent}<trans-unit id="${encodeXmlAttr(unit.id ?? unit.resname)}" resname="${encodeXmlAttr(unit.resname)}">`,
		`${childIndent}<source>${encodeXmlText(unit.source)}</source>`,
		`${childIndent}<target${state}>${encodeXmlText(unit.target)}</target>`,
		`${unitIndent}</trans-unit>`,
	].join(eol);

	const lineStart = text.lastIndexOf('\n', closeStart - 1) + 1;
	if (/^[ \t]*$/.test(text.slice(lineStart, closeStart))) {
		return { start: lineStart, end: lineStart, newText: block + eol };
	}
	return { start: closeStart, end: closeStart, newText: eol + block + eol + closeIndent };
}

export function applyTextEdits(text: string, edits: TextEdit[]): string {
	const sorted = [...edits].sort((a, b) => b.start - a.start);
	for (const e of sorted) {
		text = text.slice(0, e.start) + e.newText + text.slice(e.end);
	}
	return text;
}
