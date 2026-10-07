import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  findEmbeddedEditors,
  isCanvasCardEmbed,
} from '../../src/utils/embedded-editors';
import { createMockApp, createMockFile } from '../testUtils';
import { App, TFile } from '../mockObsidian';

/** A text-backed editor */
function createTextEditor(text: string) {
  return { getValue: () => text };
}

type TextEditor = ReturnType<typeof createTextEditor>;

class FakeEmbed {
  hoverPopover: { embed?: FakeEmbed } | null = null;
  dirty = false;
  subpath = '';
  constructor(
    public file: TFile | null,
    public editor?: TextEditor
  ) {}
}

/** A Canvas file card: the node and its embed child both hold the note */
function createCard(embed: FakeEmbed) {
  return { file: embed.file, child: embed };
}

describe('embedded-editors', () => {
  let app: App;
  let file: TFile;

  function showPreviews(...embeds: FakeEmbed[]) {
    app.workspace.iterateAllLeaves = vi.fn((callback: (leaf: any) => void) =>
      embeds.forEach((embed) => callback({ view: { hoverPopover: { embed } } }))
    );
  }

  /** Canvas leaves, each a list of cards; `null` stands for a deferred leaf whose view has no canvas yet */
  function showCanvases(
    ...canvases: (ReturnType<typeof createCard>[] | null)[]
  ) {
    app.workspace.getLeavesOfType = vi.fn((type: string) =>
      type === 'canvas'
        ? canvases.map((cards) => ({
            view: cards
              ? {
                  canvas: {
                    nodes: new Map(
                      cards.map((card, index) => [`node-${index}`, card])
                    ),
                  },
                }
              : {},
          }))
        : []
    ) as any;
  }

  beforeEach(() => {
    app = createMockApp();
    file = createMockFile('Notes/Title.md');
  });

  describe('findEmbeddedEditors', () => {
    it('finds the preview editing the note by file identity', () => {
      const embed = new FakeEmbed(file, createTextEditor('Title'));
      showPreviews(embed);

      expect(findEmbeddedEditors(app as any, file)).toEqual([embed]);
    });

    it('skips a preview that is not editing', () => {
      showPreviews(new FakeEmbed(file));

      expect(findEmbeddedEditors(app as any, file)).toEqual([]);
    });

    it('finds a preview nested inside another preview', () => {
      const outer = new FakeEmbed(
        createMockFile('Notes/Host.md'),
        createTextEditor('Host')
      );
      const nested = new FakeEmbed(file, createTextEditor('Title'));
      outer.hoverPopover = { embed: nested };
      showPreviews(outer);

      expect(findEmbeddedEditors(app as any, file)).toEqual([nested]);
    });

    it("ignores another note's preview", () => {
      showPreviews(
        new FakeEmbed(
          createMockFile('Notes/Other.md'),
          createTextEditor('Other')
        )
      );

      expect(findEmbeddedEditors(app as any, file)).toEqual([]);
    });

    it('finds a Canvas card being edited', () => {
      const card = new FakeEmbed(file, createTextEditor('Title'));
      showCanvases([createCard(card)]);

      expect(findEmbeddedEditors(app as any, file)).toEqual([card]);
    });

    it('skips a Canvas card that is not being edited', () => {
      showCanvases([createCard(new FakeEmbed(file))]);

      expect(findEmbeddedEditors(app as any, file)).toEqual([]);
    });

    it("ignores another note's Canvas card", () => {
      showCanvases([
        createCard(
          new FakeEmbed(
            createMockFile('Notes/Other.md'),
            createTextEditor('Other')
          )
        ),
      ]);

      expect(findEmbeddedEditors(app as any, file)).toEqual([]);
    });

    it('returns both a preview and a Canvas card editing the same note', () => {
      const preview = new FakeEmbed(file, createTextEditor('Title'));
      const card = new FakeEmbed(file, createTextEditor('Title'));
      showPreviews(preview);
      showCanvases([createCard(card)]);

      expect(findEmbeddedEditors(app as any, file)).toEqual([preview, card]);
    });

    // Its editor holds one section while `file` is the whole note
    it('skips a Canvas card and a preview showing a heading section', () => {
      const preview = new FakeEmbed(file, createTextEditor('Section'));
      preview.subpath = '#Heading';
      const card = new FakeEmbed(file, createTextEditor('Section'));
      card.subpath = '#Heading';
      showPreviews(preview);
      showCanvases([createCard(card)]);

      expect(findEmbeddedEditors(app as any, file)).toEqual([]);
    });

    it('skips a deferred canvas leaf without throwing', () => {
      const card = new FakeEmbed(file, createTextEditor('Title'));
      showCanvases(null, [createCard(card)]);

      expect(findEmbeddedEditors(app as any, file)).toEqual([card]);
    });
  });

  describe('isCanvasCardEmbed', () => {
    it("is true for a Canvas card's embed", () => {
      const card = new FakeEmbed(file, createTextEditor('Title'));
      showCanvases([createCard(card)]);

      expect(isCanvasCardEmbed(app as any, card)).toBe(true);
    });

    it("is false for a page preview's embed of a note a canvas also shows", () => {
      const preview = new FakeEmbed(file, createTextEditor('Title'));
      showPreviews(preview);
      showCanvases([
        createCard(new FakeEmbed(file, createTextEditor('Title'))),
      ]);

      expect(isCanvasCardEmbed(app as any, preview)).toBe(false);
    });

    it('is false when the only canvas leaf is deferred', () => {
      const card = new FakeEmbed(file, createTextEditor('Title'));
      showCanvases(null);

      expect(isCanvasCardEmbed(app as any, card)).toBe(false);
    });
  });
});
