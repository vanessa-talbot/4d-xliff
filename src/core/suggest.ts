// "Did you mean …?" for unknown resnames: the existing resnames closest to a
// misspelled one (form1.windowTite → form1.windowTitle).

/** Edit distance, ignoring case, giving up past `limit`. */
function distance(a: string, b: string, limit: number): number {
	a = a.toLowerCase();
	b = b.toLowerCase();
	if (Math.abs(a.length - b.length) > limit) {
		return limit + 1;
	}
	let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
			rowMin = Math.min(rowMin, current[j]);
		}
		if (rowMin > limit) {
			return limit + 1;
		}
		previous = current;
	}
	return previous[b.length];
}

/**
 * Resnames close enough to `name` to be what was meant, the closest first:
 * a different case, or up to 1 to 3 letters off depending on the length.
 */
export function closestResnames(name: string, candidates: Iterable<string>, max = 3): string[] {
	const limit = Math.max(1, Math.min(3, Math.floor(name.length / 4)));
	const found: { candidate: string; score: number }[] = [];
	for (const candidate of candidates) {
		if (candidate === name) {
			continue;
		}
		const score = distance(name, candidate, limit);
		if (score <= limit) {
			// Same letters in another case first, then by distance.
			found.push({ candidate, score: score + (candidate.toLowerCase() === name.toLowerCase() ? 0 : 0.5) });
		}
	}
	return found
		.sort((x, y) => x.score - y.score || x.candidate.localeCompare(y.candidate))
		.slice(0, max)
		.map(x => x.candidate);
}
