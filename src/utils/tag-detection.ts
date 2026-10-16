/**
 * Unified tag detection utilities for context menus.
 * Handles tag extraction from different UI locations (tag pane, YAML, editor).
 */

import type { EditorPosition, MarkdownView } from 'obsidian';

/**
 * Result from tag detection
 */
export interface TagDetectionResult {
  /** The tag name without # prefix */
  tagName: string;
  /** Where the tag was found */
  location: 'tag-pane' | 'yaml' | 'editor';
}

/**
 * Detect if a DOM element is a tag and extract its name.
 * Uses event delegation - checks clicked element and parents.
 *
 * @param target - The element that was clicked
 * @returns Tag info if found, null otherwise
 */
export function detectTagFromDOM(
  target: HTMLElement
): TagDetectionResult | null {
  // Check for tag pane tag
  const tagPaneElement = target.closest('.tag-pane-tag');
  if (tagPaneElement) {
    // Extract tag name from tag pane using Tag Wrangler's approach
    const tagNameEl = tagPaneElement.querySelector(
      '.tag-pane-tag-text, .tag-pane-tag .tree-item-inner-text'
    );
    const tagText = tagNameEl?.textContent?.trim();

    if (tagText) {
      const tagName = tagText.startsWith('#') ? tagText.slice(1) : tagText;
      return { tagName, location: 'tag-pane' };
    }
  }

  // Check for YAML frontmatter tag
  const yamlTagElement = target.closest(
    '.metadata-property[data-property-key="tags"] .multi-select-pill'
  );
  if (yamlTagElement) {
    const tagText = yamlTagElement.textContent?.trim();
    if (tagText) {
      const tagName = tagText.startsWith('#') ? tagText.slice(1) : tagText;
      return { tagName, location: 'yaml' };
    }
  }

  return null;
}

/**
 * Detect if the editor cursor is on a tag, reading the tags Obsidian indexed for the note so the tag matches what Obsidian itself counts as one.
 * Used for editor-menu event handler.
 *
 * The cache indexes the last saved text, so a tag typed since then shows no commands until the cache catches up.
 *
 * @param view - The Markdown view the menu opened in
 * @param pos - Cursor position in the editor
 * @returns Tag info if the cursor is on an indexed tag, null otherwise
 */
export function detectTagFromEditor(
  view: MarkdownView,
  pos: EditorPosition
): TagDetectionResult | null {
  if (!view.file) return null;

  const tags = view.app.metadataCache.getFileCache(view.file)?.tags;
  if (!tags) return null;

  const line = view.editor.getLine(pos.line);
  for (const { tag, position } of tags) {
    const { start, end } = position;
    if (start.line !== pos.line || pos.ch < start.col || pos.ch > end.col) {
      continue;
    }
    // Unsaved edits above can shift an indexed position onto other text
    if (line.slice(start.col, end.col) !== tag) continue;
    return {
      tagName: tag.startsWith('#') ? tag.slice(1) : tag,
      location: 'editor',
    };
  }

  return null;
}
