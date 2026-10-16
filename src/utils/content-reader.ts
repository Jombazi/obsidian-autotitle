import { App, TFile, Editor, MarkdownView } from 'obsidian';
import FirstLineIsTitlePlugin from '../../main';
import { verboseLog } from '../utils';
import { findEmbeddedEditors } from './embedded-editors';
import { findMarkdownViewOfEditor } from './editor-checks';

/**
 * Options for reading file content
 */
export interface ContentReaderOptions {
  /** Already have content (the text an editor or view holds) */
  providedContent?: string;
  /** Already have editor instance */
  providedEditor?: Editor;
  /** Search open editors for this note, page previews and Canvas cards included */
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
      verboseLog(
        plugin,
        `Using provided content for ${file.path} (${content.length} chars)`
      );
      return content;
    }

    // Strategy 2: Use provided editor if available
    if (providedEditor) {
      // A tab's view text rather than its editor's: a Reading view's hidden editor keeps the text it loaded while properties edited in the view or outside changes reach only the view (measured, Obsidian 1.14.4)
      content =
        findMarkdownViewOfEditor(app, providedEditor)?.getViewData() ??
        providedEditor.getValue();
      verboseLog(
        plugin,
        `Using provided editor content for ${file.path} (${content.length} chars)`
      );
      return content;
    }

    // Strategy 3: Search open editors for this note, page previews and Canvas cards included, if requested
    if (searchWorkspace) {
      const editorContent = findEditorContent(app, file);
      if (editorContent !== null) {
        verboseLog(
          plugin,
          `Found editor in workspace for ${file.path} (${editorContent.length} chars)`
        );
        return editorContent;
      }
    }

    // Strategy 4: Use contentReadMethod setting
    if (settings.core.contentReadMethod === 'Editor') {
      // Editor method with no editor available - fallback based on preferFresh
      if (preferFresh) {
        content = await app.vault.read(file);
        verboseLog(
          plugin,
          `Editor method using fresh read for ${file.path} (${content.length} chars)`
        );
      } else {
        content = await app.vault.cachedRead(file);
        verboseLog(
          plugin,
          `Editor method fallback to cached read for ${file.path} (${content.length} chars)`
        );
      }
    } else if (settings.core.contentReadMethod === 'Cache') {
      content = await app.vault.cachedRead(file);
      verboseLog(
        plugin,
        `Cached read content from ${file.path} (${content.length} chars)`
      );
    } else {
      // 'File', the last of the three read methods the settings validation allows
      content = await app.vault.read(file);
      verboseLog(
        plugin,
        `Direct read content from ${file.path} (${content.length} chars)`
      );
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
 * Search workspace for an editor or Markdown view showing the given file
 * Checks page previews and Canvas cards editing the note first, then the active view, then open Markdown leaves
 * @param app - Obsidian App instance
 * @param file - File to find editor for
 * @returns The text it holds if found, null otherwise
 */
function findEditorContent(app: App, file: TFile): string | null {
  // Page previews and Canvas cards match the note by file identity, so an embed of another note is never read. Empty content is not trusted: likely transient state after file operations.
  const embedContent = findEmbeddedEditors(app, file)[0]?.editor?.getValue();
  if (embedContent) {
    return embedContent;
  }

  // Check active view as fallback - only if file matches
  // This prevents bulk operations from returning active editor content for all files
  // The view's text, not its editor's, which a Reading view leaves stale
  const activeView = app.workspace.getActiveViewOfType(MarkdownView);
  if (activeView && activeView.file?.path === file.path) {
    const content = activeView.getViewData();
    if (content) {
      return content;
    }
  }

  // Check main workspace leaves as final fallback
  // These can be stale after file operations (renames, etc.)
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    // A deferred leaf's view is no MarkdownView and has no file or editor (measured, Obsidian 1.14.4), so it is skipped until the leaf loads
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === file.path) {
      const content = view.getViewData();
      // Don't trust empty content - could be transient/stale state
      if (content) {
        return content;
      }
      // Empty content, continue searching
    }
  }

  return null;
}
