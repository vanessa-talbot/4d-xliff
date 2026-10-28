# 4D XLIFF Localization

Browse, translate and reference the XLIFF files of a 4D project from VS Code.

4D reads translations from `Resources/<language>.lproj/*.xlf` and displays them where a form, a menu or the code uses `:xliff:resname` or `Localized string("resname")`. This extension shows those files by resname instead of by language, and links each resname to the places that use it.

## Features

**XLIFF view** (activity bar): one entry per file (`Form1.xlf`), whatever the number of languages, then its groups and resnames with their text in the source language.
- Click the copy button next to a resname to copy `:xliff:resname`, ready to paste into the 4D form or menu editor. The context menu also copies `Localized string("resname")`.
- Resnames with a missing translation show a warning icon.
- Filter by resname or by text.

**Translations panel**: click a resname to see it in every language.
- Edit the source (written to every language file) and each translation. Enter saves, Shift+Enter adds a line break, Esc cancels.
- A resname missing in a language can be added there in one click (marked `state="needs-translation"`).
- "Used in" lists the forms (with the object name), menus, choice lists, help tips and methods that reference it.

**In the 4D sources** (`.4dm`, `form.4DForm`, `menus.json`, `lists.json`, `tips.json`):
- Hover a `:xliff:` reference or `Localized string("…")` to see its translations.
- Ctrl/Cmd+click goes to the `trans-unit` in each language.
- Resnames are suggested after `:xliff:` and `Localized string("`.

**In the XLIFF files**: a CodeLens above each `trans-unit` shows how many places use it, and "Find All References" lists them.

**Problems view**: unknown resnames in forms, menus, lists, tips and code, translations missing or empty in a language, resnames defined twice, or containing spaces (they cannot be used with `:xliff:`). Resnames provided by 4D (`CommonMenuFile`, `CommonMenuItemQuit`…) are not reported.

Edits change only the text concerned: indentation, comments and attributes of the XLIFF files are kept as they are.

## Settings

| Setting | Default | |
|---|---|---|
| `4dXliff.sourceLanguage` | (from the files) | Source language of the project |
| `4dXliff.ignoredResnames` | `["^Common"]` | Regular expressions of resnames provided by 4D |
| `4dXliff.excludeFolders` | `node_modules`, `DerivedData`, `Components`, `.git` | Folders ignored |
| `4dXliff.diagnostics.enabled` | `true` | Report problems |

## Development

```sh
npm install
npm test                  # parser, index and reference scanner (Node)
npm run test:integration  # runs in the installed VS Code on a copy of test-fixtures/testXliff
```

Press F5 ("Run Extension (testXliff)") to open the test project in a VS Code window with the extension loaded.

`test-fixtures/testXliff` is a minimal 4D project (English and French, one form, one menu bar).
