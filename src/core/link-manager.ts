import { App, Editor, EditorPosition } from 'obsidian';
import FirstLineIsTitle from '../../main';
import {
  generateSafeLinkTarget,
  reverseSafeLinkTarget,
} from '../utils/string-processing';
import { InternalLinkModal } from '../modals';

/** True when `a` comes after `b` in the document. */
function isAfter(a: EditorPosition, b: EditorPosition): boolean {
  return a.line > b.line || (a.line === b.line && a.ch > b.ch);
}

/**
 * Replaces every selection holding more than whitespace with `buildReplacement(text)`, or, when nothing is selected, asks for the text in the link dialog and hands it to `insertFromDialog`.
 * Every selection's text is read before the first edit, and the edits run from the bottom of the note up, so a replacement never shifts a range still to come.
 * @param app - Opens the dialog
 * @param editor - The editor the command runs in
 * @param buildReplacement - The text that replaces a selection, given its text
 * @param insertFromDialog - Inserts what the dialog returns
 * @returns Where the topmost replaced selection started, or null when nothing was replaced
 */
export function replaceSelectionsOrAsk(
  app: App,
  editor: Editor,
  buildReplacement: (selectedText: string) => string,
  insertFromDialog: (dialogText: string) => void
): EditorPosition | null {
  const selections = editor.listSelections();
  const hasSelection = selections.some(
    ({ anchor, head }) => anchor.line !== head.line || anchor.ch !== head.ch
  );

  if (!hasSelection) {
    new InternalLinkModal(app, insertFromDialog).open();
    return null;
  }

  const ranges = selections.map(({ anchor, head }) => {
    // A selection made backwards has its anchor after its head
    const [from, to] = isAfter(anchor, head) ? [head, anchor] : [anchor, head];
    return { from, to, text: editor.getRange(from, to) };
  });
  ranges.sort((a, b) => b.from.line - a.from.line || b.from.ch - a.from.ch);

  let topmostStart: EditorPosition | null = null;
  for (const { from, to, text } of ranges) {
    if (!text.trim()) continue;
    editor.replaceRange(buildReplacement(text), from, to);
    topmostStart = from;
  }
  return topmostStart;
}

export class LinkManager {
  private plugin: FirstLineIsTitle;

  constructor(plugin: FirstLineIsTitle) {
    this.plugin = plugin;
  }

  addSafeInternalLink(editor: Editor): void {
    replaceSelectionsOrAsk(
      this.plugin.app,
      editor,
      (text) => {
        const trimmedSelection = text.trim();
        // A selected wikilink is toggled off
        if (
          trimmedSelection.startsWith('[[') &&
          trimmedSelection.endsWith(']]')
        ) {
          const linkContent = trimmedSelection.slice(2, -2);
          const pipeIndex = linkContent.indexOf('|');
          // [[target|display text]] → display text; [[target]] → reverse(target)
          return pipeIndex !== -1
            ? linkContent.slice(pipeIndex + 1)
            : reverseSafeLinkTarget(linkContent, this.plugin.settings);
        }
        // Plain text: text → [[safe(text)]]
        return `[[${generateSafeLinkTarget(text, this.plugin.settings)}]]`;
      },
      (linkTarget) => {
        editor.replaceSelection(
          `[[${generateSafeLinkTarget(linkTarget, this.plugin.settings)}]]`
        );
      }
    );
  }

  addSafeInternalLinkWithDisplayText(editor: Editor): void {
    replaceSelectionsOrAsk(
      this.plugin.app,
      editor,
      (text) => {
        const trimmedSelection = text.trim();
        if (
          !trimmedSelection.startsWith('[[') ||
          !trimmedSelection.endsWith(']]')
        ) {
          // Plain text: Hey^ → [[Heyˆ|Hey^]]
          return `[[${generateSafeLinkTarget(text, this.plugin.settings)}|${text}]]`;
        }
        const linkContent = trimmedSelection.slice(2, -2);
        const pipeIndex = linkContent.indexOf('|');
        if (pipeIndex === -1) {
          // No display text: [[Heyˆ]] → [[Heyˆ|Hey^]] (add display text as reversed target)
          return `[[${linkContent}|${reverseSafeLinkTarget(linkContent, this.plugin.settings)}]]`;
        }
        const target = linkContent.slice(0, pipeIndex);
        const displayText = linkContent.slice(pipeIndex + 1);
        const reversedTarget = reverseSafeLinkTarget(
          target,
          this.plugin.settings
        );
        // [[Heyˆ|Hey^]] → Hey^ (strip when display text matches reversed target); [[Heyˆ|Bye]] → [[Heyˆ|Hey^]] (update display text to reversed target)
        return reversedTarget === displayText
          ? displayText
          : `[[${target}|${reversedTarget}]]`;
      },
      (linkText) => {
        editor.replaceSelection(
          `[[${generateSafeLinkTarget(linkText, this.plugin.settings)}|${linkText}]]`
        );
      }
    );
  }

  addInternalLinkWithDisplayTextAndCustomTarget(editor: Editor): void {
    // Each selection becomes [[|text]]: an empty target with the text as display text
    const topmostStart = replaceSelectionsOrAsk(
      this.plugin.app,
      editor,
      (text) => `[[|${text}]]`,
      (linkTarget) => {
        const cursor = editor.getCursor();
        editor.replaceSelection(`[[|${linkTarget}]]`);
        // After [[, where typing opens the link suggester
        editor.setCursor({ line: cursor.line, ch: cursor.ch + 2 });
      }
    );
    // After the topmost link's [[, so the link suggester opens on typing
    if (topmostStart) {
      editor.setCursor({ line: topmostStart.line, ch: topmostStart.ch + 2 });
    }
  }
}
