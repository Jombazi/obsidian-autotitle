---
title: Templater integration
description: How the new-note pipeline waits for Templater and acts on the note it leaves — the Templater 2.26.0 behavior it mirrors, the creation decision nodes from templater-enabled to template-cursor, template exclusions, the background-tab path, the creation hold, and a body of only cursor placeholders.
author: 🤖 Generated with Claude Code
updated: 2026-10-16
---
# Templater integration

When Templater fills a new note from a template, the new-note pipeline has to act on the note Templater leaves, not the empty one Obsidian created. `src/core/templater-integration.ts` mirrors the checks Templater 2.26.0 makes before it applies a new-note template, so the pipeline waits for Templater exactly when Templater will fill the note and never holds a note it will not. `FileCreationCoordinator.determineActions` in `src/core/file-creation-coordinator.ts` walks the decision nodes and waits for Templater's event, and `WorkspaceIntegration` in `src/core/workspace-integration.ts` applies the result: through the editor when the note was Templater's active file, through the file when Templater wrote it in a background tab.

## Flow

```
vault create ─ handleFileCreated
  │  holdForCreationPipeline: FLIT's own passes leave the note alone
  ▼
waitForNoteView ─ NEW_NOTE_VIEW_WAIT_MS
  │  no view → created in the background: no actions
  ▼
determineActions
  feature-enabled → path-excluded → content-excluded
  → templater-enabled … regex-template-matches   (will Templater fill the note?)
      │ yes
      ▼
    waitForTemplaterEvent ─ TEMPLATER_EVENT_TIMEOUT_MS from ctime
      → template-wrote-file → template-excluded
      → path-excluded-after-template → template-cursor
  → settings hub → FileCreationActions
  ▼
applyCreationActions
  ├─ viewLagsFile: insertTitle through the file → moveCursorOnceViewReloads
  └─ otherwise:    insertTitle through the editor → delayed cursor pass
  ▼
releaseFromCreationPipeline → scheduleCreationRename
```

## What Templater does for a new note

FLIT mirrors Templater 2.26.0's `on_file_creation` and `write_template_to_file`. The mirror lives in `templater-integration.ts` alone, so a Templater change is fixed in one place.

### Before it applies a template

Templater's `create` handler makes these checks before it chooses a new-note template:

| Check | Templater's rule | FLIT's mirror |
|---|---|---|
| Trigger | Device-local `trigger_on_file_creation` in the `templater-local-settings` local storage entry, read synchronously in the `create` handler. It gates the handler ahead of the trigger mode, so the mode alone does not mean Templater fires | `isTemplaterTriggerOn`, read in `determineActions` after the new-note view wait |
| Templates folder | Skips a path that `includes` the normalized templates folder: a substring test, so `Archive/Templates/x.md` counts | `isInTemplateFolder` |
| Ignored folders | Skips a path that starts with an entry of "Ignore folders on new file creation": a plain prefix test, so `Inbox` also covers `Inbox2/` | `isInTemplaterIgnoredFolder` |
| Sleep | Waits 300 ms | — |
| Empty body | Applies a new-note template only when the file holds no text below its properties, by raw length: a lone line break counts as a body, and Templater then runs its overwrite commands instead | `hasBodyForTemplater`, on the creation snapshot rather than the file |
| Trigger mode | `trigger_on_file_creation_mode` picks which templates apply: `folder`, where the deepest matching folder wins, or `regex` | `templaterTriggerMode`, `folderTemplateMatches`, `fileRegexMatches` |

### How it writes the template

`write_template_to_file` takes one of two branches, chosen before it parses the template:

| Branch | When | Write | Event `content` |
|---|---|---|---|
| Editor | The note is Templater's active file (`activeEditor?.file ?? getActiveFile()`), with an active editor and a `MarkdownView` | Editor `setValue`, then `setSelection(0, 0)`, 100 ms, then a save | The parsed template |
| File | Otherwise, a note in a background tab among them | `vault.process` | The merged note text |

Templater then fires `templater:new-note-from-template` on the workspace with the note's `file` and that `content`.

### The cursor jumper

- **Placeholders**: a template marks cursor positions with `<% tp.file.cursor(N) %>` (`TEMPLATER_CURSOR_PLACEHOLDER`).
- **Runs right after the event**: the jumper runs synchronously after the event fires, only with Templater's "Automatic jump to cursor" on and the note active.
- **Removes what it jumps to**: it deletes the placeholders it jumps to. One it did not jump to, or one left for a later jump (`tp.file.cursor(2)`), stays in the note.

## Decision nodes for a templated note

