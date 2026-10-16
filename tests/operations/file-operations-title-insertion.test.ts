import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getFrontMatterInfo } from 'obsidian';
import { FileOperations } from '../../src/operations/file-operations';
import { reverseCharacterReplacements } from '../../src/utils/string-processing';
import { App, MarkdownView, TFile } from '../mockObsidian';
import {
  createMockApp,
  createTestSettings,
  splitFrontMatter,
} from '../testUtils';
import { PluginSettings } from '../../src/types';
import type FirstLineIsTitle from '../../main';

// The module mocks below are why these tests live apart from file-operations.test.ts,
// which exercises the real utils against the same class.
vi.mock('../../src/i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../../src/utils', () => ({
  verboseLog: vi.fn(),
  verboseLogger: vi.fn(() => vi.fn()),
}));
vi.mock('../../src/utils/file-exclusions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/file-exclusions')>()),
  shouldProcessFile: vi.fn().mockReturnValue(true),
}));
vi.mock('../../src/utils/string-processing', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/utils/string-processing')
  >()),
  reverseCharacterReplacements: vi.fn((basename: string) => basename),
}));
vi.mock('../../src/utils/title-extraction', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/utils/title-extraction')
  >()),
  isUntitledName: (name: string) => name === 'Untitled',
}));

const FILE_PATH = 'Notes/My Title.md';
const TITLE = 'My Title';

function createFile(path: string = FILE_PATH): TFile {
  const file = new TFile(path);
  file.basename = TITLE;
  file.extension = 'md';
  file.name = `${TITLE}.md`;
  return file;
}

interface EditorPosition {
  line: number;
  ch: number;
}

/** Offset of `pos` in `text`. Throws for a position outside the document, so a write aimed below the last line fails the test instead of landing somewhere plausible. */
function positionToOffset(text: string, pos: EditorPosition): number {
  const lines = text.split('\n');
  if (
    pos.line < 0 ||
    pos.line >= lines.length ||
    pos.ch < 0 ||
    pos.ch > lines[pos.line].length
  ) {
    throw new RangeError(
      `Position ${pos.line}:${pos.ch} is outside the document`
    );
  }
  return (
    lines
      .slice(0, pos.line)
      .reduce((offset, line) => offset + line.length + 1, 0) + pos.ch
  );
}

/** Line and column of `offset` in `text`. */
function offsetToPosition(text: string, offset: number): EditorPosition {
  const linesBefore = text.slice(0, offset).split('\n');
  return {
    line: linesBefore.length - 1,
    ch: linesBefore[linesBefore.length - 1].length,
  };
}

/**
 * A Markdown view whose editor reports `content` and records every write, so a test can
 * assert what the insertion path did rather than what it intended to do.
 * @param mode 'live-preview' matches what the creation paths target; 'preview' is Reading view
 */
function createView(
  app: App,
  file: TFile | null,
  content: string,
  mode: 'live-preview' | 'preview' = 'live-preview'
) {
  const view = new MarkdownView(app);
  view.file = file;
  let documentText = content;
  view.editor.getValue = vi.fn().mockImplementation(() => documentText);
  view.editor.offsetToPos = vi
    .fn()
    .mockImplementation((offset: number) =>
      offsetToPosition(view.editor.getValue(), offset)
    );
  view.editor.replaceRange = vi
    .fn()
    .mockImplementation(
      (replacement: string, from: EditorPosition, to?: EditorPosition) => {
        const current = view.editor.getValue();
        const start = positionToOffset(current, from);
        const end = to ? positionToOffset(current, to) : start;
        documentText =
          current.slice(0, start) + replacement + current.slice(end);
      }
    );
  view.editor.getLine = vi
    .fn()
    .mockImplementation((line: number) => content.split('\n')[line] ?? '');
  (view as unknown as { leaf: unknown }).leaf = {
    setViewState: vi.fn().mockResolvedValue(undefined),
  };
  view.getState = vi
    .fn()
    .mockReturnValue(
      mode === 'live-preview'
        ? { mode: 'source', source: false }
        : { mode: 'preview', source: false }
    );
  view.getMode = vi.fn(() => (mode === 'live-preview' ? 'source' : 'preview'));
  return view;
}

