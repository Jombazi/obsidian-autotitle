// Which text of a rendered line the browser shows, from an approximation of the stack of open elements its HTML parser builds; `resolveHiddenElements` in `inline-markup.ts` feeds it the line's element boundaries in order, and every element still open at the line's end ends there.
// Each rule below was measured with Obsidian 1.14.4's Reading view renderer, compared by `innerText`.

type Namespace = 'html' | 'svg' | 'math';
type Visibility = 'hidden' | 'visible';

/** The element Reading view renders a Markdown construct as: bold, italic, link text, strikethrough, highlight. */
export type ConstructElement = 'strong' | 'em' | 'a' | 'del' | 'mark';

/** An open element, or a Markdown construct Reading view renders as one (bold, italic, strikethrough, highlight, link text). */
interface StackEntry {
  // Empty for a construct, which no close tag names.
  readonly name: string;
  readonly namespace: Namespace;
  readonly special: boolean;
  readonly scopeBoundary: boolean;
  // A MathML token element or an SVG HTML integration point, whose children are HTML again.
  readonly integrationPoint: boolean;
  // Hidden by its `hidden` or `style` attribute, or by a name no descendant reveals.
  readonly hides: boolean;
  // Hidden by a name one descendant may reveal: a closed `details` (its first `summary`), an `svg` (a `text`), a `math` (a token element).
  readonly hidesUnlessRevealed: boolean;
  readonly reveals: StackEntry | undefined;
  readonly visibility: Visibility | undefined;
  readonly position: number;
  alive: boolean;
  openReveals: number;
  hasSummary: boolean;
}

// The body insertion mode ignores these start tags, so they never reach the stack (measured: `x <td hidden>a</td> b` renders `x a b`).
const IGNORED_START_TAGS = new Set([
  'caption',
  'col',
  'colgroup',
  'frame',
  'head',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'body',
  'html',
]);

// A void element ends with its own tag (measured: `x <param hidden>a b` renders `x a b`).
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'basefont',
  'bgsound',
  'br',
  'col',
  'embed',
  'hr',
  'image',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

// Obsidian's sanitizer drops these and keeps their text, so nothing they declare hides it, though the parser still puts them on the stack (measured: `x <search hidden>a</search> b` renders `x a b`).
const DROPPED_ELEMENTS = new Set([
  'object',
  'embed',
  'slot',
  'search',
  'listing',
]);

// Obsidian's sanitizer (DOMPurify 3.0.1 in `app.js`) allows neither and forbids their content, so it drops them with everything inside, in any namespace and whatever their `style`, though the parser still reads an SVG `foreignObject` as an integration point (measured: `x <svg><text><foreignObject>a</foreignObject></text></svg> b`, `x <foreignObject>a</foreignObject> b`, `x <annotation-xml>a</annotation-xml> b` and `x <math><annotation-xml><mtext>a</mtext></annotation-xml></math> b` render `x b`).
const CONTENT_DROPPED_ELEMENTS = new Set(['foreignobject', 'annotation-xml']);

