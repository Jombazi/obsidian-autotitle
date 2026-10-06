import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventHandlerManager } from '../../src/core/event-handler-manager';
import { MarkdownView, TFile } from '../mockObsidian';
import { TIMING } from '../../src/constants/timing';

const DISABLE_KEY = 'no rename';
const BLOCKING = { [DISABLE_KEY]: true };
const UNCHECKED = { [DISABLE_KEY]: false };

type Frontmatter = Record<string, unknown> | undefined;

/** Event registrars every handler needs, a metadata cache backed by a per-note frontmatter map, and the rename entry point the transition calls. */
function createMockPlugin(openLeaves: unknown[] = []) {
  const cachedFrontmatter = new Map<TFile, Frontmatter>();

  const plugin = {
    app: {
      workspace: {
        on: vi.fn(),
        // Obsidian runs the callback at once when the layout is already ready, as on a plugin reload
        onLayoutReady: vi.fn((callback: () => void) => callback()),
        getLeavesOfType: vi.fn(() => openLeaves),
      },
      vault: { on: vi.fn() },
      metadataCache: {
        on: vi.fn(),
        getFileCache: vi.fn((file: TFile) => ({
          frontmatter: cachedFrontmatter.get(file),
        })),
      },
    },
    settings: {
      core: {
        renameAutomatically: true,
        debug: false,
        enableContextMenus: true,
      },
      aliases: { enableAliases: false },
      exclusions: {
        disableRenamingKey: DISABLE_KEY,
        disableRenamingValue: 'true',
      },
    },
    editorLifecycle: {
      isFileInCreationDelay: vi.fn(() => false),
      handleEditorChangeWithThrottle: vi.fn(),
    },
    cacheManager: { isLocked: vi.fn(() => false) },
    isFullyLoaded: true,
    renameEngine: {
      processFile: vi.fn().mockResolvedValue({ success: true }),
    },
    registerEvent: vi.fn(),
    registerDomEvent: vi.fn(),
  };

  return { plugin, cachedFrontmatter };
}

type MockPlugin = ReturnType<typeof createMockPlugin>['plugin'];

function registeredCallback(
  registrar: { mock: { calls: unknown[][] } },
  eventName: string
): (...args: unknown[]) => void {
  const registration = registrar.mock.calls.find(
    (call) => call[0] === eventName
  );
  if (!registration) throw new Error(`${eventName} handler was not registered`);
  return registration[1] as (...args: unknown[]) => void;
}

/** Registers every handler, then exposes the events the transition depends on. */
function setUp() {
  const { plugin, cachedFrontmatter } = createMockPlugin();
  new EventHandlerManager(plugin as any).registerAllHandlers();

  const editorChange = registeredCallback(
    plugin.app.workspace.on,
    'editor-change'
  );
  // The first `changed` registration is the transition handler; the alias handler comes after it.
  const transition = registeredCallback(plugin.app.metadataCache.on, 'changed');

  return {
    plugin,
    cachedFrontmatter,
    /** Seeds a note the way typing in it does. */
    editInEditor(file: TFile) {
      editorChange({}, { file });
    },
    /** Updates the cache, then fires `changed` the way Obsidian does after a save. */
    cacheChanges(file: TFile, frontmatter: Frontmatter) {
      cachedFrontmatter.set(file, frontmatter);
      transition(file, '', { frontmatter });
    },
  };
}

function processFileOf(plugin: MockPlugin) {
  return plugin.renameEngine.processFile;
}

describe('rename on turning the disable property off', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renames a note seeded by editor-change once the cache turns false', () => {
    const note = new TFile('Fixtures/note.md');
    const { plugin, cachedFrontmatter, editInEditor, cacheChanges } = setUp();
    cachedFrontmatter.set(note, BLOCKING);

    editInEditor(note);
    cacheChanges(note, UNCHECKED);

    expect(processFileOf(plugin)).toHaveBeenCalledTimes(1);
    expect(processFileOf(plugin)).toHaveBeenCalledWith(note, true);
  });

  it('waits out a half-typed value, then renames once the key is removed', () => {
    const note = new TFile('Fixtures/note.md');
    const { plugin, cacheChanges } = setUp();

    cacheChanges(note, BLOCKING);
    cacheChanges(note, { [DISABLE_KEY]: 'tru' });
    expect(processFileOf(plugin)).not.toHaveBeenCalled();

    cacheChanges(note, {});
    expect(processFileOf(plugin)).toHaveBeenCalledTimes(1);
  });

  it('ignores frontmatter changes on a note that never blocked renaming', () => {
    const note = new TFile('Fixtures/note.md');
    const { plugin, editInEditor, cacheChanges } = setUp();

    editInEditor(note);
    cacheChanges(note, { tags: 'a' });
    cacheChanges(note, { tags: 'b', [DISABLE_KEY]: false });

    expect(processFileOf(plugin)).not.toHaveBeenCalled();
  });

  it('does not rename when automatic renaming is off', () => {
    const note = new TFile('Fixtures/note.md');
    const { plugin, cacheChanges } = setUp();
    cacheChanges(note, BLOCKING);
    plugin.settings.core.renameAutomatically = false;

    cacheChanges(note, UNCHECKED);

    expect(processFileOf(plugin)).not.toHaveBeenCalled();
  });

  it('leaves a note in its creation delay to the new-note processing', () => {
    const note = new TFile('Fixtures/note.md');
    const { plugin, cacheChanges } = setUp();
    cacheChanges(note, BLOCKING);
    plugin.editorLifecycle.isFileInCreationDelay.mockReturnValue(true);

    cacheChanges(note, UNCHECKED);

    expect(processFileOf(plugin)).not.toHaveBeenCalled();
  });

  it('retries a locked note and renames it once the lock is released', () => {
    vi.useFakeTimers();
    const note = new TFile('Fixtures/note.md');
    const { plugin, cacheChanges } = setUp();
    cacheChanges(note, BLOCKING);
    plugin.cacheManager.isLocked.mockReturnValueOnce(true);

    cacheChanges(note, UNCHECKED);
    expect(processFileOf(plugin)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(TIMING.UI_SETTLE_DELAY_MS);
    expect(processFileOf(plugin)).toHaveBeenCalledTimes(1);
  });

  it('gives up on a note that stays locked through every retry', () => {
    vi.useFakeTimers();
    const note = new TFile('Fixtures/note.md');
    const { plugin, cacheChanges } = setUp();
    cacheChanges(note, BLOCKING);
    plugin.cacheManager.isLocked.mockReturnValue(true);

    cacheChanges(note, UNCHECKED);
    vi.runAllTimers();

    expect(processFileOf(plugin)).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renames a note that was already open when the layout-ready seed ran', () => {
    const note = new TFile('Fixtures/note.md');
    const view = new MarkdownView();
    view.file = note;
    const { plugin, cachedFrontmatter } = createMockPlugin([{ view }]);
    cachedFrontmatter.set(note, BLOCKING);
    new EventHandlerManager(plugin as any).registerAllHandlers();
    const transition = registeredCallback(
      plugin.app.metadataCache.on,
      'changed'
    );

    cachedFrontmatter.set(note, UNCHECKED);
    transition(note, '', { frontmatter: UNCHECKED });

    expect(processFileOf(plugin)).toHaveBeenCalledTimes(1);
  });
});
