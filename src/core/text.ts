// Small text helpers shared by the parser, the editor and the scanners.

export interface LineCol {
	line: number;
	character: number;
}

export function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			starts.push(i + 1);
		}
	}
	return starts;
}

export function offsetToLineCol(starts: number[], offset: number): LineCol {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= offset) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return { line: lo, character: offset - starts[lo] };
}

/** Leading whitespace of the line containing `offset`. */
export function lineIndentAt(text: string, offset: number): string {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	return /^[ \t]*/.exec(text.slice(lineStart, offset))![0];
}

export function detectEol(text: string): string {
	return text.includes('\r\n') ? '\r\n' : '\n';
}

/** One level of indentation, guessed from the first indented element. */
export function detectIndentUnit(text: string): string {
	const m = /\n([ \t]+)</.exec(text);
	if (!m || m[1].startsWith('\t')) {
		return '\t';
	}
	return m[1].length >= 4 ? '    ' : '  ';
}
