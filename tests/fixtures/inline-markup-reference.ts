// Copy of `src/utils/inline-markup.ts` from before links, HTML stripping, footnotes, tags and the per-source scan caches were ported, kept so `tests/utils/inline-markup.test.ts` can show the caches change no other output.
// Port of the inline tokenizers Obsidian 1.14's Reading view runs (the remark-parse tokenizers bundled in its app.js, with `gfm` and `commonmark` on, plus Obsidian's highlight, wikilink, math and comment extensions), so a title keeps exactly the characters Reading view shows: escapes, autolinks, bare URLs and emails, wikilinks, link text, bold, italic, strikethrough, code spans, highlights, math, `%%` comments and the character references in plain text.
// Inline HTML is only recognized, so a tag stays raw for `extractTitle` to unwrap in a later pass; link destinations, footnotes and tags are not ported, so a delimiter inside them still parses here where Reading view would leave it alone.

import { decodeCharacterReferences } from '../../src/utils/character-references';

export interface InlineMarkupOptions {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  highlight: boolean;
  code: boolean;
  wikilinks: boolean;
  math: boolean;
  comments: 'remove' | 'unwrap' | 'keep';
  // Stands in for text the passes after this one must leave alone: escaped characters, decoded references, code spans, math, links Reading view finds on its own and wikilinks.
  protect: (text: string) => string;
}

// Reading view tokenizes the text of a link or reference with its autolink-literal tokenizers off, so a URL there is parsed for markup like any other text.
interface TokenizerOptions extends InlineMarkupOptions {
  inLink: boolean;
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
  options: TokenizerOptions
) => InlineToken | undefined;

// CommonMark's escapable set, which Reading view uses: every ASCII punctuation character and nothing else.
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
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

const WIKILINK = /(!?)\[\[(.+?)\]\]/y;
const COMMENT = /%%(.*?)%%/y;

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

