import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text } from '@codemirror/state';
import { EditorLifecycleManager } from '../../src/core/editor-lifecycle';
import { App, Editor, TFile } from '../mockObsidian';
import {
  createMockApp,
  createTestSettings,
  stubEditorText,
} from '../testUtils';
import type FirstLineIsTitle from '../../main';

/**
 * The editor runs ahead of the metadata cache by up to Obsidian's autosave delay, so the
 * cached frontmatter position can describe a frontmatter one line longer or shorter than
 * the one being edited. The first-line gate must find the body from the editor content.
 */
describe('EditorLifecycleManager first-line extraction', () => {
  let app: App;
  let editor: Editor;
  let file: TFile;
  let lifecycle: EditorLifecycleManager;
  let settings: ReturnType<typeof createTestSettings>;

  /** The cache says the frontmatter closes on `cachedEndLine`. */
  function mockCachedFrontmatterEndLine(cachedEndLine: number) {
    app.metadataCache.getFileCache = vi.fn().mockReturnValue({
      frontmatterPosition: {
        start: { line: 0, col: 0, offset: 0 },
        end: { line: cachedEndLine, col: 3, offset: 0 },
      },
    });
  }

  beforeEach(() => {
    app = createMockApp();

    file = new TFile('Notes/Body title.md');
    file.basename = 'Body title';
    file.extension = 'md';

    editor = new Editor();
    settings = createTestSettings();

    lifecycle = new EditorLifecycleManager({
      app,
      settings,
      isFullyLoaded: true,
    } as unknown as FirstLineIsTitle);
  });

  it('returns the first body line when the cached frontmatter is one line longer than the editor’s', () => {
    // A property line was just deleted; the cache still counts it.
    mockCachedFrontmatterEndLine(3);
    stubEditorText(
      editor,
      '---\naliases: [Body title]\n---\nBody title\nMore text'
    );

    expect(lifecycle.extractFirstLineFromEditor(editor, file)?.text).toBe(
      'Body title'
    );
  });

  it('returns the first body line when the cached frontmatter is one line shorter than the editor’s', () => {
    // A property line was just added; the cache does not know it yet.
    mockCachedFrontmatterEndLine(2);
    // A boundary read from the stale cache would land on the closing `---`, which horizontal-rule skipping would otherwise step over.
    settings.markupStripping.stripHorizontalRuleMarkup = false;
    stubEditorText(
      editor,
      '---\naliases: [Body title]\nstatus: draft\n---\nBody title\nMore text'
    );

    expect(lifecycle.extractFirstLineFromEditor(editor, file)?.text).toBe(
      'Body title'
    );
  });
});

/**
 * The editor-change gate schedules a rename only when the title source changes, `raw` included:
 * removing code's indentation or its fence can leave the text the same while it stops being code.
 */
describe('EditorLifecycleManager first-line gate', () => {
  let editor: Editor;
  let file: TFile;
  let setThrottleTimer: ReturnType<typeof vi.fn>;
  let setLastEditorContent: ReturnType<typeof vi.fn>;
  let lifecycle: EditorLifecycleManager;

  beforeEach(() => {
    vi.useFakeTimers();

    const app = createMockApp();
    app.metadataCache.getFileCache = vi.fn().mockReturnValue(null);

    file = new TFile('Notes/Code.md');
    file.basename = 'Code';
    file.extension = 'md';

    editor = new Editor();
    setThrottleTimer = vi.fn();
    setLastEditorContent = vi.fn();

    const settings = createTestSettings();
    settings.core.checkInterval = 0;

    lifecycle = new EditorLifecycleManager({
      app,
      settings,
      isFullyLoaded: true,
      fileStateManager: {
        isEditorSyncing: vi.fn().mockReturnValue(false),
        hasThrottleTimer: vi.fn().mockReturnValue(false),
        hasDelayedThrottleTimer: vi.fn().mockReturnValue(false),
        setThrottleTimer,
        clearThrottleTimer: vi.fn(),
        hasLastEditorContent: vi.fn().mockReturnValue(false),
        setLastEditorContent,
      },
      renameEngine: {
        processEditorChange: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as FirstLineIsTitle);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips an edit that leaves the title source unchanged', () => {
    stubEditorText(editor, 'Title\nBody');
    lifecycle.handleEditorChangeWithThrottle(editor, file);
    stubEditorText(editor, 'Title\nBody edited');
    lifecycle.handleEditorChangeWithThrottle(editor, file);

    expect(setThrottleTimer).toHaveBeenCalledTimes(1);
  });

  // A keystroke that leaves the first line alone keeps the compared text current without joining the whole note.
  it('stores the CodeMirror document as the baseline when the first line is unchanged', () => {
    stubEditorText(editor, 'Title\nBody');
    lifecycle.handleEditorChangeWithThrottle(editor, file);
    stubEditorText(editor, 'Title\nBody edited');
    const doc = Text.of(['Title', 'Body edited']);
    (editor as unknown as { cm: unknown }).cm = { state: { doc } };
    vi.mocked(editor.getValue).mockClear();

    lifecycle.handleEditorChangeWithThrottle(editor, file);

    expect(setLastEditorContent).toHaveBeenLastCalledWith(file.path, doc);
    expect(editor.getValue).not.toHaveBeenCalled();
  });

  it('stores the editor text when the editor has no CodeMirror view', () => {
    stubEditorText(editor, 'Title\nBody');
    lifecycle.handleEditorChangeWithThrottle(editor, file);
    stubEditorText(editor, 'Title\nBody edited');

    lifecycle.handleEditorChangeWithThrottle(editor, file);

    expect(setLastEditorContent).toHaveBeenLastCalledWith(
      file.path,
      'Title\nBody edited'
    );
  });

  it('schedules a rename when code loses its indentation but keeps its text', () => {
    stubEditorText(editor, '---\n    *foo*');
    lifecycle.handleEditorChangeWithThrottle(editor, file);
    stubEditorText(editor, '---\n*foo*');
    lifecycle.handleEditorChangeWithThrottle(editor, file);

    expect(setThrottleTimer).toHaveBeenCalledTimes(2);
  });

  it('schedules a rename when the opening fence line is deleted', () => {
    stubEditorText(editor, '```\n*foo*\n```');
    lifecycle.handleEditorChangeWithThrottle(editor, file);
    stubEditorText(editor, '*foo*\n```');
    lifecycle.handleEditorChangeWithThrottle(editor, file);

    expect(setThrottleTimer).toHaveBeenCalledTimes(2);
  });
});
