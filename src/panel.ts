// Detail panel of one resname: references to copy, a translation per
// language (editable), and the forms, menus and methods that use it.

import * as path from 'path';
import * as vscode from 'vscode';
import { ResEntry } from './core/xliffIndex';
import { STATUS_LABELS, translationStatus } from './core/status';
import { refOf, UnitRef, unitLocation, usageLocation, XliffModel } from './model';

type PanelMessage =
	| { type: 'ready' }
	| { type: 'copy'; text: string }
	| { type: 'saveSource'; value: string }
	| { type: 'saveTarget'; lang: string; value: string }
	| { type: 'addToLanguage'; lang: string }
	| { type: 'openUnit'; lang: string }
	| { type: 'openUsage'; index: number }
	| { type: 'reveal' };

export class XliffDetailPanel implements vscode.Disposable {
	private static current: XliffDetailPanel | undefined;

	private readonly disposables: vscode.Disposable[] = [];

	static show(context: vscode.ExtensionContext, model: XliffModel, ref: UnitRef): void {
		if (XliffDetailPanel.current) {
			XliffDetailPanel.current.ref = ref;
			XliffDetailPanel.current.panel.reveal(undefined, true);
			XliffDetailPanel.current.render();
			return;
		}
		XliffDetailPanel.current = new XliffDetailPanel(context, model, ref);
	}

	private readonly panel: vscode.WebviewPanel;

	private constructor(context: vscode.ExtensionContext, private readonly model: XliffModel, private ref: UnitRef) {
		const media = vscode.Uri.joinPath(context.extensionUri, 'media');
		this.panel = vscode.window.createWebviewPanel('4dXliff.detail', ref.resname, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
			enableScripts: true,
			localResourceRoots: [media],
		});
		this.panel.iconPath = vscode.Uri.joinPath(media, 'xliff.svg');
		const webview = this.panel.webview;
		const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'))}">
</head>
<body>
<main id="app"></main>
<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'))}"></script>
</body>
</html>`;
		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			webview.onDidReceiveMessage((m: PanelMessage) => this.onMessage(m)),
			model.onDidChange(() => this.render()),
		);
	}

	dispose(): void {
		XliffDetailPanel.current = undefined;
		this.disposables.forEach(d => d.dispose());
	}

	private entry(): ResEntry | undefined {
		return this.model.resolve(this.ref);
	}

	private render(): void {
		const entry = this.entry();
		this.panel.title = this.ref.resname;
		this.panel.webview.postMessage({ type: 'render', data: entry ? this.viewData(entry) : { missing: this.ref.resname } });
	}

	private viewData(entry: ResEntry) {
		const project = entry.fileSet.project;
		const reference = entry.byLang.get(entry.fileSet.referenceLanguage);
		const others = this.model.lookup(entry.resname, project.root).filter(e => e !== entry);
		// Usual case: the source language translation is the source itself, shown
		// as a single row (setSource then updates both).
		const sourceUnit = entry.byLang.get(project.sourceLanguage);
		const mergedSource = !!sourceUnit && !sourceUnit.hasMarkup && (sourceUnit.target === undefined || sourceUnit.target === sourceUnit.source);
		return {
			resname: entry.resname,
			id: reference?.id,
			fileName: entry.fileSet.name,
			groupPath: entry.groupPath,
			project: this.model.index.projects.length > 1 ? project.name : undefined,
			xliffRef: `:xliff:${entry.resname}`,
			localizedRef: `Localized string("${entry.resname}")`,
			sourceLanguage: project.sourceLanguage,
			source: reference?.source ?? '',
			sourceReadOnly: [...entry.byLang.values()].some(u => u.hasMarkup),
			mergedSource,
			languages: project.languages.map(lang => {
				const unit = entry.byLang.get(lang);
				const status = translationStatus(entry, lang);
				return {
					lang,
					isSource: lang === project.sourceLanguage,
					status,
					statusLabel: STATUS_LABELS[status],
					text: unit?.target ?? '',
					readOnly: !unit || !!unit.hasMarkup,
					fileLabel: entry.fileSet.files.get(lang)?.label ?? `${lang}.lproj/${entry.fileSet.name}`,
				};
			}),
			usages: this.model.usagesOf(entry).map(u => ({
				kind: u.kind,
				context: u.context,
				where: `${path.relative(project.root, u.path)}:${u.line + 1}`,
			})),
			duplicates: others.map(e => e.fileSet.name),
		};
	}

	private async onMessage(message: PanelMessage): Promise<void> {
		if (message.type === 'ready') {
			return this.render();
		}
		if (message.type === 'copy') {
			await vscode.env.clipboard.writeText(message.text);
			vscode.window.setStatusBarMessage(`$(copy) Copied ${message.text}`, 2500);
			return;
		}
		const entry = this.entry();
		if (!entry) {
			return;
		}
		try {
			switch (message.type) {
				case 'saveSource':
					await this.model.setSource(entry, message.value);
					break;
				case 'saveTarget':
					await this.model.setTarget(entry, message.lang, message.value);
					break;
				case 'addToLanguage':
					await this.model.addToLanguage(entry, message.lang);
					break;
				case 'openUnit': {
					const location = unitLocation(entry, message.lang);
					if (location) {
						await vscode.window.showTextDocument(location.uri, { selection: location.range, viewColumn: vscode.ViewColumn.One });
					}
					break;
				}
				case 'openUsage': {
					const usage = this.model.usagesOf(entry)[message.index];
					if (usage) {
						const location = usageLocation(usage);
						await vscode.window.showTextDocument(location.uri, { selection: location.range, viewColumn: vscode.ViewColumn.One });
					}
					break;
				}
				case 'reveal':
					await vscode.commands.executeCommand('4dXliff.revealInTree', refOf(entry));
					break;
			}
		} catch (err) {
			vscode.window.showErrorMessage(`4D XLIFF: ${err instanceof Error ? err.message : String(err)}`);
			this.render();
		}
	}
}
