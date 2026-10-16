import {
  TFile,
  App,
  Editor,
  MarkdownView,
  ViewWithFileEditor,
  getFrontMatterInfo,
} from 'obsidian';
import { findEmbeddedEditors } from './embedded-editors';

/**
 * Find the Markdown tab an editor belongs to.
 * @param app - Obsidian App instance
 * @param editor - Editor to match, by object identity
 * @returns The tab's view, or undefined for a page preview's or Canvas card's editor, which sits in no Markdown leaf
 */
export function findMarkdownViewOfEditor(
  app: App,
  editor: Editor
): MarkdownView | undefined {
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    if (leaf.view instanceof MarkdownView && leaf.view.editor === editor) {
      return leaf.view;
    }
  }
  return undefined;
}

/**
 * Check if only frontmatter changed between two content versions.
 * Used to detect YAML-only edits and skip unnecessary first line property updates.
 *
 * @param currentContent - Current file content
 * @param previousContent - Previous file content to compare against
 * @returns true if only frontmatter changed (body is identical), false if body changed
 */
export function isOnlyFrontmatterChanged(
  currentContent: string,
  previousContent: string
): boolean {
  const currentFrontmatterInfo = getFrontMatterInfo(currentContent);
  const previousFrontmatterInfo = getFrontMatterInfo(previousContent);

  const currentBody = currentContent.substring(
    currentFrontmatterInfo.contentStart
  );
  const previousBody = previousContent.substring(
    previousFrontmatterInfo.contentStart
  );

  return currentBody === previousBody;
}

/**
 * Check if file is currently open in a Markdown leaf or being edited in a page preview or Canvas card
 * @param file - File to check
 * @param app - Obsidian App instance
 * @returns true if file is open in any editor
 */
export function isFileOpenInAnyEditor(file: TFile, app: App): boolean {
  const leaves = app.workspace.getLeavesOfType('markdown');

  // Check main workspace leaves
  for (const leaf of leaves) {
    // Cast to ViewWithFileEditor to access FileView/MarkdownView properties
    const view = leaf.view as ViewWithFileEditor;
    if (view?.file?.path === file.path) {
      return true;
    }
  }

  return findEmbeddedEditors(app, file).length > 0;
}
