import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseXliff } from '../core/xliffParser';
import { applyTextEdits, deleteUnitEdit, insertGroupEdit, insertUnitEdit, newLanguageFile, newXliffFile, nextUnitId, renameUnitEdits, resnameProblem, setSourceEdits, setTargetEdits, splitByPlatformEdits } from '../core/xliffEdits';
import { buildIndex, entryReference, languageFileName, stripLanguageSuffix } from '../core/xliffIndex';
import { displayText, translationStatus } from '../core/status';
import { closestResnames } from '../core/suggest';
import { completionPrefix, refAt, renameUsageEdits, scanUsages } from '../core/usages';

const fixture = path.join(__dirname, '..', '..', 'test-fixtures', 'testXliff');
const read = (rel: string) => fs.readFileSync(path.join(fixture, rel), 'utf8');
const xlfPaths = ['en.lproj/Form1.xlf', 'en.lproj/Menus.xlf', 'fr.lproj/Form1.xlf', 'fr.lproj/Menus.xlf']
	.map(rel => path.join(fixture, 'Resources', rel));

test('parses the units, groups and languages of a 4D XLIFF file', () => {
	const doc = parseXliff(read('Resources/fr.lproj/Form1.xlf'));
	assert.equal(doc.sourceLanguage, 'en');
	assert.equal(doc.targetLanguage, 'fr');
	assert.deepEqual(doc.units.map(u => u.key), ['form1.windowTitle', 'form1.firstname', 'form1.lastname', 'form1.ok', 'form1.cancel', 'Clipboard_1', 'Clipboard_1']);
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
	assert.equal(project.fileSets[0].root.groups[0].entries.length, 7);
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
	assert.deepEqual(usages.map(u => [u.resname, u.kind, u.context, u.line]), [['form1.lastname', 'method', 'test_command', 4], ['Clipboard_1', 'method', 'test_command', 5], ['form1.lastname_unknown', 'method', 'test_command', 8]]);
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

test('creates the missing groups of a new trans-unit', () => {
	const text = read('Resources/fr.lproj/Menus.xlf');
	const updated = applyTextEdits(text, [insertUnitEdit(text, parseXliff(text), ['Menus', 'Help'], { resname: 'menu.help', source: 'Help', target: 'Help' })]);
	const doc = parseXliff(updated);
	assert.deepEqual(doc.units.map(u => [u.key, u.groupPath.join('/')]).pop(), ['menu.help', 'Menus/Help']);
	assert.ok(updated.includes('\t\t\t\t<group resname="Help">\n\t\t\t\t\t<trans-unit id="menu.help" resname="menu.help">\n\t\t\t\t\t\t<source>Help</source>\n\t\t\t\t\t\t<target>Help</target>\n\t\t\t\t\t</trans-unit>\n\t\t\t\t</group>\n\t\t\t</group>'), updated);
});

test('inserts an empty group and refuses an existing one', () => {
	const text = read('Resources/en.lproj/Form1.xlf');
	const doc = parseXliff(text);
	const updated = applyTextEdits(text, [insertGroupEdit(text, doc, ['Form1', 'Buttons'])]);
	assert.deepEqual(parseXliff(updated).groups.map(g => g.path.join('/')).sort(), ['Form1', 'Form1/Buttons']);
	assert.ok(updated.includes('\t\t\t\t<group resname="Buttons">\n\t\t\t\t</group>\n\t\t\t</group>'));
	assert.throws(() => insertGroupEdit(text, doc, ['Form1']), /already exists/);
});

test('new trans-unit ids follow the style of the file', () => {
	assert.equal(nextUnitId([parseXliff(read('Resources/en.lproj/Form1.xlf'))], 'form1.email'), 'form1.email');
	const numeric = parseXliff('<body><trans-unit id="1" resname="a"/><trans-unit id="12" resname="b"/></body>');
	assert.equal(nextUnitId([numeric], 'c'), '13');
	assert.equal(nextUnitId([parseXliff('<body></body>')], 'c'), 'c');
});

test('validates resnames typed by the user', () => {
	assert.equal(resnameProblem('form1.email'), undefined);
	assert.match(resnameProblem('my label')!, /Spaces/);
	assert.match(resnameProblem('a"b')!, /cannot be used/);
	assert.match(resnameProblem('')!, /Enter/);
});

test('a new file is valid XLIFF and accepts units', () => {
	const text = newXliffFile({ original: 'Dialogs', sourceLanguage: 'en', targetLanguage: 'fr' });
	const doc = parseXliff(text);
	assert.equal(doc.targetLanguage, 'fr');
	assert.deepEqual(doc.errors, []);
	const updated = applyTextEdits(text, [insertUnitEdit(text, doc, ['Dialogs'], { resname: 'dlg.title', source: 'Title', target: 'Title' })]);
	assert.ok(updated.includes('\t\t<body>\n\t\t\t<group resname="Dialogs">\n\t\t\t\t<trans-unit id="dlg.title" resname="dlg.title">'), updated);
});

test('new file names follow the naming of the project', () => {
	const plain = buildIndex(xlfPaths.map(p => ({ path: p, text: fs.readFileSync(p, 'utf8') }))).projects[0];
	assert.equal(languageFileName(plain, 'Dialogs.xlf', 'fr'), 'Dialogs.xlf');
	const suffixed = (name: string, lang: string) => ({ path: `/p/Resources/${lang}.lproj/${name}`, text: '<body/>' });
	assert.equal(languageFileName(buildIndex([suffixed('CommonEN.xlf', 'en'), suffixed('CommonFR.xlf', 'fr')]).projects[0], 'Dialogs.xlf', 'fr'), 'DialogsFR.xlf');
	assert.equal(languageFileName(buildIndex([suffixed('Common_en.xlf', 'en')]).projects[0], 'Dialogs.xlf', 'fr'), 'Dialogs_fr.xlf');
});

test('d4:includeIf variants are separate entries of the same resname', () => {
	const index = buildIndex(xlfPaths.map(p => ({ path: p, text: fs.readFileSync(p, 'utf8') })));
	const variants = index.projects[0].resnames.get('Clipboard_1')!;
	assert.deepEqual(variants.map(e => e.platform), ['win', 'mac']);
	assert.equal(variants[1].byLang.get('fr')!.source, 'Clipboard #1 (Cmd+Shift+1 or Alt+Click to fill)');
	const text = read('Resources/fr.lproj/Form1.xlf');
	const mac = parseXliff(text).units.find(u => u.key === 'Clipboard_1' && u.platform === 'mac')!;
	assert.equal(mac.platformAttr, 'd4:includeIf');
	const updated = applyTextEdits(text, setTargetEdits(text, mac, 'Presse-papiers n°1'));
	assert.ok(updated.includes('<target>Clipboard #1 (Shift or Alt+click to fill)</target>'), 'win variant unchanged');
	assert.ok(updated.includes('<target>Presse-papiers n°1</target>'));
	const inserted = insertUnitEdit(text, parseXliff(text), ['Form1'], { resname: 'x', source: 'X', target: 'X', platform: 'mac', platformAttr: 'd4:includeIf' });
	assert.match(inserted.newText, /<trans-unit d4:includeIf="mac" id="x" resname="x">/);
});

test('splits a trans-unit into win and mac versions', () => {
	const text = read('Resources/fr.lproj/Form1.xlf');
	const doc = parseXliff(text);
	assert.deepEqual(doc.rootPrefixes, ['d4']);
	const ok = doc.units.find(u => u.key === 'form1.ok')!;
	const updated = applyTextEdits(text, splitByPlatformEdits(text, doc, ok, ['win', 'mac'], 'form1.ok_mac'));
	assert.ok(updated.includes([
		'\t\t\t\t<trans-unit d4:includeIf="win" id="form1.ok" resname="form1.ok">',
		'\t\t\t\t\t<source>OK</source>',
		'\t\t\t\t\t<target>OK</target>',
		'\t\t\t\t</trans-unit>',
		'\t\t\t\t<trans-unit d4:includeIf="mac" id="form1.ok_mac" resname="form1.ok">',
		'\t\t\t\t\t<source>OK</source>',
		'\t\t\t\t\t<target>OK</target>',
		'\t\t\t\t</trans-unit>',
	].join('\n')), updated);
	assert.equal(updated.match(/xmlns:d4=/g)!.length, 1, 'namespace already declared');
	assert.throws(() => splitByPlatformEdits(text, doc, doc.units.find(u => u.platform === 'mac')!, ['win', 'mac'], 'x'), /already specific/);
});

test('declares the d4 prefix when a file does not', () => {
	const text = '<?xml version="1.0"?>\n<xliff version="1.2">\n<file><body>\n<trans-unit id="1" resname="a"><source>A</source></trans-unit>\n</body></file></xliff>';
	const doc = parseXliff(text);
	const updated = applyTextEdits(text, splitByPlatformEdits(text, doc, doc.units[0], ['win', 'mac'], '2'));
	assert.ok(updated.includes('<xliff version="1.2" xmlns:d4="http://www.4d.com/d4-ns">'), updated);
	assert.ok(updated.includes('<trans-unit d4:includeIf="mac" id="2" resname="a"><source>A</source></trans-unit>'), updated);
	assert.deepEqual(parseXliff(updated).units.map(u => [u.key, u.platform, u.id]), [['a', 'win', '1'], ['a', 'mac', '2']]);
});

test('deletes a trans-unit with its lines', () => {
	const text = read('Resources/fr.lproj/Form1.xlf');
	const doc = parseXliff(text);
	const cancel = doc.units.find(u => u.key === 'form1.cancel')!;
	const updated = applyTextEdits(text, [deleteUnitEdit(text, cancel)]);
	assert.equal(updated, text.replace(/\t\t\t\t<trans-unit id="form1.cancel"[\s\S]*?<\/trans-unit>\n/, ''));
	const mac = doc.units.find(u => u.platform === 'mac')!;
	const withoutMac = parseXliff(applyTextEdits(text, [deleteUnitEdit(text, mac)]));
	assert.deepEqual(withoutMac.units.filter(u => u.key === 'Clipboard_1').map(u => u.platform), ['win']);
	const inline = '<body><trans-unit resname="a"><source>A</source></trans-unit><trans-unit resname="b"><source>B</source></trans-unit></body>';
	assert.equal(applyTextEdits(inline, [deleteUnitEdit(inline, parseXliff(inline).units[0])]), '<body><trans-unit resname="b"><source>B</source></trans-unit></body>');
});

test('an entry added only to a translation takes its reference from there', () => {
	const project = buildIndex([
		{ path: '/p/Resources/en.lproj/X.xlf', text: '<body></body>' },
		{ path: '/p/Resources/fr.lproj/X.xlf', text: '<body><trans-unit id="a" resname="a"><source>Hello</source><target>Bonjour</target></trans-unit></body>' },
	]).projects[0];
	const [a] = project.resnames.get('a')!;
	assert.equal(entryReference(a).lang, 'fr');
	assert.equal(entryReference(a).unit.source, 'Hello');
	assert.equal(translationStatus(a, 'en'), 'missingUnit');
	assert.equal(displayText(a), 'Bonjour');
});

test('renames a trans-unit and its derived id', () => {
	const text = read('Resources/fr.lproj/Form1.xlf');
	const doc = parseXliff(text);
	const lastname = doc.units.find(u => u.key === 'form1.lastname')!;
	const renamed = applyTextEdits(text, renameUnitEdits(lastname, 'form1.familyName'));
	assert.ok(renamed.includes('<trans-unit id="form1.familyName" resname="form1.familyName">\n\t\t\t\t\t<source>Lastname</source>\n\t\t\t\t\t<target>Nom</target>'));
	const clipboards = doc.units.filter(u => u.key === 'Clipboard_1');
	const both = parseXliff(applyTextEdits(text, clipboards.flatMap(u => renameUnitEdits(u, 'clipboard.first'))));
	assert.deepEqual(both.units.filter(u => u.key === 'clipboard.first').map(u => [u.platform, u.id]), [['win', '79'], ['mac', '80']]);
	const mac = parseXliff('<trans-unit d4:includeIf="mac" id="a_mac" resname="a"><source>A</source></trans-unit>');
	assert.equal(applyTextEdits('<trans-unit d4:includeIf="mac" id="a_mac" resname="a"><source>A</source></trans-unit>', renameUnitEdits(mac.units[0], 'b')), '<trans-unit d4:includeIf="mac" id="b_mac" resname="b"><source>A</source></trans-unit>');
});

test('renames the references of a resname in 4D sources', () => {
	const formPath = path.join(fixture, 'Project/Sources/Forms/Form1/form.4DForm');
	const form = fs.readFileSync(formPath, 'utf8');
	const updated = applyTextEdits(form, renameUsageEdits(formPath, form, 'form1.lastname', 'form1.familyName'));
	assert.equal(updated, form.replace('":xliff:form1.lastname"', '":xliff:form1.familyName"'));
	const code = '$a:=Localized string("form1.lastname")\n$b:=Localized string("form1.lastname_unknown")';
	assert.equal(applyTextEdits(code, renameUsageEdits('/p/Project/Sources/Methods/m.4dm', code, 'form1.lastname', 'x')), '$a:=Localized string("x")\n$b:=Localized string("form1.lastname_unknown")');
});

test('the file of a new language copies the source file, to translate', () => {
	const text = read('Resources/en.lproj/Form1.xlf');
	const de = newLanguageFile(text, parseXliff(text), 'de');
	const doc = parseXliff(de);
	assert.equal(doc.targetLanguage, 'de');
	assert.equal(doc.sourceLanguage, 'en');
	assert.deepEqual(doc.units.map(u => [u.key, u.platform, u.id]), parseXliff(text).units.map(u => [u.key, u.platform, u.id]));
	assert.ok(doc.units.every(u => u.targetState === 'needs-translation' && u.target === u.source));
	assert.ok(de.includes('\t\t\t\t<trans-unit id="form1.cancel" resname="form1.cancel">\n\t\t\t\t\t<source>Cancel</source>\n\t\t\t\t\t<target state="needs-translation">Cancel</target>'));
	const special = '<xliff><file source-language="en"><body><trans-unit resname="a"><source>A &amp; B</source></trans-unit><trans-unit resname="b" translate="no"><source>SQL</source></trans-unit></body></file></xliff>';
	const out = newLanguageFile(special, parseXliff(special), 'es');
	assert.equal(out, '<xliff><file source-language="en" target-language="es"><body><trans-unit resname="a"><source>A &amp; B</source>\n<target state="needs-translation">A &amp; B</target></trans-unit><trans-unit resname="b" translate="no"><source>SQL</source></trans-unit></body></file></xliff>');
});

test('confirming an unchanged pending translation marks it as translated', () => {
	const text = '<trans-unit resname="ok"><source>OK</source><target state="needs-translation">OK</target></trans-unit>';
	const unit = parseXliff(text).units[0];
	assert.equal(applyTextEdits(text, setTargetEdits(text, unit, 'OK')), '<trans-unit resname="ok"><source>OK</source><target state="translated">OK</target></trans-unit>');
});

test('suggests the existing resnames closest to a misspelled one', () => {
	const names = ['form1.windowTitle', 'form1.firstname', 'form1.lastname', 'form1.ok', 'form1.cancel', 'menu.window'];
	assert.deepEqual(closestResnames('form1.windowTite', names), ['form1.windowTitle']);
	assert.deepEqual(closestResnames('form1.WindowTitle', names), ['form1.windowTitle']);
	assert.deepEqual(closestResnames('form1.lastnam', names), ['form1.lastname']);
	assert.deepEqual(closestResnames('form1.lastname_unknown', names), []);
	assert.deepEqual(closestResnames('ok', names), []);
	assert.deepEqual(closestResnames('form1.ok', names), []);
});
