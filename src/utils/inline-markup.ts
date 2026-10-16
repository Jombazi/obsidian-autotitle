// Port of the inline tokenizers Obsidian 1.14's Reading view runs (the remark-parse tokenizers bundled in its app.js, with `gfm` and `commonmark` on, plus Obsidian's highlight, wikilink, inline footnote, footnote reference, tag, math, comment and block ID extensions), so a title keeps exactly the characters Reading view shows: escapes, autolinks, bare URLs and emails, inline HTML, wikilinks, links and images, footnotes, bold, italic, strikethrough, code spans, highlights, tags, math, `%%` comments, block IDs and the character references in plain text.
// Not ported: reference links (`[a][1]`, or `[a]` with a definition elsewhere in the note), since one line cannot see the note's definitions.

import { decodeCharacterReferences } from './character-references';
import { BlockPrefixStripping, splitBlockPrefixes } from './block-prefixes';
import { ConstructElement, ElementStack } from './element-stack';

export interface InlineMarkupOptions {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  highlight: boolean;
  code: boolean;
  wikilinks: boolean;
  links: boolean;
  html: boolean;
  footnotes: boolean;
  math: boolean;
  comments: 'remove' | 'unwrap' | 'keep';
  // Stands in for text the passes after this one must leave alone: escaped characters, decoded references, code spans, math, links Reading view finds on its own, wikilinks, links and images, tags, and the HTML and footnotes a toggle keeps.
  protect: (text: string) => string;
  // True when the line opens an HTML block (`opensHtmlBlock`), which Reading view hands to the browser as typed, so no Markdown is parsed on the line: only tags, comments, raw-text elements (each ending at its first literal close tag) and character references are read; optional, so a caller without block context reads the line as a paragraph.
  htmlBlock?: boolean;
}

// Reading view tokenizes the text of a link or reference with its autolink-literal tokenizers off, so a URL there is parsed for markup like any other text.
interface TokenizerOptions extends InlineMarkupOptions {
  inLink: boolean;
  // Shared by every nested `renderTokens` of one line, so a hidden element opened outside a construct pairs with a close tag inside it.
  hiddenElementMarkers: HiddenElementMarkers;
  // Receives every link and image destination as remark resolves it, for `markdownLinkDestinations`.
  onLinkDestination?: (destination: string) => void;
  // Receives every tag with its `#`, for `inlineTags`.
  onTag?: (tag: string) => void;
}

/** An element boundary in the rendered line, which `resolveHiddenElements` applies once the whole line is rendered. */
type HiddenElementMarker =
  // An HTML open tag; `raw` is the tag as typed, since a raw-text element's close tag inside it ends that element first.
  | { kind: 'open'; name: string; raw: string }
  | { kind: 'close'; name: string }
  // Any other HTML token holding a raw-text element's close tag (in a comment, a processing instruction or a declaration), shown as `normal` outside a raw-text element.
  | { kind: 'tag'; raw: string; normal: string }
  // An image whose resolved alt text holds one; `raw` is that alt and the `">` the browser receives after it, as alt is the image tag's last attribute.
  | { kind: 'alt'; raw: string; normal: string }
  // A link kept as typed whose text, as Reading view renders it, holds one; `raw` is the link as typed.
  | { kind: 'link'; raw: string; normal: string }
  // A construct Reading view renders as an element (bold, italic, strikethrough, highlight, link text), which decides how its end closes; its end names the index of its start.
  | { kind: 'constructOpen'; element: ConstructElement }
  | { kind: 'constructClose'; open: number };

/** The markers of one line, each written into the rendered output as its index between two sentinels, so a marker's text never needs delimiting. */
class HiddenElementMarkers {
  private readonly markers: HiddenElementMarker[] = [];

  // Construct markers matter only beside an element marker, which only a `<` in the line can produce, so a line without one renders without them.
  constructor(
    readonly sentinel: string,
    private readonly tracksConstructs: boolean
  ) {}

  emit(marker: HiddenElementMarker): string {
    this.markers.push(marker);
    return `${this.sentinel}${this.markers.length - 1}${this.sentinel}`;
  }

  // The construct's markers sit inside any delimiters a toggle keeps, which Reading view never shows.
  wrapConstruct(content: string, element: ConstructElement): string {
    if (!this.tracksConstructs) return content;
    const open = this.markers.length;
    return (
      this.emit({ kind: 'constructOpen', element }) +
      content +
      this.emit({ kind: 'constructClose', open })
    );
  }

  get(index: number): HiddenElementMarker | undefined {
    return this.markers[index];
  }
}

interface InlineToken {
  end: number;
  output: string;
  // Set by an `<a …>` or `</a>` tag, which switches link context for every token after it.
  inLink?: boolean;
}

type InlineTokenizer = (
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
) => InlineToken | undefined;

