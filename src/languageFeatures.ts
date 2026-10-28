// Links between the 4D sources and the XLIFF files:
// - in forms, menus and methods: hover, go to definition and completion of resnames
// - in XLIFF files: CodeLens and "Find All References" listing the usages

import * as vscode from 'vscode';
import { ResEntry } from './core/xliffIndex';
import { parseXliff } from './core/xliffParser';
import { displayText, STATUS_LABELS, translationStatus } from './core/status';
import { completionPrefix, refAt } from './core/usages';
import { entryLabel, refOf, unitLocation, usageLocation, XliffModel } from './model';
import { escapeMd } from './tree';

/** Files of a 4D project that can reference resnames. */
export const SOURCE_SELECTOR: vscode.DocumentSelector = [
	{ scheme: 'file', pattern: '**/Project/Sources/**/*.4dm' },
	{ scheme: 'file', pattern: '**/Project/Sources/**/*.4DForm' },
	{ scheme: 'file', pattern: '**/Project/Sources/{menus,lists,tips}.json' },
];

const XLIFF_SELECTOR: vscode.DocumentSelector = [
	{ scheme: 'file', pattern: '**/*.xlf' },
	{ scheme: 'file', pattern: '**/*.xliff' },
];

function didYouMean(suggestions: string[]): string {
	return suggestions.length ? `\n\nDid you mean ${suggestions.map(s => `\`${s}\``).join(', ')}? The quick fix (Cmd+. / Ctrl+.) replaces it.` : '';
}

function commandLink(title: string, command: string, args: unknown): string {
	return `[${title}](command:${command}?${encodeURIComponent(JSON.stringify([args]))})`;
}

function translationsMarkdown(entries: ResEntry[]): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.isTrusted = { enabledCommands: ['4dXliff.showUnit', '4dXliff.copyXliffRef', '4dXliff.revealInTree'] };
	for (const entry of entries) {
		md.appendMarkdown(`**${escapeMd(entryLabel(entry))}** — ${escapeMd([entry.fileSet.name, ...entry.groupPath].join(' › '))}\n\n`);
		md.appendMarkdown('| | |\n|---|---|\n');
		for (const lang of entry.fileSet.project.languages) {
			const status = translationStatus(entry, lang);
			const unit = entry.byLang.get(lang);
			const text = status === 'ok' || status === 'needsTranslation' ? escapeMd(unit?.target ?? unit?.source ?? '') : `⚠ _${STATUS_LABELS[status]}_`;
			md.appendMarkdown(`| \`${lang}\` | ${text.replace(/\r?\n/g, ' ')} |\n`);
		}
		md.appendMarkdown(`\n${commandLink('$(globe) Translations', '4dXliff.showUnit', refOf(entry))} · `
			+ `${commandLink('$(copy) Copy', '4dXliff.copyXliffRef', refOf(entry))} · `
			+ `${commandLink('$(list-tree) Reveal', '4dXliff.revealInTree', refOf(entry))}\n\n`);
	}
	md.supportThemeIcons = true;
	return md;
}

export function registerLanguageFeatures(model: XliffModel): vscode.Disposable[] {
	const refUnderCursor = (document: vscode.TextDocument, position: vscode.Position) => {
		const ref = refAt(document.lineAt(position.line).text, position.character);
		if (!ref) {
			return undefined;
		}
		const range = new vscode.Range(position.line, ref.start, position.line, ref.end);
		return { ref, range, entries: model.lookup(ref.resname, document.uri.fsPath) };
	};

	const codeLensEmitter = new vscode.EventEmitter<void>();

	return [
		codeLensEmitter,
		model.onDidChange(() => codeLensEmitter.fire()),

		vscode.languages.registerHoverProvider(SOURCE_SELECTOR, {
			provideHover(document, position) {
				const found = refUnderCursor(document, position);
				if (!found) {
					return undefined;
				}
				if (!found.entries.length) {
					const message = model.isIgnored(found.ref.resname)
						? `**${escapeMd(found.ref.resname)}**: resname provided by 4D`
						: `**${escapeMd(found.ref.resname)}**: not found in the XLIFF files of this project${didYouMean(model.suggestionsFor(found.ref.resname, document.uri.fsPath))}`;
					return new vscode.Hover(new vscode.MarkdownString(message), found.range);
				}
				return new vscode.Hover(translationsMarkdown(found.entries), found.range);
			},
		}),

		vscode.languages.registerDefinitionProvider(SOURCE_SELECTOR, {
			provideDefinition(document, position) {
				const found = refUnderCursor(document, position);
				return found?.entries.flatMap(entry =>
					entry.fileSet.project.languages.map(lang => unitLocation(entry, lang)).filter((l): l is vscode.Location => !!l));
			},
		}),

		vscode.languages.registerCompletionItemProvider(SOURCE_SELECTOR, {
			provideCompletionItems(document, position) {
				const before = document.lineAt(position.line).text.slice(0, position.character);
				const prefix = completionPrefix(before);
				if (prefix === undefined) {
					return undefined;
				}
				const project = model.projectFor(document.uri.fsPath);
				const entries = project ? project.fileSets.flatMap(s => s.entries) : model.allEntries();
				const range = new vscode.Range(position.translate(0, -prefix.length), position);
				// One item per resname, documenting all its platform variants.
				const byResname = new Map<string, ResEntry[]>();
				for (const entry of entries) {
					byResname.set(entry.resname, [...(byResname.get(entry.resname) ?? []), entry]);
				}
				return [...byResname.values()].map(variants => {
					const [entry] = variants;
					const item = new vscode.CompletionItem({ label: entry.resname, description: displayText(entry) }, vscode.CompletionItemKind.Text);
					item.range = range;
					item.detail = entry.fileSet.name;
					item.documentation = translationsMarkdown(variants);
					return item;
				});
			},
		}, ':', '"', '.'),

		vscode.languages.registerCodeLensProvider(XLIFF_SELECTOR, {
			onDidChangeCodeLenses: codeLensEmitter.event,
			provideCodeLenses(document) {
				const found = model.langFileAt(document.uri.fsPath);
				if (!found) {
					return [];
				}
				const doc = parseXliff(document.getText());
				return doc.units.flatMap(unit => {
					const entry = found.fileSet.entries.find(e => e.resname === unit.key && e.platform === unit.platform);
					if (!entry) {
						return [];
					}
					const position = document.positionAt(unit.span.start);
					const range = new vscode.Range(position, position);
					const usages = model.usagesOf(entry);
					return [
						new vscode.CodeLens(range, {
							title: usages.length === 1 ? '1 usage' : `${usages.length} usages`,
							command: usages.length ? 'editor.action.showReferences' : '',
							arguments: [document.uri, position, usages.map(usageLocation)],
						}),
						new vscode.CodeLens(range, { title: 'Translations', command: '4dXliff.showUnit', arguments: [refOf(entry)] }),
						new vscode.CodeLens(range, { title: `Copy :xliff:${entry.resname}`, command: '4dXliff.copyXliffRef', arguments: [refOf(entry)] }),
					];
				});
			},
		}),

		vscode.languages.registerReferenceProvider(XLIFF_SELECTOR, {
			provideReferences(document, position) {
				const found = model.langFileAt(document.uri.fsPath);
				const offset = document.offsetAt(position);
				const unit = parseXliff(document.getText()).units.find(u => offset >= u.span.start && offset <= u.span.end);
				const entry = unit && found?.fileSet.entries.find(e => e.resname === unit.key && e.platform === unit.platform);
				return entry ? model.usagesOf(entry).map(usageLocation) : undefined;
			},
		}),
	];
}
