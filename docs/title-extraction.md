---
title: Title extraction
description: How a note's title is built from its text — the title-source walk, block prefixes, the inline tokenizer port and its hidden-element model, the rename engine's title pipeline, and the tag-exclusion check on the title line. Reading view's rendering is the reference throughout.
author: 🤖 Generated with Claude Code
updated: 2026-10-15
---
# Title extraction

A note's title is the text Obsidian's Reading view shows first for the note, turned into a usable file name. Two stages get there. The title-source walk finds which line, or part of a line, the title comes from, skipping the blocks Reading view shows no title text for. Title extraction then reproduces what Reading view renders for that text: it strips block prefixes, runs a port of Obsidian's inline tokenizers, and drops what the browser would hide. The rename engine wraps both with custom replacements, forbidden-character handling and truncation, and the exclusion check reads the same title source for tags Obsidian has not indexed yet.

## Invariant: Reading view is the source of truth

- **Every rule copies a measurement**: each transform aims to yield the text Obsidian 1.14.4's Reading view renders for the line, markup, escapes and code spans included. Where the code cites `app.js`, it ports Obsidian's own tokenizer.
- **A divergence is a defect**: unless it is listed under "Known divergences" below, a title that differs from Reading view is a bug. Measure Reading view's rendering of a case before changing how titles are extracted.
- **Comments carry the evidence**: the rules in `title-source.ts`, `block-prefixes.ts`, `inline-markup.ts` and `element-stack.ts` quote the measured case beside the code.

For the browser rules the hidden-element model reproduces, and how to measure Reading view from the console, see `odkb/reading-view-inline-html.md` and `odkb/undocumented-obsidian-apis.md`.

## Flow

```
note text: editor lines or file text
  │
  ▼
LineSource ─ lineSourceFromEditor / lineSourceFromText
  │
  ▼
findTitleSource ─ title-source.ts
  properties boundary → first non-empty line → block walk
  → TitleSource { text, lineIndex, raw, tagsIndexed }
  │
  ├─► findExcludingList(titleLine: text when tagsIndexed)
  │     └─ fileHasTargetTags → inlineTags(text)
  │
  ▼
onlyRenameIfHeading gate
  │
  ▼
buildTitleFromSource ─ rename-engine.ts
  ├─ applyCustomReplacements ─┐ order set by two settings
  ├─ markup stripping ────────┤
  │    raw    → applyTitleCase
  │    else   → extractTitle ─ title-extraction.ts
  │               opensHtmlBlock(line)
  │               splitBlockPrefixes ─ block-prefixes.ts
  │               renderInlineMarkup ─ inline-markup.ts
  │                 tokenizers → output with markers
  │                 resolveHiddenElements ─ ElementStack (element-stack.ts)
  │               restore protected text → applyTitleCase
  └─ sanitizeTitleForFileName ┘ processForbiddenChars, truncate, Untitled fallback
  │
  ▼
conflict counter → self-reference check → renameFile
```

## Title-source walk

`src/utils/title-source.ts`. Every reader of a title — the rename (`RenameEngine.processFileInternal`, `extractTitleRegion`), the first line property (`FirstLinePropertyManager`) and the editor-change gate (`EditorLifecycleManager.extractFirstLineFromEditor`) — walks the note through `findTitleSource`, so all of them agree on where the properties block ends and which block the title comes from.

- **Lines are read lazily**: a `LineSource` reads one line at a time — from CodeMirror's own line index in an editor (`lineSourceFromEditor`), or by `indexOf` over the text (`lineSourceFromText`) — so a keystroke never joins or splits the whole note. A trailing `\r` is dropped.
- **Properties boundary**: `bodyStartLine` follows `getFrontMatterInfo`: line 0 is exactly `---` and a later line exactly `---` closes the block; otherwise the body starts at line 0. It reads the text, not the cached `frontmatterPosition`, which lags the editor.
- **The walk starts at the first non-empty body line** and tries each block rule in remark's tokenizer order:

| Step | Block | Yields |
|---|---|---|
| 1 | Indented code (exact tab or four spaces) | The line without its indent, as code |
| 2 | Code fence | A card link's `title:` (`embed`, `cardlink`), the fence line as typed when code block stripping is off, a "Diagram" stand-in for `mermaid`, or the first content line as code |
| 3 | Math block (`$$` opener or a one-line `$$…$$`) | A "Math block" stand-in |
| 4 | Horizontal rule | Skipped |
| 5 | Comment block (`%%` or multi-line `<!--`) | Skipped to the closer, or its first inner text when comment markup is unwrapped; text after the closer is the title source |
| 6 | Link reference or footnote definition | Skipped, a footnote with its lazy continuation |
| 7 | Table (header plus delimiter row) | A "Table" stand-in |
| — | Anything else | The whole line |

