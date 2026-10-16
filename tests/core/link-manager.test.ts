/**
 * Tests for the link commands' shared selection handling: every selection is read before the first edit and replaced from the bottom up, so earlier replacements never shift a range still to come, and an empty selection falls back to the link dialog.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App, Editor, EditorPosition, EditorSelection } from 'obsidian';
import { createTestSettings } from '../testUtils';
import {
  LinkManager,
  replaceSelectionsOrAsk,
} from '../../src/core/link-manager';

// A dialog stand-in that records what it was opened with; a regular function so it is constructable with `new`, and hoisted with the mock that reads it
const { dialogSubmits } = vi.hoisted(() => ({
  dialogSubmits: [] as Array<(text: string) => void>,
}));
vi.mock('../../src/modals', () => ({
  InternalLinkModal: vi.fn().mockImplementation(function (
    _app: unknown,
    onSubmit: (text: string) => void
  ) {
    return { open: () => dialogSubmits.push(onSubmit) };
  }),
}));

// Stand-ins for the safe-target encoding, which has its own tests: `/` is encoded as `∕`
vi.mock('../../src/utils/string-processing', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/utils/string-processing')
  >()),
  generateSafeLinkTarget: (text: string) => text.replaceAll('/', '∕'),
  reverseSafeLinkTarget: (text: string) => text.replaceAll('∕', '/'),
}));

/** An editor over `text` that applies edits for real, so a test reads the resulting note. */
function createEditor(text: string, selections: EditorSelection[] = []) {
  let content = text;
  let cursor: EditorPosition = { line: 0, ch: 0 };
  const offsetOf = ({ line, ch }: EditorPosition): number =>
    content
      .split('\n')
      .slice(0, line)
      .reduce((offset, lineText) => offset + lineText.length + 1, 0) + ch;
  const editor = {
    listSelections: () =>
      selections.length > 0 ? selections : [{ anchor: cursor, head: cursor }],
    getRange: (from: EditorPosition, to: EditorPosition) =>
      content.slice(offsetOf(from), offsetOf(to)),
    replaceRange: (
      replacement: string,
      from: EditorPosition,
      to: EditorPosition
    ) => {
      content =
        content.slice(0, offsetOf(from)) +
        replacement +
        content.slice(offsetOf(to));
    },
    replaceSelection: (replacement: string) => {
      editor.replaceRange(replacement, cursor, cursor);
    },
    getCursor: () => cursor,
    setCursor: vi.fn((position: EditorPosition) => {
      cursor = position;
    }),
  };
  return {
    editor: editor as unknown as Editor & {
      setCursor: typeof editor.setCursor;
    },
    content: () => content,
    placeCursor: (position: EditorPosition) => {
      cursor = position;
    },
  };
}

/** A selection from `anchor` to `head`, each given as [line, ch]. */
function selection(
  [anchorLine, anchorCh]: [number, number],
  [headLine, headCh]: [number, number]
): EditorSelection {
  return {
    anchor: { line: anchorLine, ch: anchorCh },
    head: { line: headLine, ch: headCh },
  };
}

const app = {} as App;
const wrap = (text: string) => `[[${text}]]`;

beforeEach(() => {
  dialogSubmits.length = 0;
});

describe('replaceSelectionsOrAsk', () => {
  it('replaces several selections on one line, the later ones first so the earlier ranges still hold', () => {
    const { editor, content } = createEditor('alpha beta gamma', [
      selection([0, 0], [0, 5]),
      selection([0, 11], [0, 16]),
    ]);

    const topmostStart = replaceSelectionsOrAsk(app, editor, wrap, vi.fn());

    expect(content()).toBe('[[alpha]] beta [[gamma]]');
    expect(topmostStart).toEqual({ line: 0, ch: 0 });
  });

  it('treats a selection made backwards like one made forwards', () => {
    const { editor, content } = createEditor('alpha beta', [
      selection([0, 10], [0, 6]),
    ]);

    replaceSelectionsOrAsk(app, editor, wrap, vi.fn());

    expect(content()).toBe('alpha [[beta]]');
  });

  it('replaces selections on several lines whatever order they were made in', () => {
    const { editor, content } = createEditor('one\ntwo\nthree', [
      selection([2, 0], [2, 5]),
      selection([0, 0], [0, 3]),
    ]);

    const topmostStart = replaceSelectionsOrAsk(app, editor, wrap, vi.fn());

    expect(content()).toBe('[[one]]\ntwo\n[[three]]');
    expect(topmostStart).toEqual({ line: 0, ch: 0 });
  });

  it('leaves a whitespace-only selection as it is, without opening the dialog', () => {
    const { editor, content } = createEditor('a   b', [
      selection([0, 1], [0, 4]),
    ]);

    const topmostStart = replaceSelectionsOrAsk(app, editor, wrap, vi.fn());

    expect(content()).toBe('a   b');
    expect(topmostStart).toBeNull();
    expect(dialogSubmits).toHaveLength(0);
  });

  it('asks for the text in the dialog when nothing is selected, and hands what it returns on', () => {
    const { editor } = createEditor('note');
    const insertFromDialog = vi.fn();

    const topmostStart = replaceSelectionsOrAsk(
      app,
      editor,
      wrap,
      insertFromDialog
    );
    dialogSubmits[0]('typed');

    expect(topmostStart).toBeNull();
    expect(insertFromDialog).toHaveBeenCalledWith('typed');
  });
});

describe('LinkManager', () => {
  const plugin = { app, settings: createTestSettings() } as never;

  it('links selected text to its safe target', () => {
    const { editor, content } = createEditor('see a/b here', [
      selection([0, 4], [0, 7]),
    ]);

    new LinkManager(plugin).addSafeInternalLink(editor);

    expect(content()).toBe('see [[a∕b]] here');
  });

  it('turns a selected link back into its display text', () => {
    const { editor, content } = createEditor('see [[a∕b|Shown]] here', [
      selection([0, 4], [0, 17]),
    ]);

    new LinkManager(plugin).addSafeInternalLink(editor);

    expect(content()).toBe('see Shown here');
  });

  it('gives a link made from selected text the text as it was typed for display', () => {
    const { editor, content } = createEditor('a/b', [
      selection([0, 0], [0, 3]),
    ]);

    new LinkManager(plugin).addSafeInternalLinkWithDisplayText(editor);

    expect(content()).toBe('[[a∕b|a/b]]');
  });

  it('inserts a link to the safe target of the text typed into the dialog', () => {
    const { editor, content, placeCursor } = createEditor('x ');
    placeCursor({ line: 0, ch: 2 });

    new LinkManager(plugin).addSafeInternalLink(editor);
    dialogSubmits[0]('a/b');

    expect(content()).toBe('x [[a∕b]]');
  });

  it('leaves the cursor inside the topmost empty target, where typing opens the link suggester', () => {
    const { editor, content } = createEditor('one\ntwo', [
      selection([1, 0], [1, 3]),
      selection([0, 0], [0, 3]),
    ]);

    new LinkManager(plugin).addInternalLinkWithDisplayTextAndCustomTarget(
      editor
    );

    expect(content()).toBe('[[|one]]\n[[|two]]');
    expect(editor.setCursor).toHaveBeenLastCalledWith({ line: 0, ch: 2 });
  });
});