// The sanitizer's SVG, SVG filter and MathML tag lists less the names HTML shares, which its namespace check refuses on an HTML element, as the parser makes one opened outside `svg` and `math` or inside an integration point, so it drops that element with everything inside whatever its `style` (measured for each: `x <text>a</text> b` renders `x b`, `x <math><mtext>a<mi>b</mi> c</mtext></math> d` renders `x a c d`); `a`, `font`, `title`, `style` and `script` keep their HTML behavior (measured: `x <a>a</a> b` renders `x a b`), `svg` and `math` open foreign content, `image` is read as `img`, and a name the sanitizer disallows keeps its text (measured: `x <animate>a</animate> b` renders `x a b`).
const FOREIGN_ONLY_ELEMENTS = new Set([
  'altglyph',
  'altglyphdef',
  'altglyphitem',
  'animatecolor',
  'animatemotion',
  'animatetransform',
  'circle',
  'clippath',
  'defs',
  'desc',
  'ellipse',
  'filter',
  'g',
  'glyph',
  'glyphref',
  'hkern',
  'line',
  'lineargradient',
  'marker',
  'mask',
  'metadata',
  'mpath',
  'path',
  'pattern',
  'polygon',
  'polyline',
  'radialgradient',
  'rect',
  'stop',
  'switch',
  'symbol',
  'text',
  'textpath',
  'tref',
  'tspan',
  'view',
  'vkern',
  'feblend',
  'fecolormatrix',
  'fecomponenttransfer',
  'fecomposite',
  'feconvolvematrix',
  'fediffuselighting',
  'fedisplacementmap',
  'fedistantlight',
  'feflood',
  'fefunca',
  'fefuncb',
  'fefuncg',
  'fefuncr',
  'fegaussianblur',
  'feimage',
  'femerge',
  'femergenode',
  'femorphology',
  'feoffset',
  'fepointlight',
  'fespecularlighting',
  'fespotlight',
  'fetile',
  'feturbulence',
  'menclose',
  'merror',
  'mfenced',
  'mfrac',
  'mglyph',
  'mi',
  'mlabeledtr',
  'mmultiscripts',
  'mn',
  'mo',
  'mover',
  'mpadded',
  'mphantom',
  'mroot',
  'mrow',
  'ms',
  'mspace',
  'msqrt',
  'mstyle',
  'msub',
  'msup',
  'msubsup',
  'mtable',
  'mtd',
  'mtext',
  'mtr',
  'munder',
  'munderover',
]);

function isContentDropped(name: string, namespace: Namespace): boolean {
  return (
    CONTENT_DROPPED_ELEMENTS.has(name) ||
    (namespace === 'html' && FOREIGN_ONLY_ELEMENTS.has(name))
  );
}

// Elements Reading view shows nothing of, by element semantics (measured for each: `x <video>a</video> b` renders `x b`); `details` and `dialog` without `open`, `svg` and `math` hide too, handled where they are pushed.
// Known divergences, each measured:
// - Paragraph closing: in a paragraph, a block start tag (`div`, `p`, `details`, `dialog`, headings, lists, …) closes the paragraph and every element open inside it, which depends on a block context `splitBlockPrefixes` cannot report, as headings, list items and callout titles have no paragraph (`x <span hidden>a <div>b</div> c</span> d` renders `x b c d`, titled `x d`).
// - A start tag that closes an open element of its kind (`p`, `li`, `dd`/`dt`, `option`, `a`, `nobr`, headings), and a nested `form` the browser ignores (`x <p hidden>a <p>b</p> c</p> d` renders `x b c d`, titled `x d`).
// - Formatting elements the browser reopens at the next text after an implicit pop, the special element a bold, italic or link text end closes around moving out of the elements that end closes, with what it already holds (`x **a <span hidden>b <button>c** d</button> e</span> f` renders `x a c d e f`, titled `x a d e f`), and a wikilink or tag, rendered as an `a`, closing an open `<a hidden>` (`x **a <b hidden>b** c</b> d` renders `x a d`, titled `x a c d`).
// - Foreign content: an HTML breakout start tag inside `svg` or `math` ends it (`x <svg>a <b>b</b> c</svg> d` renders `x b c d`, titled `x d`), and `mi` text shows in mathematical italic (`x <math><mi>a</mi></math> b` renders `x 𝑎 b`, titled `x a b`).
// - Text directly inside a `table` moves before it (`x <table hidden>a</table> b` renders `x a b`, titled `x b`).
// - `textarea` shows its content as typed, and `select` only its option text (`x <select>a <span hidden>b</span> c</select> d` renders `x d`, titled `x a c d`).
const HIDING_ELEMENTS = new Set([
  'datalist',
  'rp',
  'video',
  'audio',
  'canvas',
  'meter',
  'progress',
]);