Steps 2 to 5 and 7 follow their markup-stripping toggles: with one off, the block's first line is the title source, a fence's taken as typed. Every non-empty line skipped leaves a synthetic Untitled, and an unclosed comment block yields Untitled, as Reading view renders nothing after it.

`TitleSource` carries what later stages need:

| Field | Meaning |
|---|---|
| `firstNonEmptyLine` | The first non-empty body line, as typed |
| `text` | What the title is made from |
| `lineIndex` | The line of `text` when it is that whole line; -1 for a stand-in or part of a line, which the cached-link self-reference check skips |
| `raw` | Code or a callout's default title: shown as typed, so markup stripping leaves it alone |
| `tagsIndexed` | Whether Obsidian's metadata cache indexes tags in `text`: true for a body line, a callout title and every part of a `%%` comment; false for code, a card link's title, a stand-in, and text after an HTML comment closer, whose line the cache files as an `html` section |

`sameTitleSource` compares every field but `lineIndex`, so the editor gate notices an edit that leaves the text unchanged while it stops being code.

## Block prefixes

`src/utils/block-prefixes.ts` is the only home of the block grammar; the walk, `isValidHeading` and `extractTitle` all read it from here. `splitBlockPrefixes` peels prefixes in a loop, since Reading view parses a quote's content, a list item's content and a callout's title as blocks again (`> - a`, `- # a` and `> [!note] - a` all render `a`):

1. **Indented code first, at every level**, as remark runs it before every other tokenizer: `>     - item` is code.
2. **Callout before quote**, so the quote step cannot take the callout's `>`. A callout with no title text yields its default title (`[!my-type]` → `My type`), marked `raw`.
3. **Quote, then list markers**: task, unordered, ordered, each taking exactly one separator.
4. **Heading last**: the ATX content follows remark's closing-sequence rule (`# a #` reads `a`, `# a#` keeps its `#`), and `strippedHeading` records that the content is a heading's, which is never an HTML block.

Prefixes the settings keep go into `keptPrefix` without their indentation and are put back verbatim after inline parsing, so they stay literal.

## Title extraction

`extractTitle` in `src/utils/title-extraction.ts` turns one title source into title text:

1. **Templater cursor**: removes `<% tp.file.cursor() %>` and turns a lone `<%*` into Untitled, when that toggle is on.
2. **Empty heading**: `#` alone is Untitled whatever the toggles say.
3. **HTML block check**: `opensHtmlBlock(line)` reads the whole line, prefixes included, since the block structure decides it whatever prefixes the toggles keep.
4. **Block prefixes**: `splitBlockPrefixes` with the toggles' choices. `raw` content gets only title case.
5. **Inline markup**: `renderInlineMarkup` with one option per toggle, `htmlBlock` from step 3, and a `protect` callback.
6. **Protected text**: escapes, decoded character references, code spans, math, links, wikilinks, tags, and the HTML and footnotes a toggle keeps wait behind `⸢FLITESC<n>⸥` placeholders until the edges are trimmed, then return. Every other backslash stays for `processForbiddenChars`.
7. **Empty check and title case**: an empty result is Untitled; `applyTitleCase` runs last.

## Inline tokenizer

`src/utils/inline-markup.ts` ports the inline tokenizers Reading view runs: remark-parse's, as bundled in `app.js` with `gfm` and `commonmark` on, plus Obsidian's highlight, wikilink, inline footnote, footnote reference, tag, math, comment and block ID extensions.

- **First match wins**: at each position `renderTokens` tries the tokenizers in Reading view's order — escape, autolink, URL, email, HTML, wikilink, link, inline footnote, footnote call, reference, strong, emphasis, strikethrough, code span, highlight, tag, math, comment, block ID — so a bare URL swallows the delimiters inside it. Plain text runs to the next possible token start (`TOKEN_START`) and has its character references decoded.
- **Nested runs share state**: link text, bold, italic, strikethrough and highlight content are tokenized again with the same options; link text runs with autolink literals off (`inLink`), as Reading view does.
- **An HTML block line is HTML only**: with `htmlBlock`, only `tokenizeHtml` runs and text ends only at `<`, so escapes, emphasis and block IDs stay literal.
- **Linear time**: `SourceScan` precomputes closer positions for each source once, so a long line of unclosed openers does not go quadratic.

`InlineMarkupOptions`:

