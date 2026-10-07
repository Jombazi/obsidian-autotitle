import {
  App,
  Editor,
  MarkdownView,
  TFile,
  getFrontMatterInfo,
  parseYaml,
  stringifyYaml,
} from 'obsidian';
import { Transaction } from '@codemirror/state';
import { findEmbeddedEditors, EmbeddedEditor } from './embedded-editors';

/**
 * An open editor showing a note, and how to save what is written into it.
 */
export interface SourceEditorTarget {
  editor: Editor;
  /** True while the editor holds typing it has not saved yet */
  isDirty: () => boolean;
  /** Absent for a page preview or Canvas card, whose embed saves its own edits */
  requestSave?: () => void;
}

/**
 * Apply a properties change to a note's text the way `FileManager.processFrontMatter` does.
 * @param text - Full note text
 * @param mutate - Changes the parsed properties in place
 * @returns The note text with the changed properties block
 * @throws The YAML parse error when the properties block is malformed, as `processFrontMatter` does
 */
export function applyFrontMatterChange(
  text: string,
  mutate: (frontmatter: Record<string, unknown>) => void
): string {
  // Mirrors `processFrontMatter`'s own transform with the same public helpers, so the editor ends up with exactly the text the file write would have produced.
  const info = getFrontMatterInfo(text);
  const parsed: unknown = info.exists ? parseYaml(info.frontmatter) : {};
  const frontmatter = (
    parsed && typeof parsed === 'object' ? parsed : {}
  ) as Record<string, unknown>;
  mutate(frontmatter);
  if (Object.keys(frontmatter).length === 0) {
    return info.exists ? text.slice(info.contentStart) : text;
  }
  const yaml = stringifyYaml(frontmatter);
  return info.exists
    ? text.slice(0, info.from) + yaml + text.slice(info.to)
    : '---\n' + yaml + '---\n' + text;
}

function markdownViewTarget(view: MarkdownView): SourceEditorTarget {
  return {
    editor: view.editor,
    isDirty: () => view.dirty,
    requestSave: () => view.requestSave(),
  };
}

function embeddedEditorTarget(
  embed: EmbeddedEditor,
  editor: Editor
): SourceEditorTarget {
  return { editor, isDirty: () => embed.dirty === true };
}

function isSourceViewOf(view: unknown, file: TFile): view is MarkdownView {
  return (
    view instanceof MarkdownView &&
    view.file === file &&
    view.getMode() === 'source'
  );
}

/**
 * Find the editor a properties change to the note should go through, preferring the one the user is most likely typing in.
 * Reading view never counts: an edit through its editor does not reach the file.
 * @param app - Obsidian App instance
 * @param file - Note to match, by object identity
 * @returns The editor, or undefined when the note is open in no editor
 */
export function findSourceEditorForFile(
  app: App,
  file: TFile
): SourceEditorTarget | undefined {
  const activeView = app.workspace.getActiveViewOfType(MarkdownView);
  if (isSourceViewOf(activeView, file)) {
    return markdownViewTarget(activeView);
  }

  const embeds = findEmbeddedEditors(app, file);
  const typingEmbed = embeds.find((embed) => embed.dirty === true);
  if (typingEmbed?.editor) {
    return embeddedEditorTarget(typingEmbed, typingEmbed.editor);
  }

  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    if (isSourceViewOf(leaf.view, file)) {
      return markdownViewTarget(leaf.view);
    }
  }

  const firstEmbed = embeds[0];
  return firstEmbed?.editor
    ? embeddedEditorTarget(firstEmbed, firstEmbed.editor)
    : undefined;
}

/**
 * Replace an editor's text with new text by changing only the range that differs.
 * @param editor - Editor to change
 * @param newText - Full text the editor should hold
 * @returns False when the editor already holds the text
 */
export function replaceEditorText(editor: Editor, newText: string): boolean {
  const oldText = editor.getValue();
  if (oldText === newText) {
    return false;
  }

  const shorterLength = Math.min(oldText.length, newText.length);
  let prefixLength = 0;
  while (
    prefixLength < shorterLength &&
    oldText.charCodeAt(prefixLength) === newText.charCodeAt(prefixLength)
  ) {
    prefixLength++;
  }
  // Capped so the suffix never overlaps the prefix: in "aa" -> "aaa" both would otherwise claim the same characters and give `from > to`.
  const maxSuffixLength = shorterLength - prefixLength;
  let suffixLength = 0;
  while (
    suffixLength < maxSuffixLength &&
    oldText.charCodeAt(oldText.length - 1 - suffixLength) ===
      newText.charCodeAt(newText.length - 1 - suffixLength)
  ) {
    suffixLength++;
  }

  const from = prefixLength;
  const to = oldText.length - suffixLength;
  const insert = newText.slice(prefixLength, newText.length - suffixLength);
  if (editor.cm) {
    editor.cm.dispatch({
      changes: { from, to, insert },
      // Kept out of the undo history so the user's undo reverts their own typing, not the alias.
      annotations: Transaction.addToHistory.of(false),
      // Unfiltered, as CodeMirror applies remote changes: Live Preview's properties filter drops a change to the properties when the cursor maps to before their old end, which a shrinking alias causes.
      filter: false,
    });
  } else {
    editor.replaceRange(
      insert,
      editor.offsetToPos(from),
      editor.offsetToPos(to)
    );
  }
  return true;
}