// Obsidian's own `display` rules for these beat the `hidden` attribute, though not an inline `style` (measured: `x <button hidden>a</button> b` renders `x a b`).
const HIDDEN_ATTRIBUTE_OVERRIDDEN = new Set(['button', 'marquee']);

// The HTML elements of the spec's special category, which an end tag of another element never pops through (its MathML and SVG ones are in `isForeignSpecial`), plus `dialog`: it survives a construct's end in Reading view through the paragraph closing above, so treating it as special reproduces `x **a <dialog>b** c</dialog> d` rendering `x a d`.
const SPECIAL_ELEMENTS = new Set([
  'address',
  'applet',
  'area',
  'article',
  'aside',
  'base',
  'basefont',
  'bgsound',
  'blockquote',
  'body',
  'br',
  'button',
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
  'embed',
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
  'img',
  'input',
  'keygen',
  'li',
  'link',
  'listing',
  'main',
  'marquee',
  'menu',
  'meta',
  'nav',
  'noembed',
  'noframes',
  'noscript',
  'object',
  'ol',
  'p',
  'param',
  'plaintext',
  'pre',
  'script',
  'search',
  'section',
  'select',
  'source',
  'style',
  'summary',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'title',
  'tr',
  'track',
  'ul',
  'wbr',
  'xmp',
]);

// End tags the spec handles as a block's: they pop through every element above their own, unless a scope boundary sits above it (measured: `x <div hidden>a <p>b</div> c` renders `x c`).
const BLOCK_END_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'button',
  'center',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'header',
  'hgroup',
  'listing',
  'main',
  'menu',
  'nav',
  'ol',
  'pre',
  'search',
  'section',
  'summary',
  'ul',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'dd',
  'dt',
  'form',
  'table',
]);

// The spec's default scope boundaries among HTML elements that reach the stack, as `caption`, `td`, `th` and `html` are ignored and `template` read as raw text (measured: `<div><div hidden>a <object>b</div> c</object> d` renders nothing); `</p>` also stops at a `button`.
const HTML_SCOPE_BOUNDARIES = new Set(['applet', 'marquee', 'object', 'table']);

const MATHML_TOKEN_ELEMENTS = new Set(['mi', 'mn', 'mo', 'ms', 'mtext']);
const SVG_INTEGRATION_POINTS = new Set(['foreignobject', 'desc', 'title']);

// The spec counts these MathML and SVG elements as both special and scope boundaries, so an end tag the HTML rules apply to never pops through one (measured: `x <span hidden>a <math><mtext>b</span> c</mtext></math> d` and `x <div hidden>a <svg><desc>b</div> c</desc></svg> d` render `x`, while an SVG `text` is popped through).
function isForeignSpecial(name: string, namespace: Namespace): boolean {
  return namespace === 'math'
    ? MATHML_TOKEN_ELEMENTS.has(name) || name === 'annotation-xml'
    : namespace === 'svg' && SVG_INTEGRATION_POINTS.has(name);
}

// In SVG or MathML content these end tags close every foreign element above the nearest HTML element or integration point before the HTML rules apply (measured: `x <svg><g>a</p> b</g></svg> c` and `x <svg>a</br> b</svg> c` render `x b c`, `x <svg><text>a<desc>b</p> c</desc> d</text></svg> e` renders `x a d e`).
const FOREIGN_BREAKOUT_END_TAGS = new Set(['p', 'br']);

// Bold, italic and link text render as the spec's formatting elements, whose end tag runs the adoption agency algorithm; strikethrough and highlight end as any other element does.
const FORMATTING_CONSTRUCTS: ReadonlySet<ConstructElement> = new Set([
  'strong',
  'em',
  'a',
]);

