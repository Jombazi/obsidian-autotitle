import { describe, it, expect } from 'vitest';
import {
  renderInlineMarkup,
  markdownLinkDestinations,
  opensHtmlBlock,
  inlineTags,
  InlineMarkupOptions,
} from '../../src/utils/inline-markup';
import { renderInlineMarkup as renderReferenceMarkup } from '../fixtures/inline-markup-reference';

type MarkupToggles = Omit<InlineMarkupOptions, 'protect'>;

const ALL_STRIPPING: MarkupToggles = {
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
  comments: 'unwrap',
};

const NO_STRIPPING: MarkupToggles = {
  bold: false,
  italic: false,
  strikethrough: false,
  highlight: false,
  code: false,
  wikilinks: false,
  links: false,
  html: false,
  footnotes: false,
  math: false,
  comments: 'keep',
};

const MIXED_STRIPPING: MarkupToggles = {
  bold: true,
  italic: false,
  strikethrough: true,
  highlight: false,
  code: true,
  wikilinks: false,
  links: true,
  html: false,
  footnotes: true,
  math: true,
  comments: 'remove',
};

// Marks protected text visibly, so the comparison also covers what each tokenizer protects.
const markProtected = (text: string): string => `«${text}»`;

// xorshift32, so every run draws the same inputs.
function seededRandom(seed: number): (limit: number) => number {
  let state = seed >>> 0;
  return (limit) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % limit;
  };
}

