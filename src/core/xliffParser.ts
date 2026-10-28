// Tolerant XLIFF 1.2 reader. It does not build a DOM: it records the offsets
// of every element we care about so that edits can be applied in place,
// leaving the rest of the file (indentation, comments, attributes) untouched.

import { decodeXml } from './xml';

export interface Span {
	start: number;
	end: number;
}

export interface XliffUnit {
	id?: string;
	resname?: string;
	/** Name used by 4D (resname, or id when resname is missing). */
	key: string;
	/**
	 * Platform of a 4D variant (d4:includeIf="mac" or "win"): the same
	 * resname can then be defined once per platform.
	 */
	platform?: string;
	/** Name of the attribute holding the platform, e.g. "d4:includeIf". */
	platformAttr?: string;
	source?: string;
	target?: string;
	targetState?: string;
	/** Whole <trans-unit>…</trans-unit>. */
	span: Span;
	sourceElement?: Span;
	sourceInner?: Span;
	targetElement?: Span;
	targetInner?: Span;
	targetStateValue?: Span;
	/** Values of the resname and id attributes, to rename them. */
	resnameValue?: Span;
	idValue?: Span;
	groupPath: string[];
	/** false when translate="no" is set on the unit or one of its groups. */
	translatable: boolean;
	/** Source or target contains inline elements (<g>, <x/>, …). */
	hasMarkup: boolean;
}

export interface XliffGroup {
	name: string;
	resname?: string;
	id?: string;
	path: string[];
	translatable: boolean;
	span: Span;
	closeTagStart: number;
}

export interface XliffDocument {
	original?: string;
	sourceLanguage?: string;
	targetLanguage?: string;
	targetLanguageValue?: Span;
	/** Start tag of the root <xliff> element. */
	rootElement?: Span;
	/** Namespace prefixes declared on the root element, e.g. "d4". */
	rootPrefixes: string[];
	fileElement?: Span;
	units: XliffUnit[];
	groups: XliffGroup[];
	bodyCloseStart?: number;
	errors: string[];
}

interface Attr {
	value: string;
	valueSpan: Span;
}

interface Tag {
	local: string;
	closing: boolean;
	selfClosing: boolean;
	attrs: Map<string, Attr>;
}

function findTagEnd(text: string, from: number): number {
	let quote: string | undefined;
	for (let k = from; k < text.length; k++) {
		const c = text[k];
		if (quote) {
			if (c === quote) {
				quote = undefined;
			}
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === '>') {
			return k;
		}
	}
	return -1;
}

function parseTag(text: string, lt: number, gt: number): Tag {
	const body = text.slice(lt + 1, gt);
	const closing = body.startsWith('/');
	const selfClosing = !closing && body.endsWith('/');
	const nameMatch = /^\/?\s*([^\s/>]+)/.exec(body);
	const name = nameMatch ? nameMatch[1] : '';
	const attrs = new Map<string, Attr>();
	const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	re.lastIndex = nameMatch ? nameMatch[0].length : 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body))) {
		const raw = m[2] ?? m[3] ?? '';
		const valueEnd = lt + 1 + m.index + m[0].length - 1;
		attrs.set(m[1], { value: decodeXml(raw), valueSpan: { start: valueEnd - raw.length, end: valueEnd } });
	}
	return { local: name.slice(name.indexOf(':') + 1), closing, selfClosing, attrs };
}

function skipTo(text: string, from: number, marker: string): number {
	const end = text.indexOf(marker, from);
	return end < 0 ? text.length : end + marker.length;
}

