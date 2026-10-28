# 4D XLIFF Localization

Browse, translate and reference the XLIFF files of a 4D project from VS Code.

4D reads translations from `Resources/<language>.lproj/*.xlf` and displays them where a form, a menu or the code uses `:xliff:resname` or `Localized string("resname")`. This extension shows those files by resname instead of by language, and links each resname to the places that use it.

## Features

**XLIFF view** (activity bar): one entry per file (`Form1.xlf`), whatever the number of languages, then its groups and resnames with their text in the source language.
- Click the copy button next to a resname to copy `:xliff:resname`, ready to paste into the 4D form or menu editor. The context menu also copies `Localized string("resname")`.
- Resnames with a missing translation show a warning icon.
- Filter by resname or by text.

**Adding strings, groups and files**, always in every language:
- `+` on a file or a group of the XLIFF view adds a string there. The resname is pre-filled with the prefix of its neighbours (`form1.`), and `:xliff:resname` is copied once created.
- The context menu of a file or a group adds a group.
- The `New XLIFF File` button creates the file in each `<language>.lproj` folder, named like the other files of the project (`Dialogs.xlf`, or `DialogsFR.xlf` when the project adds the language to its file names).
- On an unknown resname in a form, menu or method, the quick fix (Cmd+. / Ctrl+.) creates it. The file and group suggested first are the ones holding resnames with the same prefix, or named like the form or menu.
- The new string gets the source text in every language, marked `state="needs-translation"` except in the source language, so that 4D never displays an empty label. Its `id` follows the file: the resname, or the next number when the ids are numeric.

**Adding a language**: "Add Language…" (`…` menu of the XLIFF view, or context menu of a project) creates `<language>.lproj` with a copy of each file of the source language: same groups, ids and mac/win versions, `target-language` set, and every target holding the source text with `state="needs-translation"` (`translate="no"` strings are left as is). 4D thus shows the source text until it is translated. To try a language in 4D without changing the system language, call `SET DATABASE LOCALIZATION("de")`.

**Translating**: the checklist button of the XLIFF view shows only the strings to translate in a language (or in any language), with their count. Clicking one opens its panel with the cursor in that language; "Next to translate", or Cmd/Ctrl+Enter in a translation, saves and moves on to the next one. Enter confirms a translation marked as needing translation even when unchanged ("OK" stays "OK"). Adding a language turns this view on; it is kept across reloads, is left automatically once the last string is translated, and the close button of the view leaves it at any time.

**Renaming a resname**: "Rename Resname…" (context menu, or link in its panel) renames it in every language, mac and win versions included, and in all the forms, menus, lists, tips and methods of the project that reference it, as one operation. The id follows when it is derived from the resname; numeric ids are kept. Close the forms concerned in 4D first.

**Deleting a resname**: "Delete Resname…" in its context menu removes it from every language file, after a confirmation that lists the places still using it. For a mac/win resname, only the chosen version is removed.

**Platform versions** (`d4:includeIf="mac"` / `"win"`): each version of a resname is shown and edited separately, marked `mac` or `win`, and is not reported as a duplicate. "Different Text on mac/win…" (context menu of a resname, or link in its panel) turns a resname into a win version and a mac copy, in every language; the `xmlns:d4` declaration is added to the files that lack it.

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

Press F5 to open a VS Code window with the extension loaded:
- "Run Extension (sandbox)" opens `sandbox/testXliff`, a copy of the test project ignored by git, created when missing: try anything there.
- "Run Extension (fresh sandbox)" recreates that copy first (or `npm run sandbox`).
- "Run Extension (test fixture)" opens the reference project used by the tests, to change it on purpose.

`test-fixtures/testXliff` is a minimal 4D project (English and French, one form, one menu bar).
