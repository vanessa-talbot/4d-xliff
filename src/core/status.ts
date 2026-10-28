import { ResEntry } from './xliffIndex';
import { PENDING_STATES } from './xliffEdits';

export type TranslationStatus =
	| 'ok'
	| 'missingFile'
	| 'missingUnit'
	| 'missingTarget'
	| 'empty'
	| 'needsTranslation';

export function translationStatus(entry: ResEntry, lang: string): TranslationStatus {
	if (!entry.fileSet.files.has(lang)) {
		return 'missingFile';
	}
	const unit = entry.byLang.get(lang);
	if (!unit) {
		return 'missingUnit';
	}
	if (!unit.translatable) {
		return 'ok';
	}
	const isSource = lang === entry.fileSet.project.sourceLanguage;
	if (unit.target === undefined) {
		// 4D falls back on <source>, which is fine for the source language.
		return isSource ? 'ok' : 'missingTarget';
	}
	if (unit.target.trim() === '' && (unit.source ?? '').trim() !== '') {
		return 'empty';
	}
	if (unit.targetState && PENDING_STATES.has(unit.targetState)) {
		return 'needsTranslation';
	}
	return 'ok';
}

export function isTranslated(status: TranslationStatus): boolean {
	return status === 'ok';
}

/** Text shown for an entry: the source language translation, or the source. */
export function displayText(entry: ResEntry): string {
	const lang = entry.fileSet.project.sourceLanguage;
	const unit = entry.byLang.get(lang) ?? entry.byLang.get(entry.fileSet.referenceLanguage);
	return unit?.target || unit?.source || '';
}

export const STATUS_LABELS: Record<TranslationStatus, string> = {
	ok: 'Translated',
	missingFile: 'No file for this language',
	missingUnit: 'Missing in this language',
	missingTarget: 'No <target>',
	empty: 'Empty translation',
	needsTranslation: 'Needs translation',
};
