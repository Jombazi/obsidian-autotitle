import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getFrontMatterInfo } from 'obsidian';
import {
  findPagePreviewEditors,
  keepPagePreviewCursors,
  PagePreviewEmbed,
} from '../../src/utils/page-preview';
import { createMockApp, createMockFile, splitFrontMatter } from '../testUtils';
import { App, TFile } from '../mockObsidian';

interface Position {
  line: number;
  ch: number;
}

/** A text-backed editor; `setValue` drops the cursor to the start, the way a page preview's reload does. */
function createTextEditor(text: string, cursor: Position) {
  let value = text;
  let anchor = cursor;
  let head = cursor;
  const editor = {
    getValue: () => value,
    setValue: (next: string) => {
      value = next;
      anchor = head = { line: 0, ch: 0 };
    },
    getCursor: (which: 'anchor' | 'head') =>
      which === 'anchor' ? anchor : head,
    posToOffset: (pos: Position) => {
      const lines = value.split('\n');
      let offset = 0;
      for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1;
      return offset + pos.ch;
    },
    offsetToPos: (offset: number): Position => {
      const lines = value.slice(0, offset).split('\n');
      return { line: lines.length - 1, ch: lines[lines.length - 1].length };
    },
    setSelection: vi.fn((from: Position, to?: Position) => {
      anchor = from;
      head = to ?? from;
    }),
    getScrollInfo: () => ({ top: 240, left: 0 }),
    scrollTo: vi.fn(),
  };
  return editor;
}

type TextEditor = ReturnType<typeof createTextEditor>;

/** `set` lives on the prototype, as on Obsidian's embeds, so an uninstalled patch leaves no own property behind. */
class FakeEmbed {
  hoverPopover: { embed?: FakeEmbed } | null = null;
  dirty = false;
  constructor(
    public file: TFile | null,
    public editor?: TextEditor
  ) {}
  set(text: string): void {
    this.editor?.setValue(text);
  }
}

function asEmbed(embed: FakeEmbed): PagePreviewEmbed {
  return embed as unknown as PagePreviewEmbed;
}

function hasOwnSet(embed: FakeEmbed): boolean {
  return Object.prototype.hasOwnProperty.call(embed, 'set');
}