describe('FileOperations title insertion', () => {
  let app: App;
  let settings: PluginSettings;
  let fileStateManager: {
    markEditorSyncing: ReturnType<typeof vi.fn>;
    clearEditorSyncing: ReturnType<typeof vi.fn>;
  };
  let fileOperations: FileOperations;
  let file: TFile;

  beforeEach(() => {
    vi.clearAllMocks();

    // The shared mock reports no properties block, which would make every block in these cases read as body
    vi.mocked(getFrontMatterInfo).mockImplementation(
      splitFrontMatter as unknown as typeof getFrontMatterInfo
    );

    app = createMockApp();
    app.vault.process = vi.fn();

    settings = createTestSettings();
    settings.core.formatAsHeading = false;
    settings.core.moveCursorToFirstLine = true;
    settings.core.placeCursorAtLineEnd = true;

    fileStateManager = {
      markEditorSyncing: vi.fn(),
      clearEditorSyncing: vi.fn(),
    };

    file = createFile();

    fileOperations = new FileOperations({
      app,
      settings,
      fileStateManager,
    } as unknown as FirstLineIsTitle);
  });

  describe('editor-syncing guard around the plugin’s own write', () => {
    it('marks syncing before the write and clears it after', async () => {
      const order: string[] = [];
      const view = createView(app, file, '');
      fileStateManager.markEditorSyncing.mockImplementation(() =>
        order.push('mark')
      );
      fileStateManager.clearEditorSyncing.mockImplementation(() =>
        order.push('clear')
      );
      view.editor.replaceRange = vi.fn().mockImplementation(() => {
        order.push('write');
        view.editor.getValue = vi.fn().mockReturnValue(`${TITLE}\n`);
      });

      await fileOperations.insertTitle(file, '', 'line-end', view);

      expect(order).toEqual(['mark', 'write', 'clear']);
      expect(fileStateManager.markEditorSyncing).toHaveBeenCalledWith(
        file.path
      );
      expect(fileStateManager.clearEditorSyncing).toHaveBeenCalledWith(
        file.path
      );
    });

    it('clears the syncing flag when the write throws', async () => {
      const view = createView(app, file, '');
      view.editor.replaceRange = vi.fn().mockImplementation(() => {
        throw new Error('editor detached mid-write');
      });

      await fileOperations.insertTitle(file, '', 'line-end', view);

      expect(fileStateManager.markEditorSyncing).toHaveBeenCalledWith(
        file.path
      );
      expect(fileStateManager.clearEditorSyncing).toHaveBeenCalledWith(
        file.path
      );
    });

    it('never marks syncing when no write is needed', async () => {
      // Title already on the insertion line, so the loop is skipped entirely
      const view = createView(app, file, `${TITLE}\n`);

      const result = await fileOperations.insertTitle(
        file,
        '',
        'line-end',
        view
      );

      expect(result.inserted).toBe(true);
      expect(view.editor.replaceRange).not.toHaveBeenCalled();
      expect(fileStateManager.markEditorSyncing).not.toHaveBeenCalled();
    });

    it('guards the heading-replacement write too', async () => {
      const view = createView(app, file, '---\na: b\n---\n## \n');

      await fileOperations.insertTitle(
        file,
        '---\na: b\n---\n## \n',
        'line-end',
        view
      );

      expect(view.editor.setLine).toHaveBeenCalledWith(3, `## ${TITLE}`);
      expect(fileStateManager.markEditorSyncing).toHaveBeenCalledWith(
        file.path
      );
      expect(fileStateManager.clearEditorSyncing).toHaveBeenCalledWith(
        file.path
      );
    });
  });

  describe('live content re-derivation before writing', () => {
    it('bails without writing when a body appeared after the creation snapshot', async () => {
      // Snapshot says empty, live editor already holds a body the user typed
      const view = createView(app, file, '---\na: b\n---\nUser typed this\n');

      const result = await fileOperations.insertTitle(
        file,
        '',
        'line-end',
        view
      );

      expect(result).toEqual({ inserted: false, cursorPositioned: false });
      expect(view.editor.replaceRange).not.toHaveBeenCalled();
    });

    it('does not fall through to vault.process after bailing', async () => {
      // vault.process reads from disk, which lags the editor by Obsidian's save debounce,
      // so falling through would see an empty body and insert a duplicate title
      const view = createView(app, file, 'User typed this\n');

      await fileOperations.insertTitle(file, '', 'line-end', view);

      expect(app.vault.process).not.toHaveBeenCalled();
    });

    it('respects a properties block when deciding the body is empty', async () => {
      const view = createView(app, file, '---\na: b\n---\n');
      view.editor.replaceRange = vi.fn().mockImplementation(() => {
        view.editor.getValue = vi
          .fn()
          .mockReturnValue(`---\na: b\n---\n${TITLE}\n`);
      });

      const result = await fileOperations.insertTitle(
        file,
        '',
        'line-end',
        view
      );

      expect(result.inserted).toBe(true);
      // Line 3 is the first line below the closing ---
      expect(view.editor.replaceRange).toHaveBeenCalledWith(`${TITLE}\n`, {
        line: 3,
        ch: 0,
      });
    });

    it('writes only once when a landed write fails verification', async () => {
      // The write lands but not on the insertion line. The old loop wrote first and never
      // undid a failed attempt, so ten failed verifications prepended ten titles.
      const view = createView(app, file, '');
      view.editor.replaceRange = vi.fn().mockImplementation(() => {
        view.editor.getValue = vi
          .fn()
          .mockReturnValue(`Something else\n${TITLE}\n`);
      });

      await fileOperations.insertTitle(file, '', 'line-end', view);

      expect(view.editor.replaceRange).toHaveBeenCalledTimes(1);
      expect(app.vault.process).not.toHaveBeenCalled();
    });

    it('skips insertion in the vault fallback when disk already has a body', async () => {
      // No view at all, so the fallback runs; its callback must leave content untouched
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);
      let returned: string | undefined;
      app.vault.process = vi.fn(
        async (_f: TFile, fn: (content: string) => string) => {
          returned = fn('---\na: b\n---\nAlready here\n');
          return returned;
        }
      );

      const result = await fileOperations.insertTitle(file, '', 'line-end');

      expect(returned).toBe('---\na: b\n---\nAlready here\n');
      expect(result.inserted).toBe(false);
    });

    it('inserts below the properties block in the vault fallback', async () => {
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);
      let returned: string | undefined;
      app.vault.process = vi.fn(
        async (_f: TFile, fn: (content: string) => string) => {
          returned = fn('---\na: b\n---\n');
          return returned;
        }
      );

      const result = await fileOperations.insertTitle(file, '', 'line-end');

      expect(returned).toBe(`---\na: b\n---\n${TITLE}\n`);
      expect(result.inserted).toBe(true);
    });
  });

  describe('closing fence at the end of the note', () => {
    it('writes a line break after the fence before the title in the editor', async () => {
      // Source mode leaves a properties-only note without a line break after the fence; aiming at the line below it produced `---Title`
      const view = createView(app, file, '---\na: b\n---');

      const result = await fileOperations.insertTitle(
        file,
        '---\na: b\n---',
        'line-end',
        view
      );

      expect(result.inserted).toBe(true);
      expect(view.editor.getValue()).toBe(`---\na: b\n---\n${TITLE}\n`);
      expect(app.vault.process).not.toHaveBeenCalled();
    });

    it('trusts the live editor over a snapshot that still ends at the fence', async () => {
      // Live Preview appends the fence's line break itself, so the snapshot is stale by the time the editor is written
      const view = createView(app, file, '---\na: b\n---\n');

      await fileOperations.insertTitle(
        file,
        '---\na: b\n---',
        'line-end',
        view
      );

      expect(view.editor.getValue()).toBe(`---\na: b\n---\n${TITLE}\n`);
    });

    it('writes a line break after the fence before the title in the vault fallback', async () => {
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);
      let returned: string | undefined;
      app.vault.process = vi.fn(
        async (_f: TFile, fn: (content: string) => string) => {
          returned = fn('---\na: b\n---');
          return returned;
        }
      );

      const result = await fileOperations.insertTitle(
        file,
        '---\na: b\n---',
        'line-end'
      );

      expect(returned).toBe(`---\na: b\n---\n${TITLE}\n`);
      expect(result.inserted).toBe(true);
    });
  });

  describe('CRLF line breaks', () => {
    it('inserts below the properties block in the vault fallback, keeping CRLF', async () => {
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);
      let returned: string | undefined;
      app.vault.process = vi.fn(
        async (_f: TFile, fn: (content: string) => string) => {
          returned = fn('---\r\na: b\r\n---\r\n');
          return returned;
        }
      );

      // The creation snapshot holds the same content, so the body check before the write sees CRLF too
      const result = await fileOperations.insertTitle(
        file,
        '---\r\na: b\r\n---\r\n',
        'line-end'
      );

      expect(returned).toBe(`---\r\na: b\r\n---\r\n${TITLE}\r\n`);
      expect(result.inserted).toBe(true);
    });

    it('fills an empty heading in the vault fallback, keeping CRLF', async () => {
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);
      let returned: string | undefined;
      app.vault.process = vi.fn(
        async (_f: TFile, fn: (content: string) => string) => {
          returned = fn('---\r\na: b\r\n---\r\n## \r\n');
          return returned;
        }
      );

      await fileOperations.insertTitle(
        file,
        '---\r\na: b\r\n---\r\n## \r\n',
        'line-end'
      );

      expect(returned).toBe(`---\r\na: b\r\n---\r\n## ${TITLE}\r\n`);
    });

    it('leaves the note alone when its heading changed since the snapshot', async () => {
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);
      let returned: string | undefined;
      app.vault.process = vi.fn(
        async (_f: TFile, fn: (content: string) => string) => {
          returned = fn('---\na: b\n---\n## Typed meanwhile\n');
          return returned;
        }
      );

      await fileOperations.insertTitle(
        file,
        '---\na: b\n---\n## \n',
        'line-end'
      );

      expect(returned).toBe('---\na: b\n---\n## Typed meanwhile\n');
    });
  });

  describe('resolveMarkdownViewForFile', () => {
    it('uses a matching hint without scanning leaves', () => {
      const view = createView(app, file, '');
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);

      expect(fileOperations.resolveMarkdownViewForFile(file, view)).toBe(view);
      expect(app.workspace.getLeavesOfType).not.toHaveBeenCalled();
    });

    it('falls back to a scan when the hint names another file', () => {
      const staleView = createView(app, createFile('Notes/Other.md'), '');
      const liveView = createView(app, file, '');
      app.workspace.getLeavesOfType = vi
        .fn()
        .mockReturnValue([{ view: liveView }]);

      expect(fileOperations.resolveMarkdownViewForFile(file, staleView)).toBe(
        liveView
      );
      expect(app.workspace.getLeavesOfType).toHaveBeenCalledWith('markdown');
    });

    it('returns null when nothing matches', () => {
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);

      expect(fileOperations.resolveMarkdownViewForFile(file, null)).toBeNull();
    });

    it('rejects a hint with no editor when an editor is required', () => {
      const view = createView(app, file, '');
      (view as unknown as { editor: unknown }).editor = undefined;
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);

      expect(fileOperations.resolveMarkdownViewForFile(file, view)).toBeNull();
    });

    it('does not scan leaves when insertion is handed a usable hint', async () => {
      const view = createView(app, file, '');
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);

      await fileOperations.insertTitle(file, '', 'line-end', view);

      expect(app.workspace.getLeavesOfType).not.toHaveBeenCalled();
    });
  });

  describe('handleCursorPositioning view state', () => {
    it('never transitions the view state, in either mode', async () => {
      // Obsidian's own creators open a newly created note in Live Preview regardless of the default-view setting, and a note another plugin opens in Reading view stays there.
      for (const mode of ['live-preview', 'preview'] as const) {
        const view = createView(app, file, `${TITLE}\n`, mode);

        await fileOperations.handleCursorPositioning(file, true, view);

        const leaf = (view as unknown as { leaf: { setViewState: unknown } })
          .leaf;
        expect(leaf.setViewState).not.toHaveBeenCalled();
      }
    });

    it('places the cursor in Live Preview', async () => {
      const view = createView(app, file, `${TITLE}\n`, 'live-preview');

      await fileOperations.handleCursorPositioning(file, true, view);

      expect(view.editor.setCursor).toHaveBeenCalledWith({
        line: 0,
        ch: TITLE.length,
      });
    });

    // A Reading view's editor is hidden, and a line break written into it never reaches the note
    it('leaves a Reading view alone', async () => {
      const view = createView(app, file, '---\na: b\n---', 'preview');

      await fileOperations.handleCursorPositioning(file, true, view);

      expect(view.editor.focus).not.toHaveBeenCalled();
      expect(view.editor.replaceRange).not.toHaveBeenCalled();
      expect(view.editor.setCursor).not.toHaveBeenCalled();
    });

    it('does nothing when no view matches the file', async () => {
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);

      await expect(
        fileOperations.handleCursorPositioning(file, true)
      ).resolves.toBeUndefined();
    });
  });

  describe('handleCursorPositioning below a closing fence that ends the note', () => {
    // On the fence line, typing would turn `---` into `---text` and end the properties block
    it('writes a line break and puts the cursor on the new line', async () => {
      const view = createView(app, file, '---\na: b\n---');

      await fileOperations.handleCursorPositioning(file, true, view);

      expect(view.editor.getValue()).toBe('---\na: b\n---\n');
      expect(view.editor.setCursor).toHaveBeenCalledWith({ line: 3, ch: 0 });
    });

    it('keeps CRLF for the line break', async () => {
      const view = createView(app, file, '---\r\na: b\r\n---');

      await fileOperations.handleCursorPositioning(file, false, view);

      expect(view.editor.getValue()).toBe('---\r\na: b\r\n---\r\n');
      expect(view.editor.setCursor).toHaveBeenCalledWith({ line: 3, ch: 0 });
    });

    it('guards the line break as the plugin’s own write', async () => {
      const view = createView(app, file, '---\na: b\n---');

      await fileOperations.handleCursorPositioning(file, true, view);

      expect(fileStateManager.markEditorSyncing).toHaveBeenCalledWith(
        file.path
      );
      expect(fileStateManager.clearEditorSyncing).toHaveBeenCalledWith(
        file.path
      );
    });
  });

  // The same line break the cursor pass writes into the editor, written through the file for a view that has not reloaded yet
  describe('line break below an ending fence, through the file', () => {
    /** Runs the method against `content` and returns what vault.process would write */
    async function processedText(content: string): Promise<string> {
      let returned = content;
      app.vault.process = vi.fn(
        async (_f: TFile, fn: (content: string) => string) => {
          returned = fn(content);
          return returned;
        }
      );
      await fileOperations.addLineAfterEndingFence(file);
      return returned;
    }

    it('adds a line break after a fence that ends the note', async () => {
      expect(await processedText('---\na: b\n---')).toBe('---\na: b\n---\n');
    });

    it('keeps CRLF for the line break', async () => {
      expect(await processedText('---\r\na: b\r\n---')).toBe(
        '---\r\na: b\r\n---\r\n'
      );
    });

    it('leaves a note whose fence is followed by a line break alone', async () => {
      expect(await processedText('---\na: b\n---\n')).toBe('---\na: b\n---\n');
    });

    it('leaves a note with no properties alone', async () => {
      expect(await processedText('Body')).toBe('Body');
    });
  });

  describe('replacement character conversion', () => {
    const REPLACED_TITLE = 'a⧵b․c';
    let replacedFile: TFile;

    beforeEach(async () => {
      // The real reversal, so the inserted text shows what a user would get
      const actual = await vi.importActual<
        typeof import('../../src/utils/string-processing')
      >('../../src/utils/string-processing');
      vi.mocked(reverseCharacterReplacements).mockImplementation(
        actual.reverseCharacterReplacements
      );
      settings.characterReplacements.enableForbiddenCharReplacements = true;
      replacedFile = createFile(`Notes/${REPLACED_TITLE}.md`);
      replacedFile.basename = REPLACED_TITLE;
    });

    afterEach(() => {
      // Back to the pass-through the other cases rely on
      vi.mocked(reverseCharacterReplacements).mockReset();
    });

    it('keeps replacement characters when title conversion is off, even with Character replacements on', async () => {
      settings.core.convertReplacementChars = false;
      const view = createView(app, replacedFile, '');

      await fileOperations.insertTitle(replacedFile, '', 'line-end', view);

      expect(view.editor.getValue()).toBe(`${REPLACED_TITLE}\n`);
    });

    it('converts replacement characters when title conversion is on', async () => {
      settings.core.convertReplacementChars = true;
      const view = createView(app, replacedFile, '');

      await fileOperations.insertTitle(replacedFile, '', 'line-end', view);

      expect(view.editor.getValue()).toBe('a\\b.c\n');
    });
  });

  describe('untitled notes', () => {
    it('inserts no title into a note named Untitled', async () => {
      const untitledFile = createFile('Untitled.md');
      untitledFile.basename = 'Untitled';
      const view = createView(app, untitledFile, '');

      const result = await fileOperations.insertTitle(
        untitledFile,
        '',
        'line-end',
        view
      );

      expect(result).toEqual({ inserted: false, cursorPositioned: false });
      expect(view.editor.replaceRange).not.toHaveBeenCalled();
    });
  });

  describe('cursorPositioned reporting', () => {
    it('reports the cursor settled when placed in an already-Live-Preview view', async () => {
      const view = createView(app, file, '', 'live-preview');
      view.editor.replaceRange = vi.fn().mockImplementation(() => {
        view.editor.getValue = vi.fn().mockReturnValue(`${TITLE}\n`);
      });

      const result = await fileOperations.insertTitle(
        file,
        '',
        'line-end',
        view
      );

      expect(result).toEqual({ inserted: true, cursorPositioned: true });
    });

    // A Reading view's hidden editor takes the write and reads back as holding it, but the view never saves it
    it('writes the title into the file, not a Reading view’s editor, and places no cursor', async () => {
      const view = createView(app, file, '', 'preview');
      let returned: string | undefined;
      app.vault.process = vi.fn(
        async (_f: TFile, fn: (content: string) => string) => {
          returned = fn('');
          return returned;
        }
      );

      const result = await fileOperations.insertTitle(
        file,
        '',
        'line-end',
        view
      );

      expect(view.editor.replaceRange).not.toHaveBeenCalled();
      expect(returned).toBe(`${TITLE}\n`);
      expect(result).toEqual({ inserted: true, cursorPositioned: false });
    });

    it('fills an empty heading in the file, not a Reading view’s editor', async () => {
      const view = createView(app, file, '# \n', 'preview');
      let returned: string | undefined;
      app.vault.process = vi.fn(
        async (_f: TFile, fn: (content: string) => string) => {
          returned = fn('# \n');
          return returned;
        }
      );

      const result = await fileOperations.insertTitle(
        file,
        '# \n',
        'line-end',
        view
      );

      expect(view.editor.setLine).not.toHaveBeenCalled();
      expect(returned).toBe(`# ${TITLE}\n`);
      expect(result).toEqual({ inserted: true, cursorPositioned: false });
    });

    it('does not report it settled when the coordinator leaves the cursor', async () => {
      const view = createView(app, file, '', 'live-preview');
      view.editor.replaceRange = vi.fn().mockImplementation(() => {
        view.editor.getValue = vi.fn().mockReturnValue(`${TITLE}\n`);
      });

      const result = await fileOperations.insertTitle(file, '', 'none', view);

      expect(result).toEqual({ inserted: true, cursorPositioned: false });
    });

    // The coordinator settles the cursor from the settings; insertion no longer reads them a second time
    it('follows the coordinator rather than the cursor settings', async () => {
      settings.core.moveCursorToFirstLine = false;
      settings.core.placeCursorAtLineEnd = false;
      const view = createView(app, file, '', 'live-preview');

      const result = await fileOperations.insertTitle(
        file,
        '',
        'line-end',
        view
      );

      expect(result).toEqual({ inserted: true, cursorPositioned: true });
    });
  });

  describe('title through the file', () => {
    // Templater wrote the file while the view still shows older text, and the view's reload would wipe an editor write
    it('writes the file, not the editor of a view showing the note', async () => {
      const view = createView(app, file, '');
      let returned: string | undefined;
      app.vault.process = vi.fn(
        async (_f: TFile, fn: (content: string) => string) => {
          returned = fn('---\na: b\n---\n');
          return returned;
        }
      );

      const result = await fileOperations.insertTitle(
        file,
        '---\na: b\n---\n',
        'line-end',
        view,
        true
      );

      expect(returned).toBe(`---\na: b\n---\n${TITLE}\n`);
      expect(result).toEqual({ inserted: true, cursorPositioned: false });
      expect(view.editor.replaceRange).not.toHaveBeenCalled();
      expect(view.editor.setCursor).not.toHaveBeenCalled();
      expect(view.editor.focus).not.toHaveBeenCalled();
    });

    it('fills an empty heading in the file, not the editor', async () => {
      const view = createView(app, file, '# \n');
      let returned: string | undefined;
      app.vault.process = vi.fn(
        async (_f: TFile, fn: (content: string) => string) => {
          returned = fn('# \n');
          return returned;
        }
      );

      await fileOperations.insertTitle(file, '# \n', 'line-end', view, true);

      expect(returned).toBe(`# ${TITLE}\n`);
      expect(view.editor.setLine).not.toHaveBeenCalled();
    });
  });

  // User decision: "Place cursor at line end" applies to a new note in a background tab too
  describe('new note outside the active tab', () => {
    /** Lets the zero-delay cursor move run */
    const settleCursorMove = () =>
      new Promise((resolve) => window.setTimeout(resolve, 5));

    /** The note's view, with another view taking the active tab */
    function createInactiveView(content: string) {
      const view = createView(app, file, content);
      const activeView = createView(app, createFile('Notes/Other.md'), '');
      app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(activeView);
      return view;
    }

    it('moves the cursor to the end of the title line it inserts', async () => {
      const view = createInactiveView('---\na: b\n---\n');

      await fileOperations.insertTitle(
        file,
        '---\na: b\n---\n',
        'line-end',
        view
      );
      await settleCursorMove();

      expect(view.editor.getValue()).toBe(`---\na: b\n---\n${TITLE}\n`);
      expect(view.editor.setCursor).toHaveBeenCalledWith({
        line: 3,
        ch: TITLE.length,
      });
    });

    it('moves the cursor in the cursor pass', async () => {
      const view = createInactiveView(`${TITLE}\n`);

      await fileOperations.handleCursorPositioning(file, true, view);

      expect(view.editor.setCursor).toHaveBeenCalledWith({
        line: 0,
        ch: TITLE.length,
      });
    });
  });

  describe('cursor a template placed', () => {
    /** Lets the zero-delay cursor move run */
    const settleCursorMove = () =>
      new Promise((resolve) => window.setTimeout(resolve, 5));

    /** A view whose editor reports the cursor at `cursor`, with offsets measured against its live text */
    function createViewWithCursor(content: string, cursor: EditorPosition) {
      const view = createView(app, file, content);
      view.editor.getCursor = vi.fn().mockReturnValue(cursor);
      view.editor.posToOffset = vi
        .fn()
        .mockImplementation((pos: EditorPosition) =>
          positionToOffset(view.editor.getValue(), pos)
        );
      return view;
    }

    // CodeMirror keeps a cursor at the insertion offset in front of the inserted text
    it('ends at the end of the title line when the template cursor sits where the title goes', async () => {
      const view = createViewWithCursor('---\na: b\n---\n', {
        line: 3,
        ch: 0,
      });

      const result = await fileOperations.insertTitle(
        file,
        '---\na: b\n---\n',
        'keep-template-cursor',
        view
      );
      await settleCursorMove();

      expect(view.editor.getValue()).toBe(`---\na: b\n---\n${TITLE}\n`);
      expect(result).toEqual({ inserted: true, cursorPositioned: true });
      expect(view.editor.setCursor).toHaveBeenCalledWith({
        line: 3,
        ch: TITLE.length,
      });
    });

    // The coordinator passes `none` for a template cursor when FLIT's own placement would not be the title line end
    it('leaves a template cursor where the title goes to CodeMirror when no placement is asked for', async () => {
      const view = createViewWithCursor('---\na: b\n---\n', {
        line: 3,
        ch: 0,
      });

      const result = await fileOperations.insertTitle(
        file,
        '---\na: b\n---\n',
        'none',
        view
      );
      await settleCursorMove();

      expect(view.editor.getValue()).toBe(`---\na: b\n---\n${TITLE}\n`);
      expect(result).toEqual({ inserted: true, cursorPositioned: false });
      expect(view.editor.setCursor).not.toHaveBeenCalled();
    });

    it('leaves a template cursor on an empty heading the title fills to CodeMirror when no placement is asked for', async () => {
      const view = createViewWithCursor('---\na: b\n---\n# \n', {
        line: 3,
        ch: 2,
      });

      const result = await fileOperations.insertTitle(
        file,
        '---\na: b\n---\n# \n',
        'none',
        view
      );
      await settleCursorMove();

      expect(view.editor.setLine).toHaveBeenCalledWith(3, `# ${TITLE}`);
      expect(result).toEqual({ inserted: true, cursorPositioned: false });
      expect(view.editor.setCursor).not.toHaveBeenCalled();
    });

    it('leaves a template cursor elsewhere alone, still inserting the title', async () => {
      const view = createViewWithCursor('---\na: b\n---\n', {
        line: 1,
        ch: 4,
      });

      const result = await fileOperations.insertTitle(
        file,
        '---\na: b\n---\n',
        'keep-template-cursor',
        view
      );
      await settleCursorMove();

      expect(view.editor.getValue()).toBe(`---\na: b\n---\n${TITLE}\n`);
      expect(result).toEqual({ inserted: true, cursorPositioned: false });
      expect(view.editor.setCursor).not.toHaveBeenCalled();
    });

    it('ends at the end of a filled heading when the template cursor sits on it', async () => {
      const view = createViewWithCursor('---\na: b\n---\n## \n', {
        line: 3,
        ch: 3,
      });

      const result = await fileOperations.insertTitle(
        file,
        '---\na: b\n---\n## \n',
        'keep-template-cursor',
        view
      );
      await settleCursorMove();

      expect(view.editor.setLine).toHaveBeenCalledWith(3, `## ${TITLE}`);
      expect(result).toEqual({ inserted: true, cursorPositioned: true });
      expect(view.editor.setCursor).toHaveBeenCalledWith({
        line: 3,
        ch: `## ${TITLE}`.length,
      });
    });

    it('leaves the template cursor on a body line no title goes into', async () => {
      const view = createViewWithCursor('---\na: b\n---\nNotes: \n', {
        line: 3,
        ch: 7,
      });

      const result = await fileOperations.insertTitle(
        file,
        '---\na: b\n---\nNotes: \n',
        'keep-template-cursor',
        view
      );
      await settleCursorMove();

      expect(result).toEqual({ inserted: false, cursorPositioned: false });
      expect(view.editor.setCursor).not.toHaveBeenCalled();
    });
  });

  // Templater leaves its placeholder in the note with automatic jump off or in a background tab, and a later jump still needs it
  describe('a body of only cursor placeholders', () => {
    const PROPERTIES = '---\nkind: probe\n---\n';

    /** Lets the zero-delay cursor move run */
    const settleCursorMove = () =>
      new Promise((resolve) => window.setTimeout(resolve, 5));

    /** Runs `vault.process` on `diskText`, with no view showing the note */
    function processWithoutView(diskText: string): () => string | undefined {
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);
      let returned: string | undefined;
      app.vault.process = vi.fn(
        async (_f: TFile, fn: (content: string) => string) => {
          returned = fn(diskText);
          return returned;
        }
      );
      return () => returned;
    }

    const placeholderOnlyBodies = [
      { name: 'one placeholder', body: '<% tp.file.cursor() %>\n' },
      { name: 'an ordered placeholder', body: '<% tp.file.cursor(2) %>\n' },
      {
        name: 'placeholders and blank lines',
        body: '<% tp.file.cursor(1) %>\n\n<% tp.file.cursor(2) %>\n\n',
      },
    ];

    it.each(placeholderOnlyBodies)(
      'inserts the title above $name in the editor',
      async ({ body }) => {
        const note = PROPERTIES + body;
        const view = createView(app, file, note);

        const result = await fileOperations.insertTitle(
          file,
          note,
          'line-end',
          view
        );
        await settleCursorMove();

        expect(view.editor.getValue()).toBe(`${PROPERTIES}${TITLE}\n${body}`);
        expect(result).toEqual({ inserted: true, cursorPositioned: true });
        expect(view.editor.setCursor).toHaveBeenCalledWith({
          line: 3,
          ch: TITLE.length,
        });
        expect(app.vault.process).not.toHaveBeenCalled();
      }
    );

    it.each(placeholderOnlyBodies)(
      'inserts the title above $name through vault.process',
      async ({ body }) => {
        const note = PROPERTIES + body;
        const written = processWithoutView(note);

        const result = await fileOperations.insertTitle(file, note, 'line-end');

        expect(written()).toBe(`${PROPERTIES}${TITLE}\n${body}`);
        expect(result.inserted).toBe(true);
      }
    );

    // The background-tab path: Templater wrote the file, and the view still shows the text from before
    it('inserts the title above the placeholder through the file while a stale view shows the note', async () => {
      const note = `${PROPERTIES}<% tp.file.cursor() %>\n`;
      const view = createView(app, file, '');
      let returned: string | undefined;
      app.vault.process = vi.fn(
        async (_f: TFile, fn: (content: string) => string) => {
          returned = fn(note);
          return returned;
        }
      );

      const result = await fileOperations.insertTitle(
        file,
        note,
        'none',
        view,
        true
      );

      expect(returned).toBe(`${PROPERTIES}${TITLE}\n<% tp.file.cursor() %>\n`);
      expect(result).toEqual({ inserted: true, cursorPositioned: false });
      expect(view.editor.replaceRange).not.toHaveBeenCalled();
    });

    it('leaves a placeholder with other text alone in the editor', async () => {
      const note = `${PROPERTIES}<% tp.file.cursor() %>\nNotes\n`;
      const view = createView(app, file, note);

      const result = await fileOperations.insertTitle(file, note, 'none', view);

      expect(result.inserted).toBe(false);
      expect(view.editor.replaceRange).not.toHaveBeenCalled();
      expect(app.vault.process).not.toHaveBeenCalled();
    });

    it('bails in the editor when other text joined the placeholder after the snapshot', async () => {
      const view = createView(
        app,
        file,
        `${PROPERTIES}<% tp.file.cursor() %>\nTyped\n`
      );

      const result = await fileOperations.insertTitle(
        file,
        `${PROPERTIES}<% tp.file.cursor() %>\n`,
        'line-end',
        view
      );

      expect(result).toEqual({ inserted: false, cursorPositioned: false });
      expect(view.editor.replaceRange).not.toHaveBeenCalled();
    });

    it('leaves a placeholder with other text alone through vault.process', async () => {
      const disk = `${PROPERTIES}Notes: <% tp.file.cursor() %>\n`;
      const written = processWithoutView(disk);

      const result = await fileOperations.insertTitle(
        file,
        `${PROPERTIES}<% tp.file.cursor() %>\n`,
        'line-end'
      );

      expect(written()).toBe(disk);
      expect(result.inserted).toBe(false);
    });
  });
});
