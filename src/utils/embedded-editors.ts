import { App, Editor, TFile, ViewWithFileEditor } from 'obsidian';

/**
 * A core page preview's or Canvas card's embed. Obsidian keeps the shown note and, while it is being edited, its editor here rather than on the `HoverPopover` or Canvas node itself.
 */
export interface EmbeddedEditor {
  file: TFile | null;
  editor?: Editor;
  /** True while the embed holds typing it has not saved yet */
  dirty?: boolean;
  /** The heading or block the embed shows, empty when it shows the whole note */
  subpath?: string;
  hoverPopover?: { embed?: EmbeddedEditor } | null;
}

// A preview opened from inside another preview hangs off the outer embed; chains deeper than this are not followed.
const MAX_NESTED_PREVIEW_DEPTH = 3;

function isEditingWholeNote(embed: EmbeddedEditor): boolean {
  // A section embed's editor holds that section only while `file` is the whole note, so a properties write would land mid-note.
  return Boolean(embed.editor) && !embed.subpath;
}

/**
 * Find every page preview or Canvas card currently editing the given note, nested previews included.
 * @param app - Obsidian App instance
 * @param file - Note to match, by object identity
 * @returns Embeds showing the whole note with an editor attached
 */
export function findEmbeddedEditors(app: App, file: TFile): EmbeddedEditor[] {
  // Canvas cards and page previews share Obsidian's embed class, so one walk serves both.
  const found: EmbeddedEditor[] = [];
  const keep = (embed: EmbeddedEditor): void => {
    if (isEditingWholeNote(embed) && !found.includes(embed)) {
      found.push(embed);
    }
  };

  app.workspace.iterateAllLeaves((leaf) => {
    const view = leaf.view as ViewWithFileEditor | undefined;
    let embed = view?.hoverPopover?.embed;
    for (
      let depth = 0;
      embed && depth < MAX_NESTED_PREVIEW_DEPTH;
      depth++, embed = embed.hoverPopover?.embed
    ) {
      if (embed.file === file) {
        keep(embed);
      }
    }
  });

  for (const leaf of app.workspace.getLeavesOfType('canvas')) {
    const view = leaf.view as ViewWithFileEditor | undefined;
    for (const node of view?.canvas?.nodes?.values() ?? []) {
      if (node.file === file && node.child) {
        keep(node.child);
      }
    }
  }

  return found;
}

/**
 * Check whether an embed is a Canvas card's rather than a page preview's.
 * @param app - Obsidian App instance
 * @param embed - The `info` an `editor-change` event passed, matched by object identity
 * @returns true when some open canvas holds the embed as a card
 */
export function isCanvasCardEmbed(app: App, embed: unknown): boolean {
  if (!embed) return false;
  for (const leaf of app.workspace.getLeavesOfType('canvas')) {
    const view = leaf.view as ViewWithFileEditor | undefined;
    for (const node of view?.canvas?.nodes?.values() ?? []) {
      if (node.child === embed) {
        return true;
      }
    }
  }
  return false;
}
