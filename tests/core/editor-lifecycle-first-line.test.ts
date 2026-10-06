import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getFrontMatterInfo } from 'obsidian';
import { EditorLifecycleManager } from '../../src/core/editor-lifecycle';
import { App, Editor, TFile } from '../mockObsidian';
import {
  createMockApp,
  createTestSettings,
  splitFrontMatter,
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
    vi.mocked(getFrontMatterInfo).mockImplementation(
      splitFrontMatter as unknown as typeof getFrontMatterInfo
    );

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

  afterEach(() => {
    vi.mocked(getFrontMatterInfo).mockReset();
  });

  it('returns the first body line when the cached frontmatter is one line longer than the editor’s', () => {
    // A property line was just deleted; the cache still counts it.
    mockCachedFrontmatterEndLine(3);
    editor.getValue = vi
      .fn()
      .mockReturnValue(
        '---\naliases: [Body title]\n---\nBody title\nMore text'
      );

    expect(lifecycle.extractFirstLineFromEditor(editor, file)).toBe(
      'Body title'
    );
  });

  it('returns the first body line when the cached frontmatter is one line shorter than the editor’s', () => {
    // A property line was just added; the cache does not know it yet.
    mockCachedFrontmatterEndLine(2);
    // The stale offset lands on the closing `---`, which horizontal-rule skipping would otherwise step over.
    settings.markupStripping.stripHorizontalRuleMarkup = false;
    editor.getValue = vi
      .fn()
      .mockReturnValue(
        '---\naliases: [Body title]\nstatus: draft\n---\nBody title\nMore text'
      );

    expect(lifecycle.extractFirstLineFromEditor(editor, file)).toBe(
      'Body title'
    );
  });
});
