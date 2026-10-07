import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorLifecycleManager } from '../../src/core/editor-lifecycle';
import { FileStateManager } from '../../src/core/file-state-manager';
import { RenameEngine } from '../../src/core/rename-engine';
import { isLinkedFromAnyFile } from '../../src/utils/inbound-links';
import { TIMING } from '../../src/constants/timing';
import { App, Editor, MarkdownView, TFile } from '../mockObsidian';
import { createMockApp, createTestSettings } from '../testUtils';
import type FirstLineIsTitle from '../../main';

vi.mock('../../src/utils/inbound-links', () => ({
  isLinkedFromAnyFile: vi.fn(),
}));

const linkedFromAnyFile = vi.mocked(isLinkedFromAnyFile);

/**
 * Each rename of a linked note raises Obsidian's link-update notices, so a linked note waits for typing to pause. A real file state manager carries the delayed-timer flag the handler reads.
 */
describe('EditorLifecycleManager linked-note delay', () => {
  let app: App;
  let editor: Editor;
  let file: TFile;
  let fileStateManager: FileStateManager;
  let processEditorChangeOptimal: ReturnType<typeof vi.fn>;
  let lifecycle: EditorLifecycleManager;
  let firstLineNumber: number;

  function createLifecycle(checkInterval: number): void {
    const settings = createTestSettings();
    settings.core.checkInterval = checkInterval;
    lifecycle = new EditorLifecycleManager({
      app,
      settings,
      isFullyLoaded: true,
      fileStateManager,
      renameEngine: { processEditorChangeOptimal },
    } as unknown as FirstLineIsTitle);
  }

  /** One edit that changes the first line */
  function typeFirstLine(
    options?: Parameters<
      EditorLifecycleManager['handleEditorChangeWithThrottle']
    >[2]
  ): void {
    firstLineNumber++;
    editor.getValue = vi.fn().mockReturnValue(`Title ${firstLineNumber}\nBody`);
    lifecycle.handleEditorChangeWithThrottle(editor, file, options);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    linkedFromAnyFile.mockReset();
    linkedFromAnyFile.mockReturnValue(false);

    app = createMockApp();
    app.metadataCache.getFileCache = vi.fn().mockReturnValue(null);
    file = new TFile('Notes/Linked.md');
    editor = new Editor();
    fileStateManager = new FileStateManager({} as FirstLineIsTitle);
    processEditorChangeOptimal = vi.fn().mockResolvedValue(undefined);
    firstLineNumber = 0;
    createLifecycle(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('processes a linked note once, 2 s after its last first-line edit', async () => {
    linkedFromAnyFile.mockReturnValue(true);

    typeFirstLine();
    await vi.advanceTimersByTimeAsync(500);
    typeFirstLine();
    await vi.advanceTimersByTimeAsync(TIMING.LINKED_NOTE_RENAME_DELAY_MS - 1);

    expect(processEditorChangeOptimal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
    expect(linkedFromAnyFile).toHaveBeenCalledTimes(1);
  });

  it('lets a longer Check interval set the wait', async () => {
    createLifecycle(5000);
    linkedFromAnyFile.mockReturnValue(true);

    typeFirstLine();
    await vi.advanceTimersByTimeAsync(500);
    typeFirstLine();
    await vi.advanceTimersByTimeAsync(4999);

    expect(processEditorChangeOptimal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
  });

  it('keeps the throttle timing for a note nothing links to', async () => {
    createLifecycle(1000);

    typeFirstLine();
    await vi.advanceTimersByTimeAsync(500);
    typeFirstLine();
    await vi.advanceTimersByTimeAsync(500);

    expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
    expect(fileStateManager.hasThrottleTimer(file.path)).toBe(false);
  });

  it('does not restart the wait for an edit that leaves the first line unchanged', async () => {
    linkedFromAnyFile.mockReturnValue(true);

    typeFirstLine();
    await vi.advanceTimersByTimeAsync(1500);
    lifecycle.handleEditorChangeWithThrottle(editor, file);
    await vi.advanceTimersByTimeAsync(500);

    expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
  });

  it('delays a note edited in a Canvas card even when no link to it is indexed yet', async () => {
    typeFirstLine({ inCanvasCard: true });
    await vi.advanceTimersByTimeAsync(TIMING.LINKED_NOTE_RENAME_DELAY_MS - 1);

    expect(processEditorChangeOptimal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
  });

  it('keeps a note seen linked within the memory window delayed after it reads as unlinked', async () => {
    linkedFromAnyFile.mockReturnValueOnce(true);

    typeFirstLine();
    await vi.advanceTimersByTimeAsync(TIMING.LINKED_NOTE_RENAME_DELAY_MS);
    await vi.advanceTimersByTimeAsync(1000);
    typeFirstLine();
    await vi.advanceTimersByTimeAsync(TIMING.LINKED_NOTE_RENAME_DELAY_MS - 1);

    expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(processEditorChangeOptimal).toHaveBeenCalledTimes(2);
  });

  it('returns to the throttle timing once the memory window has passed', async () => {
    linkedFromAnyFile.mockReturnValueOnce(true);

    typeFirstLine();
    await vi.advanceTimersByTimeAsync(TIMING.LINKED_NOTE_RENAME_DELAY_MS);
    await vi.advanceTimersByTimeAsync(TIMING.LINKED_NOTE_MEMORY_MS);
    typeFirstLine();
    await vi.advanceTimersByTimeAsync(0);

    expect(processEditorChangeOptimal).toHaveBeenCalledTimes(2);
  });

  // The memory window runs from the timer firing, so a burst longer than the window cannot let the next one rename per keystroke.
  it('keeps a note delayed right after a burst longer than the memory window', async () => {
    linkedFromAnyFile.mockReturnValueOnce(true);

    typeFirstLine();
    for (let elapsed = 0; elapsed < 4000; elapsed += 500) {
      await vi.advanceTimersByTimeAsync(500);
      typeFirstLine();
    }
    await vi.advanceTimersByTimeAsync(TIMING.LINKED_NOTE_RENAME_DELAY_MS);

    expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300);
    typeFirstLine();
    await vi.advanceTimersByTimeAsync(100);

    expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
    expect(fileStateManager.hasDelayedThrottleTimer(file.path)).toBe(true);
  });

  describe('page preview closed before its save', () => {
    /** A preview embed, which is not a MarkdownView */
    function createPreview(dirty: boolean) {
      return { file, editor: editor as Editor | undefined, dirty };
    }

    it('waits for the save instead of processing', async () => {
      const preview = createPreview(true);
      linkedFromAnyFile.mockReturnValue(true);
      typeFirstLine({ owner: preview as any });
      preview.editor = undefined;

      await vi.advanceTimersByTimeAsync(TIMING.LINKED_NOTE_RENAME_DELAY_MS);

      expect(processEditorChangeOptimal).not.toHaveBeenCalled();
      expect(fileStateManager.hasDelayedThrottleTimer(file.path)).toBe(true);

      preview.dirty = false;
      await vi.advanceTimersByTimeAsync(TIMING.SAVE_COMPLETE_DELAY_MS);

      expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
      expect(processEditorChangeOptimal).toHaveBeenCalledWith(
        editor,
        file,
        preview
      );
    });

    it('processes at once when the preview has saved', async () => {
      const preview = createPreview(false);
      linkedFromAnyFile.mockReturnValue(true);
      typeFirstLine({ owner: preview as any });
      preview.editor = undefined;

      await vi.advanceTimersByTimeAsync(TIMING.LINKED_NOTE_RENAME_DELAY_MS);

      expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
    });

    it('processes anyway after 25 re-arms', async () => {
      const preview = createPreview(true);
      linkedFromAnyFile.mockReturnValue(true);
      typeFirstLine({ owner: preview as any });
      preview.editor = undefined;

      await vi.advanceTimersByTimeAsync(
        TIMING.LINKED_NOTE_RENAME_DELAY_MS + 24 * TIMING.SAVE_COMPLETE_DELAY_MS
      );

      expect(processEditorChangeOptimal).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(TIMING.SAVE_COMPLETE_DELAY_MS);

      expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
    });

    it('never waits on a tab, which saves when it switches notes', async () => {
      const view = Object.assign(new MarkdownView(app), {
        file,
        dirty: true,
      });
      linkedFromAnyFile.mockReturnValue(true);
      typeFirstLine({ owner: view });
      view.editor = new Editor();

      await vi.advanceTimersByTimeAsync(TIMING.LINKED_NOTE_RENAME_DELAY_MS);

      expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the delay across a rename, and restarts it for an edit under the new path', async () => {
    linkedFromAnyFile.mockReturnValue(true);
    const oldPath = file.path;

    typeFirstLine();
    await vi.advanceTimersByTimeAsync(1000);
    file.path = 'Notes/Renamed.md';
    fileStateManager.notifyFileRenamed(oldPath, file.path);
    lifecycle.notifyFileRenamed(oldPath, file.path);

    expect(fileStateManager.hasDelayedThrottleTimer(file.path)).toBe(true);

    typeFirstLine();
    await vi.advanceTimersByTimeAsync(TIMING.LINKED_NOTE_RENAME_DELAY_MS - 1);

    expect(processEditorChangeOptimal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
    expect(linkedFromAnyFile).toHaveBeenCalledTimes(1);
  });

  // A Canvas card can save before the timer fires, after which the editor and the file match and the edit would look like none.
  describe('baseline from before the edit', () => {
    it('seeds the compared content from the file at the first edit', async () => {
      vi.mocked(app.vault.cachedRead).mockResolvedValue('Before\nBody');

      typeFirstLine({ inCanvasCard: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(fileStateManager.getLastEditorContent(file.path)).toBe(
        'Before\nBody'
      );
    });

    it('keeps an existing baseline', async () => {
      fileStateManager.setLastEditorContent(file.path, 'Processed\nBody');
      vi.mocked(app.vault.cachedRead).mockResolvedValue('Before\nBody');

      typeFirstLine({ inCanvasCard: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(app.vault.cachedRead).not.toHaveBeenCalled();
      expect(fileStateManager.getLastEditorContent(file.path)).toBe(
        'Processed\nBody'
      );
    });

    it('keeps the baseline while a timer waits and the first line is unchanged', async () => {
      linkedFromAnyFile.mockReturnValue(true);
      vi.mocked(app.vault.cachedRead).mockResolvedValue('Before\nBody');

      typeFirstLine();
      await vi.advanceTimersByTimeAsync(0);
      editor.getValue = vi.fn().mockReturnValue('Title 1\nBody edited');
      lifecycle.handleEditorChangeWithThrottle(editor, file);

      expect(fileStateManager.hasThrottleTimer(file.path)).toBe(true);
      expect(fileStateManager.getLastEditorContent(file.path)).toBe(
        'Before\nBody'
      );
    });

    it('updates the baseline for an unchanged first line once no timer waits', async () => {
      vi.mocked(app.vault.cachedRead).mockResolvedValue('Before\nBody');

      typeFirstLine();
      await vi.advanceTimersByTimeAsync(0);
      editor.getValue = vi.fn().mockReturnValue('Title 1\nBody edited');
      lifecycle.handleEditorChangeWithThrottle(editor, file);

      expect(fileStateManager.hasThrottleTimer(file.path)).toBe(false);
      expect(fileStateManager.getLastEditorContent(file.path)).toBe(
        'Title 1\nBody edited'
      );
    });

    // A Canvas card fires editor-change twice per keystroke, the second about 2 ms later with identical text.
    it("renames a Canvas card's note when each edit is followed by an identical repeat", async () => {
      const plugin = (lifecycle as unknown as { plugin: FirstLineIsTitle })
        .plugin;
      const renameEngine = new RenameEngine(plugin);
      const processFile = vi
        .spyOn(renameEngine, 'processFile')
        .mockResolvedValue({ success: true, reason: 'renamed' });
      plugin.renameEngine = renameEngine;
      vi.mocked(app.vault.cachedRead).mockResolvedValue('Before\nBody');

      typeFirstLine({ inCanvasCard: true });
      await vi.advanceTimersByTimeAsync(2);
      lifecycle.handleEditorChangeWithThrottle(editor, file, {
        inCanvasCard: true,
      });
      await vi.advanceTimersByTimeAsync(TIMING.LINKED_NOTE_RENAME_DELAY_MS);

      expect(processFile).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps a Canvas card's pending rename through a layout change, since no Markdown leaf lists a card", async () => {
    const processFile = vi.fn().mockResolvedValue(undefined);
    (
      lifecycle as unknown as {
        plugin: { renameEngine: Record<string, unknown> };
      }
    ).plugin.renameEngine.processFile = processFile;
    (
      lifecycle as unknown as { plugin: { isFullyLoaded: boolean } }
    ).plugin.isFullyLoaded = true;
    app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);

    typeFirstLine({ inCanvasCard: true });
    await vi.advanceTimersByTimeAsync(300);
    await lifecycle.updateActiveEditorTracking();

    expect(processFile).not.toHaveBeenCalled();
    expect(fileStateManager.hasThrottleTimer(file.path)).toBe(true);

    await vi.advanceTimersByTimeAsync(TIMING.LINKED_NOTE_RENAME_DELAY_MS);

    expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
  });
});
