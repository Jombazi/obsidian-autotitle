import {
  App,
  Editor,
  EditorPosition,
  TFile,
  ViewWithFileEditor,
  getFrontMatterInfo,
} from 'obsidian';
import { around } from 'monkey-around';

/**
 * A core page preview's embed. Obsidian keeps the previewed note and, while it is being edited, its editor here rather than on the `HoverPopover` itself.
 */
export interface PagePreviewEmbed {
  file: TFile | null;
  editor?: Editor;
  /** True while the preview holds typing it has not saved yet */
  dirty?: boolean;
  set(text: string, clear?: boolean): void;
  hoverPopover?: { embed?: PagePreviewEmbed } | null;
}

/** A cursor end inside the body is kept relative to the body start, so it survives properties growing or shrinking above it; one inside the properties stays absolute. */
interface SavedOffset {
  offset: number;
  inBody: boolean;
}

interface SavedCursor {
  anchor: SavedOffset;
  head: SavedOffset;
  scrollTop: number;
}

// A preview opened from inside another preview hangs off the outer embed; chains deeper than this are not followed.
const MAX_NESTED_PREVIEW_DEPTH = 3;

// Covers the reload that follows the plugin's own write; a patch no reload consumed is removed after it.
const CURSOR_RESTORE_WINDOW_MS = 3000;

/** Embeds whose `set` still carries a cursor-restoring patch */
const embedsAwaitingReload = new WeakSet<PagePreviewEmbed>();

/**
 * Find every page preview currently editing the given note, nested previews included.
 * @param app - Obsidian App instance
 * @param file - Note to match, by object identity
 * @returns Embeds showing the note with an editor attached
 */
export function findPagePreviewEditors(
  app: App,
  file: TFile
): PagePreviewEmbed[] {
  const found: PagePreviewEmbed[] = [];
  app.workspace.iterateAllLeaves((leaf) => {
    const view = leaf.view as ViewWithFileEditor | undefined;
    let embed = view?.hoverPopover?.embed;
    for (
      let depth = 0;
      embed && depth < MAX_NESTED_PREVIEW_DEPTH;
      depth++, embed = embed.hoverPopover?.embed
    ) {
      if (embed.file === file && embed.editor && !found.includes(embed)) {
        found.push(embed);
      }
    }
  });
  return found;
}

/**
 * Keep the cursor and scroll position of every page preview editing the note across the reload the next write to it causes; call immediately before writing the note's properties.
 * @param app - Obsidian App instance
 * @param file - Note about to be written
 */
export function keepPagePreviewCursors(app: App, file: TFile): void {
  // Obsidian's page preview reloads the whole file on an outside write and drops its cursor to the start of the line, while a normal tab keeps it.
  for (const embed of findPagePreviewEditors(app, file)) {
    // A preview with unsaved typing does not reload on an outside write (its own save overwrites it), so a patch there would only fire on that save and pull the cursor back.
    if (embedsAwaitingReload.has(embed) || !embed.editor || embed.dirty) {
      continue;
    }
    restoreCursorAfterNextSet(embed, saveCursor(embed.editor));
  }
}

function saveCursor(editor: Editor): SavedCursor {
  const bodyStart = getFrontMatterInfo(editor.getValue()).contentStart;
  return {
    anchor: saveOffset(editor, editor.getCursor('anchor'), bodyStart),
    head: saveOffset(editor, editor.getCursor('head'), bodyStart),
    scrollTop: editor.getScrollInfo().top,
  };
}

function saveOffset(
  editor: Editor,
  position: EditorPosition,
  bodyStart: number
): SavedOffset {
  const offset = editor.posToOffset(position);
  return offset >= bodyStart
    ? { offset: offset - bodyStart, inBody: true }
    : { offset, inBody: false };
}

function resolveOffset(
  saved: SavedOffset,
  bodyStart: number,
  textLength: number
): number {
  const offset = saved.inBody ? bodyStart + saved.offset : saved.offset;
  return Math.min(offset, textLength);
}

function restoreCursorAfterNextSet(
  embed: PagePreviewEmbed,
  saved: SavedCursor
): void {
  let expiryTimer: number | undefined;
  const release = (): void => {
    window.clearTimeout(expiryTimer);
    uninstall();
    embedsAwaitingReload.delete(embed);
  };
  const uninstall = around(embed, {
    set(original) {
      return function (
        this: PagePreviewEmbed,
        ...args: Parameters<PagePreviewEmbed['set']>
      ): void {
        // The preview's own save also goes through `set`, with the text already in its editor; only a reload from outside changes it.
        const isReload = args[0] !== embed.editor?.getValue();
        original.apply(this, args);
        if (!isReload) return;
        release();
        restoreCursor(embed, saved);
      };
    },
  });
  embedsAwaitingReload.add(embed);
  expiryTimer = window.setTimeout(release, CURSOR_RESTORE_WINDOW_MS);
}

function restoreCursor(embed: PagePreviewEmbed, saved: SavedCursor): void {
  const editor = embed.editor;
  if (!editor) return;
  const text = editor.getValue();
  const bodyStart = getFrontMatterInfo(text).contentStart;
  editor.setSelection(
    editor.offsetToPos(resolveOffset(saved.anchor, bodyStart, text.length)),
    editor.offsetToPos(resolveOffset(saved.head, bodyStart, text.length))
  );
  editor.scrollTo(null, saved.scrollTop);
}
