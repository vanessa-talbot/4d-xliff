// Problems view: unknown :xliff: references, missing translations and
// resnames defined twice.

import * as vscode from 'vscode';
import { entryReference, LangFile, unitKey } from './core/xliffIndex';
import { XliffUnit } from './core/xliffParser';
import { translationStatus } from './core/status';
import { entryLabel, positionIn, XliffModel } from './model';

const SOURCE = '4D XLIFF';

export class XliffDiagnostics implements vscode.Disposable {
	private readonly collection = vscode.languages.createDiagnosticCollection('4d-xliff');
	private readonly subscription: vscode.Disposable;

	constructor(private readonly model: XliffModel) {
		this.subscription = model.onDidChange(() => this.update());
	}

	dispose(): void {
		this.subscription.dispose();
		this.collection.dispose();
	}

	update(): void {
		this.collection.clear();
		if (!vscode.workspace.getConfiguration('4dXliff').get<boolean>('diagnostics.enabled', true)) {
			return;
		}
		const byFile = new Map<string, vscode.Diagnostic[]>();
		const add = (filePath: string, range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity, code: string) => {
			const diagnostic = new vscode.Diagnostic(range, message, severity);
			diagnostic.source = SOURCE;
			diagnostic.code = code;
			const list = byFile.get(filePath) ?? [];
			list.push(diagnostic);
			byFile.set(filePath, list);
		};
		const unitRange = (file: LangFile, unit: XliffUnit) => {
			const start = positionIn(file, unit.span.start);
			return new vscode.Range(start, start.translate(0, '<trans-unit'.length));
		};

		for (const project of this.model.index.projects) {
			for (const fileSet of project.fileSets) {
				const reference = fileSet.files.get(fileSet.referenceLanguage)!;
				for (const lang of project.languages.filter(l => !fileSet.files.has(l))) {
					const start = positionIn(reference, reference.doc.fileElement?.start ?? 0);
					add(reference.path, new vscode.Range(start, start), `No ${lang} translation: ${lang}.lproj has no ${fileSet.name}`, vscode.DiagnosticSeverity.Warning, 'missing-file');
				}

				for (const file of fileSet.files.values()) {
					const seen = new Set<string>();
					for (const unit of file.doc.units) {
						if (!unit.resname) {
							add(file.path, unitRange(file, unit), 'trans-unit without resname: 4D cannot reference it with :xliff:', vscode.DiagnosticSeverity.Warning, 'no-resname');
						} else if (/\s/.test(unit.resname)) {
							add(file.path, unitRange(file, unit), `Resname "${unit.resname}" contains a space: it cannot be used in a :xliff: reference, only with Localized string`, vscode.DiagnosticSeverity.Information, 'resname-space');
						}
						if (seen.has(unitKey(unit))) {
							add(file.path, unitRange(file, unit), `Duplicate resname "${unit.key}" in this file`, vscode.DiagnosticSeverity.Warning, 'duplicate');
						}
						seen.add(unitKey(unit));
					}
					for (const error of file.doc.errors) {
						add(file.path, new vscode.Range(0, 0, 0, 0), error, vscode.DiagnosticSeverity.Error, 'parse-error');
					}
				}

				for (const entry of fileSet.entries) {
					for (const lang of project.languages) {
						const status = translationStatus(entry, lang);
						const file = fileSet.files.get(lang);
						const unit = entry.byLang.get(lang);
						if (status === 'missingUnit') {
							const ref = entryReference(entry);
							const refFile = fileSet.files.get(ref.lang)!;
							add(refFile.path, unitRange(refFile, ref.unit), `"${entryLabel(entry)}" is missing in ${fileSet.files.get(lang)!.label}`, vscode.DiagnosticSeverity.Warning, 'missing-unit');
						} else if (file && unit && (status === 'missingTarget' || status === 'empty')) {
							add(file.path, unitRange(file, unit), `"${entryLabel(entry)}" has no ${lang} translation`, vscode.DiagnosticSeverity.Warning, 'missing-target');
						} else if (file && unit && status === 'needsTranslation') {
							add(file.path, unitRange(file, unit), `"${entryLabel(entry)}" needs a ${lang} translation (state="${unit.targetState}")`, vscode.DiagnosticSeverity.Information, 'needs-translation');
						}
					}
				}
			}

			for (const [resname, entries] of project.resnames) {
				for (const entry of entries) {
					// Platform variants of the same file are not duplicates.
					const others = [...new Set(entries.filter(e => e.fileSet !== entry.fileSet).map(e => e.fileSet.name))].join(', ');
					if (!others) {
						continue;
					}
					for (const [lang, unit] of entry.byLang) {
						const file = entry.fileSet.files.get(lang)!;
						add(file.path, unitRange(file, unit), `"${resname}" is also defined in ${others}`, vscode.DiagnosticSeverity.Warning, 'duplicate');
					}
				}
			}
		}

		for (const [filePath, usages] of this.model.usageFiles()) {
			for (const u of usages) {
				if (!this.model.isIgnored(u.resname) && !this.model.lookup(u.resname, filePath).length) {
					const start = new vscode.Position(u.line, u.character);
					const [suggestion] = this.model.suggestionsFor(u.resname, filePath);
					const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
					add(filePath, new vscode.Range(start, start.translate(0, u.length)), `Unknown resname "${u.resname}": it is not defined in the XLIFF files of this project.${hint}`, vscode.DiagnosticSeverity.Warning, 'unknown-resname');
				}
			}
		}

		for (const [filePath, diagnostics] of byFile) {
			this.collection.set(vscode.Uri.file(filePath), diagnostics);
		}
	}
}
