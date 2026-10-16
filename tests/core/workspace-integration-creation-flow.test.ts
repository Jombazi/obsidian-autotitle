import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App, TFile } from '../mockObsidian';
import { createTestSettings } from '../testUtils';
import { TIMING } from '../../src/constants/timing';
import { FileStateManager } from '../../src/core/file-state-manager';
import { EditorLifecycleManager } from '../../src/core/editor-lifecycle';

const { determineActions } = vi.hoisted(() => ({
  determineActions: vi.fn(),
}));

vi.mock('monkey-around', () => ({
  around: vi.fn(() => vi.fn()),
}));

vi.mock('../../src/i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../../src/utils', () => ({
  verboseLog: vi.fn(),
}));

// In vitest v4 a constructable class mock needs a regular function, not an arrow
vi.mock('../../src/core/file-creation-coordinator', () => ({
  FileCreationCoordinator: vi.fn().mockImplementation(function () {
    return { determineActions };
  }),
}));

/**
 * Drives the vault 'create' handler the way Obsidian does, so the tests below assert on the
 * creation flow's real sequencing rather than on the handler in isolation.
 */
describe('WorkspaceIntegration creation flow', () => {
  let mockApp: App;
  let mockPlugin: Record<string, unknown>;
  let file: TFile;
  let createHandler: ((file: TFile) => Promise<void>) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    file = new TFile('Notes/My Title.md');
    file.basename = 'My Title';
    file.extension = 'md';

    mockApp = new App();
    createHandler = undefined;
    mockApp.vault.on = vi.fn((event: string, cb: unknown) => {
      if (event === 'create') {
        createHandler = cb as (file: TFile) => Promise<void>;
      }
      return {};
    }) as unknown as typeof mockApp.vault.on;
    mockApp.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);

    const settings = createTestSettings();
    settings.core.newNoteDelay = 0;
    settings.core.renameAutomatically = true;

    mockPlugin = {
      app: mockApp,
      settings,
      isFullyLoaded: true,
      pluginLoadTime: Date.now() - 10000,
      fileStateManager: {
        wasRecentlyRenamedInto: vi.fn().mockReturnValue(false),
      },
      eventHandlerManager: {
        hasBeenShownInEditor: vi.fn().mockReturnValue(false),
      },
      registerEvent: vi.fn(),
      addRibbonIcon: vi.fn(),
      renameEngine: { processFile: vi.fn().mockResolvedValue(undefined) },
      fileOperations: {
        insertTitle: vi
          .fn()
          .mockResolvedValue({ inserted: true, cursorPositioned: false }),
        handleCursorPositioning: vi.fn().mockResolvedValue(undefined),
        resolveMarkdownViewForFile: vi.fn().mockReturnValue(null),
        addLineAfterEndingFence: vi.fn().mockResolvedValue(undefined),
      },
    };
    // The real manager, so the creation window the pipeline holds is the one every rename pass consults
    mockPlugin.editorLifecycle = new EditorLifecycleManager(
      mockPlugin as unknown as ConstructorParameters<
        typeof EditorLifecycleManager
      >[0]
    );

    decide();

    const { WorkspaceIntegration } =
      await import('../../src/core/workspace-integration');
    const integration = new WorkspaceIntegration(
      mockPlugin as unknown as ConstructorParameters<
        typeof WorkspaceIntegration
      >[0]
    );
    (mockPlugin as { workspaceIntegration?: unknown }).workspaceIntegration =
      integration;
    integration.setupNewNotePipeline();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Makes the coordinator settle on inserting the title and placing the cursor at the end of its line, judging the text it is handed, unless `overrides` say otherwise
   */
  function decide(overrides: Record<string, unknown> = {}) {
    determineActions.mockImplementation(
      async (_file: TFile, context: { initialContent: string }) => ({
        shouldInsertTitle: true,
        shouldMoveCursor: true,
        placeCursorAtEnd: true,
        titleCursor: 'line-end',
        judgedContent: context.initialContent,
        viewLagsFile: false,
        ...overrides,
      })
    );
  }

  /**
   * Fires the create handler and lets it run to the end: it waits up to `NEW_NOTE_VIEW_WAIT_MS` for a view to show the note, so awaiting it before advancing the fake clock would never settle.
   */
  async function runCreate() {
    expect(createHandler).toBeDefined();
    const handled = createHandler!(file);
    await vi.advanceTimersByTimeAsync(TIMING.NEW_NOTE_VIEW_WAIT_MS + 10);
    await handled;
    await vi.advanceTimersByTimeAsync(
      TIMING.RAF_CURSOR_POSITIONING_DELAY_MS + 10
    );
  }

  const fileOperations = () =>
    mockPlugin.fileOperations as {
      insertTitle: ReturnType<typeof vi.fn>;
      handleCursorPositioning: ReturnType<typeof vi.fn>;
      resolveMarkdownViewForFile: ReturnType<typeof vi.fn>;
      addLineAfterEndingFence: ReturnType<typeof vi.fn>;
    };

  const processFile = () =>
    (mockPlugin.renameEngine as { processFile: ReturnType<typeof vi.fn> })
      .processFile;

  /** Workspace events the creation wait listens to, captured as Obsidian would deliver them */
  function captureWorkspaceEvents(): Record<
    string,
    (...args: unknown[]) => void
  > {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    mockApp.workspace.on = vi.fn(
      (name: string, callback: (...args: unknown[]) => void) => {
        handlers[name] = callback;
        return { name };
      }
    ) as unknown as typeof mockApp.workspace.on;
    return handlers;
  }

  /**
   * Asserts that each workspace listener the waits registered was removed, in the order registered
   * @param registeredCount - Listeners the waits are expected to have registered
   */
  function expectEveryListenerRemoved(registeredCount: number) {
    const registered = vi
      .mocked(mockApp.workspace.on)
      .mock.results.map((result) => result.value);
    expect(registered).toHaveLength(registeredCount);
    expect(
      vi.mocked(mockApp.workspace.offref).mock.calls.map(([ref]) => ref)
    ).toEqual(registered);
  }

  /**
   * Opens the note in a Markdown view `delayMs` after creation, the way Obsidian's own creators open a note only after creating it, and announces it with `file-open`.
   * @returns The view that comes to show the note
   */
  function openViewAfter(delayMs: number, text = '') {
    const handlers = captureWorkspaceEvents();
    const view = { file, getViewData: vi.fn(() => text) };
    window.setTimeout(() => {
      fileOperations().resolveMarkdownViewForFile.mockReturnValue(view);
      handlers['file-open']?.(file);
    }, delayMs);
    return view;
  }

  describe('note shown in a view after creation', () => {
    it('passes the resolved view through to title insertion', async () => {
      const view = openViewAfter(20, '# ');

      await runCreate();

      expect(fileOperations().insertTitle).toHaveBeenCalledWith(
        file,
        '# ',
        'line-end',
        view
      );
    });

    it('lets the coordinator judge the text the view holds', async () => {
      openViewAfter(20, '---\ntags: draft\n---\n');

      await runCreate();

      expect(determineActions).toHaveBeenCalledWith(
        file,
        expect.objectContaining({ initialContent: '---\ntags: draft\n---\n' })
      );
    });

    // After a Templater wait the coordinator judges the note as the template left it, which the creation snapshot predates
    it('inserts the title into the text the coordinator judged, not the creation snapshot', async () => {
      const view = openViewAfter(20, '');
      decide({ judgedContent: '---\na: b\n---\n' });

      await runCreate();

      expect(fileOperations().insertTitle).toHaveBeenCalledWith(
        file,
        '---\na: b\n---\n',
        'line-end',
        view
      );
    });

    it('leaves a cursor the template placed to title insertion alone, with no delayed pass', async () => {
      const view = openViewAfter(20);
      decide({
        shouldMoveCursor: false,
        placeCursorAtEnd: false,
        titleCursor: 'keep-template-cursor',
      });

      await runCreate();

      expect(fileOperations().insertTitle).toHaveBeenCalledWith(
        file,
        '',
        'keep-template-cursor',
        view
      );
      expect(fileOperations().handleCursorPositioning).not.toHaveBeenCalled();
    });

    it('skips the delayed cursor pass when insertion already settled the cursor', async () => {
      openViewAfter(20);
      fileOperations().insertTitle.mockResolvedValue({
        inserted: true,
        cursorPositioned: true,
      });

      await runCreate();

      expect(fileOperations().handleCursorPositioning).not.toHaveBeenCalled();
    });

    it('still runs the delayed pass when insertion did not settle the cursor', async () => {
      openViewAfter(20);

      await runCreate();

      expect(fileOperations().handleCursorPositioning).toHaveBeenCalledWith(
        file,
        true
      );
    });

    it('keeps the cursor-only path intact when nothing is inserted', async () => {
      openViewAfter(20);
      decide({ shouldInsertTitle: false });

      await runCreate();

      expect(fileOperations().insertTitle).not.toHaveBeenCalled();
      expect(fileOperations().handleCursorPositioning).toHaveBeenCalledWith(
        file,
        true
      );
    });

    it('renames it as a note shown in an editor', async () => {
      openViewAfter(20);

      await runCreate();

      expect(processFile()).toHaveBeenCalledTimes(1);
      expect(processFile().mock.calls[0][1].hasActiveEditor).toBe(true);
    });

    // `layout-change` is a 10 ms debounce any unrelated tab change also queues.
    it('keeps waiting through a layout change that comes before the view', async () => {
      const handlers = captureWorkspaceEvents();
      const view = { file, getViewData: vi.fn(() => '') };
      window.setTimeout(() => handlers['layout-change']?.(), 5);
      window.setTimeout(() => {
        fileOperations().resolveMarkdownViewForFile.mockReturnValue(view);
        handlers['layout-change']?.();
      }, 40);

      await runCreate();

      expect(fileOperations().insertTitle).toHaveBeenCalledWith(
        file,
        '',
        'line-end',
        view
      );
    });

    it('ignores a file-open for another note, matching the note by identity', async () => {
      const handlers = captureWorkspaceEvents();
      const handled = createHandler!(file);
      await vi.advanceTimersByTimeAsync(20);
      const lookupsBefore =
        fileOperations().resolveMarkdownViewForFile.mock.calls.length;

      handlers['file-open']?.(new TFile(file.path));

      expect(fileOperations().resolveMarkdownViewForFile).toHaveBeenCalledTimes(
        lookupsBefore
      );
      await vi.advanceTimersByTimeAsync(TIMING.NEW_NOTE_VIEW_WAIT_MS);
      await handled;
    });
  });

  // Templater wrote the file while the view still shows older text, and only for a note that is not its active file
  describe('view showing older text than the file', () => {
    const TITLED_NOTE = '---\na: b\n---\n# My Title\n';

    /** Text the file holds, which `vault.read` returns */
    let fileText: string;

    beforeEach(() => {
      fileText = TITLED_NOTE;
      vi.mocked(mockApp.vault.read).mockImplementation(async () => fileText);
      decide({ judgedContent: '---\na: b\n---\n', viewLagsFile: true });
    });

    /**
     * Opens a view showing `staleText` 20 ms after creation, as a background tab shows a note before Templater's file write reaches it
     * @returns The view, and `reload`, which makes it show `text` and fires `editor-change` for `forFile` as Obsidian's reload of a view does
     */
    function openLaggingView(staleText = '') {
      const handlers = captureWorkspaceEvents();
      let viewText = staleText;
      const view = { file, getViewData: vi.fn(() => viewText) };
      window.setTimeout(() => {
        fileOperations().resolveMarkdownViewForFile.mockReturnValue(view);
        handlers['file-open']?.(file);
      }, 20);
      const reload = (text: string, forFile: TFile = file) => {
        viewText = text;
        handlers['editor-change']?.({}, { file: forFile });
      };
      return { view, reload };
    }

    /** Runs the create handler past the reload wait too, which starts once the new-note wait has settled */
    async function runCreatePastReloadWait() {
      const handled = createHandler!(file);
      await vi.advanceTimersByTimeAsync(
        TIMING.NEW_NOTE_VIEW_WAIT_MS + TIMING.VIEW_RELOAD_WAIT_MS + 10
      );
      await handled;
    }

    const handleCursorPositioning = () =>
      fileOperations().handleCursorPositioning;

    it('writes the title through the file', async () => {
      openLaggingView(TITLED_NOTE);

      await runCreatePastReloadWait();

      expect(fileOperations().insertTitle).toHaveBeenCalledWith(
        file,
        '---\na: b\n---\n',
        'none',
        null,
        true
      );
    });

    it('places the cursor at once when the view already shows the file’s text', async () => {
      const { view } = openLaggingView(TITLED_NOTE);
      const handled = createHandler!(file);

      await vi.advanceTimersByTimeAsync(30);

      expect(handleCursorPositioning()).toHaveBeenCalledWith(file, true, view);
      await vi.advanceTimersByTimeAsync(TIMING.VIEW_RELOAD_WAIT_MS);
      await handled;
      expectEveryListenerRemoved(6);
    });

    it('places the cursor once an editor-change shows the view holding the file’s text', async () => {
      const { view, reload } = openLaggingView();
      window.setTimeout(() => reload(TITLED_NOTE), 60);
      const handled = createHandler!(file);

      await vi.advanceTimersByTimeAsync(50);
      expect(handleCursorPositioning()).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);

      expect(handleCursorPositioning()).toHaveBeenCalledWith(file, true, view);
      await vi.advanceTimersByTimeAsync(TIMING.VIEW_RELOAD_WAIT_MS);
      await handled;
      expectEveryListenerRemoved(6);
    });

    it('keeps waiting through an editor-change while the view still shows older text', async () => {
      const { view, reload } = openLaggingView();
      window.setTimeout(() => reload('---\na: b\n---\n'), 40);
      window.setTimeout(() => reload(TITLED_NOTE), 80);
      const handled = createHandler!(file);

      await vi.advanceTimersByTimeAsync(60);
      expect(handleCursorPositioning()).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30);

      expect(handleCursorPositioning()).toHaveBeenCalledWith(file, true, view);
      await vi.advanceTimersByTimeAsync(TIMING.VIEW_RELOAD_WAIT_MS);
      await handled;
    });

    it('ignores another note’s editor-change and takes one last look at the deadline', async () => {
      const { view, reload } = openLaggingView();
      window.setTimeout(() => reload(TITLED_NOTE, new TFile(file.path)), 40);
      const handled = createHandler!(file);

      // The reload wait starts at 20 ms, so its deadline falls at 520 ms
      await vi.advanceTimersByTimeAsync(TIMING.VIEW_RELOAD_WAIT_MS);
      expect(handleCursorPositioning()).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(TIMING.NEW_NOTE_VIEW_WAIT_MS);
      await handled;

      expect(handleCursorPositioning()).toHaveBeenCalledWith(file, true, view);
    });

    // A view reports CRLF text with LF line breaks while `vault.read` returns the bytes
    it('places the cursor when the file has CRLF line breaks and the view LF', async () => {
      fileText = TITLED_NOTE.replace(/\n/g, '\r\n');
      const { view } = openLaggingView(TITLED_NOTE);
      const handled = createHandler!(file);

      await vi.advanceTimersByTimeAsync(30);

      expect(handleCursorPositioning()).toHaveBeenCalledWith(file, true, view);
      await vi.advanceTimersByTimeAsync(TIMING.VIEW_RELOAD_WAIT_MS);
      await handled;
    });

    it('skips the cursor when no view shows the file’s text by the deadline', async () => {
      openLaggingView();

      await runCreatePastReloadWait();
      await vi.advanceTimersByTimeAsync(
        TIMING.RAF_CURSOR_POSITIONING_DELAY_MS + 10
      );

      expect(handleCursorPositioning()).not.toHaveBeenCalled();
      expectEveryListenerRemoved(6);
    });

    // Written into the hidden editor instead, the line break would leave the view unsaved, and a file write in that window raises Obsidian's merge notice
    it('writes the line break below an ending fence through the file before reading it, so the cursor pass meets a note that no longer ends at the fence', async () => {
      decide({
        shouldInsertTitle: false,
        judgedContent: '---\na: b\n---',
        viewLagsFile: true,
      });
      fileText = '---\na: b\n---';
      (
        mockPlugin.fileOperations as Record<string, unknown>
      ).addLineAfterEndingFence = vi.fn(async () => {
        fileText = '---\na: b\n---\n';
      });
      let textAtCursorPass: string | undefined;
      (
        mockPlugin.fileOperations as Record<string, unknown>
      ).handleCursorPositioning = vi.fn(
        async (
          _file: TFile,
          _placeCursorAtEnd: boolean,
          view: { getViewData: () => string }
        ) => {
          textAtCursorPass = view.getViewData();
        }
      );
      const { reload } = openLaggingView();
      // Templater's write reaches the view first, then the line break
      window.setTimeout(() => reload('---\na: b\n---'), 40);
      window.setTimeout(() => reload('---\na: b\n---\n'), 80);

      await runCreatePastReloadWait();

      expect(fileOperations().insertTitle).not.toHaveBeenCalled();
      expect(fileOperations().addLineAfterEndingFence).toHaveBeenCalledWith(
        file
      );
      expect(
        fileOperations().addLineAfterEndingFence.mock.invocationCallOrder[0]
      ).toBeLessThan(vi.mocked(mockApp.vault.read).mock.invocationCallOrder[0]);
      expect(handleCursorPositioning()).toHaveBeenCalledTimes(1);
      expect(textAtCursorPass).toBe('---\na: b\n---\n');
    });

    it('runs no delayed cursor timer', async () => {
      const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
      try {
        const { view } = openLaggingView(TITLED_NOTE);

        await runCreatePastReloadWait();
        await vi.advanceTimersByTimeAsync(
          TIMING.RAF_CURSOR_POSITIONING_DELAY_MS + 10
        );

        expect(setTimeoutSpy).not.toHaveBeenCalledWith(
          expect.any(Function),
          TIMING.RAF_CURSOR_POSITIONING_DELAY_MS
        );
        expect(handleCursorPositioning()).toHaveBeenCalledTimes(1);
        expect(handleCursorPositioning()).toHaveBeenCalledWith(
          file,
          true,
          view
        );
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it('holds the note in its creation window through the wait, and releases it after', async () => {
      const lifecycle = mockPlugin.editorLifecycle as EditorLifecycleManager;
      const heldAtCursorPass: boolean[] = [];
      (
        mockPlugin.fileOperations as Record<string, unknown>
      ).handleCursorPositioning = vi.fn(async () => {
        heldAtCursorPass.push(lifecycle.isFileInCreationWindow(file));
      });
      const { reload } = openLaggingView();
      window.setTimeout(() => reload(TITLED_NOTE), 60);
      const handled = createHandler!(file);

      await vi.advanceTimersByTimeAsync(40);
      expect(lifecycle.isFileInCreationWindow(file)).toBe(true);
      await vi.advanceTimersByTimeAsync(TIMING.VIEW_RELOAD_WAIT_MS);
      await handled;

      expect(heldAtCursorPass).toEqual([true]);
      expect(lifecycle.isFileInCreationWindow(file)).toBe(false);
    });
  });

  describe('note created in the background', () => {
    it('reads, inserts, places and renames nothing when no view ever shows it', async () => {
      await runCreate();

      expect(determineActions).not.toHaveBeenCalled();
      expect(mockApp.vault.read).not.toHaveBeenCalled();
      expect(mockApp.vault.cachedRead).not.toHaveBeenCalled();
      expect(fileOperations().insertTitle).not.toHaveBeenCalled();
      expect(fileOperations().handleCursorPositioning).not.toHaveBeenCalled();
      expect(processFile()).not.toHaveBeenCalled();
    });

    it('skips the rename pass for a note never shown in a Markdown leaf', async () => {
      mockPlugin.eventHandlerManager = {
        hasBeenShownInEditor: vi.fn().mockReturnValue(false),
      };

      await runCreate();

      expect(processFile()).not.toHaveBeenCalled();
    });

    it('stops listening once the wait ends', async () => {
      captureWorkspaceEvents();

      await runCreate();

      expectEveryListenerRemoved(3);
    });

    // A note opened after the wait is still renamed by the delayed pass, which resolves its view when it fires.
    it('still schedules the delayed rename with a new note delay set', async () => {
      (
        mockPlugin.settings as { core: { newNoteDelay: number } }
      ).core.newNoteDelay = 1000;

      await runCreate();
      await vi.advanceTimersByTimeAsync(1000);

      expect(processFile()).toHaveBeenCalledTimes(1);
      expect(
        fileOperations().resolveMarkdownViewForFile
      ).toHaveBeenLastCalledWith(file, null);
    });
  });

  function hasActiveEditorPassedToRename(): unknown {
    expect(processFile()).toHaveBeenCalledTimes(1);
    return processFile().mock.calls[0][1].hasActiveEditor;
  }

  it('treats a note already shown in a Markdown leaf as having an editor', async () => {
    mockPlugin.eventHandlerManager = {
      hasBeenShownInEditor: vi.fn().mockReturnValue(true),
    };

    await runCreate();

    expect(hasActiveEditorPassedToRename()).toBe(true);
  });

  it('treats a note created while a canvas is active as having an editor', async () => {
    mockApp.workspace.getMostRecentLeaf = vi.fn().mockReturnValue({
      view: { getViewType: () => 'canvas' },
    });

    await runCreate();

    expect(hasActiveEditorPassedToRename()).toBe(true);
  });

  // A canvas creating many notes at once would otherwise get a title inserted into each
  it('inserts no second title within the rate limit window while a canvas is active', async () => {
    mockApp.workspace.getMostRecentLeaf = vi.fn().mockReturnValue({
      view: { getViewType: () => 'canvas' },
    });

    await runCreate();
    await runCreate();

    expect(fileOperations().insertTitle).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TIMING.TITLE_INSERTION_RATE_LIMIT_MS);
    await runCreate();

    expect(fileOperations().insertTitle).toHaveBeenCalledTimes(2);
  });

  it('looks for a view already showing the note through the shared resolver', async () => {
    const view = { file, getViewData: vi.fn(() => '# ') };
    fileOperations().resolveMarkdownViewForFile.mockReturnValue(view);

    const handled = createHandler!(file);
    await vi.advanceTimersByTimeAsync(0);
    await handled;

    expect(fileOperations().resolveMarkdownViewForFile).toHaveBeenNthCalledWith(
      1,
      file,
      null
    );
    expect(fileOperations().insertTitle).toHaveBeenCalledWith(
      file,
      '# ',
      'line-end',
      view
    );
  });

  it('decides without waiting when the note is already shown or a canvas is active', async () => {
    mockPlugin.eventHandlerManager = {
      hasBeenShownInEditor: vi.fn().mockReturnValue(true),
    };

    const handled = createHandler!(file);
    await vi.advanceTimersByTimeAsync(0);
    await handled;

    expect(fileOperations().insertTitle).toHaveBeenCalledWith(
      file,
      '',
      'line-end',
      null
    );
  });

  // Real rename records, written in the order a plugin rename writes them: the vault `rename` handler moves the state, then the engine marks the new path
  describe('within the stale-create window of a plugin rename', () => {
    let fileStateManager: FileStateManager;

    beforeEach(() => {
      fileStateManager = new FileStateManager(
        mockPlugin as unknown as ConstructorParameters<
          typeof FileStateManager
        >[0]
      );
      mockPlugin.fileStateManager = fileStateManager;
    });

    // Cmd+N reusing `Untitled` right after the previous untitled note took its title, or a click on a link to a note's old name
    it('runs the pipeline for a new note created at the path a rename vacated', async () => {
      fileStateManager.notifyFileRenamed(file.path, 'Notes/Renamed.md');
      fileStateManager.markRecentlyRenamedInto('Notes/Renamed.md');
      await vi.advanceTimersByTimeAsync(TIMING.STALE_CREATE_WINDOW_MS / 2);
      openViewAfter(20);

      await runCreate();

      expect(determineActions).toHaveBeenCalledTimes(1);
      expect(fileOperations().handleCursorPositioning).toHaveBeenCalledWith(
        file,
        true
      );
    });

    it('skips a late create event for the note a rename moved into its path', async () => {
      fileStateManager.notifyFileRenamed('Notes/Untitled.md', file.path);
      fileStateManager.markRecentlyRenamedInto(file.path);
      await vi.advanceTimersByTimeAsync(TIMING.STALE_CREATE_WINDOW_MS / 2);
      openViewAfter(20);

      await runCreate();

      expect(determineActions).not.toHaveBeenCalled();
      expect(fileOperations().insertTitle).not.toHaveBeenCalled();
      expect(fileOperations().handleCursorPositioning).not.toHaveBeenCalled();
      expect(processFile()).not.toHaveBeenCalled();
    });
  });

  it('resolves the rename editor through the shared resolver', async () => {
    mockPlugin.eventHandlerManager = {
      hasBeenShownInEditor: vi.fn().mockReturnValue(true),
    };

    await runCreate();

    expect(fileOperations().resolveMarkdownViewForFile).toHaveBeenCalledWith(
      file,
      null
    );
  });

  // Templater writes its merged text before its event arrives; a rename pass on it in between named the note `Untitled` before the title went in
  describe('creation window', () => {
    const lifecycle = () =>
      mockPlugin.editorLifecycle as EditorLifecycleManager;
    const inCreationWindow = () => lifecycle().isFileInCreationWindow(file);

    it('holds the note from the create event itself', async () => {
      openViewAfter(20);

      const handled = createHandler!(file);

      expect(inCreationWindow()).toBe(true);
      await vi.advanceTimersByTimeAsync(TIMING.NEW_NOTE_VIEW_WAIT_MS + 10);
      await handled;
    });

    it('holds the note through the Templater wait and title insertion, and releases it before the creation rename', async () => {
      openViewAfter(20);
      const heldAt: Record<string, boolean> = {};
      determineActions.mockImplementation(async () => {
        heldAt.decisionStart = inCreationWindow();
        // Stands in for the wait for Templater's event
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        heldAt.decisionEnd = inCreationWindow();
        return {
          shouldInsertTitle: true,
          shouldMoveCursor: true,
          placeCursorAtEnd: true,
          titleCursor: 'line-end',
          judgedContent: '',
          viewLagsFile: false,
        };
      });
      // Replaced rather than re-implemented: the shared accessors type these mocks loosely enough that an async implementation reads as a misused promise
      (mockPlugin.fileOperations as Record<string, unknown>).insertTitle =
        vi.fn(async () => {
          heldAt.titleInsertion = inCreationWindow();
          return { inserted: true, cursorPositioned: true };
        });
      (mockPlugin.renameEngine as Record<string, unknown>).processFile = vi.fn(
        async () => {
          heldAt.creationRename = inCreationWindow();
        }
      );

      await runCreate();

      expect(heldAt).toEqual({
        decisionStart: true,
        decisionEnd: true,
        titleInsertion: true,
        creationRename: false,
      });
      expect(inCreationWindow()).toBe(false);
    });

    it('releases a note created in the background once the view wait ends', async () => {
      const handled = createHandler!(file);
      await vi.advanceTimersByTimeAsync(TIMING.NEW_NOTE_VIEW_WAIT_MS / 2);
      expect(inCreationWindow()).toBe(true);

      await vi.advanceTimersByTimeAsync(TIMING.NEW_NOTE_VIEW_WAIT_MS);
      await handled;

      expect(determineActions).not.toHaveBeenCalled();
      expect(inCreationWindow()).toBe(false);
    });

    it('releases the note when the decision throws', async () => {
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      openViewAfter(20);
      determineActions.mockRejectedValue(new Error('decision failed'));

      await runCreate();

      expect(consoleError).toHaveBeenCalled();
      expect(inCreationWindow()).toBe(false);
      consoleError.mockRestore();
    });

    it('releases a note the canvas rate limit turns away', async () => {
      mockApp.workspace.getMostRecentLeaf = vi.fn().mockReturnValue({
        view: { getViewType: () => 'canvas' },
      });
      await runCreate();
      const turnedAway = new TFile('Notes/Second.md');
      turnedAway.extension = 'md';

      await createHandler!(turnedAway);

      expect(fileOperations().insertTitle).toHaveBeenCalledTimes(1);
      expect(lifecycle().isFileInCreationWindow(turnedAway)).toBe(false);
    });
  });
});
