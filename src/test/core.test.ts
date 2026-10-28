import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseXliff } from '../core/xliffParser';
import { applyTextEdits, insertUnitEdit, setSourceEdits, setTargetEdits } from '../core/xliffEdits';
import { buildIndex, stripLanguageSuffix } from '../core/xliffIndex';
import { translationStatus } from '../core/status';
import { completionPrefix, refAt, scanUsages } from '../core/usages';

const fixture = path.join(__dirname, '..', '..', 'test-fixtures', 'testXliff');
const read = (rel: string) => fs.readFileSync(path.join(fixture, rel), 'utf8');
const xlfPaths = ['en.lproj/Form1.xlf', 'en.lproj/Menus.xlf', 'fr.lproj/Form1.xlf', 'fr.lproj/Menus.xlf']
	.map(rel => path.join(fixture, 'Resources', rel));

test('parses the units, groups and languages of a 4D XLIFF file', () => {
	const doc = parseXliff(read('Resources/fr.lproj/Form1.xlf'));
	assert.equal(doc.sourceLanguage, 'en');
	assert.equal(doc.targetLanguage, 'fr');
	assert.deepEqual(doc.units.map(u => u.key), ['form1.windowTitle', 'form1.firstname', 'form1.lastname', 'form1.ok', 'form1.cancel']);
	assert.deepEqual(doc.units[4].groupPath, ['Form1']);
	assert.equal(doc.units[4].source, 'Cancel');
	assert.equal(doc.units[4].target, 'Annuler');
	assert.equal(doc.groups.length, 1);
	assert.deepEqual(doc.errors, []);
});

test('changing a target only touches that target', () => {
	const text = read('Resources/fr.lproj/Form1.xlf');
	const unit = parseXliff(text).units.find(u => u.key === 'form1.cancel')!;
	const updated = applyTextEdits(text, setTargetEdits(text, unit, 'Annuler & <fermer>'));
	assert.equal(updated, text.replace('<target>Annuler</target>', '<target>Annuler &amp; &lt;fermer&gt;</target>'));
	assert.equal(parseXliff(updated).units.find(u => u.key === 'form1.cancel')!.target, 'Annuler & <fermer>');
});

test('adds a missing target after the source, with the same indentation', () => {
	const text = '<xliff><file><body>\n\t<trans-unit id="a" resname="a">\n\t\t<source>Hello</source>\n\t</trans-unit>\n</body></file></xliff>';
	const unit = parseXliff(text).units[0];
	const updated = applyTextEdits(text, setTargetEdits(text, unit, 'Bonjour'));
	assert.ok(updated.includes('\t\t<source>Hello</source>\n\t\t<target>Bonjour</target>\n'));
});

test('marks a pending target as translated when it is filled', () => {
	const text = '<trans-unit resname="a"><source>Hi</source><target state="needs-translation">Hi</target></trans-unit>';
	const unit = parseXliff(text).units[0];
	assert.equal(unit.targetState, 'needs-translation');
	const updated = applyTextEdits(text, setTargetEdits(text, unit, 'Salut'));
	assert.equal(updated, '<trans-unit resname="a"><source>Hi</source><target state="translated">Salut</target></trans-unit>');
});

test('updates a source', () => {
	const text = read('Resources/en.lproj/Form1.xlf');
	const unit = parseXliff(text).units.find(u => u.key === 'form1.ok')!;
	const updated = applyTextEdits(text, setSourceEdits(unit, 'Validate'));
	assert.equal(parseXliff(updated).units.find(u => u.key === 'form1.ok')!.source, 'Validate');
});

test('inserts a trans-unit at the end of its group', () => {
	const text = read('Resources/fr.lproj/Menus.xlf');
	const doc = parseXliff(text);
	const edit = insertUnitEdit(text, doc, ['Menus'], { resname: 'menu.help', source: 'Help', target: 'Help', state: 'needs-translation' });
	const updated = applyTextEdits(text, [edit]);
	const reparsed = parseXliff(updated);
	assert.equal(reparsed.units.length, 4);
	assert.deepEqual(reparsed.units[3].groupPath, ['Menus']);
	assert.ok(updated.includes('\t\t\t\t<trans-unit id="menu.help" resname="menu.help">\n\t\t\t\t\t<source>Help</source>'));
	assert.ok(updated.includes('</trans-unit>\n\t\t\t</group>'));
});