describe('renderInlineMarkup', () => {
  describe('equivalence with the tokenizer before the per-source caches', () => {
    // Delimiters, letters (including the ones `http` and `www` need), digits, spaces, and the characters of emails, escapes, tags, links and HTML.
    const ALPHABET = [
      '*',
      '_',
      '~',
      '=',
      '$',
      '`',
      '%',
      'a',
      'b',
      'c',
      'x',
      '1',
      '2',
      ' ',
      ' ',
      '@',
      '.',
      '\\',
      '<',
      '>',
      '[',
      ']',
      '(',
      ')',
      '#',
      '!',
      '|',
      '^',
      'w',
      'h',
      't',
      'p',
      ':',
      '/',
    ];
    // The constructs whose rendering changed since the reference: link destinations, inline HTML, footnotes, tags, sized embeds, and a block ID that may end an inline run (before the line's end or a closing delimiter).
    const CHANGED_CONSTRUCTS =
      /\]\(|<[A-Za-z!?/]|\[\^|\^\[|#|!\[\[|\^[a-zA-Z0-9-]+(?:$|[*_~=\]%])/;
    const INPUT_COUNT = 40000;

    it.each([
      { name: 'all stripping on', toggles: ALL_STRIPPING },
      { name: 'all stripping off', toggles: NO_STRIPPING },
      { name: 'mixed, comments removed', toggles: MIXED_STRIPPING },
    ])(
      'renders every seeded input outside the changed constructs as before, $name',
      ({ toggles }) => {
        const random = seededRandom(0x9e3779b9);
        const options: InlineMarkupOptions = {
          ...toggles,
          protect: markProtected,
        };
        let compared = 0;
        const mismatches: string[] = [];
        for (let input = 0; input < INPUT_COUNT; input++) {
          const length = random(40);
          let source = '';
          for (let index = 0; index < length; index++) {
            source += ALPHABET[random(ALPHABET.length)];
          }
          if (CHANGED_CONSTRUCTS.test(source)) continue;
          compared++;
          if (
            renderInlineMarkup(source, options) !==
            renderReferenceMarkup(source, options)
          ) {
            mismatches.push(source);
          }
        }
        expect(compared).toBeGreaterThan(INPUT_COUNT / 3);
        expect(mismatches.slice(0, 5)).toEqual([]);
      }
    );
  });

  describe('Reading view parity', () => {
    const renderAllStripped = (line: string): string =>
      renderInlineMarkup(line, { ...ALL_STRIPPING, protect: (text) => text });

    // Each readingView is the textContent Obsidian 1.14.4's Reading view renders for the line, spaces included.
    it.each([
      { line: 'foo ^ab', readingView: 'foo ' },
      { line: 'foo ^ab-1', readingView: 'foo ' },
      { line: '^ab', readingView: '' },
      { line: '[x ^ab](y) tail', readingView: 'x  tail' },
      { line: '[^ab](x) tail', readingView: ' tail' },
      { line: '[x ^ab] tail', readingView: '[x ] tail' },
      { line: '**bold ^ab** tail', readingView: 'bold  tail' },
      { line: '*em ^ab* tail', readingView: 'em  tail' },
      { line: '==hi ^ab== tail', readingView: 'hi  tail' },
      { line: '~~st ^ab~~ tail', readingView: 'st  tail' },
      { line: '*a*^ab', readingView: 'a' },
      { line: '`c`^ab', readingView: 'c' },
      { line: '\\*^ab', readingView: '*' },
      { line: '#tag^ab', readingView: '#tag' },
      { line: 'a *b ^c', readingView: 'a *b ' },
      { line: 'foo ^ab bar', readingView: 'foo ^ab bar' },
      { line: 'foo ^a_b', readingView: 'foo ^a_b' },
      { line: 'foo^ab', readingView: 'foo^ab' },
      { line: 'a ^b c', readingView: 'a ^b c' },
      { line: '[[n|x ^ab]] t', readingView: 'x ^ab t' },
    ])('block IDs: $line renders $readingView', ({ line, readingView }) => {
      expect(renderAllStripped(line)).toBe(readingView);
    });

    // Reading view shows a missing embed's error text, so these follow app.js 1.14.4's `Jg`, which reads the display text after the last `|` as a size when it is one; an embed left without alt text is titled after its target.
    it.each([
      { line: '![[a.png|alt|400]]', title: 'alt' },
      { line: '![[a.png|x|y|300x200]]', title: 'x|y' },
      { line: '![[a.png|alt|notasize]]', title: 'alt|notasize' },
      { line: '![[a.png|400]]', title: 'a.png' },
      { line: '![[a.png||400]]', title: 'a.png' },
      { line: '[[note|alt|400]]', title: 'alt|400' },
    ])('sized embeds: $line is titled $title', ({ line, title }) => {
      expect(renderAllStripped(line)).toBe(title);
    });
  });

  // Each shown text is what Obsidian 1.14.4's Reading view renders, the browser collapsing the doubled space
  describe('hidden elements', () => {
    const render = (line: string, htmlBlock?: boolean): string =>
      renderInlineMarkup(line, {
        ...ALL_STRIPPING,
        protect: (text) => text,
        htmlBlock,
      });

    it.each([
      { line: 'x <script>a `</script>` b</script> c', shown: 'x  c' },
      { line: 'x <script>a ``</script>`` b</script> c', shown: 'x  c' },
      { line: 'x <style>a `</style>` b</style> c', shown: 'x  c' },
      { line: 'x <title>a `</title>` b</title> c', shown: 'x  c' },
      { line: '<template>a `</template>` b</template> c', shown: ' c' },
      { line: 'x <script>a \\</script> b</script> c', shown: 'x  c' },
      { line: 'x <script>a $</script>$ b</script> c', shown: 'x  c' },
      { line: 'x <script>a %%</script>%% b</script> c', shown: 'x  c' },
      { line: 'x <script>a ^[</script>] b</script> c', shown: 'x  c' },
      {
        line: 'x <script>a https://e.com/</script> b</script> c',
        shown: 'x  b c',
      },
    ])(
      'in a paragraph, $line skips the close tags remark escapes',
      ({ line, shown }) => {
        expect(render(line)).toBe(shown);
      }
    );

    // Reading view renders the line's Markdown first, so a close tag in bold, emphasis, highlight, strikethrough, link or reference text pairs with an open tag outside it
    it.each([
      { line: 'x <script>a **</script>** b</script> c', shown: 'x  b c' },
      { line: 'x <script>a *</script>* b</script> c', shown: 'x  b c' },
      { line: 'x <script>a ==</script>== b</script> c', shown: 'x  b c' },
      { line: 'x <script>a ~~</script>~~ b</script> c', shown: 'x  b c' },
      { line: 'x <script>a [</script>](u) b</script> c', shown: 'x  b c' },
      { line: 'x <style>a **</style>** b</style> c', shown: 'x  b c' },
      { line: 'x <script>a **b</script> c** d</script> e', shown: 'x  c d e' },
      { line: 'x <script>a [</script>] b</script> c', shown: 'x ] b c' },
      { line: 'x <script>a [l](</script>) b</script> c', shown: 'x  c' },
      {
        line: 'x <script>a <https://e.com/</script>> b</script> c',
        shown: 'x  c',
      },
    ])(
      'in a paragraph, $line ends where the rendered HTML closes it',
      ({ line, shown }) => {
        expect(render(line)).toBe(shown);
      }
    );

    // The browser ends a hidden element at the first literal close tag in the HTML that reached it, inside an attribute value, a comment or an image's alt text too, and reads the rest of that token as HTML
    it.each([
      {
        line: 'x <script>a <a href="</script>">l</a> b</script> c',
        shown: 'x ">l b c',
      },
      {
        line: 'x <script>a <!-- </script> --> b</script> c',
        shown: 'x  --> b c',
      },
      {
        line: 'x <script>a ![</script>](p.png) b</script> c',
        shown: 'x "> b c',
      },
      {
        line: 'x <style>a <!-- </script> </style> --> b</style> c',
        shown: 'x  --> b c',
      },
      {
        line: 'x <style>a ![</script></style>](p.png) b</style> c',
        shown: 'x "> b c',
      },
      {
        line: 'x <script>a ![&lt;/script>](p.png) b</script> c',
        shown: 'x "> b c',
      },
      {
        line: 'x <script>a ![</script>a&amp;b](p.png) b</script> c',
        shown: 'x a&b"> b c',
      },
      {
        line: 'x <style>a <script title="</style>"> b</style> c',
        shown: 'x "> b c',
      },
      {
        line: 'x <script>a <!-- </script> <b>q</b> --> b</script> c',
        shown: 'x  q --> b c',
      },
      { line: 'x <a href="</script>">l</a> y', shown: 'x l y' },
      { line: 'x <!-- </script> --> y', shown: 'x  y' },
    ])('in a paragraph, $line renders $shown', ({ line, shown }) => {
      expect(render(line)).toBe(shown);
    });

    it.each([
      { line: 'x <iframe>a</iframe> b', shown: 'x  b' },
      { line: 'x <noembed>a</noembed> b', shown: 'x  b' },
      { line: 'x <noframes>a</noframes> b', shown: 'x  b' },
      { line: 'x <plaintext>a b', shown: 'x ' },
      { line: 'x <plaintext>a</plaintext> b', shown: 'x ' },
      { line: 'x <plaintext>a <script>b</script> c', shown: 'x ' },
      { line: '<plaintext>a b', shown: '' },
      { line: 'x <textarea>a</textarea> b', shown: 'x a b' },
    ])(
      'in a paragraph, $line hides what Reading view hides',
      ({ line, shown }) => {
        expect(render(line)).toBe(shown);
      }
    );

    it.each([
      { line: '<script>a `</script>` b</script> c', shown: '` b c' },
      { line: '<script>a \\</script> b</script> c', shown: ' b c' },
      { line: '<div><template>a `</template>` b</template> c', shown: '` b c' },
      { line: '<iframe src="x">a</iframe> b', shown: ' b' },
      { line: '<div><plaintext>a</plaintext> b', shown: '' },
    ])(
      'in an HTML block, $line ends at the first close tag',
      ({ line, shown }) => {
        expect(render(line, true)).toBe(shown);
      }
    );

    // A token's remainder after the close tag reaches the browser as HTML, so an element opened there stays open past the token
    it.each([
      {
        line: 'x <script>a <!-- </script> <style> --> b</script> c',
        shown: 'x  ',
      },
      {
        line: 'x <script>a <!-- </script> <span hidden> --> b</span> c',
        shown: 'x   c',
      },
    ])('in a paragraph, $line renders $shown', ({ line, shown }) => {
      expect(render(line)).toBe(shown);
    });

    // With links kept, the rest of a link whose text ends a raw-text element shows as typed, as kept bold does (`x <script>a **</script>** b</script> c` is titled `x ** b c`); a close tag Reading view escapes or keeps in a code span ends nothing
    it.each([
      { line: 'x <script>a [</script>](u) b</script> c', shown: 'x ](u) b c' },
      { line: 'x [</script>](u) y', shown: 'x [</script>](u) y' },
      { line: 'x <script>a [\\</script>](u) b</script> c', shown: 'x  c' },
      { line: 'x <script>a [`</script>`](u) b</script> c', shown: 'x  c' },
    ])('with links kept, $line renders $shown', ({ line, shown }) => {
      expect(
        renderInlineMarkup(line, {
          ...ALL_STRIPPING,
          links: false,
          protect: (text) => text,
        })
      ).toBe(shown);
    });
  });

  // Each shown text is what Obsidian 1.14.4's Reading view renders, the browser collapsing the doubled space
  describe('elements hidden by CSS or element semantics', () => {
    const render = (line: string): string =>
      renderInlineMarkup(line, { ...ALL_STRIPPING, protect: (text) => text });

    it.each([
      { line: 'x <video>a</video> b', shown: 'x  b' },
      { line: 'x <details>a</details> b', shown: 'x  b' },
      { line: 'x <dialog>a</dialog> b', shown: 'x  b' },
      { line: 'x <math>a</math> b', shown: 'x  b' },
      { line: 'x <meter>a</meter> b', shown: 'x  b' },
      { line: 'x <rp>a</rp> b', shown: 'x  b' },
      { line: 'x <audio controls>a</audio> b', shown: 'x  b' },
      { line: 'x <canvas>a</canvas> b', shown: 'x  b' },
      { line: 'x <progress>a</progress> b', shown: 'x  b' },
      { line: 'x <datalist>a</datalist> b', shown: 'x  b' },
      { line: 'x <span hidden>a</span> b', shown: 'x  b' },
      { line: 'x <b hidden>a</b> b', shown: 'x  b' },
      { line: 'x <div hidden>a</div> b', shown: 'x  b' },
      { line: 'x <SPAN HIDDEN>a</SPAN> b', shown: 'x  b' },
      { line: 'x <span hidden hidden="until-found">a</span> b', shown: 'x  b' },
      { line: 'x <span style="display:none">a</span> b', shown: 'x  b' },
      { line: 'x <span style="display: none;">a</span> b', shown: 'x  b' },
      {
        line: 'x <span style="color:red; display:none">a</span> b',
        shown: 'x  b',
      },
      { line: 'x <span style="DISPLAY:NONE">a</span> b', shown: 'x  b' },
      {
        line: 'x <span style="display:none !important">a</span> b',
        shown: 'x  b',
      },
      { line: 'x <span style="display : none">a</span> b', shown: 'x  b' },
      { line: 'x <span style="display&#58;none">a</span> b', shown: 'x  b' },
      {
        line: 'x <span style="display:none; display:foo">a</span> b',
        shown: 'x  b',
      },
      { line: 'x <span hidden style="display:foo">a</span> b', shown: 'x  b' },
      { line: 'x <span hidden style="display:">a</span> b', shown: 'x  b' },
      { line: 'x <span style="visibility:hidden">a</span> b', shown: 'x  b' },
      { line: 'x <span style="visibility:collapse">a</span> b', shown: 'x  b' },
      {
        line: 'x <span style="visibility:hidden; visibility:foo">a</span> b',
        shown: 'x  b',
      },
      { line: 'x <button style="display:none">a</button> b', shown: 'x  b' },
      { line: 'x <img hidden src="p.png"> b', shown: 'x  b' },
      { line: 'x <br hidden> b', shown: 'x  b' },
      { line: 'x <hr hidden> b', shown: 'x  b' },
    ])('$line hides what the element holds', ({ line, shown }) => {
      expect(render(line)).toBe(shown);
    });

    it.each([
      { line: 'x <details open>a</details> b', shown: 'x a b' },
      { line: 'x <details open="">a</details> b', shown: 'x a b' },
      { line: 'x <details OPEN>a</details> b', shown: 'x a b' },
      { line: 'x <dialog open>a</dialog> b', shown: 'x a b' },
      { line: 'x <span hidden="until-found">a</span> b', shown: 'x a b' },
      { line: 'x <span hidden="until&#45;found">a</span> b', shown: 'x a b' },
      { line: 'x <span aria-hidden="true">a</span> b', shown: 'x a b' },
      { line: 'x <span class="hidden">a</span> b', shown: 'x a b' },
      { line: 'x <span data-x="hidden">a</span> b', shown: 'x a b' },
      { line: 'x <span title="display:none">a</span> b', shown: 'x a b' },
      {
        line: 'x <span style="content-visibility:hidden">a</span> b',
        shown: 'x a b',
      },
      {
        line: 'x <span hidden style="display:block">a</span> b',
        shown: 'x a b',
      },
      {
        line: 'x <span hidden style="display:revert">a</span> b',
        shown: 'x a b',
      },
      {
        line: 'x <span style="display:none; display:inline">a</span> b',
        shown: 'x a b',
      },
      {
        line: 'x <span style="display:none; display:block flow">a</span> b',
        shown: 'x a b',
      },
      {
        line: 'x <span style="display:inline" style="display:none">a</span> b',
        shown: 'x a b',
      },
      {
        line: 'x <span style="visibility:hidden; visibility:inherit">a</span> b',
        shown: 'x a b',
      },
      { line: 'x <td hidden>a</td> b', shown: 'x a b' },
      { line: 'x <tr hidden>a</tr> b', shown: 'x a b' },
      { line: 'x <caption hidden>a</caption> b', shown: 'x a b' },
      { line: 'x <param hidden>a b', shown: 'x a b' },
      { line: 'x <search hidden>a</search> b', shown: 'x a b' },
      { line: 'x <object hidden>a</object> b', shown: 'x a b' },
      { line: 'x <button hidden>a</button> b', shown: 'x a b' },
      { line: 'x <marquee hidden>a</marquee> b', shown: 'x a b' },
      { line: 'x <object>a</object> b', shown: 'x a b' },
      { line: 'x <picture>a</picture> b', shown: 'x a b' },
      { line: 'x <slot>a</slot> b', shown: 'x a b' },
      { line: 'x <frameset>a</frameset> b', shown: 'x a b' },
      { line: 'x <applet>a</applet> b', shown: 'x a b' },
      { line: 'x <embed>a b', shown: 'x a b' },
    ])('$line shows what the element holds', ({ line, shown }) => {
      expect(render(line)).toBe(shown);
    });

    // A closed `details` shows its first child `summary`, an `svg` its `text` descendants and a `math` its token elements, while an outer hiding element still hides them
    it.each([
      { line: 'x <details><summary>s</summary>a</details> b', shown: 'x s b' },
      { line: 'x <details>a<summary>s</summary></details> b', shown: 'x s b' },
      {
        line: 'x <details><summary>s</summary><summary>t</summary>a</details> b',
        shown: 'x s b',
      },
      {
        line: 'x <details><summary>s <b>t</b></summary>a</details> b',
        shown: 'x s t b',
      },
      { line: 'x <summary>s</summary> b', shown: 'x s b' },
      {
        line: 'x <details>a <details open>q</details> c</details> d',
        shown: 'x  d',
      },
      {
        line: 'x <details><details><summary>s</summary>a</details>c</details> b',
        shown: 'x  b',
      },
      {
        line: 'x <details><summary hidden>s</summary>a</details> b',
        shown: 'x  b',
      },
      { line: 'x <svg><text>a</text></svg> b', shown: 'x a b' },
      { line: 'x <svg>a<text>t</text>c</svg> b', shown: 'x t b' },
      {
        line: 'x <svg><text>a<tspan>b</tspan></text></svg> c',
        shown: 'x ab c',
      },
      { line: 'x <svg><g><text>a</text></g></svg> c', shown: 'x a c' },
      { line: 'x <svg><title>t</title>a</svg> b', shown: 'x  b' },
      { line: 'x <svg><svg><text>a</text></svg></svg> b', shown: 'x a b' },
      { line: 'x <svg><svg>a</svg></svg> b', shown: 'x  b' },
      { line: 'x <video><svg><text>a</text></svg></video> b', shown: 'x  b' },
      {
        line: 'x <span hidden><svg><text>a</text></svg></span> b',
        shown: 'x  b',
      },
      { line: 'x <math><mtext>a</mtext></math> b', shown: 'x a b' },
      { line: 'x <math><mrow><mn>1</mn></mrow></math> b', shown: 'x 1 b' },
      {
        line: 'x <math><math><mtext>a</mtext></math></math> b',
        shown: 'x a b',
      },
      {
        line: 'x <span hidden>a <math><mi>b</mi></math> c</span> d',
        shown: 'x  d',
      },
      {
        line: 'x <ruby>a<rp>(</rp><rt>r</rt><rp>)</rp></ruby> b',
        shown: 'x ar b',
      },
    ])('$line reveals what Reading view reveals', ({ line, shown }) => {
      expect(render(line)).toBe(shown);
    });

    // SVG and MathML elements ignore `hidden` but not `style`, except an SVG `g`'s `display`, and honor `/>`
    it.each([
      { line: 'x <svg><text hidden>a</text></svg> b', shown: 'x a b' },
      { line: 'x <svg hidden><text>a</text></svg> b', shown: 'x a b' },
      { line: 'x <math hidden><mtext>a</mtext></math> b', shown: 'x a b' },
      {
        line: 'x <svg><text style="display:none">a</text></svg> b',
        shown: 'x  b',
      },
      {
        line: 'x <svg style="display:none"><text>a</text></svg> b',
        shown: 'x  b',
      },
      {
        line: 'x <svg style="visibility:hidden"><text>a</text></svg> b',
        shown: 'x  b',
      },
      {
        line: 'x <math><mtext style="display:none">a</mtext></math> b',
        shown: 'x  b',
      },
      {
        line: 'x <svg><text><tspan style="display:none">a</tspan>b</text></svg> c',
        shown: 'x b c',
      },
      {
        line: 'x <svg><g style="display:none"><text>a</text></g></svg> b',
        shown: 'x a b',
      },
      { line: 'x <svg/>a b', shown: 'x a b' },
      { line: 'x <math/>a b', shown: 'x a b' },
      { line: 'x <span hidden/>a b', shown: 'x ' },
    ])('foreign content: $line renders $shown', ({ line, shown }) => {
      expect(render(line)).toBe(shown);
    });

    // Obsidian's sanitizer drops a `foreignObject` or an `annotation-xml` with everything inside, in any namespace and letter case, whatever its `style`, though the parser still reads an SVG `foreignObject` as an integration point
    it.each([
      {
        line: 'x <svg><text><foreignObject>a</foreignObject></text></svg> b',
        shown: 'x  b',
      },
      {
        line: 'x <svg><foreignObject><b>a</b></foreignObject></svg> b',
        shown: 'x  b',
      },
      {
        line: 'x <svg><text><foreignObject><b>a</b></foreignObject></text></svg> b',
        shown: 'x  b',
      },
      {
        line: 'x <svg><text><foreignObject><svg><text>a</text></svg></foreignObject></text></svg> b',
        shown: 'x  b',
      },
      {
        line: 'x <svg><text>a <foreignObject>b</foreignObject> c</text></svg> d',
        shown: 'x a  c d',
      },
      {
        line: 'x <svg><text><FOREIGNOBJECT>a</FOREIGNOBJECT></text></svg> b',
        shown: 'x  b',
      },
      {
        line: 'x <svg><text><foreignObject style="display:inline">a</foreignObject></text></svg> b',
        shown: 'x  b',
      },
      { line: 'x <foreignObject>a</foreignObject> b', shown: 'x  b' },
      {
        line: 'x <math><mtext><foreignObject>a</foreignObject></mtext></math> b',
        shown: 'x  b',
      },
      { line: 'x <annotation-xml>a</annotation-xml> b', shown: 'x  b' },
      {
        line: 'x <math><annotation-xml><mtext>a</mtext></annotation-xml></math> b',
        shown: 'x  b',
      },
      {
        line: 'x <svg><text>a <annotation-xml>b</annotation-xml> c</text></svg> d',
        shown: 'x a  c d',
      },
    ])(
      'foreignObject and annotation-xml: $line renders $shown',
      ({ line, shown }) => {
        expect(render(line)).toBe(shown);
      }
    );

    // Obsidian's sanitizer drops an element named only in SVG or MathML, with everything inside, when the parser makes it an HTML element, outside `svg` and `math` or inside an integration point; the names HTML shares keep their HTML behavior, and a name the sanitizer disallows keeps its text
    it.each([
      { line: 'x <text>a</text> b', shown: 'x  b' },
      { line: 'x <mi>a</mi> b', shown: 'x  b' },
      { line: 'x <desc>a</desc> b', shown: 'x  b' },
      { line: 'x <g>a</g> b', shown: 'x  b' },
      { line: 'x <path>a</path> b', shown: 'x  b' },
      { line: 'x <tspan>a</tspan> b', shown: 'x  b' },
      { line: 'x <mrow>a</mrow> b', shown: 'x  b' },
      { line: 'x <TEXT>a</TEXT> b', shown: 'x  b' },
      { line: 'x <feBlend>a</feBlend> b', shown: 'x  b' },
      { line: 'x <text style="display:inline">a</text> b', shown: 'x  b' },
      { line: 'x <text>a <span>b</span> c</text> d', shown: 'x  d' },
      { line: 'x <span hidden>a <text>b</span> c</text> d', shown: 'x  c d' },
      {
        line: 'x <math><mtext>a<mi>b</mi> c</mtext></math> d',
        shown: 'x a c d',
      },
      {
        line: 'x <math><mtext>a<text>b</text> c</mtext></math> d',
        shown: 'x a c d',
      },
      { line: 'x <a>a</a> b', shown: 'x a b' },
      { line: 'x <font>a</font> b', shown: 'x a b' },
      { line: 'x <a hidden>a</a> b', shown: 'x  b' },
      { line: 'x <font hidden>a</font> b', shown: 'x  b' },
      {
        line: 'x <math><mtext><a>b</a> c</mtext></math> d',
        shown: 'x b c d',
      },
      { line: 'x <image>a b', shown: 'x a b' },
      { line: 'x <animate>a</animate> b', shown: 'x a b' },
      { line: 'x <mprescripts>a</mprescripts> b', shown: 'x a b' },
    ])(
      'SVG and MathML names on HTML elements: $line renders $shown',
      ({ line, shown }) => {
        expect(render(line)).toBe(shown);
      }
    );

    it.each([
      { line: 'x <video>a b', shown: 'x ' },
      { line: 'x <video>a</video', shown: 'x ' },
      { line: 'x <video>a **b**</video> c', shown: 'x  c' },
      { line: 'x <video>a <b>q</b></video> c', shown: 'x  c' },
      { line: 'x <video>a <!-- </video> --> b</video> c', shown: 'x  c' },
      {
        line: 'x <video>a <a href="</video>">l</a> b</video> c',
        shown: 'x  c',
      },
      { line: 'x <video>a `</video>` b</video> c', shown: 'x  c' },
      { line: 'x <span hidden>a <span>b</span> c</span> d', shown: 'x  d' },
      { line: 'x <video>a <video>b</video> c</video> d', shown: 'x  d' },
      { line: 'x <span hidden>a <b>b</span> c</b> d', shown: 'x  c d' },
      { line: 'x <span hidden>a <video>b</span> c</video> d', shown: 'x  c d' },
      { line: 'x <video>a <span hidden>b</video> c</span> d', shown: 'x  c d' },
      { line: 'x <span hidden>a <object>b</span> c</object> d', shown: 'x ' },
      { line: 'x <video>a <object>b</video> c</object> d', shown: 'x ' },
      {
        line: 'x <span style="visibility:hidden">a <span style="visibility:visible">b</span> c</span> d',
        shown: 'x b d',
      },
      {
        line: 'x <span style="visibility:hidden">a <span style="visibility:initial">b</span></span> c',
        shown: 'x b c',
      },
      { line: 'x <video>a <script>b</script> c</video> d', shown: 'x  d' },
      { line: 'x <video>a <script>s</video> q</script> c', shown: 'x ' },
      {
        line: 'x <video>a <style>b</video> c</style> d</video> e',
        shown: 'x  e',
      },
    ])(
      '$line hides to the close tag that pops the element',
      ({ line, shown }) => {
        expect(render(line)).toBe(shown);
      }
    );

    // A block's end tag pops through every element above its own, unless a scope boundary sits above it
    it.each([
      { line: 'x <div hidden>a <p>b</div> c', shown: 'x  c' },
      { line: 'x <details>a <p>b</details> c', shown: 'x  c' },
      {
        line: 'x <div hidden>a <details>b</div> c</details> d',
        shown: 'x  c d',
      },
      { line: 'x <div hidden><p>a</div> b', shown: 'x  b' },
      { line: '<div><div hidden>a <object>b</div> c</object> d', shown: '' },
      { line: '<div><div hidden>a <applet>b</div> c</applet> d', shown: '' },
    ])('block end tags: $line renders $shown', ({ line, shown }) => {
      expect(render(line)).toBe(shown);
    });

    // The spec counts MathML token elements, `annotation-xml` and SVG `foreignObject`, `desc` and `title` as special and as scope boundaries, so a close tag never pops through one, while an SVG `text` or a MathML `mrow` is popped through
    it.each([
      {
        line: 'x <span hidden>a <math><mtext>b</span> c</mtext></math> d',
        shown: 'x ',
      },
      {
        line: 'x <span hidden>a <math><mo>b</span> c</mo></math> d',
        shown: 'x ',
      },
      {
        line: 'x <span hidden>a <math><annotation-xml>b</span> c</annotation-xml></math> d',
        shown: 'x ',
      },
      {
        line: 'x <span hidden>a <svg><desc>b</span> c</desc></svg> d',
        shown: 'x ',
      },
      {
        line: 'x <span hidden>a <svg><title>b</span> c</title></svg> d',
        shown: 'x ',
      },
      {
        line: 'x <video>a <math><mi>b</video> c</mi></math> d',
        shown: 'x ',
      },
      {
        line: 'x <div hidden>a <math><mtext>b</div> c</mtext></math> d',
        shown: 'x ',
      },
      {
        line: 'x <div hidden>a <svg><foreignObject>b</div> c</foreignObject></svg> d',
        shown: 'x ',
      },
      {
        line: 'x <p hidden>a <svg><title>b</p> c</title></svg> d',
        shown: 'x ',
      },
      {
        line: 'x <span hidden>a <svg><text>b</span> c</text></svg> d',
        shown: 'x  c d',
      },
      {
        line: 'x <div hidden>a <svg><text>b</div> c</text></svg> d',
        shown: 'x  c d',
      },
      {
        line: 'x <div hidden>a <math><mrow>b</div> c</mrow></math> d',
        shown: 'x  c d',
      },
      { line: 'x <span hidden>a <desc>b</span> c</desc> d', shown: 'x  c d' },
    ])(
      'MathML and SVG special elements: $line renders $shown',
      ({ line, shown }) => {
        expect(render(line)).toBe(shown);
      }
    );

    // While the current element is an SVG or MathML one, an end tag closes the nearest foreign element of its name with everything above it, special or not, unless an HTML element sits above that, and `</p>` and `</br>` close every foreign element above the nearest HTML element or integration point; the HTML rules that apply otherwise match HTML elements only
    it.each([
      { line: 'x <svg><desc>a</svg> b', shown: 'x  b' },
      {
        line: 'x <span hidden>a <svg><desc>b</svg> c</span> d',
        shown: 'x  d',
      },
      {
        line: 'x <svg><text><foreignObject>a</text> b</svg> c',
        shown: 'x  c',
      },
      {
        line: 'x <svg><text><foreignObject>a</svg> b</foreignObject> c</text></svg> d',
        shown: 'x  b c d',
      },
      { line: 'x <svg><desc>a</SVG> b', shown: 'x  b' },
      { line: 'x <svg><desc>a</svg> b</desc> c', shown: 'x  b c' },
      { line: 'x <svg><text>a <foreignObject>b</svg> c', shown: 'x a  c' },
      { line: 'x <math><mtext>a</math> b</mtext> c', shown: 'x a b c' },
      {
        line: 'x <math><mrow><mtext>a</mrow> b</mtext></math> c',
        shown: 'x a c',
      },
      { line: 'x **a <svg><desc>b</svg> c** d', shown: 'x a  c d' },
      { line: 'x <svg><desc><span>a</svg> b</span> c', shown: 'x ' },
      {
        line: 'x <math><mtext>a <span hidden>b</math> c</span> d',
        shown: 'x a  d',
      },
      {
        line: 'x <math><mtext><b>a</mtext> b</b> c</math> d',
        shown: 'x a b c d',
      },
      {
        line: 'x <svg><text><foreignObject><b>a</foreignObject> b</b> c</text></svg> d',
        shown: 'x  d',
      },
      { line: 'x <svg><g>a</p> b</g></svg> c', shown: 'x  b c' },
      { line: 'x <svg>a</br> b</svg> c', shown: 'x  b c' },
      { line: 'x <math>a</p> b</math> c', shown: 'x  b c' },
      { line: 'x <svg><desc>a</p> b</desc></svg> c', shown: 'x  c' },
      { line: 'x <math><mtext>a</p> b</mtext></math> c', shown: 'x a b c' },
    ])('foreign content end tags: $line renders $shown', ({ line, shown }) => {
      expect(render(line)).toBe(shown);
    });

    // Reading view renders bold, italic, strikethrough, highlight and link text as elements, which a close tag pops through; bold, italic and link text end nothing under a scope boundary and otherwise close every non-special element opened inside, while strikethrough and highlight end nothing under any special element
    it.each([
      { line: 'x **a <video>b** c</video> d', shown: 'x a  c d' },
      { line: 'x *a <video>b* c</video> d', shown: 'x a  c d' },
      { line: 'x ~~a <video>b~~ c</video> d', shown: 'x a  c d' },
      { line: 'x ==a <video>b== c</video> d', shown: 'x a  c d' },
      { line: 'x **a <span hidden>b** c</span> d', shown: 'x a  c d' },
      { line: 'x [a <span hidden>b](u) c</span> d', shown: 'x a  c d' },
      { line: 'x **a <svg>b** c</svg> d', shown: 'x a  c d' },
      { line: 'x **a <details>b** c</details> d', shown: 'x a  d' },
      { line: 'x **a <dialog>b** c</dialog> d', shown: 'x a  d' },
      {
        line: 'x **a <details><summary>s</summary>b** c</details> d',
        shown: 'x a s d',
      },
      { line: 'x <span hidden>a **b</span> c** d', shown: 'x  c d' },
      { line: 'x <details>a **b</details> c** d', shown: 'x  c d' },
      { line: 'x <video>a **b</video> c** d', shown: 'x  c d' },
      { line: 'x <video>a [b</video>](u) c', shown: 'x  c' },
      {
        line: 'x **a <span hidden>b <object>c** d</object> e</span> f',
        shown: 'x a  f',
      },
      {
        line: 'x **a <span hidden>b <table>c** d</table> e</span> f',
        shown: 'x a  f',
      },
      {
        line: 'x **a <span hidden>b <marquee>c** d</marquee> e</span> f',
        shown: 'x a  f',
      },
      {
        line: 'x *a <span hidden>b <object>c* d</object> e</span> f',
        shown: 'x a  f',
      },
      {
        line: 'x [a <span hidden>b <object>c](u) d</object> e</span> f',
        shown: 'x a  f',
      },
      { line: 'x **a <svg><desc>b** c</desc></svg> d', shown: 'x a  d' },
      { line: 'x **a <svg><title>b** c</title></svg> d', shown: 'x a  d' },
      {
        line: 'x **a <svg><foreignObject>b** c</foreignObject></svg> d',
        shown: 'x a  d',
      },
      {
        line: 'x **a <span hidden>b <svg><desc>c** d</desc></svg> e</span> f',
        shown: 'x a  f',
      },
      {
        line: 'x **a <math><mtext>b** c</mtext></math> d',
        shown: 'x a b c d',
      },
      { line: 'x **a <math><mi>b** c</mi></math> d', shown: 'x a b c d' },
      { line: 'x **a <svg><text>b** c</text></svg> d', shown: 'x a b c d' },
      {
        line: 'x ~~a <span hidden>b <button>c~~ d</button> e</span> f',
        shown: 'x a  f',
      },
      {
        line: 'x ~~a <span hidden>b <object>c~~ d</object> e</span> f',
        shown: 'x a  f',
      },
      {
        line: 'x ==a <span hidden>b <object>c== d</object> e</span> f',
        shown: 'x a  f',
      },
      {
        line: 'x ~~a <video>b <object>c~~ d</object> e</video> f',
        shown: 'x a  f',
      },
      { line: 'x ~~a <details>b~~ c</details> d', shown: 'x a  d' },
      { line: 'x ==a <details>b== c</details> d', shown: 'x a  d' },
    ])('constructs: $line renders $shown', ({ line, shown }) => {
      expect(render(line)).toBe(shown);
    });
  });

  // The sentinels that mark hidden elements are private-use characters the line holds in no form, so its own survive
  describe('private-use characters', () => {
    it.each([
      { line: '\uE000 <script>a</script> b', shown: '\uE000  b' },
      {
        line: '&#xE000; &#57345; <script>a</script> b',
        shown: '\uE000 \uE001  b',
      },
      {
        line: '![&\\#xE000;</script>](p.png) <script>a</script> b',
        shown: '\uE000</script>  b',
      },
      { line: '%% \uE000 %% <script>a</script> b', shown: ' \uE000   b' },
    ])('$line keeps them', ({ line, shown }) => {
      expect(
        renderInlineMarkup(line, { ...ALL_STRIPPING, protect: (text) => text })
      ).toBe(shown);
    });

    it('reads the tags of a comment holding one', () => {
      expect(inlineTags('%% \uE000 #x %%')).toEqual(['#x']);
    });
  });

  describe('a 100 KB line renders in linear time', () => {
    const LINE_LENGTH = 100_000;
    const TIME_LIMIT_MS = 50;
    const repeatTo = (unit: string, length = LINE_LENGTH): string =>
      unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    // Runs one backtick longer each, so no run closes another and every offset into each run opens its own failed attempt.
    const distinctBacktickRuns = (shortestRunLength: number): string => {
      let source = '';
      for (
        let runLength = shortestRunLength;
        source.length < LINE_LENGTH;
        runLength++
      ) {
        source += '`'.repeat(runLength) + ' ';
      }
      return source;
    };

    // The best of three runs, so a garbage-collection pause or a cold JIT does not fail a line that renders in linear time; a quadratic line takes seconds every time.
    const fastestRenderMs = (source: string): number => {
      let fastest = Infinity;
      for (let run = 0; run < 3 && fastest >= TIME_LIMIT_MS; run++) {
        const startedAt = performance.now();
        renderInlineMarkup(source, {
          ...ALL_STRIPPING,
          protect: (text) => text,
        });
        fastest = Math.min(fastest, performance.now() - startedAt);
      }
      return fastest;
    };

    it.each([
      { shape: 'foo_bar snake_case', source: repeatTo('foo_bar') },
      { shape: '`$a ` repeated', source: repeatTo('$a ') },
      { shape: '`==a ` repeated', source: repeatTo('==a ') },
      { shape: '`~~a ` repeated', source: repeatTo('~~a ') },
      { shape: '`<!--a` repeated', source: repeatTo('<!--a') },
      { shape: '`<?a` repeated', source: repeatTo('<?a') },
      { shape: '`<a` repeated', source: repeatTo('<a') },
      {
        shape: '`<a` repeated and a trailing `>`',
        source: repeatTo('<a', LINE_LENGTH - 1) + '>',
      },
      {
        shape: '`<?a` repeated and a trailing `>`',
        source: repeatTo('<?a', LINE_LENGTH - 1) + '>',
      },
      {
        shape: '`<!--a` repeated and a trailing `>`',
        source: repeatTo('<!--a', LINE_LENGTH - 1) + '>',
      },
      { shape: '`www.x_` repeated', source: repeatTo('www.x_') },
      {
        shape: '`[[a]` repeated and a far `]]`',
        source: repeatTo('[[a]', LINE_LENGTH - 2) + ']]',
      },
      {
        shape: '`![[a]` repeated and a far `]]`',
        source: repeatTo('![[a]', LINE_LENGTH - 2) + ']]',
      },
      { shape: '`x@` repeated', source: repeatTo('x@') },
      { shape: '`a@b.c ` repeated', source: repeatTo('a@b.c ') },
      {
        shape: '`[a ` repeated and a closing `](x)`',
        source: repeatTo('[a ', LINE_LENGTH - 4) + '](x)',
      },
      {
        shape: '`^[a ` repeated and a closing `]`',
        source: repeatTo('^[a ', LINE_LENGTH - 1) + ']',
      },
      {
        shape: 'a long local part before an `@` whose domain has no dot',
        source:
          'a'.repeat(LINE_LENGTH / 2) + '@' + 'b'.repeat(LINE_LENGTH / 2 - 1),
      },
      {
        shape: '`<a@b` repeated and a trailing ` >`',
        source: repeatTo('<a@b', LINE_LENGTH - 2) + ' >',
      },
      { shape: '`a.@` repeated', source: repeatTo('a.@') },
      { shape: '`[a](b` repeated', source: repeatTo('[a](b') },
      {
        shape: '`[a](<b` repeated and a trailing `>`',
        source: repeatTo('[a](<b', LINE_LENGTH - 1) + '>',
      },
      { shape: '`[a](b (x` repeated', source: repeatTo('[a](b (x') },
      {
        shape: 'nested `[` and `](<` repeated, then a trailing `>`',
        source:
          '['.repeat(LINE_LENGTH / 4) + repeatTo('](<', LINE_LENGTH / 2) + '>',
      },
      { shape: '`[^a` repeated', source: repeatTo('[^a') },
      { shape: '``^[`a`` repeated', source: repeatTo('^[`a') },
      {
        shape: '`a#` repeated, no `#` after whitespace',
        source: repeatTo('a#'),
      },
      { shape: '` #a` repeated', source: repeatTo(' #a') },
      {
        shape: 'a run of 1,000 backticks and a far single one',
        source: '`'.repeat(1000) + 'a'.repeat(LINE_LENGTH - 1001) + '`',
      },
      {
        shape: 'one backtick run and a trailing ` a`',
        source: '`'.repeat(LINE_LENGTH - 2) + ' a',
      },
      {
        shape: 'about √n backtick runs of distinct lengths',
        source: distinctBacktickRuns(Math.floor(Math.sqrt(LINE_LENGTH))),
      },
      { shape: '`$a \\$ ` repeated', source: repeatTo('$a \\$ ') },
      {
        shape: 'hidden elements whose close tags sit in code spans',
        source: repeatTo('<script>`</script>` '),
      },
      {
        shape: 'closed hidden elements',
        source: repeatTo('<script>a</script> '),
      },
      {
        shape: 'hidden elements each ended inside a comment',
        source: repeatTo('<style>a <!-- </style> <b>q</b> --> '),
      },
      {
        shape: "hidden elements holding tags with another element's close tag",
        source: repeatTo('<script><a href="</style>"> '),
      },
      {
        shape: 'unclosed elements, then close tags of an element never opened',
        source:
          repeatTo('<span>', LINE_LENGTH / 2) +
          repeatTo('</video>', LINE_LENGTH / 2),
      },
      {
        shape: 'hiding elements under special ones, then their close tags',
        source:
          repeatTo('<video><div>', LINE_LENGTH / 2) +
          repeatTo('</video>', LINE_LENGTH / 2),
      },
      {
        shape: 'text runs inside unclosed elements',
        source: repeatTo('<span>a '),
      },
      {
        shape: 'unclosed elements, then bold runs',
        source:
          repeatTo('<span>', LINE_LENGTH / 2) +
          repeatTo('**a** ', LINE_LENGTH / 2),
      },
      {
        shape: 'bold runs each ending under a special element',
        source: repeatTo('**a <div>** '),
      },
      {
        shape: 'bold runs each ending under a scope boundary',
        source: repeatTo('**a <object>** '),
      },
      {
        shape: 'strikethrough runs each ending under a special element',
        source: repeatTo('~~a <div>~~ '),
      },
      {
        shape: 'unclosed SVG elements, then close tags of one never opened',
        source:
          '<svg>' +
          repeatTo('<g>', LINE_LENGTH / 2) +
          repeatTo('</text>', LINE_LENGTH / 2 - 5),
      },
      {
        shape: 'SVG elements each closed by a breakout end tag',
        source: repeatTo('<svg><g><g>a</p> '),
      },
    ])('$shape', ({ source }) => {
      expect(fastestRenderMs(source)).toBeLessThan(TIME_LIMIT_MS);
    });
  });
});

describe('markdownLinkDestinations', () => {
  it.each([
    { text: '[a](note.md)', destinations: ['note.md'] },
    { text: '[a](My%20Note.md)', destinations: ['My%20Note.md'] },
    { text: '[a](Foo%20(bar).md) tail', destinations: ['Foo%20(bar).md'] },
    { text: '[a](<My Note.md>)', destinations: ['My Note.md'] },
    { text: '[a](note.md "Title")', destinations: ['note.md'] },
    { text: '[a](Foo\\).md)', destinations: ['Foo).md'] },
    { text: '![alt](img.png) [b](c.md)', destinations: ['img.png', 'c.md'] },
    { text: '[![i](img.png)](note.md)', destinations: ['img.png', 'note.md'] },
    { text: '`[a](note.md)` and \\[b](c.md)', destinations: [] },
    { text: '[a] (note.md)', destinations: [] },
  ])('$text gives $destinations', ({ text, destinations }) => {
    expect(markdownLinkDestinations(text)).toEqual(destinations);
  });
});

// Each verdict is Obsidian 1.14.4's: the section type its metadata cache files the line under, and Reading view's rendering
describe('opensHtmlBlock', () => {
  it.each([
    '<script>x',
    '<SCRIPT>x',
    '<pre>x',
    '<style>x',
    '<!-- x',
    '<?php x',
    '<!DOCTYPE html>',
    '<![CDATA[x',
    '<div>#x</div>',
    '</div> x',
    '<center>x',
    '<p>x',
    '<title>x',
    '<b>',
    '<span class="a">',
    '  <div>x',
    '- <div>x',
    '1. <div>x',
    '- [ ] <div>x',
    '> <div>x',
    '> - <script>x',
    '> [!note] <div>x',
  ])('%s opens an HTML block', (line) => {
    expect(opensHtmlBlock(line)).toBe(true);
  });

  it.each([
    '# <div>x',
    '- # <script>x',
    'x <div>x',
    '<span>x</span>',
    '<b>x</b>',
    '<template>x',
    '<xmp>x',
    '<noscript>x',
    '<search>x',
    '> [!note] x <div>x',
    '    <div>x',
  ])('%s opens none', (line) => {
    expect(opensHtmlBlock(line)).toBe(false);
  });
});

// Each expectation is the tags Obsidian 1.14.4's metadata cache indexes for the line
describe('inlineTags', () => {
  it.each([
    { line: '#draft x', tags: ['#draft'] },
    { line: 'x #a and #b', tags: ['#a', '#b'] },
    { line: '# <div>#x</div>', tags: ['#x'] },
    { line: 'a <script>#x</script>', tags: ['#x'] },
    { line: '<span>#x</span>', tags: ['#x'] },
    { line: '<template>#x</template>', tags: ['#x'] },
    { line: '%% #x %%', tags: ['#x'] },
    { line: 'x %%#x%%', tags: ['#x'] },
    { line: '[#x](y)', tags: ['#x'] },
    { line: '^[#x]', tags: ['#x'] },
    { line: '**#x**', tags: ['#x'] },
    { line: '> [!note] #x', tags: ['#x'] },
    { line: '- [ ] #x', tags: ['#x'] },
    { line: '`#x`', tags: [] },
    { line: '[a](#x)', tags: [] },
    { line: '[x](<#x>)', tags: [] },
    { line: '\\#x', tags: [] },
    { line: '[[#x]]', tags: [] },
    { line: '[^#x]', tags: [] },
    { line: '$#x$', tags: [] },
    { line: '#123', tags: [] },
    { line: 'https://a.com/#x', tags: [] },
    { line: '<https://a.com/#x>', tags: [] },
    { line: 'x <!-- #x -->', tags: [] },
    { line: '<script>#x</script>', tags: [] },
    { line: '<div>#x</div>', tags: [] },
    { line: '- <div>#x</div>', tags: [] },
    { line: '> [!note] <div>#x</div>', tags: [] },
  ])('$line holds $tags', ({ line, tags }) => {
    expect(inlineTags(line)).toEqual(tags);
  });
});
