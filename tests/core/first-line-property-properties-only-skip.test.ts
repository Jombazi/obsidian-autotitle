import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getFrontMatterInfo } from 'obsidian';
import { EventHandlerManager } from '../../src/core/event-handler-manager';
import { FileStateManager } from '../../src/core/file-state-manager';
import { MarkdownView, TFile } from '../mockObsidian';
import { splitFrontMatter } from '../testUtils';

const SIX_MINUTES_MS = 6 * 60 * 1000;
const SAVED = '---\naliases: [Hand typed]\n---\nNote title\nBody';
const PROPERTIES_ONLY_EDIT =
  '---\naliases: [Hand typed, Second hand typed]\n---\nNote title\nBody';
const BODY_EDIT = '---\naliases: [Hand typed]\n---\nNote title\nBody edited';

/** Event registrars every handler needs, a real file state manager for the baselines, and the first line property entry point the save handlers call. */
function createMockPlugin() {
  const plugin = {
    app: {
      workspace: {
        on: vi.fn(),
        onLayoutReady: vi.fn((callback: () => void) => callback()),
        getLeavesOfType: vi.fn((): unknown[] => []),
        getActiveViewOfType: vi.fn(() => null),
        iterateAllLeaves: vi.fn(),
      },
      vault: {
        on: vi.fn(),
        read: vi.fn(),
        cachedRead: vi.fn(),
      },
      metadataCache: {
        on: vi.fn(),
        getFileCache: vi.fn(() => ({ frontmatter: {} })),
      },
    },
    settings: {
      core: {
        renameAutomatically: true,
        debug: false,
        enableContextMenus: true,
        contentReadMethod: 'Editor',
      },
      firstLineProperty: { propertyKey: 'aliases' },
      exclusions: {
        disableRenamingKey: 'no rename',
        disableRenamingValue: 'true',
      },
    },
    editorLifecycle: {
      isFileInCreationDelay: vi.fn(() => false),
      handleEditorChangeWithThrottle: vi.fn(),
    },
    cacheManager: { isLocked: vi.fn(() => false) },
    fileStateManager: new FileStateManager({} as any),
    firstLinePropertyManager: {
      updateFirstLinePropertyIfNeeded: vi.fn().mockResolvedValue(true),
    },
    pendingMetadataUpdates: new Set<TFile>(),
    isFullyLoaded: true,
    renameEngine: { processFile: vi.fn() },
    registerEvent: vi.fn(),
    registerDomEvent: vi.fn(),
  };
  return plugin;
}

type MockPlugin = ReturnType<typeof createMockPlugin>;

/** A Live Preview or Source view of the note whose editor holds `text` */
function createSourceView(file: TFile, text: string, dirty: boolean) {
  const view = Object.assign(new MarkdownView(), {
    file,
    dirty,
    getMode: () => 'source',
    requestSave: vi.fn(),
  });
  view.editor = { getValue: () => text } as any;
  return view;
}
type Callback = (...args: unknown[]) => unknown;

