# Contributing

## Source layout

| File | Role |
| --- | --- |
| `src/core/xliffParser.ts` | XLIFF reader keeping the offsets of every element, so that edits leave the rest of the file untouched |
| `src/core/xliffEdits.ts` | text edits on XLIFF files: translations, new strings, groups, files and languages, rename, delete, mac/win split |
| `src/core/xliffIndex.ts` | groups the files of a workspace into 4D projects, files and resnames across languages |
| `src/core/usages.ts` | finds `:xliff:` and `Localized string` references in forms, menus, lists, tips and methods |
| `src/core/status.ts` | translation status of a resname in a language |
| `src/model.ts` | keeps the index up to date and applies edits to the workspace |
| `src/tree.ts`, `src/panel.ts`, `media/panel.*` | XLIFF view and translations panel |
| `src/languageFeatures.ts`, `src/diagnostics.ts` | hover, definition, completion, CodeLens, references and problems |
| `src/addCommands.ts`, `src/extension.ts` | commands |

`src/core` has no VS Code dependency and is tested with Node alone.

## Build and test

Requires Node.js.

```bash
npm install
npm run compile
npm test                  # src/core, with Node
npm run test:integration  # in the installed VS Code, on a copy of test-fixtures/testXliff
```

## Running

Press `F5` to open a VS Code window with the extension loaded:

- "Run Extension (sandbox)" opens `sandbox/testXliff`, a copy of the test project ignored by git, created
  when missing: try anything there.
- "Run Extension (fresh sandbox)" recreates that copy first (or `npm run sandbox`).
- "Run Extension (test fixture)" opens `test-fixtures/testXliff`, the project used by the tests, to change
  it on purpose.

## Packaging

```bash
npm run package
```

The icon is `media/icon.png`, rendered at 256×256 from `media/icon.svg`.