describe('page-preview', () => {
  let app: App;
  let file: TFile;

  function showPreviews(...embeds: FakeEmbed[]) {
    app.workspace.iterateAllLeaves = vi.fn((callback: (leaf: any) => void) =>
      embeds.forEach((embed) => callback({ view: { hoverPopover: { embed } } }))
    );
  }

  beforeEach(() => {
    app = createMockApp();
    file = createMockFile('Notes/Title.md');
    vi.mocked(getFrontMatterInfo).mockImplementation(
      splitFrontMatter as unknown as typeof getFrontMatterInfo
    );
  });

  afterEach(() => {
    vi.mocked(getFrontMatterInfo).mockReset();
    vi.useRealTimers();
  });

  describe('findPagePreviewEditors', () => {
    it('finds the preview editing the note by file identity', () => {
      const embed = new FakeEmbed(
        file,
        createTextEditor('Title', { line: 0, ch: 0 })
      );
      showPreviews(embed);

      expect(findPagePreviewEditors(app as any, file)).toEqual([embed]);
    });

    it('skips a preview that is not editing', () => {
      showPreviews(new FakeEmbed(file));

      expect(findPagePreviewEditors(app as any, file)).toEqual([]);
    });

    it('finds a preview nested inside another preview', () => {
      const outer = new FakeEmbed(
        createMockFile('Notes/Host.md'),
        createTextEditor('Host', { line: 0, ch: 0 })
      );
      const nested = new FakeEmbed(
        file,
        createTextEditor('Title', { line: 0, ch: 0 })
      );
      outer.hoverPopover = { embed: nested };
      showPreviews(outer);

      expect(findPagePreviewEditors(app as any, file)).toEqual([nested]);
    });

    it("ignores another note's preview", () => {
      showPreviews(
        new FakeEmbed(
          createMockFile('Notes/Other.md'),
          createTextEditor('Other', { line: 0, ch: 0 })
        )
      );

      expect(findPagePreviewEditors(app as any, file)).toEqual([]);
    });
  });

  describe('keepPagePreviewCursors', () => {
    const BEFORE = '---\nstatus: draft\n---\nMy title here\nBody\n';
    const AFTER =
      '---\nstatus: draft\naliases:\n  - My title here\n---\nMy title here\nBody\n';

    it('restores a body cursor after the reload inserts two property lines above it', () => {
      const editor = createTextEditor(BEFORE, { line: 3, ch: 5 });
      const embed = new FakeEmbed(file, editor);
      showPreviews(embed);

      keepPagePreviewCursors(app as any, file);
      asEmbed(embed).set(AFTER);

      expect(editor.setSelection).toHaveBeenCalledWith(
        { line: 5, ch: 5 },
        { line: 5, ch: 5 }
      );
      expect(editor.scrollTo).toHaveBeenCalledWith(null, 240);
    });

    it('keeps a cursor inside the properties at its absolute offset', () => {
      const editor = createTextEditor(BEFORE, { line: 1, ch: 3 });
      const embed = new FakeEmbed(file, editor);
      showPreviews(embed);

      keepPagePreviewCursors(app as any, file);
      asEmbed(embed).set(AFTER);

      expect(editor.setSelection).toHaveBeenCalledWith(
        { line: 1, ch: 3 },
        { line: 1, ch: 3 }
      );
    });

    it('uninstalls itself after one reload', () => {
      const editor = createTextEditor(BEFORE, { line: 3, ch: 5 });
      const embed = new FakeEmbed(file, editor);
      showPreviews(embed);

      keepPagePreviewCursors(app as any, file);
      expect(hasOwnSet(embed)).toBe(true);
      asEmbed(embed).set(AFTER);
      asEmbed(embed).set(BEFORE);

      expect(hasOwnSet(embed)).toBe(false);
      expect(editor.setSelection).toHaveBeenCalledTimes(1);
    });

    it('leaves a preview with unsaved typing alone', () => {
      const editor = createTextEditor(BEFORE, { line: 3, ch: 5 });
      const embed = new FakeEmbed(file, editor);
      embed.dirty = true;
      showPreviews(embed);

      keepPagePreviewCursors(app as any, file);
      asEmbed(embed).set(AFTER);

      expect(hasOwnSet(embed)).toBe(false);
      expect(editor.setSelection).not.toHaveBeenCalled();
    });

    it("ignores the preview's own save, which sets the text already in its editor", () => {
      const editor = createTextEditor(BEFORE, { line: 3, ch: 5 });
      const embed = new FakeEmbed(file, editor);
      showPreviews(embed);

      keepPagePreviewCursors(app as any, file);
      asEmbed(embed).set(editor.getValue());

      expect(editor.setSelection).not.toHaveBeenCalled();
      expect(hasOwnSet(embed)).toBe(true);

      asEmbed(embed).set(AFTER);
      expect(editor.setSelection).toHaveBeenCalledTimes(1);
    });

    it('uninstalls itself after 3000 ms when no reload comes', () => {
      vi.useFakeTimers();
      const editor = createTextEditor(BEFORE, { line: 3, ch: 5 });
      const embed = new FakeEmbed(file, editor);
      showPreviews(embed);

      keepPagePreviewCursors(app as any, file);
      vi.advanceTimersByTime(2999);
      expect(hasOwnSet(embed)).toBe(true);
      vi.advanceTimersByTime(1);

      expect(hasOwnSet(embed)).toBe(false);
      asEmbed(embed).set(AFTER);
      expect(editor.setSelection).not.toHaveBeenCalled();
    });
  });
});