function registeredCallbacks(
  registrar: { mock: { calls: unknown[][] } },
  eventName: string
): Callback[] {
  return registrar.mock.calls
    .filter((call) => call[0] === eventName)
    .map((call) => call[1] as Callback);
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('first line property update on a properties-only save', () => {
  let plugin: MockPlugin;
  let note: TFile;
  let modify: Callback;
  let metadataChanged: Callback;
  let editorChange: Callback;
  let fileOpen: Callback;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getFrontMatterInfo).mockImplementation(
      splitFrontMatter as unknown as typeof getFrontMatterInfo
    );

    plugin = createMockPlugin();
    note = new TFile('Fixtures/Note title.md');
    new EventHandlerManager(plugin as any).registerAllHandlers();

    [modify] = registeredCallbacks(plugin.app.vault.on, 'modify');
    // The first `changed` registration is the disable-property transition handler.
    metadataChanged = registeredCallbacks(
      plugin.app.metadataCache.on,
      'changed'
    )[1];
    [editorChange] = registeredCallbacks(
      plugin.app.workspace.on,
      'editor-change'
    );
    [fileOpen] = registeredCallbacks(plugin.app.workspace.on, 'file-open');
  });

  afterEach(() => {
    vi.mocked(getFrontMatterInfo).mockReset();
    vi.useRealTimers();
  });

  const savedTimestamp = () =>
    plugin.fileStateManager.getState(note.path)?.lastSavedContentTimestamp;

  describe.each([
    ['modify', () => modify],
    ['metadata changed', () => metadataChanged],
  ])('%s handler', (_name, handler) => {
    beforeEach(() => {
      plugin.app.workspace.getLeavesOfType.mockReturnValue([
        { view: { file: note } },
      ]);
    });

    it('skips the first line property when only the properties changed since the baseline', async () => {
      plugin.fileStateManager.setLastSavedContent(note.path, SAVED);
      plugin.app.vault.read.mockResolvedValue(PROPERTIES_ONLY_EDIT);

      await handler()(note);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).not.toHaveBeenCalled();
      expect(plugin.fileStateManager.getLastSavedContent(note.path)).toBe(
        PROPERTIES_ONLY_EDIT
      );
    });

    it('skips the first line property even when the baseline is six minutes old', async () => {
      plugin.fileStateManager.setLastSavedContent(note.path, SAVED);
      vi.advanceTimersByTime(SIX_MINUTES_MS);
      plugin.app.vault.read.mockResolvedValue(PROPERTIES_ONLY_EDIT);

      await handler()(note);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).not.toHaveBeenCalled();
    });

    it('updates the first line property when the body changed', async () => {
      plugin.fileStateManager.setLastSavedContent(note.path, SAVED);
      plugin.app.vault.read.mockResolvedValue(BODY_EDIT);

      await handler()(note);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).toHaveBeenCalledTimes(1);
      expect(plugin.fileStateManager.getLastSavedContent(note.path)).toBe(
        BODY_EDIT
      );
    });

    it('updates the first line property when there is no baseline', async () => {
      plugin.app.vault.read.mockResolvedValue(PROPERTIES_ONLY_EDIT);

      await handler()(note);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).toHaveBeenCalledTimes(1);
    });

    it('leaves the first line property to the rename path while the editor holds unsaved typing', async () => {
      const view = createSourceView(note, BODY_EDIT, true);
      plugin.app.workspace.getLeavesOfType.mockReturnValue([{ view }]);
      plugin.fileStateManager.setLastSavedContent(note.path, SAVED);
      plugin.app.vault.read.mockResolvedValue(BODY_EDIT);

      await handler()(note);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).not.toHaveBeenCalled();
      expect(plugin.fileStateManager.getLastSavedContent(note.path)).toBe(
        BODY_EDIT
      );
    });

    // A tab, card or preview saves 2 s after its first unsaved keystroke, while a linked note's rename can still be waiting.
    it('leaves the first line property to the rename path while a rename is scheduled', async () => {
      const view = createSourceView(note, BODY_EDIT, false);
      plugin.app.workspace.getLeavesOfType.mockReturnValue([{ view }]);
      plugin.fileStateManager.setLastSavedContent(note.path, SAVED);
      plugin.fileStateManager.setThrottleTimer(note.path, 1);
      plugin.app.vault.read.mockResolvedValue(BODY_EDIT);

      await handler()(note);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).not.toHaveBeenCalled();
      expect(plugin.fileStateManager.getLastSavedContent(note.path)).toBe(
        BODY_EDIT
      );
    });

    it('writes into the editor when it holds the text just read from the file', async () => {
      const view = createSourceView(note, BODY_EDIT, false);
      plugin.app.workspace.getLeavesOfType.mockReturnValue([{ view }]);
      plugin.app.vault.read.mockResolvedValue(BODY_EDIT);

      await handler()(note);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).toHaveBeenCalledWith(
        note,
        BODY_EDIT,
        undefined,
        expect.objectContaining({ editor: view.editor })
      );
    });

    it('writes the file when the editor has not loaded the file text yet', async () => {
      const view = createSourceView(note, SAVED, false);
      plugin.app.workspace.getLeavesOfType.mockReturnValue([{ view }]);
      plugin.app.vault.read.mockResolvedValue(BODY_EDIT);

      await handler()(note);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).toHaveBeenCalledWith(note, BODY_EDIT, undefined, null);
    });
  });

  describe.each([
    ['modify', () => modify],
    ['metadata changed', () => metadataChanged],
  ])('%s handler on a note not open in an editor', (_name, handler) => {
    const editNoteInEditor = async () => {
      plugin.app.vault.cachedRead.mockResolvedValue(SAVED);
      editorChange({}, { file: note });
      await flushPromises();
    };

    beforeEach(() => {
      plugin.app.vault.read.mockResolvedValue(BODY_EDIT);
    });

    it('leaves the first line property alone and drops the baseline when the note was never edited', async () => {
      plugin.fileStateManager.setLastSavedContent(note.path, SAVED);

      await handler()(note);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).not.toHaveBeenCalled();
      expect(
        plugin.fileStateManager.getLastSavedContent(note.path)
      ).toBeUndefined();
    });

    it('updates the first line property when the note is open in an editor', async () => {
      plugin.app.workspace.getLeavesOfType.mockReturnValue([
        { view: { file: note } },
      ]);

      await handler()(note);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).toHaveBeenCalledTimes(1);
    });

    it('updates the first line property when the note was edited 1 s earlier', async () => {
      await editNoteInEditor();
      vi.advanceTimersByTime(1000);

      await handler()(note);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).toHaveBeenCalledTimes(1);
    });

    it('leaves the first line property alone and drops the baseline when the note was edited 6 s earlier', async () => {
      await editNoteInEditor();
      vi.advanceTimersByTime(6000);

      await handler()(note);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).not.toHaveBeenCalled();
      expect(
        plugin.fileStateManager.getLastSavedContent(note.path)
      ).toBeUndefined();
    });
  });

  // A card deselect or an autosave during a linked note's delay would otherwise rename it at once.
  describe('modify handler in Cache read mode', () => {
    beforeEach(() => {
      plugin.settings.core.contentReadMethod = 'Cache';
      plugin.app.vault.read.mockResolvedValue(BODY_EDIT);
    });

    it('leaves the rename to a scheduled timer', async () => {
      plugin.fileStateManager.setThrottleTimer(note.path, 1);

      await modify(note);

      expect(plugin.renameEngine.processFile).not.toHaveBeenCalled();
    });

    it('renames on save when no timer is scheduled', async () => {
      await modify(note);

      expect(plugin.renameEngine.processFile).toHaveBeenCalledWith(note, true);
    });
  });

  describe.each([
    ['editor-change', () => editorChange({}, { file: note })],
    ['file-open', () => fileOpen(note)],
  ])('%s baseline seeding', (_name, fireEvent) => {
    it('seeds the baseline from disk once', async () => {
      plugin.app.vault.cachedRead.mockResolvedValue(SAVED);

      fireEvent();
      await flushPromises();
      fireEvent();
      await flushPromises();

      expect(plugin.app.vault.cachedRead).toHaveBeenCalledTimes(1);
      expect(plugin.fileStateManager.getLastSavedContent(note.path)).toBe(
        SAVED
      );
    });

    it('never overwrites an existing baseline', async () => {
      plugin.fileStateManager.setLastSavedContent(note.path, SAVED);
      plugin.app.vault.cachedRead.mockResolvedValue(PROPERTIES_ONLY_EDIT);

      fireEvent();
      await flushPromises();

      expect(plugin.app.vault.cachedRead).not.toHaveBeenCalled();
      expect(plugin.fileStateManager.getLastSavedContent(note.path)).toBe(
        SAVED
      );
    });

    it('keeps a baseline a save stored while the disk read was in flight', async () => {
      let resolveRead: (content: string) => void = () => {};
      plugin.app.vault.cachedRead.mockReturnValue(
        new Promise<string>((resolve) => (resolveRead = resolve))
      );

      fireEvent();
      plugin.fileStateManager.setLastSavedContent(note.path, BODY_EDIT);
      resolveRead(SAVED);
      await flushPromises();

      expect(plugin.fileStateManager.getLastSavedContent(note.path)).toBe(
        BODY_EDIT
      );
    });

    it('gives an existing baseline a fresh timestamp', () => {
      plugin.fileStateManager.setLastSavedContent(note.path, SAVED);
      const storedAt = savedTimestamp();
      vi.advanceTimersByTime(SIX_MINUTES_MS);

      fireEvent();

      expect(savedTimestamp()).toBe((storedAt ?? 0) + SIX_MINUTES_MS);
      expect(plugin.fileStateManager.getLastSavedContent(note.path)).toBe(
        SAVED
      );
    });
  });
});