test('ignores comments, CDATA and alt-trans', () => {
	const text = `<body><!-- <trans-unit resname="ghost"> -->
	<trans-unit resname="a"><source><![CDATA[A < B]]></source>
		<alt-trans><source>x</source><target>y</target></alt-trans>
		<target>A &lt; B</target></trans-unit></body>`;
	const doc = parseXliff(text);
	assert.equal(doc.units.length, 1);
	assert.equal(doc.units[0].source, 'A < B');
	assert.equal(doc.units[0].target, 'A < B');
});

test('indexes the fixture project by file and language', () => {
	const index = buildIndex(xlfPaths.map(p => ({ path: p, text: fs.readFileSync(p, 'utf8') })));
	assert.equal(index.projects.length, 1);
	const project = index.projects[0];
	assert.equal(project.root, fixture);
	assert.equal(project.sourceLanguage, 'en');
	assert.deepEqual(project.languages, ['en', 'fr']);
	assert.deepEqual(project.fileSets.map(s => s.name), ['Form1.xlf', 'Menus.xlf']);
	const cancel = project.resnames.get('form1.cancel')![0];
	assert.equal(cancel.byLang.get('fr')!.target, 'Annuler');
	assert.equal(translationStatus(cancel, 'fr'), 'ok');
	assert.equal(project.fileSets[0].root.groups[0].name, 'Form1');
	assert.equal(project.fileSets[0].root.groups[0].entries.length, 5);
});

test('reports a resname missing in one language', () => {
	const en = '<body><trans-unit resname="a"><source>A</source><target>A</target></trans-unit><trans-unit resname="b"><source>B</source></trans-unit></body>';
	const fr = '<body><trans-unit resname="a"><source>A</source><target></target></trans-unit></body>';
	const index = buildIndex([
		{ path: '/p/Resources/en.lproj/X.xlf', text: en },
		{ path: '/p/Resources/fr.lproj/X.xlf', text: fr },
		{ path: '/p/Resources/de.lproj/Y.xlf', text: '<body/>' },
	]);
	const project = index.projects[0];
	const [a] = project.resnames.get('a')!;
	const [b] = project.resnames.get('b')!;
	assert.equal(translationStatus(a, 'fr'), 'empty');
	assert.equal(translationStatus(b, 'en'), 'ok');
	assert.equal(translationStatus(b, 'fr'), 'missingUnit');
	assert.equal(translationStatus(b, 'de'), 'missingFile');
});

test('finds :xliff: references in forms with the object name', () => {
	const formPath = path.join(fixture, 'Project/Sources/Forms/Form1/form.4DForm');
	const usages = scanUsages(formPath, fs.readFileSync(formPath, 'utf8'));
	assert.deepEqual(usages.map(u => u.resname), ['form1.windowTitle', 'form1.firstname', 'form1.lastname', 'form1.ok', 'form1.cancel']);
	assert.equal(usages[0].context, 'Form1 · windowTitle');
	assert.equal(usages[3].context, 'Form1 › Button · text');
});

test('finds references in menus and code', () => {
	const menusPath = path.join(fixture, 'Project/Sources/menus.json');
	const menus = scanUsages(menusPath, fs.readFileSync(menusPath, 'utf8'));
	assert.ok(menus.some(u => u.resname === 'menu.window.contacts' && u.kind === 'menu'));
	const code = scanUsages('/p/Project/Sources/Methods/test.4dm', '$t:=Localized string("form1.ok")\nOBJECT SET TITLE(*; "b"; ":xliff:menu.window")');
	assert.deepEqual(code.map(u => [u.resname, u.line, u.character]), [['form1.ok', 0, 22], ['menu.window', 1, 33]]);
	assert.equal(code[0].context, 'test');
});

