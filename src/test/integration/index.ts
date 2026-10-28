// Runs inside VS Code (see scripts/integration.sh) on a copy of the test project.

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { XliffModel } from '../../model';

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
	const { model } = (await extension.activate()) as { model: XliffModel };
	const check = async (name: string, body: () => Promise<void>) => {
		console.log(`start - ${name}`);
		await body();
		console.log(`ok - ${name}`);
	};

	await check('index', async () => {
		assert.deepEqual(model.index.projects.map(p => p.languages), [['en', 'fr']]);
		assert.equal(model.allEntries().length, 8);
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
		assert.equal(counts.length, 5);
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

}
