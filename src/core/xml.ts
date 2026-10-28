const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
};

/** Decodes entities and CDATA sections of raw XML text content. */
export function decodeXml(raw: string): string {
	return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (match, cdata: string | undefined, entity: string | undefined) => {
		if (cdata !== undefined) {
			return cdata;
		}
		if (entity!.startsWith('#')) {
			const hex = entity![1] === 'x' || entity![1] === 'X';
			const code = parseInt(entity!.slice(hex ? 2 : 1), hex ? 16 : 10);
			return Number.isNaN(code) ? match : String.fromCodePoint(code);
		}
		return NAMED_ENTITIES[entity!] ?? match;
	});
}

export function encodeXmlText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function encodeXmlAttr(value: string): string {
	return encodeXmlText(value).replace(/"/g, '&quot;');
}
