import type { Editor } from 'obsidian';
import { DebugLogger, PluginSettings } from '../types';
import { t } from '../i18n';
import {
  ATX_HEADING_OPENING,
  INDENTED_CODE_PREFIX,
  matchListMarker,
} from './block-prefixes';

// Every reader of a note's title — the rename, the first line property and the editor-change gate — walks the note through this file, so they agree on where the properties block ends and which block the title comes from. Reading view is the reference for each rule.

/** A note's lines, read one at a time so a title lookup touches only the lines it needs. */
export interface LineSource {
  readonly lineCount: number;
  line(index: number): string;
}

/** Where a note's title comes from. */
export interface TitleSource {
  /** The first non-empty line after the properties block, as typed. */
  firstNonEmptyLine: string;
  /** The text the title is made from. */
  text: string;
  /** The absolute line of `text` when it is that whole line; -1 for a synthetic title (`Table`, Untitled) or part of a line (the text after a comment closer, a card link's `title:`), which the cached-link self-reference check skips. */
  lineIndex: number;
  /** The text is shown as typed (code, a callout's default title), so markup stripping leaves it alone. */
  raw: boolean;
  /** Obsidian's metadata cache indexes tags written in `text`: true for a body line, a callout's title and every part of a `%%` comment; false for code, a card link's `title:`, a synthetic title and the text after an HTML comment block's closer, whose line the cache files as an `html` section. */
  tagsIndexed: boolean;
}

/** True when both describe the same title source, `raw` and `tagsIndexed` included: deleting a fence line can leave the text unchanged while it stops being code. */
export function sameTitleSource(
  a: TitleSource | null,
  b: TitleSource | null
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.firstNonEmptyLine === b.firstNonEmptyLine &&
    a.text === b.text &&
    a.raw === b.raw &&
    a.tagsIndexed === b.tagsIndexed
  );
}

function withoutTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Lines of a note's text, found lazily with `indexOf` so the text is never split whole; a trailing `\r` is dropped, as CodeMirror never keeps one. */
export function lineSourceFromText(text: string): LineSource {
  // Start offset of every line read so far
  const lineStarts = [0];
  let reachedEnd = false;
  let totalLines: number | undefined;

  const walkTo = (index: number): void => {
    while (!reachedEnd && lineStarts.length <= index) {
      const newline = text.indexOf('\n', lineStarts[lineStarts.length - 1]);
      if (newline === -1) {
        reachedEnd = true;
      } else {
        lineStarts.push(newline + 1);
      }
    }
  };

  return {
    get lineCount(): number {
      if (totalLines === undefined) {
        // Counts the remaining breaks without recording their offsets, which only lines actually read need.
        let count = lineStarts.length;
        if (!reachedEnd) {
          let newline = text.indexOf('\n', lineStarts[lineStarts.length - 1]);
          while (newline !== -1) {
            count++;
            newline = text.indexOf('\n', newline + 1);
          }
        }
        totalLines = count;
      }
      return totalLines;
    },
    line(index: number): string {
      // One line past the requested one, so its end is known
      walkTo(index + 1);
      if (index < 0 || index >= lineStarts.length) return '';
      const end =
        index + 1 < lineStarts.length ? lineStarts[index + 1] - 1 : text.length;
      return withoutTrailingCarriageReturn(text.slice(lineStarts[index], end));
    },
  };
}

/** Lines of an open editor, read through CodeMirror's own line index so a keystroke never joins the whole note. */
export function lineSourceFromEditor(editor: Editor): LineSource {
  return {
    get lineCount(): number {
      return editor.lineCount();
    },
    line(index: number): string {
      return withoutTrailingCarriageReturn(editor.getLine(index));
    },
  };
}

/** The first line after the properties block, under `getFrontMatterInfo`'s rules (app.js 1.14.4): line 0 is exactly `---` and a later line exactly `---` closes the block; otherwise 0. */
export function bodyStartLine(lines: LineSource): number {
  if (lines.lineCount === 0 || lines.line(0) !== '---') return 0;
  for (let i = 1; i < lines.lineCount; i++) {
    if (lines.line(i) === '---') return i + 1;
  }
  return 0;
}

