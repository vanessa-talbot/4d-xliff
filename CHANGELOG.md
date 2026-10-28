# Changelog

## 0.1.0 — 2026-10-28

First release.

- XLIFF view by file, group and resname, whatever the number of languages; file names carrying the
  language (`CommonFR.xlf`) are grouped with the other languages.
- Copy of `:xliff:` and `Localized string` references, ready to paste into 4D.
- Translations panel: source and translations edited in place, references listed with the form object,
  menu, list, tip or method using them.
- In forms, menus, lists, tips and methods: hover, go to definition and completion of resnames. In the
  XLIFF files: CodeLens and "Find All References" for the usages.
- Problems view: unknown resnames, with "Did you mean …?" and a quick fix replacing a misspelled one
  with the existing resname, missing or empty translations, duplicates. Resnames provided by 4D and
  `translate="no"` strings are not reported.
- Create strings, groups and XLIFF files in every language, from the XLIFF view or with the quick fix on
  an unknown resname.
- Add a language: a copy of the source language files, every string marked as needing translation.
- "To translate" view: the strings left to translate in a language, translated one after the other with
  Next / Cmd+Enter, left automatically once everything is translated.
- Rename a resname in every language and in all the forms, menus, lists, tips and methods using it.
- Delete a resname from every language.
- mac/win versions of a resname (`d4:includeIf`): shown and edited separately, and created with
  "Different Text on mac/win…".
