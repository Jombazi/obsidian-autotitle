import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getFrontMatterInfo, parseYaml, stringifyYaml } from 'obsidian';
import { Transaction } from '@codemirror/state';
import {
  applyFrontMatterChange,
  findSourceEditorForFile,
  replaceEditorText,
} from '../../src/utils/frontmatter-edit';
import { createMockApp, createMockFile, splitFrontMatter } from '../testUtils';
import { App, MarkdownView, TFile } from '../mockObsidian';

describe('frontmatter-edit', () => {
  describe('applyFrontMatterChange', () => {
    // Raw YAML block -> parsed value, and parsed value (as JSON) -> YAML text
    let parsedFixtures: Map<string, unknown>;
    let stringifiedFixtures: Map<string, string>;

    beforeEach(() => {
      parsedFixtures = new Map<string, unknown>();
      stringifiedFixtures = new Map<string, string>();
      vi.mocked(getFrontMatterInfo).mockImplementation(
        splitFrontMatter as unknown as typeof getFrontMatterInfo
      );
      vi.mocked(parseYaml).mockImplementation(((yaml: string) => {
        if (!parsedFixtures.has(yaml)) {
          throw new Error(`malformed YAML: ${yaml}`);
        }
        return parsedFixtures.get(yaml);
      }) as typeof parseYaml);
      vi.mocked(stringifyYaml).mockImplementation((value: unknown) => {
        const key = JSON.stringify(value);
        const yaml = stringifiedFixtures.get(key);
        if (yaml === undefined) {
          throw new Error(`no YAML fixture for ${key}`);
        }
        return yaml;
      });
    });

    afterEach(() => {
      vi.mocked(getFrontMatterInfo).mockReset();
      vi.mocked(parseYaml).mockReset();
      vi.mocked(stringifyYaml).mockReset();
    });

    it('splices the new block between the frontmatter bounds', () => {
      parsedFixtures.set('status: draft\n', { status: 'draft' });
      stringifiedFixtures.set(
        JSON.stringify({ status: 'draft', aliases: ['Title'] }),
        'status: draft\naliases:\n  - Title\n'
      );

      const result = applyFrontMatterChange(
        '---\nstatus: draft\n---\nTitle\nBody',
        (frontmatter) => {
          frontmatter.aliases = ['Title'];
        }
      );

      expect(result).toBe(
        '---\nstatus: draft\naliases:\n  - Title\n---\nTitle\nBody'
      );
    });

    it('prepends a block when the note has none', () => {
      stringifiedFixtures.set(
        JSON.stringify({ aliases: ['Title'] }),
        'aliases:\n  - Title\n'
      );

      const result = applyFrontMatterChange('Title\nBody', (frontmatter) => {
        frontmatter.aliases = ['Title'];
      });

      expect(result).toBe('---\naliases:\n  - Title\n---\nTitle\nBody');
    });

    it('drops the block when the change empties it', () => {
      parsedFixtures.set('aliases: Old\n', { aliases: 'Old' });

      const result = applyFrontMatterChange(
        '---\naliases: Old\n---\nTitle\nBody',
        (frontmatter) => {
          delete frontmatter.aliases;
        }
      );

      expect(result).toBe('Title\nBody');
      expect(stringifyYaml).not.toHaveBeenCalled();
    });

    it('leaves a note without a block unchanged when nothing is added', () => {
      expect(applyFrontMatterChange('Title\nBody', () => {})).toBe(
        'Title\nBody'
      );
    });

    it.each([
      ['a scalar', 'just text', 'just text'],
      ['null', '~', null],
    ])('passes an empty object for %s YAML', (_label, yaml, parsed) => {
      parsedFixtures.set(`${yaml}\n`, parsed);
      const received: unknown[] = [];

      applyFrontMatterChange(`---\n${yaml}\n---\nBody`, (frontmatter) => {
        received.push({ ...frontmatter });
      });

      expect(received).toEqual([{}]);
    });

    it('throws on malformed YAML, as processFrontMatter does', () => {
      expect(() =>
        applyFrontMatterChange('---\n: [\n---\nBody', () => {})
      ).toThrow('malformed YAML');
    });
  });

  describe('findSourceEditorForFile', () => {
    let app: App;
    let file: TFile;

    function createView(viewFile: TFile, mode: 'source' | 'preview') {
      const view = new MarkdownView(app as any);
      return Object.assign(view, {
        file: viewFile,
        dirty: false,
        getMode: () => mode,
        requestSave: vi.fn(),
      });
    }

    function createPreviewEmbed(embedFile: TFile, dirty: boolean) {
      return {
        file: embedFile,
        dirty,
        editor: { getValue: () => 'preview text' },
      };
    }

    function showLeaves(
      markdownViews: unknown[],
      previewEmbeds: unknown[] = [],
      canvasCards: { file: TFile }[] = []
    ) {
      app.workspace.getLeavesOfType = vi.fn((type: string) =>
        type === 'canvas'
          ? [
              {
                view: {
                  canvas: {
                    nodes: new Map(
                      canvasCards.map((card, index) => [
                        `node-${index}`,
                        { file: card.file, child: card },
                      ])
                    ),
                  },
                },
              },
            ]
          : markdownViews.map((view) => ({ view }))
      ) as any;
      app.workspace.iterateAllLeaves = vi.fn(
        (callback: (leaf: unknown) => void) =>
          previewEmbeds.forEach((embed) =>
            callback({ view: { hoverPopover: { embed } } })
          )
      );
    }

    beforeEach(() => {
      app = createMockApp();
      file = createMockFile('Notes/Title.md');
    });

    it('returns the active view when it edits the note', () => {
      const view = createView(file, 'source');
      app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);
      showLeaves([view]);

      const target = findSourceEditorForFile(app as any, file);

      expect(target?.editor).toBe(view.editor);
      expect(target?.isDirty()).toBe(false);
      view.dirty = true;
      expect(target?.isDirty()).toBe(true);
      target?.requestSave?.();
      expect(view.requestSave).toHaveBeenCalled();
    });

    it('prefers a preview with unsaved typing over a source view that is not active', () => {
      const view = createView(file, 'source');
      const typingPreview = createPreviewEmbed(file, true);
      showLeaves([view], [typingPreview]);

      const target = findSourceEditorForFile(app as any, file);

      expect(target?.editor).toBe(typingPreview.editor);
      expect(target?.isDirty()).toBe(true);
      expect(target?.requestSave).toBeUndefined();
    });

    it('prefers a Canvas card with unsaved typing over a source view that is not active', () => {
      const view = createView(file, 'source');
      const typingCard = createPreviewEmbed(file, true);
      showLeaves([view], [], [typingCard]);

      const target = findSourceEditorForFile(app as any, file);

      expect(target?.editor).toBe(typingCard.editor);
      expect(target?.isDirty()).toBe(true);
      expect(target?.requestSave).toBeUndefined();
    });

    it('returns another source view of the note ahead of a preview without typing', () => {
      const view = createView(file, 'source');
      showLeaves([view], [createPreviewEmbed(file, false)]);

      expect(findSourceEditorForFile(app as any, file)?.editor).toBe(
        view.editor
      );
    });

    it('skips a Reading view, whose editor does not reach the file', () => {
      const readingView = createView(file, 'preview');
      const preview = createPreviewEmbed(file, false);
      app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(readingView);
      showLeaves([readingView], [preview]);

      expect(findSourceEditorForFile(app as any, file)?.editor).toBe(
        preview.editor
      );
    });

    it("ignores another note's views and previews", () => {
      const other = createMockFile('Notes/Other.md');
      const otherView = createView(other, 'source');
      app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(otherView);
      showLeaves([otherView], [createPreviewEmbed(other, true)]);

      expect(findSourceEditorForFile(app as any, file)).toBeUndefined();
    });

    it('returns undefined when the note is open nowhere', () => {
      showLeaves([]);

      expect(findSourceEditorForFile(app as any, file)).toBeUndefined();
    });
  });

  describe('replaceEditorText', () => {
    function createEditor(text: string, withCodeMirror = true) {
      return {
        getValue: () => text,
        replaceRange: vi.fn(),
        offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
        cm: withCodeMirror ? { dispatch: vi.fn() } : undefined,
      };
    }

    function dispatchedChange(editor: ReturnType<typeof createEditor>) {
      return editor.cm!.dispatch.mock.calls[0][0] as {
        changes: { from: number; to: number; insert: string };
        annotations: { type: unknown; value: unknown };
        filter: boolean;
      };
    }

    it('dispatches only the differing range, unfiltered and kept out of the undo history', () => {
      const editor = createEditor('---\naliases: Old\n---\nTitle');

      const changed = replaceEditorText(
        editor as any,
        '---\naliases: New\n---\nTitle'
      );

      expect(changed).toBe(true);
      const { changes, annotations, filter } = dispatchedChange(editor);
      expect(changes).toEqual({ from: 13, to: 16, insert: 'New' });
      expect(annotations.type).toBe(Transaction.addToHistory);
      expect(annotations.value).toBe(false);
      expect(filter).toBe(false);
    });

    it.each([
      ['an insertion inside repeated characters', 'aa', 'aaa'],
      ['a deletion inside repeated characters', 'aaa', 'aa'],
      ['a replacement of the whole text', 'abc', 'xyz'],
    ])('gives a valid range for %s', (_label, oldText, newText) => {
      const editor = createEditor(oldText);

      replaceEditorText(editor as any, newText);

      const { from, to, insert } = dispatchedChange(editor).changes;
      expect(from).toBeLessThanOrEqual(to);
      expect(oldText.slice(0, from) + insert + oldText.slice(to)).toBe(newText);
    });

    it('returns false without dispatching when the text is unchanged', () => {
      const editor = createEditor('Title\nBody');

      expect(replaceEditorText(editor as any, 'Title\nBody')).toBe(false);
      expect(editor.cm!.dispatch).not.toHaveBeenCalled();
    });

    it('falls back to replaceRange when the editor has no CodeMirror view', () => {
      const editor = createEditor('aliases: Old', false);

      replaceEditorText(editor as any, 'aliases: New');

      expect(editor.replaceRange).toHaveBeenCalledWith(
        'New',
        { line: 0, ch: 9 },
        { line: 0, ch: 12 }
      );
    });
  });
});