| Option | Effect when on |
|---|---|
| `bold`, `italic`, `strikethrough`, `highlight`, `code`, `wikilinks`, `links`, `footnotes`, `math` | The construct shows its rendered text without delimiters |
| `html` | Tags show nothing and hidden elements are resolved; off, tags stay as typed and nothing is hidden |
| `comments` | `remove` drops a `%%` comment, `unwrap` keeps its text, `keep` leaves it as typed |
| `protect` | Wraps text later passes must leave alone |
| `htmlBlock` | The line opens an HTML block: no Markdown is parsed |

The same tokenizers serve two other readers, so a construct inside code or a comment never counts:

- **`markdownLinkDestinations`**: every link and image destination as Reading view resolves it, for the self-reference check.
- **`inlineTags`**: the tags the metadata cache indexes in a line, described under "Tag exclusions on the title line".

## Hidden elements

When `html` is on and the line holds a `<`, the tokenizers write element boundaries into the rendered output as markers instead of resolving them on the spot, since Reading view renders the whole line's Markdown before the browser parses any HTML. Each marker is its index between two sentinels, a private-use character the line itself does not hold (`unusedPrivateUseCharacter`).

| Marker | Written for |
|---|---|
| `open`, `close` | An HTML open or close tag |
| `tag` | A comment, processing instruction or declaration holding a raw-text close tag |
| `alt` | An image whose alt text holds a raw-text close tag |
| `link` | A link kept as typed whose rendered text holds one |
| `constructOpen`, `constructClose` | Bold, italic, link text, strikethrough or highlight, rendered as `strong`, `em`, `a`, `del` or `mark` |

`resolveHiddenElements` then makes one left-to-right pass (`HiddenElementResolution`), keeping text only while it shows:

- **Raw-text elements** — `script`, `style`, `xmp`, `template`, `noscript`, `title`, `iframe`, `noembed`, `noframes` — hide everything up to the first close tag of the same element in the HTML that reached the browser, including one inside a tag's attribute value, a comment, an alt text or a kept link; `plaintext` hides the rest of the line. Inside one, only that close tag counts. What follows the close tag inside a tag or comment is parsed again as HTML; inside an alt text or a kept link it shows as text.
- **Every other element goes through `ElementStack`** in `src/utils/element-stack.ts`, an approximation of the browser's stack of open elements. Each entry records whether it is special or a scope boundary, its namespace (HTML, SVG, MathML) and integration points, whether it hides (`hidden` except `until-found`, an inline `display: none` or `visibility`, `video` and the other hiding elements, `dialog` without `open`, and what Obsidian's sanitizer drops with its content: `foreignObject` and `annotation-xml` in any namespace, and an HTML element named only in SVG or MathML, such as `text`, `g` or `mi` opened outside `svg` and `math` or inside an integration point, while `a`, `font`, `title`, `style` and `script` keep their HTML behavior) or hides unless revealed (`details` without `open` by its first `summary`, `svg` by `text`, `math` by token elements). A running `hidingCount` answers `showsText` without walking the stack.
- **Close tags and construct ends follow the parser's rules**: while the current element is an SVG or MathML one, a close tag pops through the nearest foreign element of its name, special or not, unless an HTML element sits above it, and `</p>` and `</br>` first pop every foreign element above the nearest HTML element or integration point; otherwise the HTML rules apply, matching HTML elements only: block end tags pop through everything above them unless a scope boundary sits above; other end tags never pop through a special element; bold, italic and link text end like formatting elements (closing what sits above them up to the first special element), strikethrough and highlight like ordinary ones. Ignored start tags (`td`, `tr`, `body`, …), void elements, and elements the sanitizer drops (`object`, `embed`, `slot`, `search`, `listing`) hide nothing.

## Rename engine pipeline

`buildTitleFromSource` in `src/core/rename-engine.ts` turns a `TitleSource` into the note's name. Markup stripping is `extractTitle`, or only `applyTitleCase` for a `raw` source. Two settings choose the order:

| Setting | Order |
|---|---|
| `customReplacements.applyAfterForbiddenChars` | Strip markup → sanitize → custom replacements → sanitize again, since a replacement can reintroduce separators or exceed the limit |
| `markupStripping.applyCustomReplacementsAfterMarkupStripping` | Strip markup → custom replacements → sanitize |
| Neither | Custom replacements → strip markup → sanitize |