`determineActions` reaches these nodes after `feature-enabled`, `path-excluded` and `content-excluded` have let the note through. The `FileCreationCoordinator` doc comment is the tree's sole definition, and every branch records `<node>:<outcome>` into `decisionPath`; this table summarizes its Templater nodes.

| Node | Tests | Outcome |
|---|---|---|
| `templater-enabled` | Templater is loaded | N → settings hub |
| `templater-trigger` | The device-local trigger is on | N → settings hub |
| `in-template-folder` | The path holds the templates folder, as Templater tests it | Y → settings hub |
| `in-ignored-folder` | The path starts with a folder Templater ignores on creation | Y → settings hub |
| `body-not-empty` | The creation snapshot holds any text below its properties, whitespace included | Y → settings hub |
| `folder-templates-mode` | The trigger mode is `folder` | Y → `folder-template-matches`, N → `regex-templates-mode` |
| `folder-template-matches` | A folder template matches, walking up from the note's folder | Y → wait, N → settings hub, since Templater never falls back to a file regex in folder mode |
| `regex-templates-mode` | The trigger mode is `regex` | N → settings hub |
| `regex-template-matches` | A file regex matches the path | Y → wait, N → settings hub |
| `templater-event` | Templater's event for this path arrived within the timeout | N → settings hub, judging the creation snapshot |
| `template-wrote-file` | The note was not Templater's active file, so Templater wrote the file (`templaterWroteFile`) | Y → the event's text is judged, and `viewLagsFile` sends the title through the file |
| `template-excluded` | The judged text carries an excluded tag or property | Y → do nothing |
| `path-excluded-after-template` | The path is excluded once the template has run, since Templater can rename or move the note during the wait | Y → do nothing |
| `template-cursor` | Templater's jump removed a cursor placeholder: the view's text holds fewer placeholders than the event's text (`templaterJumpedToCursor`) | Y → settings hub, leaving the cursor where the template put it. Always N after `template-wrote-file:Y` |

- **The judged text**: after `template-wrote-file:N` it is the view's `getViewData()`, read before any await so the placeholder count sees the note as the jumper left it, or the creation snapshot when no view shows the note any more. After `template-wrote-file:Y` it is the event's `content`, since the view still shows older text.
- **The jumper has run when FLIT reads**: the event listener resolves a promise, and the code awaiting it resumes only after the event dispatch returns — after Templater's synchronous jump.
- **Templater chooses its branch early**: in the editor branch Templater reads the condition about 110 ms before the event, while `template-wrote-file` reads it at the event. A tab switch in that window reads Y for an editor write, which is harmless: the title then goes through the file into a view that is current.

### Why wait for the event, not a fixed time

- **The event's time varies**: measured from creation, it arrived at about 0.31 s in a background tab and 0.41 s in the active tab on desktop, and at about 0.55 s on Android. A fixed delay long enough for the slowest case holds every templated note that long; a shorter one acts before Templater does.
- **The event carries the template's text**: `template-cursor` counts placeholders in it, and after a file write it is the only current copy of the note.
- **FLIT acts at once**: title and cursor land within milliseconds of the event.
- **The timeout counts from the file's ctime**: `waitForTemplaterEvent` gives up `TEMPLATER_EVENT_TIMEOUT_MS` (2 s) after `file.stat.ctime`, not after the wait starts, because the new-note view wait has already spent part of it.

## Template exclusions

`template-excluded` re-checks exclusions on the judged text, since a template can add tags or properties the note did not carry at `content-excluded`.

- **Parsed, not cached**: `parseTemplateMetadata` runs the judged text through `metadataCache.computeMetadataAsync`, because the metadata cache indexes the template 4–7 ms after the event, so `getFileCache` still holds the empty note. It falls back to `getFileCache` only when the parse resolves `undefined`, on a metadata worker error. Empty text resolves `{}`, which is judged as it stands.
- **Tags**: a listed tag excludes the note. In "Exclude all except listed" mode, a template that carries tags in the configured scope but none of the listed ones is excluded.
- **Properties by key alone**: a listed property key, by plain name or name pattern, excludes the note; configured values play no part. "Exclude all except listed" mode mirrors the tag rule.

## The background-tab path

After `template-wrote-file:Y`, `FileCreationActions.viewLagsFile` is true: Templater wrote the note through `vault.process`, and the tab's view shows older text until Obsidian reloads it from the file, +1 to +55 ms after the vault `modify` event. `applyCreationActions` then works through the file first and the view last:

1. **Title through the file**: `insertTitle` runs with `writeThroughFile`, so it resolves no view and writes through `vault.process`. An editor write into the stale view would be wiped by its reload.
2. **Line break after a note-ending fence, through the file**: before the cursor pass, `addLineAfterEndingFence` writes the line break below a closing properties fence that ends the note. Written through the editor instead, by `handleCursorPositioning`, it would leave the view unsaved for Obsidian's 2 s save, and a file write in that window raises Obsidian's "modified externally, merging changes automatically" notice.
3. **Cursor once the view shows the file's text**: `moveCursorOnceViewReloads` reads the file, then `waitForNoteView` waits until the view's `getViewData()` equals that text, line breaks normalized, since a view reports a CRLF file with LF line breaks. The wait checks once on entry, because the reload's `editor-change` can fire before the awaited `vault.read` resolves, then listens for `file-open`, `layout-change` and `editor-change`, and gives up after `VIEW_RELOAD_WAIT_MS`.
4. **The cursor lands in the unselected tab**: `handleCursorPositioning` calls `editor.focus()` and `setCursor()`. In a tab that is not shown, focus stays where it was, and the cursor holds until the tab is shown.

For the platform behavior behind each step, see "A vault write reloads the open view" and "Opening a note in a background tab" in `odkb/obsidian-api-quirks.md`.

## The creation hold

- **What it holds off**: `holdForCreationPipeline` marks the note from the `create` event on, with no await before it, and `isFileInCreationWindow` keeps FLIT's own editor-change, focus and event rename passes off the note until `applyCreationActions` has inserted the title and placed or scheduled the cursor.
- **Released before the creation rename**: `handleFileCreated` releases the hold in a `finally`, before `scheduleCreationRename`. That rename reads the finished text, and an edit made while it runs gets a pass of its own.
- **The failure it prevents**: Templater writes its merged text before its event arrives. A rename pass on that raw text named a note whose template body was only a cursor placeholder `Untitled` (measured), since "Strip Templater markup" empties the placeholder line, and `insertTitle` then skips the untitled note.

## Behavior decisions

- **Wait whenever Templater fills the note**: the Templater gates run whatever the exclusion settings are. Without the wait, the template's `setSelection(0, 0)` lands after the title insertion and leaves the cursor at the start of the title line.
- **A template's cursor is kept**: after `template-cursor:Y` the settings hub drops FLIT's cursor moves, while the title decision stands.
- **Except where the title goes**: a template cursor exactly where the title goes — at the body start of an empty body, or on the empty heading line the title fills — ends at the title line end when "Move cursor to first line" and "Place cursor at line end" are both on (`keep-template-cursor`), since CodeMirror would leave it in front of an inserted title. With either off, it stays where CodeMirror maps it.
- **"Place cursor at line end" applies in background tabs too**: `moveCursorOnceViewReloads` passes it to `handleCursorPositioning`.

## A body of only cursor placeholders

Templater leaves its cursor placeholder in the note whenever its jumper does not run: in a background tab, since the jumper runs only for the active note, and in the current tab with "Automatic jump to cursor" off. A body of only placeholders and whitespace counts as no body for the new-note title, whatever "Strip Templater markup" says, since a placeholder is Templater's transient marker, not note content.

- **One test, two readers**: `isOnlyCursorPlaceholders` in `templater-integration.ts` is read by the coordinator's `content-below-yaml` and by `hasBodyContent` in `deriveTitleInsertionPoint`, which the editor path's live re-derivation and the `vault.process` path share.
- **The title goes above the placeholder**: the note ends as its properties, the title, then the placeholder line, which stays for a later jump. The cursor follows the usual rules, in a background tab once its view reloads.
- **The note keeps its name**: the creation rename reads the title as the first line, not the placeholder line, which "Strip Templater markup" empties and which named the note `Untitled` before (measured).
- **Other text makes it a body**: a placeholder beside any other text, on its own line or another, still leaves the note without a title.
- **The rename engine is unchanged**: with "Insert title" off, a placeholder-only first line still names the note as it did.

## Platform references

- **A view's reload after a vault write**, the merge notice and line-break normalization: "A vault write reloads the open view" in `odkb/obsidian-api-quirks.md`.
- **Metadata cache lag after a write**: "The metadata cache lags the write" in `odkb/obsidian-api-quirks.md`.
- **Focus and cursor in a background tab**: "Opening a note in a background tab" in `odkb/obsidian-api-quirks.md`.
- **Why the pipeline reads `getViewData()`**: "Reading view's hidden editor goes stale" in `odkb/obsidian-api-quirks.md`.
- **`computeMetadataAsync`'s result shape**: `odkb/undocumented-obsidian-apis.md`.