/** The first non-empty line after the properties block, or -1 when the body holds only blank lines. */
export function firstNonEmptyLineIndex(lines: LineSource): number {
  for (let i = bodyStartLine(lines); i < lines.lineCount; i++) {
    if (lines.line(i).trim() !== '') return i;
  }
  return -1;
}

interface FenceOpener {
  character: string;
  length: number;
}

// Remark's fencedCode tokenizer (app.js 1.14.4): any spaces and tabs (indented code has taken tab- and four-space lines), then three or more backticks or tildes; a backtick in a backtick fence's info string cancels the fence, while tilde fences may hold tildes.
function parseFenceOpener(line: string): FenceOpener | null {
  const match = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const run = match[1];
  if (run[0] === '`' && match[2].includes('`')) return null;
  return { character: run[0], length: run.length };
}

// A closer takes up to three spaces (spaces only), a run of the opener's character at least as long, then only whitespace.
function closesFence(line: string, opener: FenceOpener): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return (
    match !== null &&
    match[1][0] === opener.character &&
    match[1].length >= opener.length
  );
}

// Obsidian 1.14.4's math block tokenizer: up to three spaces (spaces only), two or more `$`, spaces, then text holding no `$`, which is the block's first content line. A one-line `$$…$$` matches nothing here, as Obsidian leaves it to the inline math tokenizer.
const MATH_BLOCK_OPENER = /^ {0,3}\${2,} *[^$]*$/;
// A line that is one whole `$$…$$` formula, which the inline math tokenizer renders as display math: its first `$$` not shielded by a backslash closes it, so `$$a$$ b $$c$$` is no match.
const ONE_LINE_DISPLAY_MATH = /^ {0,3}\$\$(?:\\.|[^$\\]|\$(?!\$))+\$\$[ \t]*$/;

// Remark's thematicBreak: any spaces and tabs, then three or more of one of `*`, `-` or `_`, with spaces or tabs between and after.
const THEMATIC_BREAK =
  /^[ \t]*(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

// Obsidian's comment tokenizer: up to three spaces (spaces only), then `%%` with no `%` anywhere after it on the line, so `%% 50% off` is a paragraph.
const OBSIDIAN_COMMENT_OPENER = /^ {0,3}%%[^%]*$/;

// A link reference definition; a footnote label is not one, as app.js's definition tokenizer refuses `[^`.
const LINK_REFERENCE_DEFINITION = /^[ \t]*\[(?!\^)[^\]]+\]:\s*\S/;
// A footnote definition, whose label holds no whitespace.
const FOOTNOTE_DEFINITION = /^[ \t]*\[\^[^\]\s]+\]:/;

const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;
const HTML_TAG_OPENING = /^<[A-Za-z/!?]/;

