import { App, TFile } from 'obsidian';

/**
 * Check whether another note or a canvas links to the given note. A canvas's file cards count as its links.
 * @param app - Obsidian App instance
 * @param file - Note to look up
 * @returns true when any source in the resolved link map lists the note
 */
export function isLinkedFromAnyFile(app: App, file: TFile): boolean {
  // The public `resolvedLinks` map rather than `getBacklinksForFile`: a yes-or-no answer needs no link resolution or ordering.
  const { resolvedLinks } = app.metadataCache;
  // One pass over every source's link map (about 0.2 ms at 3,000 sources), asked whenever no timer is pending for the note, which at Check interval 0 means every keystroke of an unlinked note.
  for (const sourcePath in resolvedLinks) {
    if (resolvedLinks[sourcePath]?.[file.path] !== undefined) {
      return true;
    }
  }
  return false;
}