// The cascade drops a declaration whose value it cannot parse, so the last valid one decides (measured: `x <span hidden style="display:foo">a</span> b` renders `x b`, `display:block flow` shows).
const CSS_WIDE_KEYWORDS = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
]);
const DISPLAY_KEYWORDS = new Set([
  'block',
  'inline',
  'run-in',
  'flow',
  'flow-root',
  'table',
  'flex',
  'grid',
  'ruby',
  'list-item',
  'math',
  'inline-block',
  'inline-table',
  'inline-flex',
  'inline-grid',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-row',
  'table-cell',
  'table-column-group',
  'table-column',
  'table-caption',
  'ruby-text',
  '-webkit-box',
  '-webkit-inline-box',
]);
const WHITESPACE_RUN = /\s+/;

function isValidDisplay(value: string): boolean {
  if (
    value === 'none' ||
    value === 'contents' ||
    CSS_WIDE_KEYWORDS.has(value)
  ) {
    return true;
  }
  return value
    .split(WHITESPACE_RUN)
    .every((keyword) => DISPLAY_KEYWORDS.has(keyword));
}

function isValidVisibility(value: string): boolean {
  return (
    value === 'visible' ||
    value === 'hidden' ||
    value === 'collapse' ||
    CSS_WIDE_KEYWORDS.has(value)
  );
}

// The value the cascade takes for `property` from a `style` attribute, lowercased: the last valid `!important` declaration, or else the last valid one (measured: `x <span style="display:none; display:inline">a</span> b` renders `x a b`).
function declaredValue(
  style: string,
  property: string,
  isValid: (value: string) => boolean
): string | undefined {
  let normal: string | undefined;
  let important: string | undefined;
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (
      colon === -1 ||
      declaration.slice(0, colon).trim().toLowerCase() !== property
    ) {
      continue;
    }
    let value = declaration
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    const bang = value.lastIndexOf('!');
    const isImportant =
      bang !== -1 && value.slice(bang + 1).trim() === 'important';
    if (isImportant) value = value.slice(0, bang).trim();
    if (!isValid(value)) continue;
    if (isImportant) important = value;
    else normal = value;
  }
  return important ?? normal;
}

// `inherit`, `unset` and the `revert` keywords leave the inherited visibility in place, so only a value that sets one declares it (measured: `visibility:hidden; visibility:inherit` shows).
function declaredVisibility(style: string): Visibility | undefined {
  const value = declaredValue(style, 'visibility', isValidVisibility);
  if (value === 'hidden' || value === 'collapse') return 'hidden';
  return value === 'visible' || value === 'initial' ? 'visible' : undefined;
}

// An inline `display` beats the `hidden` attribute, whatever its value (measured: `x <span hidden style="display:block">a</span> b` renders `x a b`).
function hidesByAttributes(
  name: string,
  namespace: Namespace,
  attributes: ReadonlyMap<string, string>
): boolean {
  const style = attributes.get('style');
  // Chromium's `innerText` still reads the text inside an SVG `g` set to `display: none` (measured: `x <svg><g style="display:none"><text>a</text></g></svg> b` renders `x a b`, while a `tspan`, `a` or `switch` set to it hides)
  const display =
    style === undefined || (namespace === 'svg' && name === 'g')
      ? undefined
      : declaredValue(style, 'display', isValidDisplay);
  if (display !== undefined) return display === 'none';
  // `hidden` is an HTML attribute, so SVG and MathML elements ignore it (measured: `x <svg><text hidden>a</text></svg> b` renders `x a b`)
  if (namespace !== 'html' || HIDDEN_ATTRIBUTE_OVERRIDDEN.has(name)) {
    return false;
  }
  const hidden = attributes.get('hidden');
  return hidden !== undefined && hidden.toLowerCase() !== 'until-found';
}

// The namespace a child of `parent` opens in: a foreign element's, unless `parent` is an integration point.
function childNamespace(parent: StackEntry | undefined): Namespace {
  return parent !== undefined &&
    parent.namespace !== 'html' &&
    !parent.integrationPoint
    ? parent.namespace
    : 'html';
}

