// Finds the places where a 4D project references a resname:
//   ":xliff:resname" in forms, menus, choice lists, help tips and code
//   Localized string("resname") in code

import * as path from 'path';
import { lineStarts } from './text';

export type UsageKind = 'form' | 'menu' | 'list' | 'tip' | 'method';

const JSON_KINDS: Record<string, UsageKind> = {
	'menus.json': 'menu',
	'lists.json': 'list',
	'tips.json': 'tip',
};

export interface Usage {
	resname: string;
	path: string;
	kind: UsageKind;
	/** Offset and length of the resname itself. */
	offset: number;
	length: number;
	line: number;
	character: number;
	/** Human readable location, e.g. "Form1 › Button · text". */
	context: string;
}

export interface ResnameRef {
	resname: string;
	start: number;
	end: number;
}

const XLIFF_RE = /:xliff:([^"'\s\\<>,;()]+)/g;
const LOCALIZED_RE = /\bLocalized string(?::C\d+)?\s*\(\s*"([^"\\]+)"/gi;

export function usageKind(filePath: string): UsageKind | undefined {
	const lower = filePath.toLowerCase();
	if (!/[\\/]project[\\/]sources[\\/]/.test(lower)) {
		return undefined;
	}
	if (lower.endsWith('.4dform')) {
		return 'form';
	}
	if (lower.endsWith('.4dm')) {
		return 'method';
	}
	return JSON_KINDS[path.basename(lower)];
}

/** Root of the 4D project owning a file of Project/Sources. */
export function projectRootOfSource(filePath: string): string | undefined {
	return /^(.*)[\\/]Project[\\/]Sources[\\/]/i.exec(filePath)?.[1];
}

/** All resname references of a line, with columns. */
export function findRefsInLine(line: string): ResnameRef[] {
	const refs: ResnameRef[] = [];
	for (const re of [XLIFF_RE, LOCALIZED_RE]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(line))) {
			const start = m.index + m[0].lastIndexOf(m[1]);
			refs.push({ resname: m[1], start, end: start + m[1].length });
		}
	}
	return refs.sort((a, b) => a.start - b.start);
}

export function refAt(line: string, character: number): ResnameRef | undefined {
	return findRefsInLine(line).find(r => character >= r.start && character <= r.end);
}

/** Text typed so far when completing a resname, if the cursor is in one. */
export function completionPrefix(lineBeforeCursor: string): string | undefined {
	const m = /(?::xliff:|Localized string(?::C\d+)?\s*\(\s*")([^"'\s\\<>,;()]*)$/i.exec(lineBeforeCursor);
	return m?.[1];
}

export function scanUsages(filePath: string, text: string): Usage[] {
	const kind = usageKind(filePath);
	if (!kind || (!text.includes(':xliff:') && !/Localized string/i.test(text))) {
		return [];
	}
	const starts = lineStarts(text);
	const lines = text.split('\n');
	const usages: Usage[] = [];
	lines.forEach((lineText, line) => {
		for (const ref of findRefsInLine(lineText)) {
			usages.push({
				resname: ref.resname,
				path: filePath,
				kind,
				offset: starts[line] + ref.start,
				length: ref.end - ref.start,
				line,
				character: ref.start,
				context: describe(filePath, kind, lines, line),
			});
		}
	});
	return usages;
}

function describe(filePath: string, kind: UsageKind, lines: string[], line: number): string {
	const property = /"([^"]+)"\s*:\s*"[^"]*:xliff:/.exec(lines[line])?.[1];
	if (kind === 'menu') {
		return property ? `Menus · ${property}` : 'Menus';
	}
	if (kind === 'list' || kind === 'tip') {
		// The top-level key is the list or tip name.
		const name = enclosingKeys(lines, line)[0];
		return [kind === 'list' ? 'Lists' : 'Tips', name].filter(Boolean).join(' › ');
	}
	if (kind === 'form') {
		const form = path.basename(path.dirname(filePath));
		return [[form, ...enclosingKeys(lines, line)].join(' › '), property].filter(Boolean).join(' · ');
	}
	const parts = filePath.split(/[\\/]/);
	const name = path.basename(filePath, path.extname(filePath));
	const formsAt = parts.lastIndexOf('Forms');
	if (formsAt >= 0 && parts[formsAt + 2] === 'ObjectMethods') {
		return `${parts[formsAt + 1]} › ${name} (object method)`;
	}
	if (formsAt >= 0 && name === 'method') {
		return `${parts[formsAt + 1]} (form method)`;
	}
	if (parts.includes('Classes')) {
		return `Class ${name}`;
	}
	return name;
}

/**
 * Keys of the JSON objects enclosing a line, below "objects" in a form:
 * ["Button"] for a button text, [] for the window title.
 * Relies on the indentation 4D uses when saving JSON files.
 */
function enclosingKeys(lines: string[], line: number): string[] {
	const indentOf = (s: string) => /^\s*/.exec(s)![0].length;
	let indent = indentOf(lines[line]);
	const keys: string[] = [];
	for (let k = line - 1; k >= 0 && indent > 0; k--) {
		if (!lines[k].trim() || indentOf(lines[k]) >= indent) {
			continue;
		}
		indent = indentOf(lines[k]);
		const m = /^\s*"([^"]+)"\s*:\s*[{[]/.exec(lines[k]);
		if (m) {
			if (m[1] === 'objects' || m[1] === 'pages') {
				break;
			}
			keys.unshift(m[1]);
		}
	}
	return keys;
}
