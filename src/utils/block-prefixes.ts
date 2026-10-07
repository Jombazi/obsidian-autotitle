// Reading view parses inline markup only inside a block's content, so these prefixes come off before inline parsing and a `*` bullet never pairs with an emphasis delimiter.

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
}

const CALLOUT_PREFIX = /^>\s*\[![^\]]+\][-+]?(?:\s+(.*))?$/;
const QUOTE_PREFIX = /^(>\s*)(.*)$/;
const ATX_HEADING_OPENING = /^#{1,6}(?:[ \t]+|$)/;

// Task first, so a task's bullet is never taken for a plain list marker.
const LIST_PREFIXES: ReadonlyArray<[BlockListKind, RegExp]> = [
  ['task', /^(?:[-+*]|\d+[.)]) \[.\] /],
  ['unordered', /^[-+*] /],
  ['ordered', /^\d+[.)] /],
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

function matchListPrefix(
  content: string,
  onlyKind: BlockListKind | undefined,
  nested: boolean
): { kind: BlockListKind; marker: string } | undefined {
  for (const [kind, pattern] of LIST_PREFIXES) {
    if (!nested && kind !== onlyKind) continue;
    const marker = pattern.exec(content)?.[0];
    if (marker !== undefined) return { kind, marker };
  }
  return undefined;
}

// Reading view parses a quote's content, a list item's content and a callout's title as blocks again, so prefixes nest: `> - a`, `- # a` and `> [!note] - a` all render `a`.
// The first level follows the caller's reading of the original line, whose indentation the trimmed `line` no longer shows.
export function splitBlockPrefixes(
  line: string,
  firstListKind: BlockListKind | undefined,
  firstIsHeading: boolean,
  strip: BlockPrefixStripping
): BlockPrefixSplit {
  let keptPrefix = '';
  let content = line;
  for (let nested = false; ; nested = true) {
    // Callout before quote, so the quote step cannot take the callout's `>`.
    const callout = strip.callouts ? CALLOUT_PREFIX.exec(content) : null;
    if (callout) {
      content = callout[1] ?? '';
      continue;
    }
    const quote = QUOTE_PREFIX.exec(content);
    if (quote) {
      if (!strip.quote) keptPrefix += quote[1];
      content = quote[2];
      continue;
    }
    const list = matchListPrefix(content, firstListKind, nested);
    if (list) {
      if (!strip[list.kind]) keptPrefix += list.marker;
      content = content.slice(list.marker.length);
      continue;
    }
    const isHeading = nested
      ? ATX_HEADING_OPENING.test(content)
      : firstIsHeading;
    if (isHeading && strip.headings) content = atxHeadingContent(content);
    return { keptPrefix, content };
  }
}