// Skips the entries a pop or a construct's end has removed, so each one is passed over once.
function topAlive(entries: StackEntry[] | undefined): StackEntry | undefined {
  if (entries === undefined) return undefined;
  while (entries.length > 0 && !entries[entries.length - 1].alive) {
    entries.pop();
  }
  return entries[entries.length - 1];
}

function isAbove(
  candidate: StackEntry | undefined,
  entry: StackEntry
): boolean {
  return candidate !== undefined && candidate.position > entry.position;
}

/** The browser's open elements while one rendered line is read left to right. */
export class ElementStack {
  // Removed entries below the top stay in place, marked dead, so positions held elsewhere stay valid and a construct's end never splices; the top entry is always alive.
  private readonly entries: StackEntry[] = [];
  // Each list in push order, so its last live entry is the topmost of its kind and a close tag finds it at once; names are indexed apart by namespace, as the HTML end tag rules match HTML elements only and the foreign ones foreign elements only.
  private readonly htmlEntriesByName = new Map<string, StackEntry[]>();
  private readonly foreignEntriesByName = new Map<string, StackEntry[]>();
  private readonly htmlEntries: StackEntry[] = [];
  private readonly specialEntries: StackEntry[] = [];
  private readonly scopeBoundaryEntries: StackEntry[] = [];
  private readonly visibilityEntries: StackEntry[] = [];
  private readonly foreignRoots: StackEntry[] = [];
  private readonly constructs = new Map<
    number,
    { entry: StackEntry; formatting: boolean }
  >();
  // Hiding contributions of the live entries, less the ones a reveal cancels, so a text run reads one number however deep the stack is.
  private hidingCount = 0;

  /** Whether text at the current position shows: no entry hides it, and the nearest entry declaring a visibility does not set `hidden` or `collapse`, as a `visible` never undoes a hiding ancestor. */
  get showsText(): boolean {
    if (this.hidingCount > 0) return false;
    return topAlive(this.visibilityEntries)?.visibility !== 'hidden';
  }

  /**
   * Applies an HTML open tag.
   * @param name - The tag name, lowercased
   * @param attributes - Each attribute's decoded value under its lowercased name, the first of a repeated name kept
   * @param selfClosing - Whether the tag ends in `/>`
   */
  openElement(
    name: string,
    attributes: ReadonlyMap<string, string>,
    selfClosing: boolean
  ): void {
    if (IGNORED_START_TAGS.has(name) || VOID_ELEMENTS.has(name)) return;
    const parent = this.top();
    const context = childNamespace(parent);
    let namespace: Namespace = context;
    if (context === 'html' && (name === 'svg' || name === 'math')) {
      namespace = name;
    }
    // The browser honors `/>` in SVG and MathML only (measured: `x <svg/>a b` renders `x a b`, `x <span hidden/>a b` renders `x`)
    if (selfClosing && namespace !== 'html') return;
    // An `svg` or `math` nested in its own content adds nothing, as a `text` or token element inside shows through both (measured: `x <svg><svg><text>a</text></svg></svg> b` renders `x a b`)
    const isForeignRoot = context === 'html' && namespace !== 'html';
    const isDropped = DROPPED_ELEMENTS.has(name);
    const isForeignSpecialElement = isForeignSpecial(name, namespace);
    const style = attributes.get('style');
    const entry = this.push({
      name,
      namespace,
      special:
        (namespace === 'html' && SPECIAL_ELEMENTS.has(name)) ||
        isForeignSpecialElement,
      scopeBoundary:
        (namespace === 'html' && HTML_SCOPE_BOUNDARIES.has(name)) ||
        isForeignSpecialElement,
      integrationPoint:
        (namespace === 'math' && MATHML_TOKEN_ELEMENTS.has(name)) ||
        (namespace === 'svg' && SVG_INTEGRATION_POINTS.has(name)),
      hides:
        isContentDropped(name, namespace) ||
        (!isDropped &&
          ((namespace === 'html' &&
            (HIDING_ELEMENTS.has(name) ||
              (name === 'dialog' && !attributes.has('open')))) ||
            hidesByAttributes(name, namespace, attributes))),
      hidesUnlessRevealed:
        !isDropped &&
        (isForeignRoot ||
          (namespace === 'html' &&
            name === 'details' &&
            !attributes.has('open'))),
      reveals: this.revealedBy(name, namespace, parent),
      visibility:
        isDropped || style === undefined
          ? undefined
          : declaredVisibility(style),
    });
    if (isForeignRoot) this.foreignRoots.push(entry);
  }