// CommonMark's escapable set, which Reading view uses: every ASCII punctuation character and nothing else.
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
// remark's `unescape` under commonmark drops a backslash before the same set, and before a line feed.
const ESCAPED_CHARACTER = /\\([!-/:-@[-`{-~\n])/g;
const WHITESPACE = /\s/;
const WORD_CHARACTER = /\w/;
const NON_WHITESPACE = /\S/g;

const AT_SIGN = 0x40;
const BACKSLASH = 0x5c;
const DASH = 0x2d;
const DOLLAR = 0x24;
const DOT = 0x2e;
const PLUS = 0x2b;
const SPACE = 0x20;
const TAB = 0x09;
const UNDERSCORE = 0x5f;

const NO_POSITION = -1;

// remark's autolink-literal tokenizers test ASCII only, through is-decimal and is-alphabetical.
function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

function isAsciiAlphanumeric(code: number): boolean {
  return isAsciiDigit(code) || isAsciiLetter(code);
}

// Obsidian's block ID grammar (app.js 1.14.4 `blockid`, `/^\^([a-zA-Z0-9\-]+)$/`): `^` and a run of ASCII letters, digits and `-`.
function isBlockIdCharacter(code: number): boolean {
  return isAsciiAlphanumeric(code) || code === DASH;
}

// A single `$` closes math only when no space or tab comes before it and no digit after it.
function isInlineMathCloser(source: string, index: number): boolean {
  const previousCode = source.charCodeAt(index - 1);
  return (
    source.charCodeAt(index) === DOLLAR &&
    previousCode !== SPACE &&
    previousCode !== TAB &&
    !isAsciiDigit(source.charCodeAt(index + 1))
  );
}

// Obsidian 1.14's highlight color markers in circle and square form, as its own lookup table accepts both.
const HIGHLIGHT_COLOR_MARKERS = new Set([
  '\u{1F534}',
  '\u{1F7E5}',
  '\u{1F7E0}',
  '\u{1F7E7}',
  '\u{1F7E1}',
  '\u{1F7E8}',
  '\u{1F7E2}',
  '\u{1F7E9}',
  '\u{1F535}',
  '\u{1F7E6}',
  '\u{1F7E3}',
  '\u{1F7EA}',
]);

// Obsidian's `ilink` refuses a target holding `[[` in a separate check; refusing it in the pattern ends each attempt at the next opener instead of at the farthest `]]`.
const WIKILINK = /(!?)\[\[((?:(?!\[\[).)+?)\]\]/y;
const COMMENT = /%%(.*?)%%/y;
// Obsidian reads the display text after an embed's last `|` as a size when it is one (app.js `Jg`, `Zg`), and an embed left without alt text falls back to its file name.
const EMBED_SIZE = /^\s*\d+\s*(?:x\s*\d+\s*)?$/;
// Obsidian's tag grammar (app.js 1.14.4): `#` and a run of anything but whitespace, the listed ASCII punctuation and two Unicode punctuation blocks.
const TAG = /#[^\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s]+/y;
const ALL_DIGIT_TAG = /^#\d+$/;

// A bare URL's path never ends on these, so trailing punctuation stays outside the link.
const URL_TRAILING_PUNCTUATION = new Set([
  '!',
  '*',
  ',',
  '.',
  ':',
  '?',
  '_',
  '~',
]);

// Every position a tokenizer below can start at, except an email's, which `locateEmail` finds, and a block ID's, which `SourceScan` finds; plain text runs up to the nearest one, so a delimiter inside a word still gets its turn.
// The URL locator is case-sensitive while its tokenizer is not, so `HTTPS://` links only where something else ended the text before it.
// Obsidian's tag locator accepts only a `#` after whitespace; `nextTokenStart` tests the character before each `#` in code, as a lookbehind would fail to parse on iOS before 16.4, and a refused `#` stays inside the text run, so a reference such as `&#35;` still decodes whole.
const TOKEN_START = /\\|!?\[|[*_`$<]|~~|==|%%|www\.|https?:\/\/|#|\^\[/g;

function keepDelimiters(
  strip: boolean,
  delimiter: string,
  content: string
): string {
  return strip ? content : delimiter + content + delimiter;
}

function firstNonWhitespaceIndex(source: string, from: number): number {
  NON_WHITESPACE.lastIndex = from;
  return NON_WHITESPACE.exec(source)?.index ?? source.length;
}

// The stop of the last stretch scanned, for a scan whose stop test reads only the characters at the stop: a later scan starting inside the stretch ends at the same stop, so a line of repeated starts walks each stretch once.
class StretchStops {
  private stretchStart = 0;
  private stop = NO_POSITION;

  constructor(
    private readonly source: string,
    private readonly isStop: (index: number) => boolean
  ) {}

  stopFrom(from: number): number {
    if (from >= this.stretchStart && from <= this.stop) return this.stop;
    let index = from;
    while (index < this.source.length && !this.isStop(index)) index++;
    this.stretchStart = from;
    this.stop = index;
    return index;
  }
}

// For every start, the first position at or after it whose character `isStop` accepts, or `source.length` when none; with `skipsEscapes`, a backslash hides the character after it.
function firstStopPositions(
  source: string,
  isStop: (character: string, index: number) => boolean,
  skipsEscapes: boolean
): Int32Array {
  const length = source.length;
  const positions = new Int32Array(length + 2).fill(length);
  for (let index = length - 1; index >= 0; index--) {
    const character = source[index];
    if (isStop(character, index)) {
      positions[index] = index;
    } else if (skipsEscapes && character === '\\') {
      positions[index] = positions[Math.min(index + 2, length)];
    } else {
      positions[index] = positions[index + 1];
    }
  }
  return positions;
}

// remark's link-text scan (app.js `link`) from every start at once: the first `]` at depth 0, a backslash hiding the character after it and, under gfm, backticks counting for nothing; `source.length` when none.
// Built right to left in one pass, a nested `[` jumps past its own closer, so each answer is exact for any start and a line of unclosed `[` costs linear time instead of a depth walk from every opener.
function linkTextClosers(source: string): Int32Array {
  const length = source.length;
  const closers = new Int32Array(length + 2).fill(length);
  for (let index = length - 1; index >= 0; index--) {
    const character = source[index];
    if (character === ']') {
      closers[index] = index;
    } else if (character === '\\') {
      closers[index] = closers[Math.min(index + 2, length)];
    } else if (character === '[') {
      const nestedCloser = closers[index + 1];
      closers[index] =
        nestedCloser === length ? length : closers[nestedCloser + 1];
    } else {
      closers[index] = closers[index + 1];
    }
  }
  return closers;
}

// remark-style scan of Obsidian's `inlineNote` (app.js) from every start at once: as `linkTextClosers`, except that a backtick run opens code that only a later run of the same length closes, and inside code neither brackets nor backslashes count.
// A run is measured forward from where the scan meets it, and the closing run is always a whole run, since the scan only meets backticks after a non-backtick or right past a whole run.
function inlineNoteClosers(source: string): Int32Array {
  const length = source.length;
  const closers = new Int32Array(length + 2).fill(length);
  const nearestRunStartByLength = new Map<number, number>();
  let runLength = 0;
  for (let index = length - 1; index >= 0; index--) {
    const character = source[index];
    if (character === '`') {
      runLength++;
      const closingRunStart = nearestRunStartByLength.get(runLength);
      closers[index] =
        closingRunStart === undefined
          ? length
          : closers[closingRunStart + runLength];
      if (source[index - 1] !== '`') {
        nearestRunStartByLength.set(runLength, index);
      }
      continue;
    }
    runLength = 0;
    if (character === ']') {
      closers[index] = index;
    } else if (character === '\\') {
      closers[index] = closers[Math.min(index + 2, length)];
    } else if (character === '[') {
      const nestedCloser = closers[index + 1];
      closers[index] =
        nestedCloser === length ? length : closers[nestedCloser + 1];
    } else {
      closers[index] = closers[index + 1];
    }
  }
  return closers;
}

// remark's bare link destination (app.js `link`) from every start at once: it ends at whitespace or at a `)` that closes no `(` opened after the start, and a backslash takes the next character whatever it is.
function bareDestinationEnds(source: string): Int32Array {
  const length = source.length;
  const ends = new Int32Array(length + 2).fill(length);
  for (let index = length - 1; index >= 0; index--) {
    const character = source[index];
    if (character === ')' || WHITESPACE.test(character)) {
      ends[index] = index;
    } else if (character === '\\') {
      ends[index] = ends[Math.min(index + 2, length)];
    } else if (character === '(') {
      const nestedEnd = ends[index + 1];
      ends[index] = source[nestedEnd] === ')' ? ends[nestedEnd + 1] : nestedEnd;
    } else {
      ends[index] = ends[index + 1];
    }
  }
  return ends;
}

function isAutolinkSchemeStop(source: string, index: number): boolean {
  const character = source[index];
  return (
    WHITESPACE.test(character) ||
    character === '>' ||
    character === '@' ||
    (character === ':' && source[index + 1] === '/')
  );
}

// What one `renderTokens` source tells every tokenizer attempt, computed once: the last position each closer test accepts, and caches for the scans that would otherwise restart from many positions of the same stretch.
// Positions only grow within one `renderTokens` call, which the forward caches rely on; the tables are built on first use and answer for any start.
class SourceScan {
  // An opener whose search passes the last position its closer test accepts can never close, so it gives up there instead of at the end of the line.
  readonly emphasisBound: Record<string, number> = {
    '*': NO_POSITION,
    _: NO_POSITION,
  };
  readonly strongBound: Record<string, number> = {
    '*': NO_POSITION,
    _: NO_POSITION,
  };
  readonly doubledBound: Record<string, number> = {
    '~': NO_POSITION,
    '=': NO_POSITION,
  };
  readonly displayMathBound: number;
  readonly commentBound: number;
  readonly tagCloseBound: number;
  readonly processingInstructionBound: number;
  readonly cdataBound: number;
  // A block ID must run to the end of the source, so only the `^` right before the trailing run of block ID characters can start one.
  readonly blockIdStart: number;
  // Obsidian's block ID locator ends text only at a `^` after whitespace; a block ID right after another token needs no stop, as tokens are tried there anyway.
  private readonly blockIdTextStop: number;

  readonly autolinkSchemeStops: StretchStops;
  readonly autolinkRestStops: StretchStops;
  readonly footnoteLabelStops: StretchStops;

  private emailStart: number | undefined;
  private emailAt = NO_POSITION;
  private emailRunStart = 0;
  private emailRunEnd = 0;
  private emailDomainAt = NO_POSITION;
  private emailDomainEnd = NO_POSITION;

  private tokenStart = NO_POSITION;
  private tokenSearchExhausted = false;

  private failedDomainFrom = 1;
  private failedDomainUntil = 0;

  private backtickRunEndTable: Int32Array | undefined;
  private readonly lastCodeRunEndByLength = new Map<number, number>();
  private inlineMathCloserTable: Int32Array | undefined;
  private linkTextCloserTable: Int32Array | undefined;
  private inlineNoteCloserTable: Int32Array | undefined;
  private bareDestinationEndTable: Int32Array | undefined;
  private nonWhitespaceTable: Int32Array | undefined;
  private angleDestinationStopTable: Int32Array | undefined;
  private readonly titleCloserTables = new Map<string, Int32Array>();

  constructor(readonly source: string) {
    this.displayMathBound = source.lastIndexOf('$$');
    this.commentBound = source.lastIndexOf('%%');
    this.tagCloseBound = source.lastIndexOf('>');
    this.processingInstructionBound = source.lastIndexOf('?>');
    this.cdataBound = source.lastIndexOf(']]>');
    for (let index = source.length - 1; index >= 0; index--) {
      const character = source[index];
      const previous = source.charAt(index - 1);
      const next = source.charAt(index + 1);
      if (character === '*' || character === '_') {
        if (
          this.emphasisBound[character] === NO_POSITION &&
          next !== character &&
          previous !== character &&
          !(character === '_' && WORD_CHARACTER.test(next))
        ) {
          this.emphasisBound[character] = index;
        }
        if (
          this.strongBound[character] === NO_POSITION &&
          next === character &&
          source[index + 2] !== character
        ) {
          this.strongBound[character] = index;
        }
      } else if (character === '~' || character === '=') {
        if (
          this.doubledBound[character] === NO_POSITION &&
          next === character &&
          !WHITESPACE.test(previous)
        ) {
          this.doubledBound[character] = index;
        }
      }
    }
    let blockIdRunStart = source.length;
    while (
      blockIdRunStart > 0 &&
      isBlockIdCharacter(source.charCodeAt(blockIdRunStart - 1))
    ) {
      blockIdRunStart--;
    }
    this.blockIdStart =
      blockIdRunStart < source.length && source[blockIdRunStart - 1] === '^'
        ? blockIdRunStart - 1
        : NO_POSITION;
    this.blockIdTextStop =
      this.blockIdStart > 0 && WHITESPACE.test(source[this.blockIdStart - 1])
        ? this.blockIdStart
        : source.length;
    this.autolinkSchemeStops = new StretchStops(source, (index) =>
      isAutolinkSchemeStop(source, index)
    );
    this.autolinkRestStops = new StretchStops(
      source,
      (index) => WHITESPACE.test(source[index]) || source[index] === '>'
    );
    this.footnoteLabelStops = new StretchStops(source, (index) => {
      const character = source[index];
      return (
        character === ']' ||
        character === ' ' ||
        character === '\t' ||
        character === '\n'
      );
    });
  }

  // remark's email locator, reused while the start it found is still ahead: no `@` before that start had a local-part character before it, whichever later position the search starts from.
  // A search starting inside the local-part run of the `@` found last finds that `@` again, with the run cut at the search start, so the run is never walked back again.
  nextEmailStart(from: number): number {
    if (this.emailStart === NO_POSITION) return NO_POSITION;
    if (this.emailStart !== undefined && from <= this.emailStart) {
      return this.emailStart;
    }
    if (this.emailStart !== undefined && from < this.emailAt) {
      this.emailStart = from;
      return from;
    }
    this.emailStart = locateEmail(this.source, from);
    if (this.emailStart !== NO_POSITION) {
      this.emailAt = this.source.indexOf('@', this.emailStart);
    }
    return this.emailStart;
  }

  // Once the locator finds no email past some position, no later attempt can match one.
  get emailSearchExhausted(): boolean {
    return this.emailStart === NO_POSITION;
  }

  // The end of the local-part run that starts at `start`; a start inside the run walked last ends where that run ended.
  emailLocalPartEnd(start: number): number {
    if (start >= this.emailRunStart && start < this.emailRunEnd) {
      return this.emailRunEnd;
    }
    let index = start;
    while (isEmailLocalCharacter(this.source.charCodeAt(index))) index++;
    this.emailRunStart = start;
    this.emailRunEnd = index;
    return index;
  }

  // The domain after an `@` decides an email whichever local-part start reached it, so each `@` is walked once.
  emailEnd(atIndex: number): number {
    if (atIndex !== this.emailDomainAt) {
      this.emailDomainAt = atIndex;
      this.emailDomainEnd = scanEmailDomain(this.source, atIndex);
    }
    return this.emailDomainEnd;
  }

  // A search that found a token start still at or past `from` finds the same one again, and a search that found none is final for this source.
  nextTokenStart(from: number): number {
    const emailStart = this.nextEmailStart(from);
    if (!this.tokenSearchExhausted && this.tokenStart < from) {
      TOKEN_START.lastIndex = from;
      let match = TOKEN_START.exec(this.source);
      // The character before the search start belongs to the current text, so the test sees what Obsidian's locator sees.
      while (
        match &&
        match[0] === '#' &&
        !WHITESPACE.test(this.source.charAt(match.index - 1))
      ) {
        match = TOKEN_START.exec(this.source);
      }
      if (match) this.tokenStart = match.index;
      else this.tokenSearchExhausted = true;
    }
    const tokenStart = this.tokenSearchExhausted
      ? this.source.length
      : this.tokenStart;
    const stop =
      emailStart === NO_POSITION
        ? tokenStart
        : Math.min(tokenStart, emailStart);
    return this.blockIdTextStop >= from
      ? Math.min(stop, this.blockIdTextStop)
      : stop;
  }

  // A `www.` start inside a domain stretch that already failed on `_` reaches the same stop and the same last two labels while it starts before the second-to-last dot, so it fails the same way.
  isInsideFailedDomain(domainStart: number): boolean {
    return (
      domainStart >= this.failedDomainFrom &&
      domainStart <= this.failedDomainUntil
    );
  }

  rememberFailedDomain(domainStart: number, secondToLastDot: number): void {
    this.failedDomainFrom = domainStart;
    this.failedDomainUntil = secondToLastDot;
  }

  // One right-to-left pass records the position right after the run through each backtick and the last run of each length; a failed code span hands every later backtick of its run its own attempt, and walking the run again from each one made a long run quadratic.
  private backtickRunEnds(): Int32Array {
    if (this.backtickRunEndTable) return this.backtickRunEndTable;
    const source = this.source;
    const runEnds = new Int32Array(source.length + 1);
    for (let index = source.length - 1; index >= 0; index--) {
      if (source[index] !== '`') continue;
      runEnds[index] =
        source[index + 1] === '`' ? runEnds[index + 1] : index + 1;
      const runLength = runEnds[index] - index;
      if (
        source[index - 1] !== '`' &&
        !this.lastCodeRunEndByLength.has(runLength)
      ) {
        this.lastCodeRunEndByLength.set(runLength, runEnds[index] - 1);
      }
    }
    this.backtickRunEndTable = runEnds;
    return runEnds;
  }

  // The position right after the backtick run through `index`, so an opener at any offset into a run reads its length as the difference.
  backtickRunEnd(index: number): number {
    return this.backtickRunEnds()[index];
  }

  // A code span closes only on a whole backtick run of its opener's length, so the last such run bounds its search, and every backtick of a long run that opens no span fails at once instead of scanning to the line's last backtick.
  lastCodeRunEnd(runLength: number): number {
    this.backtickRunEnds();
    return this.lastCodeRunEndByLength.get(runLength) ?? NO_POSITION;
  }

  // Each `$` opener reads its closer here instead of walking towards the last candidate, which made a line of openers whose candidates are all escaped quadratic.
  nextInlineMathCloser(from: number): number {
    this.inlineMathCloserTable ??= firstStopPositions(
      this.source,
      (_character, index) => isInlineMathCloser(this.source, index),
      true
    );
    return this.inlineMathCloserTable[Math.min(from, this.source.length)];
  }

  linkTextCloser(textStart: number): number {
    this.linkTextCloserTable ??= linkTextClosers(this.source);
    return this.linkTextCloserTable[textStart];
  }

  inlineNoteCloser(contentStart: number): number {
    this.inlineNoteCloserTable ??= inlineNoteClosers(this.source);
    return this.inlineNoteCloserTable[contentStart];
  }

  bareDestinationEnd(start: number): number {
    this.bareDestinationEndTable ??= bareDestinationEnds(this.source);
    return this.bareDestinationEndTable[start];
  }

  nextNonWhitespace(from: number): number {
    this.nonWhitespaceTable ??= firstStopPositions(
      this.source,
      (character) => !WHITESPACE.test(character),
      false
    );
    return this.nonWhitespaceTable[Math.min(from, this.source.length)];
  }

  // A `<…>` destination runs to the first `>` with no escapes, and a line feed before it fails the link.
  angleDestinationStop(from: number): number {
    this.angleDestinationStopTable ??= firstStopPositions(
      this.source,
      (character) => character === '>' || character === '\n',
      false
    );
    return this.angleDestinationStopTable[Math.min(from, this.source.length)];
  }

  nextUnescaped(closer: string, from: number): number {
    let table = this.titleCloserTables.get(closer);
    if (!table) {
      table = firstStopPositions(
        this.source,
        (character) => character === closer,
        true
      );
      this.titleCloserTables.set(closer, table);
    }
    return table[Math.min(from, this.source.length)];
  }
}

function tokenizeEscape(
  source: string,
  start: number,
  options: TokenizerOptions
): InlineToken | undefined {
  const escaped = source.charAt(start + 1);
  if (source[start] !== '\\' || !ASCII_PUNCTUATION.test(escaped)) {
    return undefined;
  }
  return { end: start + 2, output: options.protect(escaped) };
}

// A link's text is decoded but never parsed for markup.
function protectLinkText(text: string, options: TokenizerOptions): string {
  return options.protect(decodeCharacterReferences(text, (decoded) => decoded));
}

// remark's `decode.raw(unescape(…))`, which an image's alt text and a link's destination go through.
function resolveRawText(text: string): string {
  return decodeCharacterReferences(
    text.replace(ESCAPED_CHARACTER, '$1'),
    (decoded) => decoded
  );
}

const MAILTO = 'mailto:';

// Port of remark's `autoLink` tokenizer: `<scheme://…>` or `<local@domain>` shows without its angle brackets, and an email without a leading `mailto:`.
function tokenizeAutolink(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  if (
    options.inLink ||
    source[start] !== '<' ||
    scan.tagCloseBound < start + 2
  ) {
    return undefined;
  }
  const index = scan.autolinkSchemeStops.stopFrom(start + 1);
  if (index === start + 1) return undefined;
  const isEmail = source[index] === '@';
  // A scheme needs `://`, and its second `/` already belongs to the rest, so `<https://>` still links.
  let restStart: number;
  if (isEmail) {
    restStart = index + 1;
  } else if (source[index] === ':' && source[index + 2] === '/') {
    restStart = index + 2;
  } else {
    return undefined;
  }
  const end = scan.autolinkRestStops.stopFrom(restStart);
  if (end === restStart || source[end] !== '>') return undefined;
  let shown = source.slice(start + 1, end);
  if (isEmail && shown.slice(0, MAILTO.length).toLowerCase() === MAILTO) {
    shown = shown.slice(MAILTO.length);
  }
  return { end: end + 1, output: protectLinkText(shown, options) };
}

function urlSchemeLength(source: string, start: number): number {
  if (source.startsWith('www.', start)) return 4;
  const scheme = source.slice(start, start + 8).toLowerCase();
  if (scheme.startsWith('http://')) return 7;
  return scheme === 'https://' ? 8 : 0;
}

function isUrlDomainCharacter(code: number): boolean {
  return isAsciiAlphanumeric(code) || code === DASH || code === UNDERSCORE;
}

function countCharacter(text: string, character: string): number {
  return text.split(character).length - 1;
}

// remark drops a closing `)` while the path holds more closers than openers, so a URL in parentheses leaves the outer one as text.
function trimUnbalancedParentheses(
  source: string,
  pathStart: number,
  end: number
): number {
  if (source[end - 1] !== ')') return end;
  let path = source.slice(pathStart, end);
  const openers = countCharacter(path, '(');
  let closers = countCharacter(path, ')');
  while (closers > openers) {
    end = pathStart + path.lastIndexOf(')');
    path = source.slice(pathStart, end);
    closers--;
  }
  return end;
}

// A final `;` always drops, and so does the named reference it ends, so `&amp;` after a URL decodes as text instead.
function trimTrailingSemicolon(source: string, end: number): number {
  if (source[end - 1] !== ';') return end;
  end--;
  if (!isAsciiLetter(source.charCodeAt(end - 1))) return end;
  let referenceStart = end - 2;
  while (isAsciiLetter(source.charCodeAt(referenceStart))) referenceStart--;
  return source[referenceStart] === '&' ? referenceStart : end;
}

// Port of remark's gfm `url` tokenizer: the domain needs a dot and no `_` in its last two labels, and the path runs to whitespace or `<`.
function tokenizeUrl(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  if (options.inLink) return undefined;
  const schemeLength = urlSchemeLength(source, start);
  if (schemeLength === 0) return undefined;
  const domainStart = start + schemeLength;
  if (scan.isInsideFailedDomain(domainStart)) return undefined;
  const dots: number[] = [];
  let previousDot = domainStart - 1;
  let index = domainStart;
  let code = NaN;
  while (index < source.length) {
    code = source.charCodeAt(index);
    if (code === DOT) {
      if (previousDot === index - 1) break;
      dots.push(index);
      previousDot = index;
    } else if (!isUrlDomainCharacter(code)) {
      break;
    }
    index++;
  }
  // A dot that ends the domain, or that a second dot follows, belongs to the path instead.
  if (code === DOT) {
    dots.pop();
    index--;
  }
  if (dots.length === 0) return undefined;
  const lastLabelsStart =
    dots.length < 2 ? domainStart : dots[dots.length - 2] + 1;
  if (source.slice(lastLabelsStart, index).includes('_')) {
    if (dots.length >= 2) {
      scan.rememberFailedDomain(domainStart, dots[dots.length - 2]);
    }
    return undefined;
  }
  const pathStart = index;
  let end = index;
  while (
    index < source.length &&
    !WHITESPACE.test(source[index]) &&
    source[index] !== '<'
  ) {
    index++;
    if (!URL_TRAILING_PUNCTUATION.has(source[index - 1])) end = index;
  }
  end = trimTrailingSemicolon(
    source,
    trimUnbalancedParentheses(source, pathStart, end)
  );
  return { end, output: protectLinkText(source.slice(start, end), options) };
}

function isEmailLocalCharacter(code: number): boolean {
  return (
    isAsciiAlphanumeric(code) ||
    code === PLUS ||
    code === DASH ||
    code === DOT ||
    code === UNDERSCORE
  );
}

function isEmailDomainCharacter(code: number): boolean {
  return (
    isAsciiAlphanumeric(code) ||
    code === DASH ||
    code === DOT ||
    code === UNDERSCORE
  );
}

// The end of the email whose `@` sits at `atIndex`, or `NO_POSITION` when its domain fails: the domain needs a dot that is not its last character, and may not end on `-` or `_`.
function scanEmailDomain(source: string, atIndex: number): number {
  let index = atIndex + 1;
  let code = AT_SIGN;
  let afterFirstDot = NO_POSITION;
  while (index < source.length) {
    code = source.charCodeAt(index);
    if (!isEmailDomainCharacter(code)) break;
    index++;
    if (afterFirstDot === NO_POSITION && code === DOT) afterFirstDot = index;
  }
  if (
    afterFirstDot === NO_POSITION ||
    afterFirstDot === index ||
    code === DASH ||
    code === UNDERSCORE
  ) {
    return NO_POSITION;
  }
  return code === DOT ? index - 1 : index;
}

// Port of remark's gfm `email` tokenizer: a run of local-part characters, an `@` and a domain.
function tokenizeEmail(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  if (options.inLink || scan.emailSearchExhausted) return undefined;
  const atIndex = scan.emailLocalPartEnd(start);
  if (atIndex === start || source.charCodeAt(atIndex) !== AT_SIGN) {
    return undefined;
  }
  const end = scan.emailEnd(atIndex);
  if (end === NO_POSITION) return undefined;
  return { end, output: protectLinkText(source.slice(start, end), options) };
}

// remark's inline HTML grammar (open tag, close tag, comment, processing instruction, declaration, CDATA); the unquoted attribute value `[^"'=<>\`\u0000-\u0020]` is spelled as the ranges it allows, so no control character appears in a regex.
// One attribute, its name and its unquoted, single- or double-quoted value captured for `readOpenTag`, so the tag grammar and the attribute reading cannot drift apart.
const HTML_ATTRIBUTE_SOURCE = String.raw`\s+([a-zA-Z_:][a-zA-Z0-9:._-]*)(?:\s*=\s*(?:([!#-&(-;?-_a-\uFFFF]+)|'([^']*)'|"([^"]*)"))?`;
const HTML_OPEN_TAG = new RegExp(
  `<[A-Za-z][A-Za-z0-9-]*(?:${HTML_ATTRIBUTE_SOURCE})*\\s*\\/?>`
);
const HTML_ATTRIBUTE = new RegExp(HTML_ATTRIBUTE_SOURCE, 'y');
const HTML_OPEN_TAG_END = /\s*(\/?)>/y;
const HTML_CLOSE_TAG = /<\/[A-Za-z][A-Za-z0-9-]*\s*>/;
const HTML_OTHER =
  /<!---->|<!--(?:-?[^>-])(?:-?[^-])*-->|<[?].*?[?]>|<![A-Za-z]+\s+[^>]*>|<!\[CDATA\[[\s\S]*?\]\]>/;
const INLINE_HTML = new RegExp(
  [HTML_OPEN_TAG, HTML_CLOSE_TAG, HTML_OTHER]
    .map((part) => part.source)
    .join('|'),
  'y'
);
const HTML_LINK_OPEN = /^<a /i;
const HTML_LINK_CLOSE = /^<\/a>/i;
const HTML_OPEN_TAG_NAME = /^<([A-Za-z][A-Za-z0-9-]*)/;
const HTML_CLOSE_TAG_NAME = /^<\/([A-Za-z][A-Za-z0-9-]*)/;
const CDATA_OPENER = '<![CDATA[';

// Raw-text, template, noscript, iframe and the fallback-content elements show nothing of what they hold (measured in Reading view for each; `textarea` shows its text), so Reading view hides everything from the open tag to the close tag, and the rest of the line when none follows; inside one, only its own close tag counts, so every other marker is skipped.
// Known divergence: a close tag inside a bare link or image destination, a link title, or a wikilink or embed target also ends the element in Reading view, followed by an attribute tail of Obsidian's own link serialization (measured: `x <script>a [l](u</script>) b</script> c` renders `x " data-href="u" class="internal-link">l b c`); no marker is emitted there, since each tail would hardcode that serialization.
// Elements Reading view hides by CSS or element semantics rather than by parsing (`video`, `details` without `open`, `hidden`, `display: none`, …) are modeled in `element-stack.ts`, with their known divergences.
const HIDDEN_CONTENT_CLOSE_TAGS = new Map(
  [
    'script',
    'style',
    'xmp',
    'template',
    'noscript',
    'title',
    'iframe',
    'noembed',
    'noframes',
  ].map((name) => [name, new RegExp(`</${name}\\s*>`, 'gi')])
);
const ANY_HIDDEN_CONTENT_CLOSE_TAG = new RegExp(
  `</(?:${Array.from(HIDDEN_CONTENT_CLOSE_TAGS.keys()).join('|')})\\s*>`,
  'i'
);
// The browser reads everything after `<plaintext>` as its text and never ends it, a `</plaintext>` included (measured: `x <plaintext>a</plaintext> b` renders `x`).
const PLAINTEXT = 'plaintext';

function isHiddenElement(name: string): boolean {
  return name === PLAINTEXT || HIDDEN_CONTENT_CLOSE_TAGS.has(name);
}

/** An open tag's attributes as the browser reads them (names lowercased, the first of a repeated name kept, character references in values decoded), and whether it ends in `/>`. */
function readOpenTag(tag: string): {
  attributes: Map<string, string>;
  selfClosing: boolean;
} {
  const attributes = new Map<string, string>();
  // A failed sticky match resets `lastIndex`, so the end of the last attribute is kept apart
  let attributesEnd = HTML_OPEN_TAG_NAME.exec(tag)?.[0].length ?? 0;
  HTML_ATTRIBUTE.lastIndex = attributesEnd;
  for (
    let match = HTML_ATTRIBUTE.exec(tag);
    match;
    match = HTML_ATTRIBUTE.exec(tag)
  ) {
    attributesEnd = HTML_ATTRIBUTE.lastIndex;
    const name = match[1].toLowerCase();
    if (attributes.has(name)) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    // Measured: `x <span style="display&#58;none">a</span> b` renders `x b`
    attributes.set(
      name,
      decodeCharacterReferences(value, (decoded) => decoded)
    );
  }
  // An unquoted value takes a `/` before the `>`, so `<svg a=b/>` closes nothing
  HTML_OPEN_TAG_END.lastIndex = attributesEnd;
  return {
    attributes,
    selfClosing: HTML_OPEN_TAG_END.exec(tag)?.[1] === '/',
  };
}

// Reading view renders a paragraph's or heading's Markdown before the browser parses the HTML, so a tag only marks where an element opens or closes, applied once the line is rendered: a close tag inside bold or link text still pairs with an open tag outside it, while one inside a code span or another construct remark escapes ends nothing.
// An HTML block reaches the browser as typed, with no Markdown between its tags, so a raw-text element ends at its first literal close tag wherever it sits (measured: `<script>a \`</script>\` b</script> c` renders `\` b c`).
function inlineHtmlOutput(tag: string, options: TokenizerOptions): string {
  const markers = options.hiddenElementMarkers;
  const openName = HTML_OPEN_TAG_NAME.exec(tag)?.[1].toLowerCase();
  if (openName !== undefined) {
    return markers.emit({ kind: 'open', name: openName, raw: tag });
  }
  const closeName = HTML_CLOSE_TAG_NAME.exec(tag)?.[1].toLowerCase();
  if (closeName !== undefined) {
    return markers.emit({ kind: 'close', name: closeName });
  }
  // The browser's raw-text state ends at the first literal close tag, inside an attribute value or a comment too (measured: `x <script>a <!-- </script> --> b</script> c` renders `x --> b c`).
  if (ANY_HIDDEN_CONTENT_CLOSE_TAG.test(tag)) {
    return markers.emit({ kind: 'tag', raw: tag, normal: '' });
  }
  return '';
}

// Port of remark's `html` tokenizer: with HTML stripping on a tag shows nothing, so the text between tags flows on; off, it stays as typed. `<a …>` turns autolink literals off until `</a>`, as link text does.
function tokenizeHtml(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  if (source[start] !== '<' || scan.tagCloseBound < start + 2) {
    return undefined;
  }
  // A processing instruction or CDATA section scans lazily to its own closer, so only that closer's last position bounds it.
  const second = source[start + 1];
  if (second === '?') {
    if (scan.processingInstructionBound < start + 2) return undefined;
  } else if (second === '!') {
    if (
      source.startsWith(CDATA_OPENER, start) &&
      scan.cdataBound < start + CDATA_OPENER.length
    ) {
      return undefined;
    }
  } else if (second !== '/' && !isAsciiLetter(second.charCodeAt(0))) {
    return undefined;
  }
  INLINE_HTML.lastIndex = start;
  const tag = INLINE_HTML.exec(source)?.[0];
  if (tag === undefined) return undefined;
  let inLink: boolean | undefined;
  if (!options.inLink && HTML_LINK_OPEN.test(tag)) inLink = true;
  else if (options.inLink && HTML_LINK_CLOSE.test(tag)) inLink = false;
  const tagEnd = start + tag.length;
  if (!options.html) {
    return { end: tagEnd, output: options.protect(tag), inLink };
  }
  return { end: tagEnd, output: inlineHtmlOutput(tag, options), inLink };
}

// remark's email locator: the start of the run of local-part characters right before an `@`, never before `from`.
function locateEmail(source: string, from: number): number {
  for (
    let atIndex = source.indexOf('@', from);
    atIndex !== -1;
    atIndex = source.indexOf('@', atIndex + 1)
  ) {
    let localStart = atIndex;
    while (
      localStart > from &&
      isEmailLocalCharacter(source.charCodeAt(localStart - 1))
    ) {
      localStart--;
    }
    if (localStart < atIndex) return localStart;
  }
  return NO_POSITION;
}

// Obsidian shows a link without display text as its subpath parts joined by ` > `, empty parts dropped, so `[[x#h]]` reads `x > h`.
function wikilinkTitle(target: string): string {
  return target
    .split('#')
    .filter((part) => part !== '')
    .join(' > ')
    .trim();
}

// A wikilink's content is raw, so a backslash inside one is never an escape.
function tokenizeWikilink(
  source: string,
  start: number,
  options: TokenizerOptions
): InlineToken | undefined {
  WIKILINK.lastIndex = start;
  const match = WIKILINK.exec(source);
  if (!match) return undefined;
  const target = match[2].trim();
  const end = start + match[0].length;
  if (!options.wikilinks) return { end, output: options.protect(match[0]) };
  // Only a `|` past the first character starts display text, and a backslash before it stays with the target.
  const pipeIndex = target.indexOf('|');
  if (pipeIndex <= 0) {
    return { end, output: options.protect(wikilinkTitle(target)) };
  }
  const displayText = target.slice(pipeIndex + 1).trim();
  if (match[1] !== '!') return { end, output: options.protect(displayText) };
  // An embed's size is no display text, so `![[a|alt|400]]` is titled `alt`, and a sized embed left without alt text is titled after its target, as an embed without a size is.
  const sizePipeIndex = displayText.lastIndexOf('|');
  if (!EMBED_SIZE.test(displayText.slice(sizePipeIndex + 1))) {
    return { end, output: options.protect(displayText) };
  }
  const altText =
    sizePipeIndex === -1 ? '' : displayText.slice(0, sizePipeIndex).trim();
  return {
    end,
    output: options.protect(
      altText === '' ? wikilinkTitle(target.slice(0, pipeIndex)) : altText
    ),
  };
}

interface LinkTail {
  end: number;
  destination: string;
}

// remark's link tail after `](` (app.js `link`, commonmark): optional whitespace, a destination in `<…>` or bare, then optional whitespace and a title in `"…"`, `'…'` or `(…)` that needs whitespace before it, optional whitespace, and `)`. Either part may be empty.
function parseLinkTail(
  source: string,
  openParen: number,
  scan: SourceScan
): LinkTail | undefined {
  let index = scan.nextNonWhitespace(openParen + 1);
  let destination: string;
  if (source[index] === '<') {
    const angleClose = scan.angleDestinationStop(index + 1);
    if (source[angleClose] !== '>') return undefined;
    destination = source.slice(index + 1, angleClose);
    index = angleClose + 1;
  } else {
    const destinationEnd = scan.bareDestinationEnd(index);
    destination = source.slice(index, destinationEnd);
    index = destinationEnd;
  }
  const titleStart = scan.nextNonWhitespace(index);
  const titleOpener = source[titleStart];
  if (
    titleStart > index &&
    (titleOpener === '"' || titleOpener === "'" || titleOpener === '(')
  ) {
    const titleClose = scan.nextUnescaped(
      titleOpener === '(' ? ')' : titleOpener,
      titleStart + 1
    );
    if (titleClose >= source.length) return undefined;
    index = scan.nextNonWhitespace(titleClose + 1);
  } else {
    index = titleStart;
  }
  if (source[index] !== ')') return undefined;
  return { end: index + 1, destination };
}

// Port of remark's `link` tokenizer: `[text](destination "title")`, or an image with a leading `!`. An image may sit inside a link's text, a link may not, and `[^…](…)` is a link too, as remark tries links before footnotes.
function tokenizeLink(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  const isImage = source[start] === '!';
  const textStart = start + (isImage ? 2 : 1);
  if (source[textStart - 1] !== '[' || (!isImage && options.inLink)) {
    return undefined;
  }
  // `]` must be followed at once by `(`, so `[a] (x)` stays text.
  const textEnd = scan.linkTextCloser(textStart);
  if (source[textEnd + 1] !== '(') return undefined;
  const tail = parseLinkTail(source, textEnd + 1, scan);
  if (!tail) return undefined;
  const text = source.slice(textStart, textEnd);
  let output: string;
  if (!options.links) {
    const raw = source.slice(start, tail.end);
    output = options.protect(raw);
    if (!isImage) output = keptLinkOutput(text, raw, output, options);
  } else if (isImage) {
    output = options.protect(resolveRawText(text));
  } else {
    output = options.hiddenElementMarkers.wrapConstruct(
      renderTokens(text, { ...options, inLink: true }),
      'a'
    );
  }
  options.onLinkDestination?.(resolveRawText(tail.destination));
  return {
    end: tail.end,
    output: isImage
      ? imageOutput(resolveRawText(text), output, options)
      : output,
  };
}

// An image's alt text reaches the browser raw, so a hidden close tag in it ends the element (measured: `x <script>a ![</script>](p.png) b</script> c` renders `x "> b c`).
function imageOutput(
  altText: string,
  output: string,
  options: TokenizerOptions
): string {
  if (!options.html || !ANY_HIDDEN_CONTENT_CLOSE_TAG.test(altText)) {
    return output;
  }
  return options.hiddenElementMarkers.emit({
    kind: 'alt',
    raw: `${altText}">`,
    normal: output,
  });
}

// A link kept as typed still reaches Reading view as a link whose text it renders, so a raw-text element's close tag there ends the element, and the rest of the link shows as typed, as kept bold does (`x <script>a **</script>** b</script> c` is titled `x ** b c`); escaped or in a code span it ends nothing (measured: `x <script>a [\</script>](u) b</script> c` renders `x c`).
function keptLinkOutput(
  text: string,
  raw: string,
  output: string,
  options: TokenizerOptions
): string {
  if (!options.html || !ANY_HIDDEN_CONTENT_CLOSE_TAG.test(text)) return output;
  const rendered = renderTokens(text, {
    ...options,
    inLink: true,
    onLinkDestination: undefined,
    onTag: undefined,
  });
  if (!holdsHiddenContentCloseTag(rendered, options.hiddenElementMarkers)) {
    return output;
  }
  return options.hiddenElementMarkers.emit({
    kind: 'link',
    raw,
    normal: output,
  });
}

// Whether a rendered stretch holds a marker that would end some raw-text element.
function holdsHiddenContentCloseTag(
  rendered: string,
  markers: HiddenElementMarkers
): boolean {
  const sentinel = markers.sentinel;
  let markerStart = rendered.indexOf(sentinel);
  while (markerStart !== -1) {
    const indexStart = markerStart + sentinel.length;
    const markerEnd = rendered.indexOf(sentinel, indexStart);
    if (markerEnd === -1) return false;
    const marker = markers.get(Number(rendered.slice(indexStart, markerEnd)));
    if (
      marker?.kind === 'close'
        ? HIDDEN_CONTENT_CLOSE_TAGS.has(marker.name)
        : marker !== undefined &&
          'raw' in marker &&
          ANY_HIDDEN_CONTENT_CLOSE_TAG.test(marker.raw)
    ) {
      return true;
    }
    markerStart = rendered.indexOf(sentinel, markerEnd + sentinel.length);
  }
  return false;
}

// Port of Obsidian's `inlineNote` tokenizer: `^[` up to the `]` that closes it, nested brackets and escapes counted and brackets inside a backtick run ignored.
function tokenizeInlineNote(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  if (source[start] !== '^' || source[start + 1] !== '[') return undefined;
  const closer = scan.inlineNoteCloser(start + 2);
  if (closer >= source.length) return undefined;
  const end = closer + 1;
  // The metadata cache tags an inline footnote's text, which a title never shows
  if (options.onTag) renderTokens(source.slice(start + 2, closer), options);
  return {
    end,
    output: options.footnotes ? '' : options.protect(source.slice(start, end)),
  };
}

// Port of Obsidian's `footnoteCall` tokenizer: `[^` and a non-empty label holding no space, tab or line feed, closed by the first `]`; what follows plays no part, so `[^1]:` mid-line is a reference too.
function tokenizeFootnoteCall(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  if (source[start] !== '[' || source[start + 1] !== '^') return undefined;
  const labelEnd = scan.footnoteLabelStops.stopFrom(start + 2);
  if (labelEnd === start + 2 || source[labelEnd] !== ']') return undefined;
  const end = labelEnd + 1;
  return {
    end,
    output: options.footnotes ? '' : options.protect(source.slice(start, end)),
  };
}

// The bracketed text of an undefined shortcut reference, which Reading view shows in brackets; Obsidian's wrapper around remark's `reference` refuses a `[^` start.
// Text holding another `[` is refused, as remark refuses a shortcut reference whose text nests brackets, so the outer `[` stays text and an inner `[b]` gets its own turn outside link context.
function tokenizeReference(
  source: string,
  start: number,
  options: TokenizerOptions
): InlineToken | undefined {
  if (options.inLink || source[start] !== '[' || source[start + 1] === '^') {
    return undefined;
  }
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (character === '[') return undefined;
    if (character === '\\') {
      index++;
    } else if (character === ']') {
      if (index === start + 1) return undefined;
      const content = renderTokens(source.slice(start + 1, index), {
        ...options,
        inLink: true,
      });
      return { end: index + 1, output: `[${content}]` };
    }
  }
  return undefined;
}

// remark pairs `**` with the first later `**` that ends a run, skipping only escaped characters; flanking rules play no part.
function tokenizeStrong(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  const marker = source[start];
  if ((marker !== '*' && marker !== '_') || source[start + 1] !== marker) {
    return undefined;
  }
  const bound = scan.strongBound[marker];
  for (let index = start + 2; index <= bound; index++) {
    if (source[index] === '\\') {
      index++;
      continue;
    }
    if (
      source[index] === marker &&
      source[index + 1] === marker &&
      source[index + 2] !== marker
    ) {
      const content = source.slice(start + 2, index);
      if (!content.trim()) return undefined;
      return {
        end: index + 2,
        output: keepDelimiters(
          options.bold,
          marker + marker,
          options.hiddenElementMarkers.wrapConstruct(
            renderTokens(content, options),
            'strong'
          )
        ),
      };
    }
  }
  return undefined;
}

// A closer that directly follows another delimiter or an escaped one fails the whole span, which is why `*a\**` stays literal.
function tokenizeEmphasis(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  const marker = source[start];
  if (marker !== '*' && marker !== '_') return undefined;
  const bound = scan.emphasisBound[marker];
  if (bound < start + 1) return undefined;
  const firstVisibleIndex = firstNonWhitespaceIndex(source, start + 1);
  let lastConsumed = '';
  let index = start + 1;
  while (index <= bound) {
    const character = source[index];
    if (character === marker && source[index + 1] !== marker) {
      if (firstVisibleIndex >= index || lastConsumed === marker) {
        return undefined;
      }
      // A `_` followed by a word character is part of the word, not a closer.
      if (marker === '_' && WORD_CHARACTER.test(source.charAt(index + 1))) {
        lastConsumed = marker;
        index++;
        continue;
      }
      return {
        end: index + 1,
        output: keepDelimiters(
          options.italic,
          marker,
          options.hiddenElementMarkers.wrapConstruct(
            renderTokens(source.slice(start + 1, index), options),
            'em'
          )
        ),
      };
    }
    if (character === marker) {
      lastConsumed = marker;
      index += 2;
    } else if (character === '\\') {
      lastConsumed = source.charAt(index + 1);
      index += 2;
    } else {
      lastConsumed = character;
      index++;
    }
  }
  return undefined;
}

// Unlike emphasis, `~~` and `==` skip no escapes, so `\==` still closes a highlight and its backslash stays visible.
function findDoubledDelimiterCloser(
  source: string,
  start: number,
  delimiter: string,
  scan: SourceScan
): number | undefined {
  const contentStart = start + 2;
  const bound = scan.doubledBound[delimiter];
  if (
    source[start] !== delimiter ||
    source[start + 1] !== delimiter ||
    bound < contentStart ||
    WHITESPACE.test(source.charAt(contentStart))
  ) {
    return undefined;
  }
  for (let closerStart = contentStart; closerStart <= bound; closerStart++) {
    const beforeCloser =
      closerStart > contentStart ? source[closerStart - 1] : '';
    if (
      source[closerStart] === delimiter &&
      source[closerStart + 1] === delimiter &&
      !WHITESPACE.test(beforeCloser)
    ) {
      return closerStart;
    }
  }
  return undefined;
}

function tokenizeStrikethrough(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  const closerStart = findDoubledDelimiterCloser(source, start, '~', scan);
  if (closerStart === undefined) return undefined;
  return {
    end: closerStart + 2,
    output: keepDelimiters(
      options.strikethrough,
      '~~',
      options.hiddenElementMarkers.wrapConstruct(
        renderTokens(source.slice(start + 2, closerStart), options),
        'del'
      )
    ),
  };
}

function leadingColorMarker(content: string): string {
  const codePoint = content.codePointAt(0);
  if (codePoint === undefined) return '';
  const character = String.fromCodePoint(codePoint);
  return HIGHLIGHT_COLOR_MARKERS.has(character) ? character : '';
}

// Obsidian reads the color from the raw first code point, before any markup inside the highlight is parsed.
function tokenizeHighlight(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  if (source.startsWith('====', start)) return undefined;
  const closerStart = findDoubledDelimiterCloser(source, start, '=', scan);
  if (closerStart === undefined) return undefined;
  const content = source.slice(start + 2, closerStart);
  const colorMarker = leadingColorMarker(content);
  const rendered = options.hiddenElementMarkers.wrapConstruct(
    renderTokens(content.slice(colorMarker.length), options),
    'mark'
  );
  return {
    end: closerStart + 2,
    output: options.highlight ? rendered : `==${colorMarker}${rendered}==`,
  };
}

// One space or newline comes off each end only when both ends have one and something else sits between them.
function codeSpanValue(content: string): string {
  const isPadding = (character: string): boolean =>
    character === ' ' || character === '\n';
  if (
    content.length > 2 &&
    isPadding(content[0]) &&
    isPadding(content[content.length - 1]) &&
    /[^ \n]/.test(content.slice(1, -1))
  ) {
    return content.slice(1, -1);
  }
  return content;
}

// A backtick run closes only on a run of the same length; an unmatched run fails here, and the text step then consumes just its first backtick, so the next one gets to open a span.
function tokenizeCodeSpan(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  if (source[start] !== '`') return undefined;
  const contentStart = scan.backtickRunEnd(start);
  const runLength = contentStart - start;
  if (contentStart === source.length) return undefined;
  const bound = scan.lastCodeRunEnd(runLength);
  let closerStart = -1;
  for (let index = contentStart; index <= bound; index++) {
    if (source[index] !== '`') {
      closerStart = -1;
      continue;
    }
    if (closerStart === -1) closerStart = index;
    if (source[index + 1] !== '`' && index + 1 - closerStart === runLength) {
      const shown = options.code
        ? codeSpanValue(source.slice(contentStart, closerStart))
        : source.slice(start, index + 1);
      return { end: index + 1, output: options.protect(shown) };
    }
  }
  return undefined;
}

// Port of Obsidian's tag tokenizer: which `#` may start a tag is the locator's rule, kept in `nextTokenStart`, so a tag right after another token is one; an all-digit tag is text. A tag shows as typed, so no markup inside it is parsed.
function tokenizeTag(
  source: string,
  start: number,
  options: TokenizerOptions
): InlineToken | undefined {
  if (source[start] !== '#') return undefined;
  TAG.lastIndex = start;
  const tag = TAG.exec(source)?.[0];
  if (tag === undefined || ALL_DIGIT_TAG.test(tag)) return undefined;
  options.onTag?.(tag);
  return { end: start + tag.length, output: options.protect(tag) };
}

// Whitespace after `$$…$$` is consumed only up to a line break, which a one-line title never reaches.
function endOfDisplayMath(source: string, afterCloser: number): number {
  for (let index = afterCloser; index < source.length; index++) {
    if (source[index] === '\n') return index + 1;
    if (!WHITESPACE.test(source[index])) break;
  }
  return afterCloser;
}

// Port of Obsidian's math tokenizer, taken from its app.js because MathJax replaces the rendered text: content stays raw, a backslash only shields the next character from closing, and a single `$` neither opens before whitespace nor closes after it or before a digit.
function tokenizeMath(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  if (source.charCodeAt(start) !== DOLLAR) return undefined;
  const isDisplay = source.charCodeAt(start + 1) === DOLLAR;
  const contentStart = start + (isDisplay ? 2 : 1);
  let closerStart: number;
  if (isDisplay) {
    closerStart = displayMathCloser(source, contentStart, scan);
  } else {
    const next = source.charCodeAt(contentStart);
    if (next === SPACE || next === TAB) return undefined;
    closerStart = scan.nextInlineMathCloser(contentStart);
  }
  if (closerStart >= source.length) return undefined;
  const end = isDisplay
    ? endOfDisplayMath(source, closerStart + 2)
    : closerStart + 1;
  const shown = options.math
    ? source.slice(contentStart, closerStart)
    : source.slice(start, end);
  return { end, output: options.protect(shown) };
}

// The `$$` that closes display math, or `source.length` when none.
function displayMathCloser(
  source: string,
  contentStart: number,
  scan: SourceScan
): number {
  for (let index = contentStart; index <= scan.displayMathBound; index++) {
    const code = source.charCodeAt(index);
    if (code === DOLLAR && source.charCodeAt(index + 1) === DOLLAR) {
      return index;
    }
    if (code === BACKSLASH) index++;
  }
  return source.length;
}

// Port of Obsidian's `blockid` tokenizer: a block ID ending the inline run being tokenized (the line, or the text of a link, reference, bold, italic, strikethrough or highlight) shows nothing.
function tokenizeBlockId(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  return start === scan.blockIdStart
    ? { end: source.length, output: '' }
    : undefined;
}

function tokenizeComment(
  source: string,
  start: number,
  options: TokenizerOptions,
  scan: SourceScan
): InlineToken | undefined {
  if (scan.commentBound < start + 2) return undefined;
  COMMENT.lastIndex = start;
  const match = COMMENT.exec(source);
  if (!match) return undefined;
  const end = start + match[0].length;
  if (options.comments === 'remove') return { end, output: '' };
  // Reading view hides the comment, so no hidden-element boundary inside it reaches the browser (measured: `x <script>a %%</script>%% b</script> c` renders `x  c`)
  const rendered = resolveHiddenElements(
    renderTokens(match[1], options),
    options
  );
  return {
    end,
    output: options.comments === 'unwrap' ? rendered : `%%${rendered}%%`,
  };
}

// Reading view's order (app.js 1.14.4, Obsidian's extensions spliced in where it splices them): at any position the first tokenizer that matches wins, so a bare URL or email swallows the delimiters inside it.
const INLINE_TOKENIZERS: InlineTokenizer[] = [
  tokenizeEscape,
  tokenizeAutolink,
  tokenizeUrl,
  tokenizeEmail,
  tokenizeHtml,
  tokenizeWikilink,
  tokenizeLink,
  tokenizeInlineNote,
  tokenizeFootnoteCall,
  tokenizeReference,
  tokenizeStrong,
  tokenizeEmphasis,
  tokenizeStrikethrough,
  tokenizeCodeSpan,
  tokenizeHighlight,
  tokenizeTag,
  tokenizeMath,
  tokenizeComment,
  tokenizeBlockId,
];

// A line that opens an HTML block is read as HTML only.
const HTML_BLOCK_TOKENIZERS: InlineTokenizer[] = [tokenizeHtml];

// Where the text starting at `position` ends; in an HTML block only a `<` can start a token, and the inline token starts would cut a reference short (`&ampx@y.com` at its email).
function textEnd(
  source: string,
  position: number,
  options: TokenizerOptions,
  scan: SourceScan
): number {
  if (!options.htmlBlock) return scan.nextTokenStart(position + 1);
  const nextTagStart = source.indexOf('<', position + 1);
  return nextTagStart === -1 ? source.length : nextTagStart;
}

function renderTokens(source: string, options: TokenizerOptions): string {
  const scan = new SourceScan(source);
  const tokenizers = options.htmlBlock
    ? HTML_BLOCK_TOKENIZERS
    : INLINE_TOKENIZERS;
  let output = '';
  let position = 0;
  let current = options;
  while (position < source.length) {
    let token: InlineToken | undefined;
    for (const tokenize of tokenizers) {
      token = tokenize(source, position, current, scan);
      if (token) break;
    }
    if (token) {
      output += token.output;
      position = token.end;
      if (token.inLink !== undefined) {
        current = { ...current, inLink: token.inLink };
      }
      continue;
    }
    const end = textEnd(source, position, options, scan);
    output += decodeCharacterReferences(
      source.slice(position, end),
      options.protect
    );
    position = end;
  }
  return output;
}

// Where the first close tag of the raw-text element `name` in a token's raw text ends, or undefined when it holds none.
function closeTagEnd(raw: string, name: string): number | undefined {
  const closeTag = HIDDEN_CONTENT_CLOSE_TAGS.get(name);
  if (!closeTag) return undefined;
  closeTag.lastIndex = 0;
  const close = closeTag.exec(raw);
  return close ? close.index + close[0].length : undefined;
}

/** One left-to-right pass over a rendered line, applying its markers as the browser parses the HTML Reading view renders. */
class HiddenElementResolution {
  private readonly stack = new ElementStack();
  private rawTextElement: string | undefined;
  output = '';

  constructor(private readonly options: TokenizerOptions) {}

  private get showsText(): boolean {
    return this.rawTextElement === undefined && this.stack.showsText;
  }

  apply(rendered: string): void {
    const markers = this.options.hiddenElementMarkers;
    const sentinel = markers.sentinel;
    let position = 0;
    for (;;) {
      const markerStart = rendered.indexOf(sentinel, position);
      const textEnd = markerStart === -1 ? rendered.length : markerStart;
      if (textEnd > position && this.showsText) {
        this.output += rendered.slice(position, textEnd);
      }
      if (markerStart === -1) return;
      const indexStart = markerStart + sentinel.length;
      const markerEnd = rendered.indexOf(sentinel, indexStart);
      const index =
        markerEnd === -1 ? NaN : Number(rendered.slice(indexStart, markerEnd));
      const marker = markers.get(index);
      if (!marker) {
        // Only a line holding every private-use code point can hold the sentinel as text
        if (this.showsText) this.output += sentinel;
        position = indexStart;
        continue;
      }
      position = markerEnd + sentinel.length;
      if (this.rawTextElement === undefined) this.applyMarker(marker, index);
      else this.applyMarkerInRawText(marker, this.rawTextElement);
    }
  }

  private applyMarker(marker: HiddenElementMarker, index: number): void {
    switch (marker.kind) {
      case 'open': {
        if (isHiddenElement(marker.name)) {
          this.rawTextElement = marker.name;
          return;
        }
        const { attributes, selfClosing } = readOpenTag(marker.raw);
        this.stack.openElement(marker.name, attributes, selfClosing);
        return;
      }
      case 'close':
        this.stack.closeElement(marker.name);
        return;
      case 'constructOpen':
        this.stack.openConstruct(index, marker.element);
        return;
      case 'constructClose':
        this.stack.closeConstruct(marker.open);
        return;
      default:
        if (this.showsText) this.output += marker.normal;
    }
  }

  // Searching for the current element's own close tag lets a token holding close tags of two elements end the right one (measured: `x <style>a <!-- </script> </style> --> b</style> c` renders `x --> b c`).
  private applyMarkerInRawText(
    marker: HiddenElementMarker,
    name: string
  ): void {
    if (marker.kind === 'close') {
      if (marker.name === name && name !== PLAINTEXT) {
        this.rawTextElement = undefined;
      }
      return;
    }
    if (!('raw' in marker)) return;
    const end = closeTagEnd(marker.raw, name);
    if (end === undefined) return;
    this.rawTextElement = undefined;
    const remainder = marker.raw.slice(end);
    if (marker.kind === 'alt' || marker.kind === 'link') {
      if (this.showsText) this.output += this.options.protect(remainder);
      return;
    }
    // A tag's or comment's remainder reaches the browser as HTML, and an element it opens stays open past the token (measured: `x <script>a <!-- </script> <b>q</b> --> b</script> c` renders `x q --> b c`, `x <script>a <!-- </script> <style> --> b</script> c` renders `x`)
    this.apply(renderTokens(remainder, { ...this.options, htmlBlock: true }));
  }
}

// Reading view renders the whole line's Markdown first, then the browser parses the HTML: a raw-text element hides everything to the first close tag of that element in the HTML that reached it, a tag's attribute value, a comment, an image's alt text and a kept link included, and other elements hide by CSS or element semantics; one left-to-right pass applies the markers in that order.
function resolveHiddenElements(
  rendered: string,
  options: TokenizerOptions
): string {
  if (!rendered.includes(options.hiddenElementMarkers.sentinel)) {
    return rendered;
  }
  const resolution = new HiddenElementResolution(options);
  resolution.apply(rendered);
  return resolution.output;
}

const PRIVATE_USE_AREAS: readonly { first: number; last: number }[] = [
  { first: 0xe000, last: 0xf8ff },
  { first: 0xf0000, last: 0xffffd },
  { first: 0x100000, last: 0x10fffd },
];
const PRIVATE_USE_CHARACTER = /[\uE000-\uF8FF]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/g;
const NUMERIC_REFERENCE = /&#(?:[xX]([\dA-Fa-f]+)|(\d+))/g;

// The first private-use code point the rendered line cannot hold otherwise: neither one of its own characters nor one a numeric reference decodes to, escaped references included, as an image's alt text drops escapes before decoding; no named reference decodes into a private-use area (WHATWG `entities.json`).
// Only a line holding every one of the 137,468 private-use code points finds none, and then risks garbling its own title alone.
function unusedPrivateUseCharacter(source: string): string {
  const used = new Set<number>();
  for (const match of source.matchAll(PRIVATE_USE_CHARACTER)) {
    used.add(match[0].codePointAt(0) ?? 0);
  }
  if (source.includes('&')) {
    const unescaped = source.replace(ESCAPED_CHARACTER, '$1');
    for (const match of unescaped.matchAll(NUMERIC_REFERENCE)) {
      used.add(
        match[1] === undefined ? Number(match[2]) : parseInt(match[1], 16)
      );
    }
  }
  for (const area of PRIVATE_USE_AREAS) {
    for (let codePoint = area.first; codePoint <= area.last; codePoint++) {
      if (!used.has(codePoint)) return String.fromCodePoint(codePoint);
    }
  }
  return String.fromCodePoint(PRIVATE_USE_AREAS[0].first);
}

// One per rendered line, chosen against that line, since a `%%` comment resolves its own markers even where the output is discarded.
function hiddenElementMarkersFor(
  source: string,
  tracksConstructs: boolean
): HiddenElementMarkers {
  return new HiddenElementMarkers(
    unusedPrivateUseCharacter(source),
    tracksConstructs
  );
}

export function renderInlineMarkup(
  source: string,
  options: InlineMarkupOptions
): string {
  const tokenizerOptions: TokenizerOptions = {
    ...options,
    inLink: false,
    hiddenElementMarkers: hiddenElementMarkersFor(
      source,
      options.html && source.includes('<')
    ),
  };
  // Resolved before returning, so no pass after this one ever sees a marker
  return resolveHiddenElements(
    renderTokens(source, tokenizerOptions),
    tokenizerOptions
  );
}

// Every link and image destination in `text` as Reading view resolves it (escapes removed, character references decoded, angle brackets and title dropped), found by the same tokenizers that render a title, so a link inside code, a comment or another construct is not one.
export function markdownLinkDestinations(text: string): string[] {
  const destinations: string[] = [];
  if (!text.includes('](')) return destinations;
  renderTokens(text, {
    bold: true,
    italic: true,
    strikethrough: true,
    highlight: true,
    code: true,
    wikilinks: true,
    links: true,
    html: true,
    footnotes: true,
    math: true,
    comments: 'remove',
    protect: (protectedText) => protectedText,
    inLink: false,
    hiddenElementMarkers: hiddenElementMarkersFor(text, false),
    onLinkDestination: (destination) => {
      destinations.push(destination);
    },
  });
  return destinations;
}

// remark-parse's `block-elements` as bundled in app.js 1.14.4, which its html block tokenizer reads for the block-tag opener; unlike CommonMark's list it has `hgroup`, `meta` and `pre` and lacks `search`.
const HTML_BLOCK_ELEMENTS = [
  'address',
  'article',
  'aside',
  'base',
  'basefont',
  'blockquote',
  'body',
  'caption',
  'center',
  'col',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'frame',
  'frameset',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'iframe',
  'legend',
  'li',
  'link',
  'main',
  'menu',
  'menuitem',
  'meta',
  'nav',
  'noframes',
  'ol',
  'optgroup',
  'option',
  'p',
  'param',
  'pre',
  'section',
  'source',
  'title',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'track',
  'ul',
];

// remark's html block openers (app.js 1.14.4), tried on the content from its first `<`: a raw-text element, a comment, a processing instruction, a declaration, CDATA, a block element's open or close tag, or one complete tag alone on the line.
const HTML_BLOCK_OPENERS: readonly RegExp[] = [
  /^<(?:script|pre|style)(?=\s|>|$)/i,
  /^<!--/,
  /^<\?/,
  /^<![A-Za-z]/,
  /^<!\[CDATA\[/,
  new RegExp(`^</?(?:${HTML_BLOCK_ELEMENTS.join('|')})(?=\\s|/?>|$)`, 'i'),
  new RegExp(`^(?:${HTML_OPEN_TAG.source}|${HTML_CLOSE_TAG.source})\\s*$`),
];

// Every prefix comes off whatever the toggles say, since the line's block structure, not the title, decides how Reading view and the metadata cache read its content.
const ALL_BLOCK_PREFIXES: BlockPrefixStripping = {
  callouts: true,
  quote: true,
  task: true,
  unordered: true,
  ordered: true,
  headings: true,
};

/** A line's content after its block prefixes, and whether that content opens an HTML block. */
function blockContentOf(line: string): {
  content: string;
  raw: boolean;
  opensHtmlBlock: boolean;
} {
  const { content, raw, strippedHeading } = splitBlockPrefixes(
    line,
    ALL_BLOCK_PREFIXES
  );
  // A heading's content is parsed inline only, while a quote's, a list item's, a task's and a callout title's are parsed as blocks again (measured in Reading view and the metadata cache)
  const opensHtmlBlock =
    !raw &&
    !strippedHeading &&
    HTML_BLOCK_OPENERS.some((opener) => opener.test(content));
  return { content, raw, opensHtmlBlock };
}

/**
 * True when Reading view hands the line to the browser as an HTML block: after its quote, list, task and callout prefixes, and unless it is a heading, its content opens with one of remark's HTML block openers.
 * @param line - A whole line, block prefixes included
 */
export function opensHtmlBlock(line: string): boolean {
  return line.includes('<') && blockContentOf(line).opensHtmlBlock;
}

/**
 * The tags the metadata cache indexes in a line, found by the title tokenizers with fixed options matching the cache rather than the user's toggles: comment text is read, as the cache tags `%% #x %%`, and HTML tags stay as typed so a hidden element's content is read, as the cache tags `a <script>#x</script>`.
 * A line that opens an HTML block yields none, as the cache files it as an `html` section without tags. Known gap: with HTML stripping off and a multi-line `<!--` opener, or math block stripping off, the title source is the opener line, which is read here.
 * @param line - A title source's text, block prefixes included
 * @returns Each tag with its `#`
 */
export function inlineTags(line: string): string[] {
  if (!line.includes('#')) return [];
  const { content, raw, opensHtmlBlock } = blockContentOf(line);
  if (raw || opensHtmlBlock) return [];
  const tags: string[] = [];
  renderTokens(content, {
    bold: true,
    italic: true,
    strikethrough: true,
    highlight: true,
    code: true,
    wikilinks: true,
    links: true,
    html: false,
    footnotes: true,
    math: true,
    comments: 'keep',
    protect: (text) => text,
    inLink: false,
    hiddenElementMarkers: hiddenElementMarkersFor(content, false),
    onTag: (tag) => {
      tags.push(tag);
    },
  });
  return tags;
}
