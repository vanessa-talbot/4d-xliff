// Runs inside VS Code (see scripts/integration.sh) on a copy of the test project.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { XliffModel } from '../../model';
import type { XliffTreeProvider } from '../../tree';

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, what: string, timeout = 5000): Promise<T> {
	const end = Date.now() + timeout;
	for (;;) {
		const value = await probe();
		if (value) {
			return value;
		}
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

function positionOf(document: vscode.TextDocument, needle: string): vscode.Position {
	const offset = document.getText().indexOf(needle);
	assert.ok(offset >= 0, `${needle} not found`);
	return document.positionAt(offset + 1);
}

export async function run(): Promise<void> {
	const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
	const extension = vscode.extensions.all.find(e => e.packageJSON.name === '4d-xliff')!;
	const { model, tree } = (await extension.activate()) as { model: XliffModel; tree: XliffTreeProvider };
	const check = async (name: string, body: () => Promise<void>) => {
		console.log(`start - ${name}`);
		await body();
		console.log(`ok - ${name}`);
	};

	await check('index', async () => {
		assert.deepEqual(model.index.projects.map(p => p.languages), [['en', 'fr']]);
		assert.equal(model.allEntries().length, 10);
	});

	const formUri = vscode.Uri.file(path.join(root, 'Project/Sources/Forms/Form1/form.4DForm'));
	const form = await vscode.workspace.openTextDocument(formUri);

	await check('hover on :xliff: in a form', async () => {
		const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', formUri, positionOf(form, 'form1.cancel'));
		const text = hovers.flatMap(h => h.contents.map(c => (c as vscode.MarkdownString).value)).join('\n');
		assert.ok(text.includes('Annuler'), text);
	});

	await check('go to definition in en and fr', async () => {
		const defs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', formUri, positionOf(form, 'form1.cancel'));
		assert.deepEqual(defs.map(d => path.basename(path.dirname(d.uri.fsPath))).sort(), ['en.lproj', 'fr.lproj']);
	});

	await check('completion after :xliff:', async () => {
		const position = positionOf(form, 'form1.ok').translate(0, 'form1.'.length - 1);
		const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', formUri, position, '.');
		const labels = list.items.map(i => (typeof i.label === 'string' ? i.label : i.label.label));
		assert.ok(labels.includes('form1.cancel') && labels.includes('menu.window'), labels.join(','));
	});

	const frForm1 = vscode.Uri.file(path.join(root, 'Resources/fr.lproj/Form1.xlf'));
	await check('CodeLens with usage counts in the XLIFF file', async () => {
		await vscode.workspace.openTextDocument(frForm1);
		const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', frForm1);
		const counts = lenses.map(l => /^(\d+) usages?$/.exec(l.command?.title ?? '')?.[1]).filter(Boolean).map(Number);
		assert.equal(counts.length, 7);
		assert.ok(counts.every(n => n >= 1), counts.join(','));
	});

	await check('only the deliberate unknown resname is reported (Common* resnames ignored)', async () => {
		const problems = vscode.languages.getDiagnostics().filter(([, d]) => d.length);
		assert.deepEqual(problems.map(([uri, d]) => `${path.relative(root, uri.fsPath)}: ${d.map(x => x.code).join('; ')}`), [
			'Project/Sources/Methods/test_command.4dm: unknown-resname',
		]);
	});

	await check('edit a translation in place', async () => {
		const before = fs.readFileSync(frForm1.fsPath, 'utf8');
		const entry = model.lookup('form1.cancel', root)[0];
		await model.setTarget(entry, 'fr', 'Annuler & fermer');
		const after = fs.readFileSync(frForm1.fsPath, 'utf8');
		assert.equal(after, before.replace('<target>Annuler</target>', '<target>Annuler &amp; fermer</target>'));
		await until(() => model.lookup('form1.cancel', root)[0]?.byLang.get('fr')?.target === 'Annuler & fermer', 'index update');
	});

	const enForm1 = path.join(root, 'Resources/en.lproj/Form1.xlf');
	await check('missing translation is reported, then added', async () => {
		const text = fs.readFileSync(enForm1, 'utf8');
		fs.writeFileSync(enForm1, text.replace('\t\t\t</group>', '\t\t\t\t<trans-unit id="form1.email" resname="form1.email">\n\t\t\t\t\t<source>Email</source>\n\t\t\t\t\t<target>Email</target>\n\t\t\t\t</trans-unit>\n\t\t\t</group>'));
		const entry = await until(() => model.lookup('form1.email', root)[0], 'new resname');
		await until(() => vscode.languages.getDiagnostics(vscode.Uri.file(enForm1)).some(d => d.code === 'missing-unit'), 'missing-unit diagnostic');
		await model.addToLanguage(entry, 'fr');
		const fr = fs.readFileSync(frForm1.fsPath, 'utf8');
		assert.ok(fr.includes('\t\t\t\t<trans-unit id="form1.email" resname="form1.email">\n\t\t\t\t\t<source>Email</source>\n\t\t\t\t\t<target state="needs-translation">Email</target>\n\t\t\t\t</trans-unit>\n\t\t\t</group>'), fr);
		await until(() => vscode.languages.getDiagnostics(frForm1).some(d => d.code === 'needs-translation'), 'needs-translation diagnostic');
		await model.setTarget(await until(() => model.lookup('form1.email', root)[0], 'entry'), 'fr', 'E-mail');
		assert.ok(fs.readFileSync(frForm1.fsPath, 'utf8').includes('<target state="translated">E-mail</target>'));
	});

	await check('unknown resname in code is reported', async () => {
		const method = path.join(root, 'Project/Sources/Methods/demo.4dm');
		fs.writeFileSync(method, '$t:=Localized string("does.not.exist")\n');
		await until(() => vscode.languages.getDiagnostics(vscode.Uri.file(method)).some(d => d.code === 'unknown-resname'), 'unknown-resname diagnostic');
	});

	await check('commands are registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const id of ['4dXliff.copyXliffRef', '4dXliff.showUnit', '4dXliff.revealInTree', '4dXliff.filter']) {
			assert.ok(commands.includes(id), id);
		}
		await vscode.commands.executeCommand('4dXliff.copyXliffRef', { projectRoot: root, fileSetId: '', resname: 'form1.ok' });
		assert.equal(await vscode.env.clipboard.readText(), ':xliff:form1.ok');
		await vscode.commands.executeCommand('4dXliff.showUnit', { projectRoot: root, fileSetId: '', resname: 'form1.ok' });
	});

	await check('quick fix offers to create an unknown resname', async () => {
		const method = vscode.Uri.file(path.join(root, 'Project/Sources/Methods/test_command.4dm'));
		const document = await vscode.workspace.openTextDocument(method);
		const position = positionOf(document, 'form1.lastname_unknown');
		const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', method, new vscode.Range(position, position));
		const create = actions.find(a => a.title === 'Create "form1.lastname_unknown" in the XLIFF files…');
		assert.ok(create, actions.map(a => a.title).join(', '));
		assert.deepEqual(create.command?.arguments, [{ resname: 'form1.lastname_unknown', sourcePath: method.fsPath }]);
	});

	await check('a misspelled resname in a form suggests the existing one', async () => {
		const formPath = path.join(root, 'Project/Sources/Forms/Form2/form.4DForm');
		fs.writeFileSync(formPath, fs.readFileSync(formPath, 'utf8').replace(':xliff:form1.windowTitle', ':xliff:form1.windowTite'));
		const formUri = vscode.Uri.file(formPath);
		const diagnostic = await until(() => vscode.languages.getDiagnostics(formUri).find(d => d.code === 'unknown-resname'), 'unknown-resname diagnostic in the form');
		assert.match(diagnostic.message, /Did you mean "form1\.windowTitle"\?/);
		const formDoc = await vscode.workspace.openTextDocument(formUri);
		const actions = (await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', formUri, diagnostic.range))
			.filter(a => /^(Replace with|Create) "/.test(a.title));
		assert.deepEqual(actions.map(a => a.title), ['Replace with "form1.windowTitle" (Contact)', 'Create "form1.windowTite" in the XLIFF files…']);
		assert.ok(actions[0].edit, 'replacement edit');
		assert.ok(await vscode.workspace.applyEdit(actions[0].edit!), 'edit applied');
		assert.ok(formDoc.getText().includes('":xliff:form1.windowTitle"'), formDoc.getText().slice(0, 200));
		await formDoc.save();
		assert.ok(fs.readFileSync(formPath, 'utf8').includes('":xliff:form1.windowTitle"'));
		await until(() => !vscode.languages.getDiagnostics(formUri).some(d => d.code === 'unknown-resname') ? true : undefined, 'diagnostic removed');
	});

	const project = () => model.index.projects[0];
	const fileSet = (name: string) => project().fileSets.find(s => s.name === name)!;

	await check('add a string in every language', async () => {
		const entry = await model.addUnit(fileSet('Form1.xlf'), ['Form1'], 'form1.lastname_unknown', 'Last name');
		assert.ok(entry);
		assert.ok(fs.readFileSync(enForm1, 'utf8').includes('<trans-unit id="form1.lastname_unknown" resname="form1.lastname_unknown">\n\t\t\t\t\t<source>Last name</source>\n\t\t\t\t\t<target>Last name</target>'));
		assert.ok(fs.readFileSync(frForm1.fsPath, 'utf8').includes('<source>Last name</source>\n\t\t\t\t\t<target state="needs-translation">Last name</target>'));
		await until(() => !vscode.languages.getDiagnostics().some(([, d]) => d.some(x => x.code === 'unknown-resname' && x.message.includes('form1.lastname_unknown'))), 'diagnostic removed');
		await assert.rejects(model.addUnit(fileSet('Menus.xlf'), [], 'form1.ok', 'x'), /already exists/);
	});

	await check('add a group in every language', async () => {
		await model.addGroup(fileSet('Menus.xlf'), ['Menus', 'Help']);
		for (const lang of ['en', 'fr']) {
			const text = fs.readFileSync(path.join(root, `Resources/${lang}.lproj/Menus.xlf`), 'utf8');
			assert.ok(text.includes('\t\t\t\t<group resname="Help">\n\t\t\t\t</group>\n\t\t\t</group>'), text);
		}
		assert.ok(fileSet('Menus.xlf').root.groups[0].groups.some(g => g.name === 'Help'));
	});

	await check('add a file in every language, then a string in it', async () => {
		const created = await model.addFile(project(), 'Dialogs.xlf');
		assert.equal(created?.name, 'Dialogs.xlf');
		assert.deepEqual([...created!.files.keys()].sort(), ['en', 'fr']);
		assert.match(fs.readFileSync(path.join(root, 'Resources/fr.lproj/Dialogs.xlf'), 'utf8'), /source-language="en" target-language="fr"/);
		await model.addUnit(fileSet('Dialogs.xlf'), ['Dialogs'], 'dialogs.title', 'Title');
		assert.ok(fileSet('Dialogs.xlf').root.groups[0].entries.some(e => e.resname === 'dialogs.title'));
		await assert.rejects(model.addFile(project(), 'dialogs.xlf'), /already exists/);
	});

	await check('split a string into mac and win versions', async () => {
		const ok = model.lookup('form1.ok', root)[0];
		const mac = await model.splitByPlatform(ok);
		assert.equal(mac?.platform, 'mac');
		assert.deepEqual(model.lookup('form1.ok', root).map(e => e.platform).sort(), ['mac', 'win']);
		await model.setTarget(mac!, 'fr', 'OK (Mac)');
		const fr = fs.readFileSync(frForm1.fsPath, 'utf8');
		assert.ok(fr.includes('<trans-unit d4:includeIf="win" id="form1.ok" resname="form1.ok">\n\t\t\t\t\t<source>OK</source>\n\t\t\t\t\t<target>OK</target>'), fr);
		assert.ok(fr.includes('<trans-unit d4:includeIf="mac" id="form1.ok_mac" resname="form1.ok">\n\t\t\t\t\t<source>OK</source>\n\t\t\t\t\t<target>OK (Mac)</target>'), fr);
		assert.ok(!vscode.languages.getDiagnostics(frForm1).some(d => d.code === 'duplicate'));
	});

	await check('delete a resname in every language, or one platform version', async () => {
		const title = model.lookup('dialogs.title', root)[0];
		await model.deleteEntry(title);
		assert.equal(model.lookup('dialogs.title', root).length, 0);
		for (const lang of ['en', 'fr']) {
			assert.ok(!fs.readFileSync(path.join(root, `Resources/${lang}.lproj/Dialogs.xlf`), 'utf8').includes('dialogs.title'));
		}
		const mac = model.lookup('form1.ok', root).find(e => e.platform === 'mac')!;
		await model.deleteEntry(mac);
		assert.deepEqual(model.lookup('form1.ok', root).map(e => e.platform), ['win']);
		assert.ok(!fs.readFileSync(frForm1.fsPath, 'utf8').includes('form1.ok_mac'));
	});

	await check('a string added by hand only in fr can be added to en', async () => {
		const frMenus = path.join(root, 'Resources/fr.lproj/Menus.xlf');
		const text = fs.readFileSync(frMenus, 'utf8');
		fs.writeFileSync(frMenus, text.replace('\t\t\t</group>\n\t\t</body>', '\t\t\t\t<trans-unit id="menu.byhand" resname="menu.byhand">\n\t\t\t\t\t<source>By hand</source>\n\t\t\t\t\t<target>À la main</target>\n\t\t\t\t</trans-unit>\n\t\t\t</group>\n\t\t</body>'));
		const entry = await until(() => model.lookup('menu.byhand', root)[0], 'hand-made resname');
		await until(() => vscode.languages.getDiagnostics(vscode.Uri.file(frMenus)).some(d => d.code === 'missing-unit' && d.message.includes('en.lproj/Menus.xlf')), 'missing-unit diagnostic on the fr file');
		await model.addToLanguage(entry, 'en');
		const en = fs.readFileSync(path.join(root, 'Resources/en.lproj/Menus.xlf'), 'utf8');
		assert.ok(en.includes('<trans-unit id="menu.byhand" resname="menu.byhand">\n\t\t\t\t\t<source>By hand</source>\n\t\t\t\t\t<target>By hand</target>'), en);
	});

	await check('rename a resname in every language and every reference', async () => {
		const lastname = model.lookup('form1.lastname', root)[0];
		const renamed = await model.renameEntry(lastname, 'form1.familyName');
		assert.equal(renamed?.resname, 'form1.familyName');
		assert.equal(model.lookup('form1.lastname', root).length, 0);
		for (const lang of ['en', 'fr']) {
			assert.ok(fs.readFileSync(path.join(root, `Resources/${lang}.lproj/Form1.xlf`), 'utf8').includes('<trans-unit id="form1.familyName" resname="form1.familyName">'));
		}
		for (const form of ['Form1', 'Form2']) {
			const text = fs.readFileSync(path.join(root, `Project/Sources/Forms/${form}/form.4DForm`), 'utf8');
			assert.ok(text.includes('":xliff:form1.familyName"') && !text.includes(':xliff:form1.lastname"'), form);
		}
		const method = fs.readFileSync(path.join(root, 'Project/Sources/Methods/test_command.4dm'), 'utf8');
		assert.ok(method.includes('Localized string("form1.familyName")') && method.includes('Localized string("form1.lastname_unknown")'), method);
		assert.equal(model.usagesOf(renamed!).length, 3);
		const clipboard = model.lookup('Clipboard_1', root)[0];
		await model.renameEntry(clipboard, 'clipboard.first');
		assert.deepEqual(model.lookup('clipboard.first', root).map(e => e.platform).sort(), ['mac', 'win']);
		await assert.rejects(model.renameEntry(model.lookup('form1.ok', root)[0], 'form1.cancel'), /already exists/);
	});

	await check('add a language, then list what remains to translate', async () => {
		await model.addLanguage(project(), 'de');
		assert.deepEqual(project().languages, ['en', 'de', 'fr']);
		const de = fs.readFileSync(path.join(root, 'Resources/de.lproj/Form1.xlf'), 'utf8');
		assert.match(de, /target-language="de"/);
		assert.ok(de.includes('<source>Cancel</source>\n\t\t\t\t\t<target state="needs-translation">Cancel</target>'), de);
		for (const set of project().fileSets) {
			assert.ok(set.files.has('de'), set.name);
		}
		await assert.rejects(model.addLanguage(project(), 'DE'), /already exists/);

		tree.setTranslateLanguage('de');
		const todo = tree.shownEntries();
		assert.equal(todo.length, model.allEntries().length);
		await model.setTarget(todo[0], 'de', 'Kontakt');
		await until(() => tree.shownEntries().length === todo.length - 1 ? true : undefined, 'translated string leaves the view');
		await vscode.commands.executeCommand('4dXliff.nextToTranslate', { projectRoot: root, fileSetId: todo[0].fileSet.id, resname: todo[0].resname });
		for (const entry of tree.shownEntries()) {
			await model.setTarget(entry, 'de', entry.byLang.get('de')!.target ?? '');
		}
		await until(() => tree.translateLanguage === undefined ? true : undefined, 'leaving the view once everything is translated');
	});

	await check('add commands are registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const id of ['4dXliff.addUnit', '4dXliff.addGroup', '4dXliff.addFile', '4dXliff.splitByPlatform', '4dXliff.deleteUnit', '4dXliff.renameUnit', '4dXliff.addLanguage', '4dXliff.showToTranslate', '4dXliff.nextToTranslate', '4dXliff.stopTranslating']) {
			assert.ok(commands.includes(id), id);
		}
	});
}