  /** Applies an HTML close tag, by its lowercased name: while the current node is an SVG or MathML element, as the spec's rules for foreign content do, and otherwise, or where those hand it on, as its HTML rules do. */
  closeElement(name: string): void {
    const current = this.top();
    if (current !== undefined && current.namespace !== 'html') {
      if (FOREIGN_BREAKOUT_END_TAGS.has(name)) {
        this.popToHtmlOrIntegrationPoint();
      } else {
        // The nearest foreign element of the tag's name closes with everything above it, special or not, unless an HTML element comes first (measured: `x <svg><desc>a</svg> b` renders `x b`, `x <svg><desc><span>a</svg> b</span> c` renders `x`)
        const foreign = topAlive(this.foreignEntriesByName.get(name));
        const html = topAlive(this.htmlEntries);
        if (
          foreign !== undefined &&
          (html === undefined || isAbove(foreign, html))
        ) {
          this.removeEntries(foreign.position, this.entries.length);
          return;
        }
      }
    }
    this.closeHtmlElement(name);
  }

  /** Opens a construct's element, under a key its end names. */
  openConstruct(key: number, element: ConstructElement): void {
    const parent = this.top();
    const entry = this.push({
      name: '',
      namespace: childNamespace(parent),
      special: false,
      scopeBoundary: false,
      integrationPoint: false,
      hides: false,
      hidesUnlessRevealed: false,
      reveals: undefined,
      visibility: undefined,
    });
    this.constructs.set(key, {
      entry,
      formatting: FORMATTING_CONSTRUCTS.has(element),
    });
  }

  /** Ends a construct: bold, italic or link text ends nothing while a scope boundary sits above it, and otherwise closes with every non-special element above it, while a special one above it and what sits on that stay open (measured: `x **a <video>b** c</video> d` renders `x a c d`, `x **a <details>b** c</details> d` renders `x a d`, `x **a <svg><desc>b** c</desc></svg> d` renders `x a d`); strikethrough or highlight ends nothing while any special element sits above it, and otherwise closes with everything above it (measured: `x ~~a <span hidden>b <button>c~~ d</button> e</span> f` renders `x a f`). */
  closeConstruct(key: number): void {
    const construct = this.constructs.get(key);
    // A close tag already popped through it (measured: `x <span hidden>a **b</span> c** d` renders `x c d`)
    if (construct === undefined || !construct.entry.alive) return;
    const { entry, formatting } = construct;
    if (!formatting) {
      if (isAbove(topAlive(this.specialEntries), entry)) return;
      this.removeEntries(entry.position, this.entries.length);
      return;
    }
    if (isAbove(topAlive(this.scopeBoundaryEntries), entry)) return;
    let end = entry.position + 1;
    while (
      end < this.entries.length &&
      !(this.entries[end].alive && this.entries[end].special)
    ) {
      end++;
    }
    this.removeEntries(entry.position, end);
  }

  private top(): StackEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  // The HTML end tag rules, which match an HTML element only, so a foreign element of the same name ends nothing and a special one blocks the tag (measured: `x <math><mtext><b>a</mtext> b</b> c</math> d` renders `x a b c d`, `x <svg><text><foreignObject><b>a</foreignObject> b</b> c</text></svg> d` renders `x d`).
  private closeHtmlElement(name: string): void {
    const entry = topAlive(this.htmlEntriesByName.get(name));
    if (entry === undefined) return;
    if (BLOCK_END_TAGS.has(name)) {
      const isOutOfScope =
        isAbove(topAlive(this.scopeBoundaryEntries), entry) ||
        (name === 'p' &&
          isAbove(topAlive(this.htmlEntriesByName.get('button')), entry));
      if (isOutOfScope) return;
    } else if (isAbove(topAlive(this.specialEntries), entry)) {
      // A construct is no special element, so a close tag pops through one (measured: `x <video>a **b</video> c** d` renders `x c d`)
      return;
    }
    this.removeEntries(entry.position, this.entries.length);
  }

