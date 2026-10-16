import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorLifecycleManager } from '../../src/core/editor-lifecycle';
import { App, Editor, TFile } from '../mockObsidian';
import {
  createMockApp,
  createTestSettings,
  stubEditorText,
} from '../testUtils';
import type FirstLineIsTitle from '../../main';

/**
 * The new-note pipeline holds a note from its create event until the title and the cursor are in place, so a rename pass on a template's half-merged text cannot name it `Untitled` first.
 */
describe('EditorLifecycleManager creation window', () => {
  let app: App;
  let editor: Editor;
  let note: TFile;
  let setThrottleTimer: ReturnType<typeof vi.fn>;
  let processFile: ReturnType<typeof vi.fn>;
  let lifecycle: EditorLifecycleManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    app = createMockApp();
    app.metadataCache.getFileCache = vi.fn().mockReturnValue(null);

    note = new TFile('Untitled.md');
    note.basename = 'Untitled';
    note.extension = 'md';

    editor = new Editor();
    stubEditorText(editor, 'Typed title\n');

    setThrottleTimer = vi.fn();
    processFile = vi.fn().mockResolvedValue(undefined);

    const settings = createTestSettings();
    settings.core.checkInterval = 0;
    settings.core.renameAutomatically = true;
    settings.core.renameOnFocus = true;

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
        hasLastEditorContent: vi.fn().mockReturnValue(true),
        setLastEditorContent: vi.fn(),
      },
      renameEngine: { processFile, processEditorChange: vi.fn() },
    } as unknown as FirstLineIsTitle);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds a note from the pipeline start until its release', () => {
    lifecycle.holdForCreationPipeline(note);
    expect(lifecycle.isFileInCreationWindow(note)).toBe(true);

    lifecycle.releaseFromCreationPipeline(note);
    expect(lifecycle.isFileInCreationWindow(note)).toBe(false);
  });

  it('starts no editor-change pass for a held note, and does once it is released', () => {
    lifecycle.holdForCreationPipeline(note);
    lifecycle.handleEditorChangeWithThrottle(editor, note);
    expect(setThrottleTimer).not.toHaveBeenCalled();

    lifecycle.releaseFromCreationPipeline(note);
    lifecycle.handleEditorChangeWithThrottle(editor, note);
    expect(setThrottleTimer).toHaveBeenCalledTimes(1);
  });

  it('runs no focus rename for a held note, and does once it is released', async () => {
    app.workspace.getActiveFile = vi.fn().mockReturnValue(note);

    lifecycle.holdForCreationPipeline(note);
    await lifecycle.updateActiveEditorTracking();
    expect(processFile).not.toHaveBeenCalled();

    lifecycle.releaseFromCreationPipeline(note);
    await lifecycle.updateActiveEditorTracking();
    expect(processFile).toHaveBeenCalledWith(note, { hasActiveEditor: true });
  });

  // Templater can rename or move a note during its wait, so the hold follows the note rather than its path
  it('keeps holding a note renamed during the pipeline', () => {
    lifecycle.holdForCreationPipeline(note);

    note.path = 'Templated name.md';

    expect(lifecycle.isFileInCreationWindow(note)).toBe(true);
  });

  it('does not hold a note created later at the path a held note had', () => {
    lifecycle.holdForCreationPipeline(note);
    const laterNote = new TFile(note.path);
    laterNote.extension = 'md';

    expect(lifecycle.isFileInCreationWindow(laterNote)).toBe(false);
    lifecycle.handleEditorChangeWithThrottle(editor, laterNote);
    expect(setThrottleTimer).toHaveBeenCalledTimes(1);
  });

  it('still counts a note in its New note delay as in the creation window', () => {
    lifecycle.setCreationDelayTimer(
      note.path,
      window.setTimeout(() => {}, 1)
    );

    expect(lifecycle.isFileInCreationWindow(note)).toBe(true);
  });
});
