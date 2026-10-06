import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getFrontMatterInfo } from 'obsidian';
import { EventHandlerManager } from '../../src/core/event-handler-manager';
import { FileStateManager } from '../../src/core/file-state-manager';
import { TFile } from '../mockObsidian';
import { splitFrontMatter } from '../testUtils';

const SIX_MINUTES_MS = 6 * 60 * 1000;
const SAVED = '---\naliases: [Hand typed]\n---\nNote title\nBody';
const PROPERTIES_ONLY_EDIT =
  '---\naliases: [Hand typed, Second hand typed]\n---\nNote title\nBody';
const BODY_EDIT = '---\naliases: [Hand typed]\n---\nNote title\nBody edited';

/** Event registrars every handler needs, a real file state manager for the baselines, and the alias entry point the save handlers call. */
function createMockPlugin() {
  const plugin = {
    app: {
      workspace: {
        on: vi.fn(),
        onLayoutReady: vi.fn((callback: () => void) => callback()),
        getLeavesOfType: vi.fn(() => []),
        getActiveViewOfType: vi.fn(() => null),
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
      aliases: { enableAliases: true },
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
    aliasManager: { updateAliasIfNeeded: vi.fn().mockResolvedValue(true) },
    pendingMetadataUpdates: new Set<TFile>(),
    isFullyLoaded: true,
    renameEngine: { processFile: vi.fn() },
    registerEvent: vi.fn(),
    registerDomEvent: vi.fn(),
  };
  return plugin;
}

type MockPlugin = ReturnType<typeof createMockPlugin>;
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

describe('alias update on a properties-only save', () => {
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
    it('skips the alias when only the properties changed since the baseline', async () => {
      plugin.fileStateManager.setLastSavedContent(note.path, SAVED);
      plugin.app.vault.read.mockResolvedValue(PROPERTIES_ONLY_EDIT);

      await handler()(note);

      expect(plugin.aliasManager.updateAliasIfNeeded).not.toHaveBeenCalled();
      expect(plugin.fileStateManager.getLastSavedContent(note.path)).toBe(
        PROPERTIES_ONLY_EDIT
      );
    });

    it('skips the alias even when the baseline is six minutes old', async () => {
      plugin.fileStateManager.setLastSavedContent(note.path, SAVED);
      vi.advanceTimersByTime(SIX_MINUTES_MS);
      plugin.app.vault.read.mockResolvedValue(PROPERTIES_ONLY_EDIT);

      await handler()(note);

      expect(plugin.aliasManager.updateAliasIfNeeded).not.toHaveBeenCalled();
    });

    it('updates the alias when the body changed', async () => {
      plugin.fileStateManager.setLastSavedContent(note.path, SAVED);
      plugin.app.vault.read.mockResolvedValue(BODY_EDIT);

      await handler()(note);

      expect(plugin.aliasManager.updateAliasIfNeeded).toHaveBeenCalledTimes(1);
      expect(plugin.fileStateManager.getLastSavedContent(note.path)).toBe(
        BODY_EDIT
      );
    });

    it('updates the alias when there is no baseline', async () => {
      plugin.app.vault.read.mockResolvedValue(PROPERTIES_ONLY_EDIT);

      await handler()(note);

      expect(plugin.aliasManager.updateAliasIfNeeded).toHaveBeenCalledTimes(1);
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