- **Custom replacements**: `applyCustomReplacementRules` (`src/utils/custom-replacement-rules.ts`) applies each rule as whole-line, start-of-line or everywhere; a result of only whitespace becomes Untitled.
- **Sanitizing**: `sanitizeTitleForFileName` runs `processForbiddenChars` (`src/utils/string-processing.ts`), which replaces or drops each forbidden character and a leading dot by the character replacement settings, trims and collapses whitespace, then truncates to `core.charCount` with an ellipsis, counting the name as it will be saved. An empty result or a Windows reserved name (`CON`, `COM1`, …) becomes Untitled on every platform.
- **Before the title**: with `onlyRenameIfHeading` on, a source that is `raw` or no heading is refused before any title is built.
- **After the title**: a taken name gets a counter (`Title 1`); a title source linking to the note itself blocks the rename; a case-only rename the adapter refuses goes through a temporary name (`renameCaseOnlyThroughTemporaryName`).

The first line property builds its value from the same `TitleSource` in `FirstLinePropertyManager.computeFirstLinePropertyValue`, with its own toggles for custom replacements, markup stripping (`extractTitle`'s `skipMarkupStripping`) and truncation, and no forbidden-character handling.

## Tag exclusions on the title line

The metadata cache re-indexes a note only after its file is saved, so a tag just typed into the title line is missing from `getFileCache()`. Without help, an excluded tag being typed would let the note rename on every keystroke until the re-index.

- **The title line is read directly**: `processFileInternal` passes `titleLine: titleSource.text` to `findExcludingList`, and the first line property to `shouldProcessFile`, but only when `tagsIndexed` is true, so a tag in code, a card link's title or after an HTML comment closer never excludes the note — matching what the cache will index.
- **`fileHasTargetTags` checks it last**: after the properties' tags and the cache's body tags, it tests `inlineTags(titleLine)` against the excluded tags.
- **`inlineTags` mirrors the cache, not the toggles**: it strips every block prefix, returns nothing for code or a line that opens an HTML block, and tokenizes with fixed options: comment text is read (the cache tags `%% #x %%`) and HTML stays as typed, so a hidden element's content is read (the cache tags `a <script>#x</script>`).

## Known divergences

Each was measured, and is left in place on purpose or as a known cost:

- **Reference links**: `[a][1]`, or `[a]` with a definition elsewhere in the note, are not ported, since one line cannot see the note's definitions.
- **Close tags in link destinations**: a raw-text close tag inside a bare link or image destination, a link title, or a wikilink or embed target ends the element in Reading view, followed by the tail of Obsidian's link serialization (`x <script>a [l](u</script>) b</script> c` renders `x " data-href="u" class="internal-link">l b c`). No marker is written there, since each tail would hardcode that serialization.
- **Tree-builder rules `ElementStack` leaves out**, listed with their measured cases in `element-stack.ts`:
  - A block start tag closing the paragraph and everything open in it, which depends on block context `splitBlockPrefixes` cannot report.
  - A start tag that closes an open element of its kind (`p`, `li`, `dd`/`dt`, `option`, `a`, `nobr`, headings), and a nested `form`.
  - Formatting elements the browser reopens after an implicit pop, and a wikilink or tag closing an open `<a hidden>`.
  - Foreign content ended by an HTML breakout start tag, and `mi` text shown in mathematical italic.
  - Text inside a `table` moved before it, and `textarea` and `select` content.
- **One-line comments**: `%%x%%` opens no comment block, so it stays the title source — Untitled with comments stripped entirely, `x` with comment markup unwrapped — though Reading view shows the next line. Deliberate.
- **`inlineTags` on an opener line**: with HTML stripping off and a multi-line `<!--` opener, or math block stripping off, the title source is the opener line, whose tags `inlineTags` reads although the cache does not index them.

## Parity tests

The expected values in these tests are Reading view measurements on Obsidian 1.14.4, or its `app.js` tokenizers where math rendering replaces the text:

| Test file | Covers |
|---|---|
| `tests/utils/title-source.test.ts` | `findTitleSource`, `bodyStartLine`, `sameTitleSource`, and the "Reading view parity" block of whole-note bodies |
| `tests/utils.test.ts` | `extractTitle` and `isValidHeading`: backslashes, math, the "Reading view parity" lines, hidden elements in paragraphs and HTML blocks, embeds |
| `tests/utils/inline-markup.test.ts` | `renderInlineMarkup` (block IDs, sized embeds, hidden elements, elements hidden by CSS or semantics, private-use sentinels, a 100 KB line in linear time), `markdownLinkDestinations`, `opensHtmlBlock`, `inlineTags` |
| `tests/fixtures/inline-markup-reference.ts` | A frozen copy of the tokenizer from before the per-source caches; `inline-markup.test.ts` checks the current one gives the same output |
| `tests/core/rename-engine.test.ts` | The title pipeline as the rename runs it: replacement ordering, title sources, the heading-only gate, self-references, a tag typed into the title line, case-only renames |
