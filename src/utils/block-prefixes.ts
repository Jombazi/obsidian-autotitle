// Reading view parses inline markup only inside a block's content, so these prefixes come off before inline parsing and a `*` bullet never pairs with an emphasis delimiter.
// The block grammar lives here alone: the title-source walk, `isValidHeading` and `extractTitle` all read it from this file.

export type BlockListKind = 'task' | 'unordered' | 'ordered';

export interface BlockPrefixStripping {
  callouts: boolean;
  quote: boolean;
  task: boolean;
  unordered: boolean;
  ordered: boolean;
  headings: boolean;
}

export interface BlockPrefixSplit {
  // Prefixes the settings keep, put back verbatim after inline parsing so they stay literal.
  keptPrefix: string;
  content: string;
  // The content is shown as typed — indented code, or a callout's default title — so inline parsing must leave it alone.
  raw: boolean;
  // A heading marker came off, so the content is a heading's, which Reading view parses inline only and never as an HTML block.
  strippedHeading: boolean;
}

// Remark's indentedCode tokenizer runs before every other block tokenizer and opens on an exact leading tab or four leading spaces; any other mix of spaces and tabs is not code (Obsidian 1.14.4, measured).
export const INDENTED_CODE_PREFIX = /^(?:\t| {4})/;

// Remark's atxHeading, list and blockquote tokenizers skip any run of spaces and tabs before their marker; indented code has already taken exact-tab and four-space lines.
export const ATX_HEADING_OPENING = /^[ \t]*#{1,6}(?:[ \t]+|$)/;
// At most one space after `>` belongs to the marker; the rest is block-tokenized again, so indented code can follow it.
export const QUOTE_PREFIX = /^([ \t]*> ?)(.*)$/;
// The callout marker must follow `>` directly or after one space (`>  [!note] t` is a plain quote), and its type stops at the first `|` (app.js 1.14.4, measured).
const CALLOUT_PREFIX = /^[ \t]*> ?\[!([^\]|]+)[^\]]*\][-+]?(?:\s+(.*))?$/;

// Task first, so a task's bullet is never taken for a plain list marker. A marker takes exactly one space or tab, or ends the line (a bare marker is an empty item); Obsidian accepts any digit count.
const LIST_PREFIXES: ReadonlyArray<[BlockListKind, RegExp]> = [
  ['task', /^[ \t]*(?:[-+*]|\d+[.)])[ \t]\[.\] /],
  ['unordered', /^[ \t]*[-+*](?:[ \t]|$)/],
  ['ordered', /^[ \t]*\d+[.)](?:[ \t]|$)/],
];

function isSpaceOrTab(character: string | undefined): boolean {
  return character === ' ' || character === '\t';
}

// Port of remark's atxHeading tokenizer in Obsidian 1.14.4's app.js: a closing run of `#` drops only when whitespace or the opening run sits before it, so `# a #` reads `a` while `# a#` keeps its `#`.
function atxHeadingContent(line: string): string {
  const opening = ATX_HEADING_OPENING.exec(line);
  if (!opening) return line;
  let content = '';
  // Whitespace and `#` runs wait here until a later character proves they are content, not the closing sequence.
  let pending = '';
  let index = opening[0].length;
  while (index < line.length) {
    let character = line[index];
    if (!isSpaceOrTab(character) && character !== '#') {
      content += pending + character;
      pending = '';
      index++;
      continue;
    }
    while (isSpaceOrTab(character)) {
      pending += character;
      character = line[++index];
    }
    if (content !== '' && pending === '' && character === '#') {
      content += character;
      index++;
      continue;
    }
    while (character === '#') {
      pending += character;
      character = line[++index];
    }
    while (isSpaceOrTab(character)) {
      pending += character;
      character = line[++index];
    }
  }
  return content;
}

/** True when the line opens an ATX heading in Reading view: not indented code, then the heading marker. */
export function opensAtxHeading(line: string): boolean {
  return !INDENTED_CODE_PREFIX.test(line) && ATX_HEADING_OPENING.test(line);
}

/** True when the line opens an ATX heading with no content, which Reading view renders as an empty heading. */
export function isEmptyAtxHeading(line: string): boolean {
  return opensAtxHeading(line) && atxHeadingContent(line) === '';
}

/** The list marker a line opens with, including its one separator, or undefined. */
export function matchListMarker(
  content: string
): { kind: BlockListKind; marker: string } | undefined {
  for (const [kind, pattern] of LIST_PREFIXES) {
    const marker = pattern.exec(content)?.[0];
    if (marker !== undefined) return { kind, marker };
  }
  return undefined;
}

// app.js 1.14.4 (remark callout transformer, measured): the type is trimmed, lowercased and has whitespace runs turned into `-`; the default title reads each `-` as a space and uppercases the first character, keeping `_`.
function defaultCalloutTitle(typeText: string): string {
  const type = typeText.trim().toLowerCase().replace(/\s+/g, '-');
  const title = type.replace(/-/g, ' ');
  return title.charAt(0).toUpperCase() + title.slice(1);
}

// Reading view parses a quote's content, a list item's content and a callout's title as blocks again, so prefixes nest: `> - a`, `- # a` and `> [!note] - a` all render `a`.
// Indented code is checked first at every level, as remark runs it before every other tokenizer: `>     - item` and `-     # a` render code.
export function splitBlockPrefixes(
  line: string,
  strip: BlockPrefixStripping
): BlockPrefixSplit {
  let keptPrefix = '';
  let content = line;
  for (;;) {
    const indentedCode = INDENTED_CODE_PREFIX.exec(content);
    if (indentedCode) {
      return {
        keptPrefix,
        content: content.slice(indentedCode[0].length),
        raw: true,
        strippedHeading: false,
      };
    }
    // Callout before quote, so the quote step cannot take the callout's `>`.
    const callout = strip.callouts ? CALLOUT_PREFIX.exec(content) : null;
    if (callout) {
      const title = callout[2] ?? '';
      if (title.trim() === '') {
        return {
          keptPrefix,
          content: defaultCalloutTitle(callout[1]),
          raw: true,
          strippedHeading: false,
        };
      }
      content = title;
      continue;
    }
    // A kept marker loses its indentation, which Reading view never shows.
    const quote = QUOTE_PREFIX.exec(content);
    if (quote) {
      if (!strip.quote) keptPrefix += quote[1].trimStart();
      content = quote[2];
      continue;
    }
    const list = matchListMarker(content);
    if (list) {
      if (!strip[list.kind]) keptPrefix += list.marker.trimStart();
      content = content.slice(list.marker.length);
      continue;
    }
    const strippedHeading = strip.headings && ATX_HEADING_OPENING.test(content);
    if (strippedHeading) {
      content = atxHeadingContent(content);
    }
    return {
      keptPrefix,
      content: content.trimStart(),
      raw: false,
      strippedHeading,
    };
  }
}