// Every position a tokenizer below can start at, except an email's, which `locateEmail` finds; plain text runs up to the nearest one, so a delimiter inside a word still gets its turn.
// The URL locator is case-sensitive while its tokenizer is not, so `HTTPS://` links only where something else ended the text before it.
const TOKEN_START = /\\|!?\[|[*_`$<]|~~|==|%%|www\.|https?:\/\//g;

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

const MAILTO = 'mailto:';

// Port of remark's `autoLink` tokenizer: `<scheme://…>` or `<local@domain>` shows without its angle brackets, and an email without a leading `mailto:`.
function tokenizeAutolink(
  source: string,
  start: number,
  options: TokenizerOptions
): InlineToken | undefined {
  if (options.inLink || source[start] !== '<') return undefined;
  let index = start + 1;
  while (
    index < source.length &&
    !WHITESPACE.test(source[index]) &&
    source[index] !== '>' &&
    source[index] !== '@' &&
    !(source[index] === ':' && source[index + 1] === '/')
  ) {
    index++;
  }
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
  let end = restStart;
  while (
    end < source.length &&
    !WHITESPACE.test(source[end]) &&
    source[end] !== '>'
  ) {
    end++;
  }
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
  options: TokenizerOptions
): InlineToken | undefined {
  if (options.inLink) return undefined;
  const schemeLength = urlSchemeLength(source, start);
  if (schemeLength === 0) return undefined;
  const domainStart = start + schemeLength;
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
  if (source.slice(lastLabelsStart, index).includes('_')) return undefined;
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

// Port of remark's gfm `email` tokenizer: the domain needs a dot that is not its last character, and may not end on `-` or `_`.
function tokenizeEmail(
  source: string,
  start: number,
  options: TokenizerOptions
): InlineToken | undefined {
  if (options.inLink) return undefined;
  let index = start;
  while (isEmailLocalCharacter(source.charCodeAt(index))) index++;
  if (index === start || source.charCodeAt(index) !== AT_SIGN) {
    return undefined;
  }
  index++;
  let code = AT_SIGN;
  let afterFirstDot = -1;
  while (index < source.length) {
    code = source.charCodeAt(index);
    if (!isEmailDomainCharacter(code)) break;
    index++;
    if (afterFirstDot === -1 && code === DOT) afterFirstDot = index;
  }
  if (
    afterFirstDot === -1 ||
    afterFirstDot === index ||
    code === DASH ||
    code === UNDERSCORE
  ) {
    return undefined;
  }
  const end = code === DOT ? index - 1 : index;
  return { end, output: protectLinkText(source.slice(start, end), options) };
}

// remark's inline HTML grammar (open tag, close tag, comment, processing instruction, declaration, CDATA); the unquoted attribute value `[^"'=<>\`\u0000-\u0020]` is spelled as the ranges it allows, so no control character appears in a regex.
const HTML_OPEN_TAG =
  /<[A-Za-z][A-Za-z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\s*=\s*(?:[!#-&(-;?-_a-\uFFFF]+|'[^']*'|"[^"]*"))?)*\s*\/?>/;
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

// Port of remark's `html` tokenizer: a tag stays raw, attributes included, for `extractTitle`'s tag pass, and `<a …>` turns autolink literals off until `</a>`, as link text does.
function tokenizeHtml(
  source: string,
  start: number,
  options: TokenizerOptions
): InlineToken | undefined {
  if (source[start] !== '<' || source.length - start < 3) return undefined;
  const second = source[start + 1];
  if (
    !isAsciiLetter(second.charCodeAt(0)) &&
    second !== '?' &&
    second !== '!' &&
    second !== '/'
  ) {
    return undefined;
  }
  INLINE_HTML.lastIndex = start;
  const tag = INLINE_HTML.exec(source)?.[0];
  if (tag === undefined) return undefined;
  let inLink: boolean | undefined;
  if (!options.inLink && HTML_LINK_OPEN.test(tag)) inLink = true;
  else if (options.inLink && HTML_LINK_CLOSE.test(tag)) inLink = false;
  return { end: start + tag.length, output: tag, inLink };
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
  return -1;
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
  if (target.includes('[[')) return undefined;
  const end = start + match[0].length;
  if (!options.wikilinks) return { end, output: options.protect(match[0]) };
  // Only a `|` past the first character starts display text, and a backslash before it stays with the target.
  const pipeIndex = target.indexOf('|');
  const displayText =
    pipeIndex > 0 ? target.slice(pipeIndex + 1).trim() : wikilinkTitle(target);
  return { end, output: options.protect(displayText) };
}

// The bracketed text of a link or of an undefined reference, which Reading view shows in brackets; the destination after it is left to `extractTitle`.
// Text holding another `[` is skipped, as only a link or full reference may nest brackets and telling those apart needs the destination parser.
function tokenizeLinkText(
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
  options: TokenizerOptions
): InlineToken | undefined {
  const marker = source[start];
  if ((marker !== '*' && marker !== '_') || source[start + 1] !== marker) {
    return undefined;
  }
  for (let index = start + 2; index < source.length; index++) {
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
          renderTokens(content, options)
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
  options: TokenizerOptions
): InlineToken | undefined {
  const marker = source[start];
  if (marker !== '*' && marker !== '_') return undefined;
  const firstVisibleIndex = firstNonWhitespaceIndex(source, start + 1);
  let lastConsumed = '';
  let index = start + 1;
  while (index < source.length) {
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
          renderTokens(source.slice(start + 1, index), options)
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
  delimiter: string
): number | undefined {
  const contentStart = start + 2;
  if (
    source[start] !== delimiter ||
    source[start + 1] !== delimiter ||
    WHITESPACE.test(source.charAt(contentStart))
  ) {
    return undefined;
  }
  for (
    let closerStart = contentStart;
    closerStart + 1 < source.length;
    closerStart++
  ) {
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
  options: TokenizerOptions
): InlineToken | undefined {
  const closerStart = findDoubledDelimiterCloser(source, start, '~');
  if (closerStart === undefined) return undefined;
  return {
    end: closerStart + 2,
    output: keepDelimiters(
      options.strikethrough,
      '~~',
      renderTokens(source.slice(start + 2, closerStart), options)
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
  options: TokenizerOptions
): InlineToken | undefined {
  if (source.startsWith('====', start)) return undefined;
  const closerStart = findDoubledDelimiterCloser(source, start, '=');
  if (closerStart === undefined) return undefined;
  const content = source.slice(start + 2, closerStart);
  const colorMarker = leadingColorMarker(content);
  const rendered = renderTokens(content.slice(colorMarker.length), options);
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
  options: TokenizerOptions
): InlineToken | undefined {
  let contentStart = start;
  while (source[contentStart] === '`') contentStart++;
  const runLength = contentStart - start;
  if (runLength === 0 || contentStart === source.length) return undefined;
  let closerStart = -1;
  for (let index = contentStart; index < source.length; index++) {
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
  options: TokenizerOptions
): InlineToken | undefined {
  if (source.charCodeAt(start) !== DOLLAR) return undefined;
  const isDisplay = source.charCodeAt(start + 1) === DOLLAR;
  const contentStart = start + (isDisplay ? 2 : 1);
  let next = source.charCodeAt(contentStart);
  if (!isDisplay && (next === SPACE || next === TAB)) return undefined;
  for (let index = contentStart; index < source.length; index++) {
    const code = next;
    next = source.charCodeAt(index + 1);
    if (code === DOLLAR) {
      const previous = source.charCodeAt(index - 1);
      const closes = isDisplay
        ? next === DOLLAR
        : previous !== SPACE && previous !== TAB && !isAsciiDigit(next);
      if (!closes) continue;
      const end = isDisplay ? endOfDisplayMath(source, index + 2) : index + 1;
      const shown = options.math
        ? source.slice(contentStart, index)
        : source.slice(start, end);
      return { end, output: options.protect(shown) };
    }
    if (code === BACKSLASH) {
      index++;
      next = source.charCodeAt(index + 1);
    }
  }
  return undefined;
}

function tokenizeComment(
  source: string,
  start: number,
  options: TokenizerOptions
): InlineToken | undefined {
  COMMENT.lastIndex = start;
  const match = COMMENT.exec(source);
  if (!match) return undefined;
  const end = start + match[0].length;
  if (options.comments === 'remove') return { end, output: '' };
  const rendered = renderTokens(match[1], options);
  return {
    end,
    output: options.comments === 'unwrap' ? rendered : `%%${rendered}%%`,
  };
}

// Reading view's order: at any position the first tokenizer that matches wins, so a bare URL or email swallows the delimiters inside it.
const INLINE_TOKENIZERS: InlineTokenizer[] = [
  tokenizeEscape,
  tokenizeAutolink,
  tokenizeUrl,
  tokenizeEmail,
  tokenizeHtml,
  tokenizeWikilink,
  tokenizeLinkText,
  tokenizeStrong,
  tokenizeEmphasis,
  tokenizeStrikethrough,
  tokenizeCodeSpan,
  tokenizeHighlight,
  tokenizeMath,
  tokenizeComment,
];

function nextTokenStart(source: string, from: number): number {
  TOKEN_START.lastIndex = from;
  const tokenStart = TOKEN_START.exec(source)?.index ?? source.length;
  const emailStart = locateEmail(source, from);
  return emailStart === -1 ? tokenStart : Math.min(tokenStart, emailStart);
}

function renderTokens(source: string, options: TokenizerOptions): string {
  let output = '';
  let position = 0;
  let current = options;
  while (position < source.length) {
    let token: InlineToken | undefined;
    for (const tokenize of INLINE_TOKENIZERS) {
      token = tokenize(source, position, current);
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
    const textEnd = nextTokenStart(source, position + 1);
    output += decodeCharacterReferences(
      source.slice(position, textEnd),
      options.protect
    );
    position = textEnd;
  }
  return output;
}

export function renderInlineMarkup(
  source: string,
  options: InlineMarkupOptions
): string {
  return renderTokens(source, { ...options, inLink: false });
}
