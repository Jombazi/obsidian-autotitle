---
title: Copy style
description: Rules for user-facing text in English and Russian — notice punctuation, quotes, counts, terminology and settled term choices for settings, dialogs, notices and the READMEs.
author: 🤖 Generated with Claude Code
updated: 2026-10-16
---
# Copy style

The rules every user-facing string follows: settings, dialogs, notices, command names and the READMEs, in `locale/en.json`, `locale/ru.json`, `README.md` and `README_RU.md`. Some are enforced by tests (`tests/notice-copy.test.ts`, `tests/locale-parity.test.ts`); the rest are settled choices to keep when writing new copy.

## Both languages

- **Notice end punctuation follows its sentence count**: a one-sentence notice ends without a period, a notice of two or more sentences ends with one, and a progress notice keeps its "...". Defined at `showNotice` in `src/settings/settings-base.ts`; `tests/notice-copy.test.ts` checks every `notifications.*` string.
- **Quoted names**: curly “…” in English, straight "…" in Russian, the style Obsidian's own Russian text uses most (1.14.4: 59 straight spans, 21 «…», 19 “…”).
- **Tags are never quoted**: "Disabled renaming for #project".
- **Counts take the plural form of their number**: "1 note", "2 notes" (RU "заметка/заметки/заметок"), through `tp()` in `src/i18n.ts`. With several notes selected, menus, dialogs and notices count every selected note, whether or not each can be renamed ("Renaming 5 notes...", "Renamed 2/5 notes").
- **A refused rename names its first matching reason**, in this order: the property that disables renaming, then excluded file path, excluded tag, excluded property.
- **A trailing "unless excluded" takes a comma** after a full clause ("…on note creation, unless excluded."; RU "…, если она не исключена."). In a command name it sits in parentheses instead: "Put first line in title (unless excluded)".
- **Example hints** read "e.g. /…/" in English, with Russian examples in Russian ("например /^черновик/").

## Terms

| Concept | English | Russian |
|---|---|---|
| Exclusion by path | file path | путь к файлу |
| Exclusion mode options | Exclude listed / Exclude all except listed | Исключить указанные / Исключить все, кроме указанных |
| Empty exclusion list | No files listed. / No tags listed. / No properties listed. | Нет указанных файлов. / …тегов. / …свойств. |
| Exclusions subsections | Files, Tags, Properties | Файлы, Теги, Свойства |
| First line property | first line property | Свойство с первой строкой (every case form) |
| Custom replacements section | Custom replacements | Замена текста |
| A property's name | property name | Имя свойства |
| Advanced group | Advanced | Расширенные настройки |
| Link to GitHub Discussions | Discuss | Обсудить |

- **Why "Files", not "Excluded files"**: under "Exclude all except listed" a listed entry allows renaming, so "Excluded" would mislead. Refusal notices keep "excluded file path/tag/property", which is true whenever they show.
- **Why "Discuss", not "Help"**: "Help" stays free for a future documentation link.
- **Labels only**: the exclusion mode labels changed, but the stored strategy values (`Only exclude...`, `Exclude all except...`) did not.
- **Obsidian's own wording wins where FLIT copies its UI**: the Excluded files dialog's hint keeps "Enter a path or a regular expression, e.g. /daily-.*/", and a regex entry's "Regex" tag stays untranslated, as Obsidian hard-codes it.
- **Obsidian's names**: "properties", never "frontmatter" or "YAML"; "Markdown" capitalized; "Reading view", "Live Preview" and "Source view" capitalized.
- **The READMEs never mention regular expressions**.

## English

- **American spelling and punctuation**: "color", "-ize", "e.g." without a following comma in hints.

## Russian

- **е for ё**, except where е would change the meaning. Noted in `src/i18n.ts`; `tests/locale-parity.test.ts` enforces it with an allowlist for the exceptions (empty today).
- **Check Obsidian's Russian text first**: when Obsidian's own Russian UI already has a term, use it ("Имя свойства", as in "Имя свойства не может быть пустым.", never "Название свойства").
- **End punctuation follows the English rules** above, in notices and settings alike.