  // One entry per pass, each removed once, so a line of breakout end tags stays linear.
  private popToHtmlOrIntegrationPoint(): void {
    for (
      let current = this.top();
      current !== undefined &&
      current.namespace !== 'html' &&
      !current.integrationPoint;
      current = this.top()
    ) {
      this.removeEntries(current.position, this.entries.length);
    }
  }

  // A closed `details` shows its first child `summary`, an `svg` its `text` descendants and a `math` its token elements, while an outer hiding entry still hides them (measured: `x <details><details><summary>s</summary>a</details>c</details> b` renders `x b`).
  private revealedBy(
    name: string,
    namespace: Namespace,
    parent: StackEntry | undefined
  ): StackEntry | undefined {
    if (namespace === 'html' && name === 'summary') {
      if (
        parent?.name !== 'details' ||
        parent.namespace !== 'html' ||
        parent.hasSummary
      ) {
        return undefined;
      }
      parent.hasSummary = true;
      return parent.hidesUnlessRevealed ? parent : undefined;
    }
    const isForeignText =
      (namespace === 'svg' && name === 'text') ||
      (namespace === 'math' && MATHML_TOKEN_ELEMENTS.has(name));
    if (!isForeignText) return undefined;
    const root = topAlive(this.foreignRoots);
    return root?.namespace === namespace ? root : undefined;
  }

  private push(
    fields: Omit<
      StackEntry,
      'position' | 'alive' | 'openReveals' | 'hasSummary'
    >
  ): StackEntry {
    const entry: StackEntry = {
      ...fields,
      position: this.entries.length,
      alive: true,
      openReveals: 0,
      hasSummary: false,
    };
    this.entries.push(entry);
    const isHtml = entry.namespace === 'html';
    if (entry.name !== '') {
      const entriesByName = isHtml
        ? this.htmlEntriesByName
        : this.foreignEntriesByName;
      let sameName = entriesByName.get(entry.name);
      if (sameName === undefined) {
        sameName = [];
        entriesByName.set(entry.name, sameName);
      }
      sameName.push(entry);
    }
    if (isHtml) this.htmlEntries.push(entry);
    if (entry.special) this.specialEntries.push(entry);
    if (entry.scopeBoundary) this.scopeBoundaryEntries.push(entry);
    if (entry.visibility !== undefined) this.visibilityEntries.push(entry);
    if (entry.hides) this.hidingCount++;
    if (entry.hidesUnlessRevealed) this.hidingCount++;
    if (entry.reveals !== undefined && entry.reveals.openReveals++ === 0) {
      this.hidingCount--;
    }
    return entry;
  }

  // Top down, so a reveal gives its ancestor's contribution back before that ancestor goes.
  private removeEntries(from: number, to: number): void {
    for (let index = to - 1; index >= from; index--) {
      const entry = this.entries[index];
      if (entry.alive) this.kill(entry);
    }
    while (
      this.entries.length > 0 &&
      !this.entries[this.entries.length - 1].alive
    ) {
      this.entries.pop();
    }
  }

  private kill(entry: StackEntry): void {
    entry.alive = false;
    if (entry.hides) this.hidingCount--;
    if (entry.hidesUnlessRevealed && entry.openReveals === 0) {
      this.hidingCount--;
    }
    const revealed = entry.reveals;
    if (revealed?.alive && --revealed.openReveals === 0) this.hidingCount++;
  }
}
