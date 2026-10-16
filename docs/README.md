---
title: Doc index
description: Index of all project docs — when and why to read each one.
author: 🤖 Generated with Claude Code
updated: 2026-10-16
---
# Doc index

> [!important]
> While an effort is made to keep these docs continuously up to date, all content is generated with Claude Code and may contain inaccuracies — verify important information against source code.

Cross-plugin knowledge docs (platform quirks, Obsidian API gotchas, Electron/CSS rendering issues) live in a [shared repository](https://github.com/churnish/odkb).

| Doc | Read before |
|---|---|
| [title-extraction.md](title-extraction.md) | Changing how a note's title is found or built — documents the title-source walk, block prefixes, the inline tokenizer port and its options, hidden-element markers and the element stack, the rename engine's title pipeline, the tag-exclusion check on the title line, the known divergences from Reading view, and where the parity tests live. |
| [templater-integration.md](templater-integration.md) | Changing how new notes are handled around Templater — documents the Templater 2.26.0 behavior FLIT mirrors, the creation decision nodes from `templater-enabled` to `template-cursor`, the background-tab path, template exclusions, the creation hold, and a body of only cursor placeholders. |
| [copy-style.md](copy-style.md) | Writing or changing any user-facing text — settings, dialogs, notices, command names or the READMEs, in English or Russian — documents notice punctuation, quote styles, counts, refusal reasons, and the settled term choices in both languages. |
| [release-guide.md](release-guide.md) | Running a release, bumping versions, or troubleshooting the release pipeline — documents the full npm version lifecycle, GitHub Action build, and rollback procedures. |
