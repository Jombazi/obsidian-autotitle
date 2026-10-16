/**
 * Tests for the title-source walk
 *
 * Focus: every reader of a note's title finds the same properties boundary and the
 * same block, and that block is the one Reading view shows first. Expected values
 * follow Obsidian 1.14.4's Reading view (measured in the Dev vault) or its app.js
 * tokenizers where MathJax replaces the rendering.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  bodyStartLine,
  findTitleSource,
  firstNonEmptyLineIndex,
  lineSourceFromEditor,
  lineSourceFromText,
  sameTitleSource,
  TitleSource,
} from '../../src/utils/title-source';
import { applyTitleCase, extractTitle } from '../../src/utils/title-extraction';
import { PluginSettings } from '../../src/types';
import { createTestSettings, splitFrontMatter } from '../testUtils';
import { Editor } from '../mockObsidian';

describe('title-source', () => {
  let settings: PluginSettings;

  beforeEach(() => {
    settings = createTestSettings();
  });

  /** The title source for a note's text. */
  const sourceOf = (text: string): TitleSource | null =>
    findTitleSource(lineSourceFromText(text), settings);

  /** The title source's text, or null for a body with no non-empty line. */
  const textOf = (text: string): string | null => sourceOf(text)?.text ?? null;

  /** The title a note's text yields before forbidden characters, as the rename makes it. */
  const titleOf = (text: string): string => {
    const source = sourceOf(text);
    if (source === null) return '';
    return source.raw
      ? applyTitleCase(source.text.trim(), settings)
      : extractTitle(source.text, settings);
  };

  describe('lineSourceFromText', () => {
    const texts = [
      '',
      'one line',
      'a\nb\nc',
      'trailing newline\n',
      '\n\nblank lines first',
      'a\r\nb\r\n\r\nc',
      'mixed\r\nbreaks\nhere\r\n',
      '---\ntitle: x\n---\nBody',
    ];

    it.each(texts)('returns the same lines as split for %j', (text) => {
      const expected = text.split(/\r?\n/);
      const lines = lineSourceFromText(text);

      expect(lines.lineCount).toBe(expected.length);
      expect(
        Array.from({ length: lines.lineCount }, (_, i) => lines.line(i))
      ).toEqual(expected);
    });

    it('reads the same lines in any order', () => {
      const lines = lineSourceFromText('a\nb\nc\nd');

      expect(lines.line(3)).toBe('d');
      expect(lines.line(1)).toBe('b');
      expect(lines.lineCount).toBe(4);
      expect(lines.line(0)).toBe('a');
    });

    it('returns an empty string past the last line', () => {
      expect(lineSourceFromText('a\nb').line(5)).toBe('');
    });

    it('never splits the whole text', () => {
      const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join(
        '\n'
      );
      const split = vi.spyOn(String.prototype, 'split');

      try {
        const lines = lineSourceFromText(text);
        lines.line(0);
        lines.line(250);
        void lines.lineCount;
        findTitleSource(lines, settings);

        expect(split.mock.contexts.some((context) => context == text)).toBe(
          false
        );
      } finally {
        split.mockRestore();
      }
    });
  });

  describe('lineSourceFromEditor', () => {
    it("reads through the editor's line index", () => {
      const editor = new Editor();
      editor.lineCount = vi.fn(() => 2);
      editor.getLine = vi.fn((line: number) => ['First', 'Second'][line]);

      const lines = lineSourceFromEditor(editor);

      expect(lines.lineCount).toBe(2);
      expect(lines.line(1)).toBe('Second');
      expect(editor.getValue).not.toHaveBeenCalled();
    });
  });

  describe('bodyStartLine', () => {
    /** The body's first line by `getFrontMatterInfo`'s offsets; a closer that ends the note leaves an empty body. */
    const expectedBodyStart = (text: string): number => {
      const info = splitFrontMatter(text);
      if (!info.exists) return 0;
      const head = text.slice(0, info.contentStart);
      return head.endsWith('\n')
        ? head.split('\n').length - 1
        : text.split(/\r?\n/).length;
    };

    const openers = ['---', '--- ', ' ---', '----'];
    const closers = ['---', '--- ', ' ---', '\t---', '----'];
    const bodies = ['', 'Body', 'Body\nMore'];
    const cases: string[] = [];
    for (const separator of ['\n', '\r\n']) {
      for (const opener of openers) {
        for (const closer of closers) {
          for (const body of bodies) {
            cases.push(
              [opener, 'title: x', closer, body].join(separator),
              [opener, closer, body].join(separator)
            );
          }
        }
        cases.push(`${opener}${separator}title: x`);
      }
    }
    cases.push('---', '---\n---', '---\ntitle: x\n---', 'Body\n---\nx\n---');

    it.each(cases)('agrees with getFrontMatterInfo on %j', (text) => {
      const lines = lineSourceFromText(text);
      const expected = expectedBodyStart(text);

      if (expected >= lines.lineCount) {
        // An empty body: the closer is the note's last line
        expect(bodyStartLine(lines)).toBe(lines.lineCount);
      } else {
        expect(bodyStartLine(lines)).toBe(expected);
      }
    });
  });

  describe('firstNonEmptyLineIndex', () => {
    it('counts lines from the start of the note', () => {
      expect(
        firstNonEmptyLineIndex(lineSourceFromText('---\na: 1\n---\n\nBody'))
      ).toBe(4);
    });

    it('is -1 for a body of blank lines', () => {
      expect(
        firstNonEmptyLineIndex(lineSourceFromText('---\na: 1\n---\n \n\t\n'))
      ).toBe(-1);
    });
  });

  describe('findTitleSource', () => {
    it('returns null for an empty body', () => {
      expect(sourceOf('')).toBeNull();
      expect(sourceOf('\n  \n\t')).toBeNull();
      expect(sourceOf('---\ntitle: x\n---\n\n')).toBeNull();
    });

    it.each(['---', '%%\ncomment', '[1]: https://example.com'])(
      'returns a synthetic Untitled when every line of %j is skipped',
      (text) => {
        expect(sourceOf(text)).toEqual({
          firstNonEmptyLine: text.split('\n')[0],
          text: 'Untitled',
          lineIndex: -1,
          raw: false,
          tagsIndexed: false,
        });
      }
    );

    it('reports the first non-empty line and the absolute line of the text', () => {
      expect(sourceOf('---\na: 1\n---\n\n---\nTitle')).toEqual({
        firstNonEmptyLine: '---',
        text: 'Title',
        lineIndex: 5,
        raw: false,
        tagsIndexed: true,
      });
    });

    it('reads a pseudo-block opened by `--- ` as body, as getFrontMatterInfo does', () => {
      expect(sourceOf('--- \nfoo: bar\n---\nBody')).toMatchObject({
        text: 'foo: bar',
        lineIndex: 1,
      });
    });

    it('finds the same source in a CRLF file as in an LF file', () => {
      expect(sourceOf('---\r\na: 1\r\n---\r\n```\r\ncode\r\n```')).toEqual(
        sourceOf('---\na: 1\n---\n```\ncode\n```')
      );
    });

    it.each([' ---\nfoo: bar\n---\nBody', '---\nfoo: bar\n ---\nBody'])(
      'reads %j as body, never cutting it at the pseudo-block',
      (text) => {
        expect(textOf(text)).toBe('foo: bar');
      }
    );

    describe('rule 1: indented code', () => {
      it.each([
        { text: '    foo', title: 'foo' },
        { text: '\tfoo', title: 'foo' },
        { text: '\t\tfoo', title: '\tfoo' },
        { text: '     foo', title: ' foo' },
      ])('takes $text as code, without one indent', ({ text, title }) => {
        expect(sourceOf(text)).toMatchObject({
          text: title,
          lineIndex: 0,
          raw: true,
        });
      });

      it('takes any other mix of spaces and tabs as no code', () => {
        expect(sourceOf('  \ta')).toMatchObject({ text: '  \ta', raw: false });
      });

      // Remark runs indented code before every other block tokenizer.
      it.each([
        '    ---',
        '    %%\ncomment\n%%\nNext',
        '    $$\nx\n$$',
        '    ```',
      ])('takes %j as code before any other rule', (text) => {
        expect(sourceOf(text)).toMatchObject({
          text: text.split('\n')[0].slice(4),
          raw: true,
        });
      });
    });

    describe('rule 2: code fences', () => {
      it('takes the first non-empty line inside, as typed', () => {
        expect(sourceOf('```js\n\n# comment\n```\nNext')).toEqual({
          firstNonEmptyLine: '```js',
          text: '# comment',
          lineIndex: 2,
          raw: true,
          tagsIndexed: false,
        });
      });

      it('reads a tilde fence', () => {
        expect(sourceOf('~~~\ncode\n~~~\nNext')).toMatchObject({
          text: 'code',
          raw: true,
        });
      });

      it('lets a tilde fence hold tildes in its info string', () => {
        expect(textOf('~~~a~b\ncode\n~~~')).toBe('code');
      });

      it('cancels a backtick fence whose info string holds a backtick', () => {
        expect(sourceOf('```js `x`\ncode')).toMatchObject({
          text: '```js `x`',
          raw: false,
        });
      });

      it('opens a fence after spaces and a tab', () => {
        expect(sourceOf(' \t```\ncode\n```')).toMatchObject({
          text: 'code',
          raw: true,
        });
      });

      it('gives Untitled for an empty fence', () => {
        expect(sourceOf('```\n\n```\nNext')).toMatchObject({
          text: 'Untitled',
          lineIndex: -1,
        });
      });

      it('gives Untitled for an unclosed fence holding only blank lines', () => {
        expect(textOf('```\n\n')).toBe('Untitled');
      });

      it('reads a closer indented four spaces as content', () => {
        expect(textOf('```\n    ```\n```')).toBe('    ```');
      });

      it('reads a shorter closer as content', () => {
        expect(textOf('````\n```\n````')).toBe('```');
      });

      it('reads a closer of the other character as content', () => {
        expect(textOf('```\n~~~\n```')).toBe('~~~');
      });

      describe('with code block stripping off', () => {
        beforeEach(() => {
          settings.markupStripping.stripMarkupSettings.codeBlocks = false;
        });

        it('takes the fence line as typed', () => {
          expect(sourceOf('```js\nconst x = 1;\n```')).toEqual({
            firstNonEmptyLine: '```js',
            text: '```js',
            lineIndex: 0,
            raw: true,
            tagsIndexed: false,
          });
        });

        it('still reads a card link title', () => {
          expect(textOf('```embed\nurl: x\ntitle: "Card"\n```')).toBe('Card');
        });

        it('skips diagram detection, which Settings shows under the toggle', () => {
          expect(textOf('```mermaid\ngraph TD\n```')).toBe('```mermaid');
        });
      });

      describe('card links', () => {
        it.each(['embed', 'cardlink'])(
          'takes the title of a %s card link as part of a line',
          (kind) => {
            expect(
              sourceOf(`\`\`\`${kind}\nurl: x\ntitle: 'Card'\n\`\`\``)
            ).toMatchObject({ text: 'Card', lineIndex: -1, raw: false });
          }
        );

        it('gives Untitled for a card link with no title', () => {
          expect(textOf('```cardlink\nurl: x\n```\nNext')).toBe('Untitled');
        });

        it('reads a card link as code when grabbing its title is off', () => {
          settings.markupStripping.grabTitleFromCardLink = false;

          expect(sourceOf('```cardlink\nurl: x\n```')).toMatchObject({
            text: 'url: x',
            raw: true,
          });
        });
      });

      describe('diagrams', () => {
        it('titles a mermaid fence Diagram', () => {
          expect(sourceOf('```mermaid\ngraph TD\n```')).toMatchObject({
            text: 'Diagram',
            lineIndex: -1,
          });
        });

        it('reads a mermaid fence as code when detection is off', () => {
          settings.markupStripping.detectDiagrams = false;

          expect(textOf('```mermaid\ngraph TD\n```')).toBe('graph TD');
        });
      });
    });

    describe('rule 3: display math', () => {
      it.each([
        { text: '$$\n\nx^2\n$$\nNext', block: 'a multi-line block' },
        {
          text: '$$x^2\n$$\nNext',
          block: 'an opener with text after its `$$`',
        },
        { text: '$$\nx $$\nNext', block: 'a block closed on a content line' },
        { text: '$$\n$$\nNext', block: 'an empty block' },
        { text: '$$\nx^2\nNext', block: 'an unclosed block' },
        { text: '$$', block: 'an unclosed empty block' },
        { text: '   $$\nx\n$$', block: 'a block opened after three spaces' },
        { text: '$$E=mc^2$$\nNext', block: 'a one-line formula' },
        { text: '  $$E=mc^2$$ \t', block: 'a spaced one-line formula' },
        { text: '$$a$b \\$$ c$$', block: 'a one-line formula holding `$`' },
      ])('titles $block Math block', ({ text }) => {
        expect(sourceOf(text)).toEqual({
          firstNonEmptyLine: text.split('\n')[0],
          text: 'Math block',
          lineIndex: -1,
          raw: false,
          tagsIndexed: false,
        });
      });

      it('opens no block after a tab', () => {
        expect(textOf(' \t$$\nx\n$$')).toBe(' \t$$');
      });

      it.each([
        'Energy $$E=mc^2$$ rules',
        '$$a$$ and $$b$$',
        '$$E=mc^2$$ rules',
        '$$a\\$$',
      ])('leaves %j to the inline math tokenizer', (text) => {
        expect(sourceOf(text)).toMatchObject({ text, lineIndex: 0 });
      });

      it('keeps the opener line when math block stripping is off', () => {
        settings.markupStripping.stripMathBlockMarkup = false;

        expect(textOf('$$\nx\n$$')).toBe('$$');
        expect(textOf('$$E=mc^2$$\nNext')).toBe('$$E=mc^2$$');
      });
    });

    describe('rule 4: rules', () => {
      it.each(['---', '***', '___', '- - -', ' \t---', '--- '])(
        'skips %j',
        (rule) => {
          expect(textOf(`${rule}\nNext`)).toBe('Next');
        }
      );

      it('keeps a rule when rule stripping is off', () => {
        settings.markupStripping.stripHorizontalRuleMarkup = false;

        expect(textOf('---\nNext')).toBe('---');
      });
    });

    describe('rule 5: comment blocks', () => {
      describe('removed (strip comment markup and strip comments entirely, strip HTML markup)', () => {
        beforeEach(() => {
          settings.markupStripping.stripMarkupSettings.comments = true;
          settings.markupStripping.stripCommentsEntirely = true;
          settings.markupStripping.stripMarkupSettings.htmlTags = true;
        });

        // Each readingView is the first text Obsidian 1.14.4's Reading view renders for the body, measured in the Dev vault
        it.each([
          { body: '%%\ncomment\n%%\nNext', readingView: 'Next' },
          { body: '<!--\ncomment\n-->\nNext', readingView: 'Next' },
          { body: '%% foo\nbar\n%%\nNext', readingView: 'Next' },
          { body: '%%\ncomment\n%% Tail\nNext', readingView: 'Tail' },
          { body: '<!--\ncomment\n--> Tail', readingView: 'Tail' },
          { body: '   %%\ncomment\n%%\nNext', readingView: 'Next' },
        ])(
          '$body yields the line Reading view shows first',
          ({ body, readingView }) => {
            expect(textOf(body)?.trim()).toBe(readingView);
          }
        );

        it("skips the HTML opener line's own text and blank lines after the closer", () => {
          expect(textOf('<!-- foo\nbar\n-->\n\nNext')).toBe('Next');
        });

        it('continues past consecutive comment blocks', () => {
          expect(textOf('%%\na\n%%\n%%\nb\n%%\nNext')).toBe('Next');
        });

        it.each(['%%\ncomment\nNext', '<!--\ncomment\nNext'])(
          'gives Untitled when %s never closes, since Reading view renders nothing after it',
          (body) => {
            expect(textOf(body)).toBe('Untitled');
          }
        );

        it('takes the text after the closer as part of a line', () => {
          expect(sourceOf('%%\ncomment\n%% Tail')?.lineIndex).toBe(-1);
        });

        it('reads `%% 50% off` as a paragraph, since a `%` on the opener line cancels the block', () => {
          expect(textOf('%% 50% off\ncomment\n%%\nNext')).toBe('%% 50% off');
        });

        it('opens no block after a tab', () => {
          expect(textOf(' \t%%\ncomment\n%%\nNext')).toBe(' \t%%');
        });
      });

      describe('unwrapped (strip comment markup only)', () => {
        beforeEach(() => {
          settings.markupStripping.stripCommentsEntirely = false;
          settings.markupStripping.stripMarkupSettings.comments = true;
        });

        it("takes the opener line's text after %%", () => {
          expect(textOf('%% foo\nbar\n%%\nNext')?.trim()).toBe('foo');
        });

        it('takes the first non-blank line inside the comment, as a whole line', () => {
          expect(sourceOf('%%\n\ncomment\n%%\nNext')).toMatchObject({
            text: 'comment',
            lineIndex: 2,
          });
        });

        it("takes the closer line's text before %%", () => {
          expect(textOf('%%\n\nbar %% Tail\nNext')?.trim()).toBe('bar');
        });

        it('takes the text inside a comment that never closes', () => {
          expect(textOf('%%\n\ncomment')).toBe('comment');
        });

        it('continues after an empty comment', () => {
          expect(textOf('%%\n\n%%\nNext')).toBe('Next');
        });

        it('takes the text after the closer of an empty comment', () => {
          expect(textOf('%%\n%% Tail\nNext')?.trim()).toBe('Tail');
        });

        it('gives Untitled for an empty comment that never closes', () => {
          expect(textOf('%%\n\n')).toBe('Untitled');
        });

        it('still removes an HTML comment block, which has no unwrap mode', () => {
          expect(textOf('<!-- foo\nbar\n-->\nNext')).toBe('Next');
        });
      });

      describe('kept', () => {
        it('returns the %% opener line when both comment toggles are off', () => {
          settings.markupStripping.stripCommentsEntirely = false;
          settings.markupStripping.stripMarkupSettings.comments = false;

          expect(textOf('%%\ncomment\n%%\nNext')).toBe('%%');
        });

        // Settings hides "Strip comments entirely" under "Strip comment markup", so it counts only while that is on.
        it('returns the %% opener line when only strip comments entirely is on', () => {
          settings.markupStripping.stripCommentsEntirely = true;
          settings.markupStripping.stripMarkupSettings.comments = false;

          expect(textOf('%%\ncomment\n%%\nNext')).toBe('%%');
        });

        it('returns the HTML comment opener line when HTML markup is kept', () => {
          settings.markupStripping.stripMarkupSettings.htmlTags = false;

          expect(textOf('<!--\ncomment\n-->\nNext')).toBe('<!--');
        });
      });

      it('keeps a one-line comment as the title source, though Reading view shows the next line', () => {
        expect(textOf('%%x%%\nNext')).toBe('%%x%%');
      });
    });

    describe('rule 6: definitions', () => {
      it.each([
        '[1]: https://example.com\n\nNext',
        '[1]: https://example.com\nNext',
        ' \t[a]: /url\nNext',
      ])('skips the link reference definition in %j', (text) => {
        expect(textOf(text)).toBe('Next');
      });

      it.each([
        { text: '[^1]: note\n\nNext', title: 'Next' },
        { text: '[^1]:note\n\nNext', title: 'Next' },
        { text: ' \t[^1]: note\n\nNext', title: 'Next' },
        { text: '[^1]: note\n    more\n\nNext', title: 'Next' },
        { text: '[^1]: note\n\n\tmore\n\nNext', title: 'Next' },
        { text: '[^1]: note\n\n   less\n\nNext', title: '   less' },
      ])(
        'ends the footnote definition in $text at $title',
        ({ text, title }) => {
          expect(textOf(text)).toBe(title);
        }
      );

      it('continues the footnote definition over paragraph text right after it', () => {
        expect(textOf('[^1]: note\nNext')).toBe('Untitled');
      });

      it('lets no comment end the footnote definition', () => {
        expect(textOf('[^1]: note\n%%\nc\n%%\nNext')).toBe('Untitled');
      });

      it.each([
        { opener: '# Heading', title: '# Heading' },
        { opener: '   # Heading', title: '   # Heading' },
        { opener: '- item', title: '- item' },
        { opener: '1. item', title: '1. item' },
        { opener: '> q', title: '> q' },
        { opener: '```\ncode\n```', title: 'code' },
        { opener: '$$\nx\n$$', title: 'Math block' },
        { opener: '<div>html</div>', title: '<div>html</div>' },
        { opener: 'a | b\n-|-', title: 'Table' },
        { opener: 'Title\n===', title: 'Title' },
        { opener: '[a]: /url\nNext', title: 'Next' },
        { opener: '[^2]: other\n\nNext', title: 'Next' },
      ])(
        'ends the footnote definition at a following $opener',
        ({ opener, title }) => {
          expect(textOf(`[^1]: note\n${opener}`)).toBe(title);
        }
      );

      it('reads a footnote label holding whitespace as no definition', () => {
        expect(textOf('[^a b]: note\nNext')).toBe('[^a b]: note');
      });
    });

    describe('rule 7: tables', () => {
      it.each([
        '| a | b |\n|---|---|',
        'a | b\n-|-',
        'a|b\n-|-',
        'a | b | c\n--- | ---',
        'a | b\n--- | --- | ---',
        ' a | b\n -|-',
        '- a | b\n-|-',
        '> a | b\n-|-',
      ])('titles %j Table', (text) => {
        expect(sourceOf(text)).toMatchObject({ text: 'Table', lineIndex: -1 });
      });

      it.each([
        { text: 'a | b\n---\nNext', title: 'a | b' },
        { text: 'a\n---|---', title: 'a' },
        { text: '|a\n|-', title: '|a' },
        { text: ' | a |\n| - |', title: ' | a |' },
        { text: 'a | b | c\n-||-', title: 'a | b | c' },
        { text: '# a | b\n-|-', title: '# a | b' },
      ])('reads $text as no table', ({ text, title }) => {
        expect(textOf(text)).toBe(title);
      });

      it('keeps the table line when table stripping is off', () => {
        settings.markupStripping.stripTableMarkup = false;

        expect(textOf('a | b\n-|-')).toBe('a | b');
      });
    });

    // Each verdict is whether Obsidian 1.14.4's metadata cache indexes a tag written in the source's text (measured with `computeMetadataAsync`)
    describe('tags indexed', () => {
      // A `%%` comment's own text is the title source only while comments are unwrapped
      it.each([
        { body: '#x a', block: 'a body line', unwrap: false },
        { body: '> [!note] #x a', block: "a callout's title", unwrap: false },
        {
          body: '%% #x a\nmore\n%%',
          block: "a `%%` comment's opener line",
          unwrap: true,
        },
        {
          body: '%%\n#x a\n%%',
          block: 'a line inside a `%%` comment',
          unwrap: true,
        },
        {
          body: '%%\nc\n%% #x a',
          block: 'the text after a `%%` closer',
          unwrap: false,
        },
      ])('indexes tags in $block', ({ body, unwrap }) => {
        settings.markupStripping.stripCommentsEntirely = !unwrap;

        expect(sourceOf(body)?.tagsIndexed).toBe(true);
      });

      it.each([
        { body: '    #x a', block: 'indented code' },
        { body: '```\n#x a\n```', block: 'fenced code' },
        {
          body: '```cardlink\ntitle: "#x Plan"\n```',
          block: 'a card link title',
        },
        {
          body: '<!--\nc\n--> #x a',
          block: 'the text after an HTML comment block',
        },
        { body: '| #x | b |\n|---|---|', block: 'a table stand-in' },
        { body: '---', block: 'a synthetic Untitled' },
      ])('indexes no tag in $block', ({ body }) => {
        expect(sourceOf(body)?.tagsIndexed).toBe(false);
      });
    });
  });

  describe('sameTitleSource', () => {
    const source: TitleSource = {
      firstNonEmptyLine: '---',
      text: 'foo',
      lineIndex: 1,
      raw: false,
      tagsIndexed: true,
    };

    it('matches sources with the same lines and rendering', () => {
      expect(sameTitleSource(source, { ...source, lineIndex: 2 })).toBe(true);
      expect(sameTitleSource(null, null)).toBe(true);
    });

    it('tells code from text with the same characters', () => {
      expect(sameTitleSource(source, { ...source, raw: true })).toBe(false);
    });

    it('tells text whose tags the cache indexes from text whose tags it does not', () => {
      expect(sameTitleSource(source, { ...source, tagsIndexed: false })).toBe(
        false
      );
    });

    it('tells an empty body from any source', () => {
      expect(sameTitleSource(source, null)).toBe(false);
    });
  });

  describe('Reading view parity', () => {
    // Each title is the text Obsidian 1.14.4's Reading view shows first for the note, with default settings.
    it.each([
      { text: '> [!note]\n> body', title: 'Note' },
      { text: '> [!my-type]\n> body', title: 'My type' },
      { text: ' # x', title: 'x' },
      { text: '-  # a', title: 'a' },
      { text: '-\ta', title: 'a' },
      { text: '    > a\n\nNext', title: '> a' },
      { text: '~~~\ncode\n~~~\nNext', title: 'code' },
      { text: '[1]: https://example.com\n\nNext', title: 'Next' },
      { text: '[^1]: note\n\nNext', title: 'Next' },
      { text: 'a | b\n---\nNext', title: 'a | b' },
      { text: '   # Title', title: 'Title' },
      { text: '```js\n# comment\n```\nNext', title: '# comment' },
      { text: '```\nconst x = *1*;\n```\nNext', title: 'const x = *1*;' },
      { text: '--- \nfoo: bar\n---\nBody', title: 'foo: bar' },
    ])('$text is titled $title', ({ text, title }) => {
      expect(titleOf(text)).toBe(title);
    });

    it.each([
      { text: '$$E=mc^2$$\nNext', title: 'Math block' },
      { text: '$$x^2\n$$\nNext', title: 'Math block' },
      { text: '$$\nx $$\nNext', title: 'Math block' },
      { text: '# a | b\n-|-', title: 'a | b' },
      { text: '- a | b\n-|-', title: 'Table' },
      { text: ' \t---\nNext', title: 'Next' },
      { text: ' \t```\ncode\n```', title: 'code' },
      { text: '  > quote', title: 'quote' },
      { text: '>  [!note] t', title: '[!note] t' },
      { text: '>     - item', title: '- item' },
      { text: '>\t- item', title: '- item' },
      { text: '-     # a', title: '# a' },
      { text: '-\t\t# a', title: '# a' },
      { text: '- \t# a', title: '# a' },
      { text: '-     a', title: 'a' },
      { text: '-    # a', title: 'a' },
      { text: '-\t # a', title: 'a' },
      { text: ' \t- item', title: 'item' },
      { text: '1234567890. a', title: 'a' },
      { text: '-', title: 'Untitled' },
    ])('rule-level: $text is titled $title', ({ text, title }) => {
      expect(titleOf(text)).toBe(title);
    });

    it('keeps code as typed through markup stripping', () => {
      const source = sourceOf('>     *a* **b**');

      expect(source?.raw).toBe(false);
      expect(extractTitle(source?.text ?? '', settings)).toBe('*a* **b**');
    });
  });
});