/** Columns of indentation, a tab advancing to the next multiple of four. */
function indentColumns(line: string): number {
  let columns = 0;
  for (const character of line) {
    if (character === ' ') columns++;
    else if (character === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

// Obsidian 1.14.4's table tokenizer (remark), which compares no cell counts: the line and the next both hold a `|` past their first character, both or neither start with `|`, and the next line holds only `|`, `-`, `:`, spaces and tabs in at least one cell, an empty cell refused.
function opensTable(lines: LineSource, index: number): boolean {
  if (index + 1 >= lines.lineCount) return false;
  const header = lines.line(index);
  const delimiter = lines.line(index + 1);
  if (header.indexOf('|', 1) === -1 || delimiter.indexOf('|', 1) === -1) {
    return false;
  }
  if ((header[0] === '|') !== (delimiter[0] === '|')) return false;
  if (!/^[|\-: \t]+$/.test(delimiter)) return false;
  return delimiter
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .every((cell) => /^:?-+:?$/.test(cell.trim()));
}

// app.js 1.14.4 `interruptFootnoteDefinition` (measured): the block openers that end a footnote definition's lazy continuation, each tried from the line's first non-whitespace character. A `%%` comment is not among them.
function interruptsFootnoteDefinition(
  lines: LineSource,
  index: number
): boolean {
  const line = lines.line(index).trimStart();
  return (
    parseFenceOpener(line) !== null ||
    MATH_BLOCK_OPENER.test(line) ||
    THEMATIC_BREAK.test(line) ||
    opensTable(lines, index) ||
    ATX_HEADING_OPENING.test(line) ||
    matchListMarker(line) !== undefined ||
    line.startsWith('>') ||
    LINK_REFERENCE_DEFINITION.test(line) ||
    FOOTNOTE_DEFINITION.test(line) ||
    HTML_TAG_OPENING.test(line) ||
    (index + 1 < lines.lineCount &&
      SETEXT_UNDERLINE.test(lines.line(index + 1)))
  );
}

/**
 * The line a footnote definition opened at `definitionIndex` ends before: the first line Reading view renders outside it, or `lines.lineCount`.
 * A line indented four or more columns continues it, and so does paragraph text right after a non-blank line; a line under four columns ends it after a blank line, or when it opens a block.
 */
function footnoteDefinitionEnd(
  lines: LineSource,
  definitionIndex: number
): number {
  let previousLineBlank = false;
  for (let i = definitionIndex + 1; i < lines.lineCount; i++) {
    const line = lines.line(i);
    if (line.trim() === '') {
      previousLineBlank = true;
      continue;
    }
    if (indentColumns(line) < 4) {
      if (previousLineBlank || interruptsFootnoteDefinition(lines, i)) {
        return i;
      }
    }
    previousLineBlank = false;
  }
  return lines.lineCount;
}

/** A comment kind that can span lines: everything from the opener to the closer is hidden in Reading view. */
interface CommentBlockSyntax {
  opener: string;
  closer: string;
}

const OBSIDIAN_COMMENT_BLOCK: CommentBlockSyntax = {
  opener: '%%',
  closer: '%%',
};
const HTML_COMMENT_BLOCK: CommentBlockSyntax = {
  opener: '<!--',
  closer: '-->',
};

/** The comment block a line opens, so the comment runs past the line. */
function commentBlockOpenedBy(line: string): CommentBlockSyntax | null {
  if (OBSIDIAN_COMMENT_OPENER.test(line)) {
    return OBSIDIAN_COMMENT_BLOCK;
  }
  const trimmedLine = line.trim();
  if (trimmedLine.startsWith('<!--') && !trimmedLine.includes('-->')) {
    return HTML_COMMENT_BLOCK;
  }
  return null;
}

/** How a comment block counts toward the title, with the same precedence as `extractTitle`'s comment handling so the line picked here and its rendering agree. */
function commentBlockHandling(
  syntax: CommentBlockSyntax,
  settings: PluginSettings
): 'remove' | 'unwrap' | 'keep' {
  const { stripCommentsEntirely, stripMarkupSettings } =
    settings.markupStripping;
  if (syntax === HTML_COMMENT_BLOCK) {
    return stripMarkupSettings.htmlTags ? 'remove' : 'keep';
  }
  // Settings hides "Strip comments entirely" under "Strip comment markup", so it counts only while that is on.
  if (!stripMarkupSettings.comments) return 'keep';
  return stripCommentsEntirely ? 'remove' : 'unwrap';
}

/** What a block the walk skips yields: a title source, the line the walk resumes at, or Untitled. */
type BlockOutcome =
  | { type: 'title-source'; text: string; lineIndex: number }
  | { type: 'resume-scan'; nextIndex: number }
  | { type: 'untitled' };

/**
 * Resolves a comment block opened at `openerIndex` into the title source it yields, or the line the scan resumes at.
 * Text after the opener on the opener line is inside the comment. With `unwrap`, the first non-blank text inside the comment is the title source.
 * Part of a line (after the opener, before or after the closer) carries line index -1, so the cached-link self-reference check skips it, as it does card-link titles.
 */
function resolveCommentBlock(
  lines: LineSource,
  openerIndex: number,
  syntax: CommentBlockSyntax,
  unwrap: boolean
): BlockOutcome {
  const openerLine = lines.line(openerIndex);
  const textAfterOpener = openerLine.slice(
    openerLine.indexOf(syntax.opener) + syntax.opener.length
  );
  if (unwrap && textAfterOpener.trim() !== '') {
    return { type: 'title-source', text: textAfterOpener, lineIndex: -1 };
  }

  for (let j = openerIndex + 1; j < lines.lineCount; j++) {
    const line = lines.line(j);
    const closerIndex = line.indexOf(syntax.closer);
    if (closerIndex === -1) {
      if (unwrap && line.trim() !== '') {
        return { type: 'title-source', text: line, lineIndex: j };
      }
      continue;
    }

    const textBeforeCloser = line.slice(0, closerIndex);
    if (unwrap && textBeforeCloser.trim() !== '') {
      return { type: 'title-source', text: textBeforeCloser, lineIndex: -1 };
    }
    const textAfterCloser = line.slice(closerIndex + syntax.closer.length);
    if (textAfterCloser.trim() !== '') {
      return { type: 'title-source', text: textAfterCloser, lineIndex: -1 };
    }
    return { type: 'resume-scan', nextIndex: j + 1 };
  }

  // Reading view renders nothing after a comment that never closes
  return { type: 'untitled' };
}

/** A card link's `title:` from the lines after its opener, or null when it has none. */
function cardLinkTitle(lines: LineSource, openerIndex: number): string | null {
  const maxLinesToCheck = 20;
  for (
    let j = openerIndex + 1;
    j < Math.min(lines.lineCount, openerIndex + maxLinesToCheck);
    j++
  ) {
    const cardLine = lines.line(j).trim();
    if (cardLine === '') continue;
    if (cardLine.toLowerCase().startsWith('title:')) {
      let title = cardLine.substring(cardLine.indexOf(':') + 1).trim();
      if (
        (title.startsWith('"') && title.endsWith('"')) ||
        (title.startsWith("'") && title.endsWith("'"))
      ) {
        title = title.substring(1, title.length - 1);
      }
      return title;
    }
    if (cardLine.startsWith('```')) return null;
  }
  return null;
}

/** The first non-blank line inside a fence opened at `openerIndex`, or null when the fence holds none before its closer or the end of the note. */
function firstFencedContentLine(
  lines: LineSource,
  openerIndex: number,
  opener: FenceOpener
): number | null {
  for (let j = openerIndex + 1; j < lines.lineCount; j++) {
    const line = lines.line(j);
    if (closesFence(line, opener)) return null;
    if (line.trim() !== '') return j;
  }
  return null;
}

/**
 * Finds where a note's title comes from, walking the body past the blocks Reading view shows no title text for.
 *
 * @param lines - The whole note, properties block included
 * @param settings - Plugin settings
 * @param debugLog - Receives the walk's debug lines
 * @returns null when the body holds no non-empty line; a synthetic Untitled when every non-empty line is skipped
 */
export function findTitleSource(
  lines: LineSource,
  settings: PluginSettings,
  debugLog?: DebugLogger
): TitleSource | null {
  const firstIndex = firstNonEmptyLineIndex(lines);
  if (firstIndex === -1) return null;

  const firstNonEmptyLine = lines.line(firstIndex);
  const titleSource = (
    text: string,
    lineIndex: number,
    raw: boolean,
    tagsIndexed: boolean
  ): TitleSource => ({ firstNonEmptyLine, text, lineIndex, raw, tagsIndexed });
  // Code holds no indexed tags
  const codeTitle = (text: string, lineIndex: number): TitleSource =>
    titleSource(text, lineIndex, true, false);
  // A card link's title sits in a fenced block, and a stand-in is no text the note holds, so the cache indexes no tag in either
  const syntheticTitle = (text: string): TitleSource =>
    titleSource(text, -1, false, false);
  const log = (message: string, data?: unknown): void => {
    debugLog?.(message, data);
  };
  const markupStripping = settings.markupStripping;

  for (let i = firstIndex; i < lines.lineCount; i++) {
    const line = lines.line(i);
    if (line.trim() === '') continue;

    // 1 Indented code runs before every other block tokenizer, so `    ---` or `    %%` is code, never a rule or a comment.
    const indentedCode = INDENTED_CODE_PREFIX.exec(line);
    if (indentedCode) {
      log('Indented code detected, using its text as typed');
      return codeTitle(line.slice(indentedCode[0].length), i);
    }

    // 2 Code fences
    const fence = parseFenceOpener(line);
    if (fence) {
      const trimmedLine = line.trim();
      // Card links have their own setting and behavior, whatever the code block toggle says.
      const cardLinkMatch = /^```(embed|cardlink)$/.exec(trimmedLine);
      if (markupStripping.grabTitleFromCardLink && cardLinkMatch) {
        const title = cardLinkTitle(lines, i);
        log(
          title === null
            ? `Card link has no title, using ${t('untitled')}`
            : `Found ${cardLinkMatch[1]} card link`,
          { title }
        );
        return syntheticTitle(title ?? t('untitled'));
      }

      if (!markupStripping.stripMarkupSettings.codeBlocks) {
        log('Code fence detected, using the fence line as typed');
        return codeTitle(line, i);
      }

      // Settings shows diagram detection under "Strip code block markup", so it counts only while that is on.
      if (markupStripping.detectDiagrams && trimmedLine === '```mermaid') {
        log(`Mermaid diagram detected, using "${t('diagram')}" as title`);
        return syntheticTitle(t('diagram'));
      }

      const contentIndex = firstFencedContentLine(lines, i, fence);
      log('Code fence detected, using its first line as typed', {
        contentIndex,
      });
      return contentIndex === null
        ? syntheticTitle(t('untitled'))
        : codeTitle(lines.line(contentIndex), contentIndex);
    }

    // 3 Display math takes a stand-in, as tables do, whatever the block holds and whether or not it closes.
    if (
      markupStripping.stripMathBlockMarkup &&
      (MATH_BLOCK_OPENER.test(line) || ONE_LINE_DISPLAY_MATH.test(line))
    ) {
      log(`Math block detected, using "${t('mathBlock')}" as title`);
      return syntheticTitle(t('mathBlock'));
    }

    // 4 Rules
    if (
      markupStripping.stripHorizontalRuleMarkup &&
      THEMATIC_BREAK.test(line)
    ) {
      log('Horizontal rule detected, skipping line');
      continue;
    }

    // 5 Comment blocks. A one-line comment such as `%%x%%` opens no block and stays the title source, which extractTitle reduces to Untitled; deliberate, though Reading view shows the next line.
    const commentSyntax = commentBlockOpenedBy(line);
    const commentHandling = commentSyntax
      ? commentBlockHandling(commentSyntax, settings)
      : 'keep';
    if (commentSyntax && commentHandling !== 'keep') {
      const outcome = resolveCommentBlock(
        lines,
        i,
        commentSyntax,
        commentHandling === 'unwrap'
      );
      log(`Comment block detected (${commentHandling})`, { outcome });
      if (outcome.type === 'resume-scan') {
        // The loop's own increment lands on nextIndex
        i = outcome.nextIndex - 1;
        continue;
      }
      // The cache indexes tags anywhere in a `%%` comment, but files an HTML comment block's closer line, the text after `-->` included, as an `html` section without tags (measured)
      return outcome.type === 'title-source'
        ? titleSource(
            outcome.text,
            outcome.lineIndex,
            false,
            commentSyntax === OBSIDIAN_COMMENT_BLOCK
          )
        : syntheticTitle(t('untitled'));
    }

    // 6 Definitions render nothing
    if (LINK_REFERENCE_DEFINITION.test(line)) {
      log('Link reference definition detected, skipping line');
      continue;
    }
    if (FOOTNOTE_DEFINITION.test(line)) {
      const endIndex = footnoteDefinitionEnd(lines, i);
      log('Footnote definition detected, skipping it', { endIndex });
      // The loop's own increment lands on endIndex
      i = endIndex - 1;
      continue;
    }

    // 7 Tables; a heading takes the line first, as remark tokenizes atxHeading before table.
    if (
      markupStripping.stripTableMarkup &&
      !ATX_HEADING_OPENING.test(line) &&
      opensTable(lines, i)
    ) {
      log(`Table detected, using "${t('table')}" as title`);
      return syntheticTitle(t('table'));
    }

    return titleSource(line, i, false, true);
  }

  return syntheticTitle(t('untitled'));
}
