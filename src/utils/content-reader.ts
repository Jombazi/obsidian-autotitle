import { App, TFile, Editor, MarkdownView } from 'obsidian';
import FirstLineIsTitlePlugin from '../../main';
import { findPagePreviewEditors } from './page-preview';

/**
 * Options for reading file content
 */
export interface ContentReaderOptions {
  /** Already have content (from editor.getValue()) */
  providedContent?: string;
  /** Already have editor instance */
  providedEditor?: Editor;
  /** Search open editors for this note, page previews included */
  searchWorkspace?: boolean;
  /** Use vault.read instead of vault.cachedRead when falling back */
  preferFresh?: boolean;
}

/**
 * Centralized utility for reading file content with support for multiple strategies.
 * Handles Editor/Cache/File read methods and workspace editor searching.
 *
 * @param plugin - Plugin instance for settings and logging
 * @param file - File to read content from
 * @param options - Read options
 * @returns File content as string
 * @throws Error if file cannot be read
 */
export async function readFileContent(
  plugin: FirstLineIsTitlePlugin,
  file: TFile,
  options: ContentReaderOptions = {}
): Promise<string> {
  const {
    providedContent,
    providedEditor,
    searchWorkspace = false,
    preferFresh = false,
  } = options;
  const app = plugin.app;
  const settings = plugin.settings;

  let content: string;

  try {
    // Strategy 1: Use provided content if available (highest priority)
    // Accept any string including empty (user may have deleted all content)
    if (providedContent !== undefined) {
      content = providedContent;
      if (settings.core.debug) {
        console.debug(
          `Using provided content for ${file.path} (${content.length} chars)`
        );
      }
      return content;
    }

    // Strategy 2: Use provided editor if available
    if (providedEditor) {
      content = providedEditor.getValue();
      if (settings.core.debug) {
        console.debug(
          `Using provided editor content for ${file.path} (${content.length} chars)`
        );
      }
      return content;
    }

    // Strategy 3: Search open editors for this note, page previews included, if requested
    if (searchWorkspace) {
      const editorContent = findEditorContent(app, file);
      if (editorContent !== null) {
        if (settings.core.debug) {
          console.debug(
            `Found editor in workspace for ${file.path} (${editorContent.length} chars)`
          );
        }
        return editorContent;
      }
    }

    // Strategy 4: Use contentReadMethod setting
    if (settings.core.contentReadMethod === 'Editor') {
      // Editor method with no editor available - fallback based on preferFresh
      if (preferFresh) {
        content = await app.vault.read(file);
        if (settings.core.debug) {
          console.debug(
            `Editor method using fresh read for ${file.path} (${content.length} chars)`
          );
        }
      } else {
        content = await app.vault.cachedRead(file);
        if (settings.core.debug) {
          console.debug(
            `Editor method fallback to cached read for ${file.path} (${content.length} chars)`
          );
        }
      }
    } else if (settings.core.contentReadMethod === 'Cache') {
      content = await app.vault.cachedRead(file);
      if (settings.core.debug) {
        console.debug(
          `Cached read content from ${file.path} (${content.length} chars)`
        );
      }
    } else if (settings.core.contentReadMethod === 'File') {
      content = await app.vault.read(file);
      if (settings.core.debug) {
        console.debug(
          `Direct read content from ${file.path} (${content.length} chars)`
        );
      }
    } else {
      // Unknown method - use preferFresh or fallback to cache
      if (preferFresh) {
        content = await app.vault.read(file);
        if (settings.core.debug) {
          console.debug(
            `Unknown method, using fresh read for ${file.path} (${content.length} chars)`
          );
        }
      } else {
        content = await app.vault.cachedRead(file);
        if (settings.core.debug) {
          console.debug(
            `Unknown method, fallback to cached read for ${file.path} (${content.length} chars)`
          );
        }
      }
    }

    return content;
  } catch (error) {
    console.error(`Failed to read file ${file.path}:`, error);
    throw new Error(
      `Failed to read file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Search workspace for an editor matching the given file
 * Checks page previews editing the note first, then the active view, then open Markdown leaves
 * @param app - Obsidian App instance
 * @param file - File to find editor for
 * @returns Editor content if found, null otherwise
 */
function findEditorContent(app: App, file: TFile): string | null {
  // Page previews match the note by file identity, so a preview of another note is never read. Empty content is not trusted: likely transient state after file operations.
  const previewContent = findPagePreviewEditors(
    app,
    file
  )[0]?.editor?.getValue();
  if (previewContent) {
    return previewContent;
  }

  // Check active view's editor as fallback - only if file matches
  // This prevents bulk operations from returning active editor content for all files
  const activeView = app.workspace.getActiveViewOfType(MarkdownView);
  if (activeView?.editor && activeView.file?.path === file.path) {
    const content = activeView.editor.getValue();
    if (content) {
      return content;
    }
  }

  // Check main workspace leaves as final fallback
  // These can be stale after file operations (renames, etc.)
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view as MarkdownView;
    if (view && view.file?.path === file.path && view.editor) {
      const content = view.editor.getValue();
      // Don't trust empty content - could be transient/stale state
      if (content) {
        return content;
      }
      // Empty content, continue searching
    }
  }

  return null;
}

/**
 * Find an editor instance for the given file in the workspace
 * @param app - Obsidian App instance
 * @param file - File to find editor for
 * @returns Editor instance if found, null otherwise
 */
export function findEditor(app: App, file: TFile): Editor | null {
  const leaves = app.workspace.getLeavesOfType('markdown');
  for (const leaf of leaves) {
    const view = leaf.view as MarkdownView;
    if (view && view.file?.path === file.path && view.editor) {
      return view.editor;
    }
  }
  return null;
}
