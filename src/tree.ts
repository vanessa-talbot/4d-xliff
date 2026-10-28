// "XLIFF files" view: project › file › group › resname.

import * as vscode from 'vscode';
import { ResEntry, TreeGroup, XliffFileSet, XliffProject } from './core/xliffIndex';
import { displayText, isTranslated, STATUS_LABELS, translationStatus } from './core/status';
import { refOf, XliffModel } from './model';

export type XliffNode =
	| { kind: 'project'; project: XliffProject; parent?: XliffNode; children: XliffNode[] }
	| { kind: 'file'; fileSet: XliffFileSet; parent?: XliffNode; children: XliffNode[] }
	| { kind: 'group'; group: TreeGroup; fileSet: XliffFileSet; parent?: XliffNode; children: XliffNode[] }
	| { kind: 'unit'; entry: ResEntry; parent?: XliffNode; children: XliffNode[] };

export class XliffTreeProvider implements vscode.TreeDataProvider<XliffNode> {
	private roots: XliffNode[] = [];
	private readonly unitNodes = new Map<ResEntry, XliffNode>();
	private filter = '';
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly model: XliffModel) {
		model.onDidChange(() => this.rebuild());
		this.rebuild();
	}

	get filterText(): string {
		return this.filter;
	}

	setFilter(value: string): void {
		this.filter = value.trim();
		vscode.commands.executeCommand('setContext', '4dXliff.filterActive', this.filter !== '');
		this.rebuild();
	}

	nodeFor(entry: ResEntry): XliffNode | undefined {
		return this.unitNodes.get(entry);
	}

	getChildren(node?: XliffNode): XliffNode[] {
		return node ? node.children : this.roots;
	}

	getParent(node: XliffNode): XliffNode | undefined {
		return node.parent;
	}

	getTreeItem(node: XliffNode): vscode.TreeItem {
		const expanded = this.filter ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
		switch (node.kind) {
			case 'project': {
				const item = new vscode.TreeItem(node.project.name, vscode.TreeItemCollapsibleState.Expanded);
				item.id = `project:${node.project.root}`;
				item.iconPath = new vscode.ThemeIcon('project');
				item.description = node.project.languages.join(' · ') || 'no XLIFF file';
				item.tooltip = node.project.root;
				return item;
			}
			case 'file': {
				const { fileSet } = node;
				const item = new vscode.TreeItem(fileSet.name, expanded);
				item.id = `file:${fileSet.id}`;
				item.iconPath = new vscode.ThemeIcon('file-code');
				const missing = fileSet.entries.filter(e => !isComplete(e)).length;
				item.description = fileSet.project.languages.filter(l => fileSet.files.has(l)).join(' · ') + (missing ? `  ⚠ ${missing}` : '');
				item.tooltip = [...fileSet.files.values()].map(f => `${f.lang}: ${f.path}`).join('\n');
				item.contextValue = 'xliffFile';
				return item;
			}
			case 'group': {
				const item = new vscode.TreeItem(node.group.name, expanded);
				item.id = `group:${node.fileSet.id}|${node.group.path.join('\u0000')}`;
				item.iconPath = new vscode.ThemeIcon('symbol-namespace');
				item.description = `${node.group.entries.length}`;
				item.contextValue = 'xliffGroup';
				return item;
			}
			case 'unit': {
				const { entry } = node;
				const item = new vscode.TreeItem(entry.resname, vscode.TreeItemCollapsibleState.None);
				item.id = `unit:${entry.fileSet.id}|${entry.resname}`;
				item.description = displayText(entry);
				item.iconPath = isComplete(entry)
					? new vscode.ThemeIcon('symbol-string')
					: new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
				item.tooltip = unitTooltip(entry);
				item.contextValue = 'xliffUnit';
				item.command = { command: '4dXliff.showUnit', title: 'Show Translations', arguments: [refOf(entry)] };
				return item;
			}
		}
	}

	private rebuild(): void {
		this.unitNodes.clear();
		const needle = this.filter.toLowerCase();
		const matches = (e: ResEntry) => !needle || e.resname.toLowerCase().includes(needle)
			|| [...e.byLang.values()].some(u => (u.target ?? '').toLowerCase().includes(needle) || (u.source ?? '').toLowerCase().includes(needle));

		const groupChildren = (group: TreeGroup, fileSet: XliffFileSet, parent: XliffNode): XliffNode[] => {
			const nodes: XliffNode[] = [];
			for (const sub of group.groups) {
				const node: XliffNode = { kind: 'group', group: sub, fileSet, parent, children: [] };
				node.children = groupChildren(sub, fileSet, node);
				if (node.children.length || !needle) {
					nodes.push(node);
				}
			}
			for (const entry of group.entries.filter(matches)) {
				const node: XliffNode = { kind: 'unit', entry, parent, children: [] };
				this.unitNodes.set(entry, node);
				nodes.push(node);
			}
			return nodes;
		};

		const fileNodes = (project: XliffProject, parent?: XliffNode): XliffNode[] => project.fileSets.flatMap(fileSet => {
			const node: XliffNode = { kind: 'file', fileSet, parent, children: [] };
			node.children = groupChildren(fileSet.root, fileSet, node);
			return node.children.length || !needle ? [node] : [];
		});

		const projects = this.model.index.projects;
		if (projects.length === 1) {
			this.roots = fileNodes(projects[0]);
		} else {
			this.roots = projects.map(project => {
				const node: XliffNode = { kind: 'project', project, children: [] };
				node.children = fileNodes(project, node);
				return node;
			});
		}
		this.emitter.fire();
	}
}

function isComplete(entry: ResEntry): boolean {
	return entry.fileSet.project.languages.every(lang => isTranslated(translationStatus(entry, lang)));
}

function unitTooltip(entry: ResEntry): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.appendMarkdown(`**:xliff:${escapeMd(entry.resname)}**\n\n`);
	for (const lang of entry.fileSet.project.languages) {
		const status = translationStatus(entry, lang);
		const unit = entry.byLang.get(lang);
		const text = status === 'ok' || status === 'needsTranslation' ? unit?.target ?? unit?.source ?? '' : `_${STATUS_LABELS[status]}_`;
		md.appendMarkdown(`- \`${lang}\` ${escapeMd(text)}${status === 'needsTranslation' ? ' _(needs translation)_' : ''}\n`);
	}
	return md;
}

export function escapeMd(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
