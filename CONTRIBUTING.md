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

Use **Node.js 24 LTS**, matching the release workflow, with npm.

```bash
npm ci
npm test                  # src/core, with Node
```

`npm test` compiles the extension before running the core tests. To compile without running tests,
use `npm run compile`.

### Integration tests

Integration tests require a local VS Code installation and a graphical desktop session. Run:

```bash
npm run test:integration
```

The script compiles the extension and opens a separate VS Code instance on a temporary copy of
`test-fixtures/testXliff`, with isolated user data and extensions. The original fixture is not modified.

The default executable is `/Applications/Visual Studio Code.app/Contents/MacOS/Code` on macOS.
For another installation, set `VSCODE_BIN` to the VS Code executable:

```bash
VSCODE_BIN="/path/to/VS Code executable" npm run test:integration
```

The test script uses a POSIX shell; on Windows, run it from a compatible shell.

## Running

Press `F5` to open a VS Code window with the extension loaded:

- "Run Extension (sandbox)" opens `sandbox/testXliff`, a copy of the test project ignored by git, created
  when missing: try anything there.
- "Run Extension (fresh sandbox)" recreates that copy first (or `npm run sandbox`).
- "Run Extension (test fixture)" opens `test-fixtures/testXliff`, the project used by the tests, to change
  it on purpose.

## Packaging

From the repository root, install dependencies with `npm ci` if you have not already done so, then run:

```bash
npm run package
```

This compiles the extension and creates `4d-xliff-<version>.vsix` in the repository root.
In VS Code, run **Extensions: Install from VSIX…** from the Command Palette and select that file.

The icon is `media/icon.png`, rendered at 256×256 from `media/icon.svg`.

## GitHub releases

Pushing a tag named `v<version>` (for example `v0.1.0`) runs
[the release workflow](.github/workflows/release.yml). It checks that the tag matches the version in
`package.json` and `package-lock.json`, installs dependencies, runs the core tests, packages the
extension and creates a GitHub release with automatically generated notes and the `.vsix` attached.
Tags with a prerelease version, such as `v0.2.0-beta.1`, create a GitHub prerelease.

To prepare a new version:

```bash
npm version patch --no-git-tag-version  # or minor / major
# Update CHANGELOG.md for the new version.
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release $(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"
git push
git push origin "v$(node -p "require('./package.json').version")"
```

For the initial `0.1.0` release, skip the version bump and commit if the release contents are already
committed; just create and push `v0.1.0`. The workflow must be committed before creating the tag.
You can also create the tag on GitHub, pointing to that commit, without creating a release manually.

The workflow uses the automatic `GITHUB_TOKEN`; no additional secret is required. GitHub Actions
must be enabled for the repository. This creates a GitHub release only, not a VS Code Marketplace
publication. Download the `.vsix` from the release and use **Extensions: Install from VSIX…** in
VS Code to install it.