export function parseXliff(text: string): XliffDocument {
	const doc: XliffDocument = { units: [], groups: [], rootPrefixes: [], errors: [] };
	const groupStack: XliffGroup[] = [];
	let fileCount = 0;
	let unit: XliffUnit | undefined;
	let altDepth = 0;
	let inner: { name: 'source' | 'target'; elementStart: number; contentStart: number; depth: number } | undefined;

	let i = 0;
	for (;;) {
		const lt = text.indexOf('<', i);
		if (lt < 0) {
			break;
		}
		if (text.startsWith('<!--', lt)) {
			i = skipTo(text, lt + 4, '-->');
			continue;
		}
		if (text.startsWith('<![CDATA[', lt)) {
			i = skipTo(text, lt + 9, ']]>');
			continue;
		}
		if (text.startsWith('<?', lt)) {
			i = skipTo(text, lt + 2, '?>');
			continue;
		}
		if (text.startsWith('<!', lt)) {
			i = skipTo(text, lt + 2, '>');
			continue;
		}
		const gt = findTagEnd(text, lt + 1);
		if (gt < 0) {
			doc.errors.push(`Unterminated tag at offset ${lt}`);
			break;
		}
		i = gt + 1;
		const tag = parseTag(text, lt, gt);

		if (inner && unit) {
			if (tag.local !== inner.name) {
				unit.hasMarkup = true;
			} else if (!tag.closing) {
				if (!tag.selfClosing) {
					inner.depth++;
				}
			} else if (inner.depth > 0) {
				inner.depth--;
			} else {
				const innerSpan = { start: inner.contentStart, end: lt };
				const value = decodeXml(text.slice(innerSpan.start, innerSpan.end));
				const element = { start: inner.elementStart, end: gt + 1 };
				if (inner.name === 'source') {
					unit.source = value;
					unit.sourceInner = innerSpan;
					unit.sourceElement = element;
				} else {
					unit.target = value;
					unit.targetInner = innerSpan;
					unit.targetElement = element;
				}
				inner = undefined;
			}
			continue;
		}

		switch (tag.local) {
			case 'xliff':
				if (!tag.closing && !doc.rootElement) {
					doc.rootElement = { start: lt, end: gt + 1 };
					doc.rootPrefixes = [...tag.attrs.keys()].filter(name => name.startsWith('xmlns:')).map(name => name.slice('xmlns:'.length));
				}
				break;
			case 'file':
				if (!tag.closing && fileCount++ === 0) {
					doc.original = tag.attrs.get('original')?.value;
					doc.sourceLanguage = tag.attrs.get('source-language')?.value;
					doc.targetLanguage = tag.attrs.get('target-language')?.value;
					doc.targetLanguageValue = tag.attrs.get('target-language')?.valueSpan;
					doc.fileElement = { start: lt, end: gt + 1 };
				}
				break;
			case 'body':
				if (tag.closing && doc.bodyCloseStart === undefined) {
					doc.bodyCloseStart = lt;
				}
				break;
			case 'group':
				if (tag.closing) {
					const group = groupStack.pop();
					if (group) {
						group.span.end = gt + 1;
						group.closeTagStart = lt;
						doc.groups.push(group);
					}
				} else if (!tag.selfClosing) {
					const resname = tag.attrs.get('resname')?.value;
					const id = tag.attrs.get('id')?.value;
					const name = resname ?? id ?? '(group)';
					const parent = groupStack[groupStack.length - 1];
					const translate = tag.attrs.get('translate')?.value;
					groupStack.push({
						name,
						resname,
						id,
						path: [...(parent?.path ?? []), name],
						translatable: translate ? translate !== 'no' : parent?.translatable ?? true,
						span: { start: lt, end: -1 },
						closeTagStart: -1,
					});
				}
				break;
			case 'trans-unit':
				if (tag.closing) {
					if (unit) {
						unit.span.end = gt + 1;
						doc.units.push(unit);
						unit = undefined;
					}
				} else {
					const resname = tag.attrs.get('resname')?.value;
					const id = tag.attrs.get('id')?.value;
					const group = groupStack[groupStack.length - 1];
					const translate = tag.attrs.get('translate')?.value;
					const includeIf = [...tag.attrs].find(([name]) => name === 'includeIf' || name.endsWith(':includeIf'));
					unit = {
						id,
						resname,
						resnameValue: tag.attrs.get('resname')?.valueSpan,
						idValue: tag.attrs.get('id')?.valueSpan,
						key: resname ?? id ?? '',
						platform: includeIf?.[1].value,
						platformAttr: includeIf?.[0],
						span: { start: lt, end: gt + 1 },
						groupPath: group?.path ?? [],
						translatable: translate ? translate !== 'no' : group?.translatable ?? true,
						hasMarkup: false,
					};
					altDepth = 0;
					if (tag.selfClosing) {
						doc.units.push(unit);
						unit = undefined;
					}
				}
				break;
			case 'alt-trans':
				if (!tag.selfClosing) {
					altDepth += tag.closing ? -1 : 1;
				}
				break;
			case 'source':
			case 'target':
				if (!unit || altDepth > 0 || tag.closing) {
					break;
				}
				if (tag.local === 'target') {
					const state = tag.attrs.get('state');
					unit.targetState = state?.value;
					unit.targetStateValue = state?.valueSpan;
				}
				if (tag.selfClosing) {
					const element = { start: lt, end: gt + 1 };
					if (tag.local === 'source') {
						unit.source = '';
						unit.sourceElement = element;
					} else {
						unit.target = '';
						unit.targetElement = element;
					}
				} else {
					inner = { name: tag.local, elementStart: lt, contentStart: gt + 1, depth: 0 };
				}
				break;
		}
	}
	if (groupStack.length) {
		doc.errors.push('Unclosed <group> element');
	}
	return doc;
}
