# 4D XLIFF Localization

Stop finding out at runtime that a form shows `:xliff:form1.lastname` instead of "Last name".

In a 4D project, forms, menus and code refer to translations by name: `:xliff:resname` or `Localized string("resname")`. A typo, a string missing in one language, or the same resname defined twice only shows up when the form is opened in that language. This extension checks every reference of the project against its XLIFF files while you edit, and gives you the exact reference to paste into 4D.

## Installation

Requires **VS Code 1.90 or later**.

1. Download the `.vsix` file attached to a release on the [GitHub releases page](https://github.com/vanessa-talbot/4d-xliff/releases).
2. In VS Code, open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux).
3. Run **Extensions: Install from VSIX…** and select the downloaded file.

If no release is available yet, you can [build and package the extension from source](CONTRIBUTING.md#packaging).

## Quick start

1. Open your 4D project folder in VS Code. Translations must be stored in `Resources/<language>.lproj` folders, such as `Resources/en.lproj` and `Resources/fr.lproj`.
2. Click the **4D XLIFF** icon in the Activity Bar to browse the project's strings by file and group.
3. Click a resname to edit its translations, or use its copy button to copy `:xliff:resname` into 4D.

Open the **Problems** view (`Cmd+Shift+M` / `Ctrl+Shift+M`) to see unknown references and translation issues.
Before renaming a resname, close the affected forms in the 4D form editor to prevent it from overwriting the changes.

## Catch broken references before running

The Problems view lists, for the whole project:

- **Unknown resnames**: a `:xliff:` reference in a form, menu, choice list or help tip, or a `Localized string("…")` in a method, that no XLIFF file defines. This is what 4D displays as `:xliff:…` at runtime. When it looks like a typo of an existing resname (`form1.windowTite`, `form1.WindowTitle`), the message says "Did you mean `form1.windowTitle`?".
- **Strings missing in a language**: defined in `en.lproj` but not in `fr.lproj`, or present without a translation, or with an empty one.
- **Strings still to translate** (`state="needs-translation"`).
- **Duplicate resnames**: the same name in two files, where 4D uses only one of them.
- **Resnames that `:xliff:` cannot reference**: containing a space, or without a `resname` attribute.

For unknown resnames, a quick fix (Cmd+. / Ctrl+.) can replace a typo with a suggested existing resname, or create the string in every language alongside its neighbours. The translations panel can also add a missing string to a language in one click.

![4D XLIFF localisation highlighting, and diagnostics](docs/diagnostic.png)

Resnames provided by 4D itself (`CommonMenuFile`, `CommonMenuItemQuit`…) are not reported as unknown, `translate="no"` strings as untranslated, nor the mac and win versions of a resname (`d4:includeIf`) as duplicates.

## Copy the reference instead of typing it

The XLIFF view in the Activity Bar lists the project's resnames across all project languages, grouped by file and group, with their text. The copy button next to a resname copies `:xliff:resname`, ready to paste into the Property List of the 4D form or menu editor; the context menu also copies `Localized string("resname")` for the code. A new string created from the view is copied at once.

![4D XLIFF localisation editor](docs/editor.png)

## See each resname where it is used

- **In forms, menus, lists, tips and methods**: hover a reference to see its translations, Cmd/Ctrl+click to open its `trans-unit` in each language, and get resnames suggested after `:xliff:` and `Localized string("`.
- **In the XLIFF files**: a CodeLens above each `trans-unit` counts its usages, and "Find All References" lists them.
- **In the translations panel**: "Used in" lists the form objects (`Form1 › Button · text`), menus, lists, tips and methods using the resname.

## Edit the XLIFF files

Additions, renames and deletions are applied across the project's languages; editing a translation updates only the selected language. Edits target the text concerned, preserving the surrounding indentation, comments and attributes.

- **Translations panel** (click a resname): edit the source and each translation. Enter saves, and confirms a translation marked as needing translation even when it stays the same.
- **Add** a string or a group (`+` and context menu of the XLIFF view), or a file, created in each `<language>.lproj` and named like the other files of the project. New strings use the source text as their initial value in every language and are marked as needing translation.
- **Rename** a resname: in every language and in all the forms, menus, lists, tips and methods referencing it, as one operation.
- **Delete** a resname from every language, after a confirmation listing the places still using it.
- **Add a language**: a copy of the source language files with every string to translate. The "to translate" view then lists only what remains, and Next / Cmd+Enter moves from one string to the next. To try a language in 4D, call `SET DATABASE LOCALIZATION("de")`.
- **mac/win versions** (`d4:includeIf`): each version is shown and edited separately; "Different Text on mac/win…" creates them.

## Settings

| Setting | Default | Description |
|---|---|---|
| `4dXliff.sourceLanguage` | (from the files) | Source language of the project |
| `4dXliff.ignoredResnames` | `["^Common"]` | Regular expressions of resnames provided by 4D |
| `4dXliff.excludeFolders` | `node_modules`, `DerivedData`, `Components`, `.git` | Folders ignored |
| `4dXliff.diagnostics.enabled` | `true` | Report problems |

## Known limitations

- The edits are written to the files: close the forms concerned in the 4D form editor before renaming a resname, so that 4D does not save over the change.
- Resnames containing spaces can only be used with `Localized string`, not in a `:xliff:` reference.
- Only `Resources/<language>.lproj` folders are read; an XLIFF file directly in `Resources` is ignored.
- References built at runtime (`Localized string($name)`) cannot be found.

## Commands

<details>
<summary>Show all commands</summary>

From the Command Palette, the XLIFF view title bar or its context menus:

- **4D XLIFF: Copy :xliff: Reference** — copies `:xliff:resname` for the 4D form or menu editor (copy button of a resname, or pick one by name).
- **4D XLIFF: Copy Localized string(…)** — copies `Localized string("resname")` for the code.
- **4D XLIFF: Show Translations…** — opens the translations panel of a resname.
- **4D XLIFF: Filter Resnames…** — shows only the resnames whose name or text contains a given text; **Clear Filter** shows them all again.
- **4D XLIFF: Show Strings to Translate…** — shows only the strings left to translate in a language, or in any language; **Leave the To Translate View** goes back to the whole list.
- **4D XLIFF: Add String…** — creates a resname in every language (`+` of a file or group, or quick fix on an unknown resname).
- **4D XLIFF: Add Group…** — creates a group in every language.
- **4D XLIFF: New XLIFF File…** — creates a file in each `<language>.lproj` folder.
- **4D XLIFF: Add Language…** — creates `<language>.lproj` from the source language files, every string marked as needing translation.
- **4D XLIFF: Refresh** — reads the XLIFF files and the 4D sources of the workspace again.

From the context menu of a resname in the XLIFF view:

- **Open in XLIFF File** — opens its `trans-unit` in the source language file.
- **Find Usages** — lists the forms, menus, lists, tips and methods using it.
- **Rename Resname…** — renames it in every language and in every reference of the project.
- **Different Text on mac/win…** — splits it into a win version and a mac version (`d4:includeIf`).
- **Delete Resname…** — removes it from every language.

</details>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the source layout, tests and build instructions.

## License

[MIT](LICENSE)