test('locates the resname under the cursor and the completion prefix', () => {
	assert.deepEqual(refAt('"text": ":xliff:form1.ok",', 18), { resname: 'form1.ok', start: 16, end: 24 });
	assert.equal(refAt('"text": ":xliff:form1.ok",', 2), undefined);
	assert.equal(completionPrefix('"text": ":xliff:form1.'), 'form1.');
	assert.equal(completionPrefix('$t:=Localized string("fo'), 'fo');
	assert.equal(completionPrefix('$t:=1'), undefined);
});

test('finds Localized string in a method of the test project', () => {
	const methodPath = path.join(fixture, 'Project/Sources/Methods/test_command.4dm');
	const usages = scanUsages(methodPath, fs.readFileSync(methodPath, 'utf8'));
	assert.deepEqual(usages.map(u => [u.resname, u.kind, u.context, u.line]), [['form1.lastname', 'method', 'test_command', 4], ['form1.lastname_unknown', 'method', 'test_command', 7]]);
});

test('finds :xliff: references in choice lists and help tips, with their name', () => {
	const lists = '{\n\t"Colors": {\n\t\t"items": [\n\t\t\t{\n\t\t\t\t"value": ":xliff:color.red"\n\t\t\t}\n\t\t]\n\t}\n}';
	const tips = '{\n\t"SaveTip": {\n\t\t"content": ":xliff:tip.save"\n\t}\n}';
	assert.deepEqual(scanUsages('/p/Project/Sources/lists.json', lists).map(u => [u.resname, u.kind, u.context]), [['color.red', 'list', 'Lists › Colors']]);
	assert.deepEqual(scanUsages('/p/Project/Sources/tips.json', tips).map(u => [u.resname, u.kind, u.context]), [['tip.save', 'tip', 'Tips › SaveTip']]);
	assert.deepEqual(scanUsages('/p/Project/Sources/other.json', tips), []);
});

test('groups file names carrying a language code', () => {
	assert.equal(stripLanguageSuffix('CommonFR.xlf', 'fr'), 'Common.xlf');
	assert.equal(stripLanguageSuffix('Common_fr.xlf', 'fr'), 'Common.xlf');
	assert.equal(stripLanguageSuffix('Common-fr-ca.xlf', 'fr-ca'), 'Common.xlf');
	assert.equal(stripLanguageSuffix('CommonFRCA.xlf', 'fr-ca'), 'Common.xlf');
	assert.equal(stripLanguageSuffix('Messages.xlf', 'es'), 'Messages.xlf');
	assert.equal(stripLanguageSuffix('pathPicker.xlf', 'fr'), 'pathPicker.xlf');
	assert.equal(stripLanguageSuffix('FR.xlf', 'fr'), 'FR.xlf');
	assert.equal(stripLanguageSuffix('sub/FR.xlf', 'fr'), 'sub/FR.xlf');
	const index = buildIndex([
		{ path: '/p/Resources/en.lproj/CommonEN.xlf', text: '<body><trans-unit resname="a"><source>A</source><target>A</target></trans-unit></body>' },
		{ path: '/p/Resources/fr.lproj/CommonFR.xlf', text: '<body><trans-unit resname="a"><source>A</source><target>Á</target></trans-unit></body>' },
	]);
	const [set] = index.projects[0].fileSets;
	assert.equal(set.name, 'Common.xlf');
	assert.deepEqual([...set.files.values()].map(f => f.label), ['en.lproj/CommonEN.xlf', 'fr.lproj/CommonFR.xlf']);
});

test('translate="no" units are never reported as untranslated', () => {
	const en = '<body><group resname="g" translate="no"><trans-unit resname="a"><source>A</source></trans-unit></group><trans-unit resname="b" translate="no"><source>B</source></trans-unit></body>';
	const fr = '<body><group resname="g" translate="no"><trans-unit resname="a"><source>A</source></trans-unit></group><trans-unit resname="b" translate="no"><source>B</source></trans-unit></body>';
	const project = buildIndex([{ path: '/p/Resources/en.lproj/X.xlf', text: en }, { path: '/p/Resources/fr.lproj/X.xlf', text: fr }]).projects[0];
	assert.equal(translationStatus(project.resnames.get('a')![0], 'fr'), 'ok');
	assert.equal(translationStatus(project.resnames.get('b')![0], 'fr'), 'ok');
});
