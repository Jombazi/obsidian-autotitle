import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventHandlerManager } from '../../src/core/event-handler-manager';
import { FileStateManager } from '../../src/core/file-state-manager';
import {
  App,
  Editor,
  MarkdownView,
  Menu,
  TFile,
  TFolder,
} from '../mockObsidian';
import { captureMenuItems, createTestSettings } from '../testUtils';

// The shared mock has no `Component`; the pop-out tag listeners need one that adds and removes real DOM listeners
vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class Component {
    private cleanups: (() => void)[] = [];
    registerDomEvent(
      target: EventTarget,
      type: string,
      listener: EventListener
    ): void {
      target.addEventListener(type, listener);
      this.cleanups.push(() => target.removeEventListener(type, listener));
    }
    unload(): void {
      for (const cleanup of this.cleanups.splice(0)) cleanup();
    }
  }
  return { ...actual, Component };
});

// Minimal mock plugin for EventHandlerManager
// Only includes what's needed for testing the pendingFirstLinePropertyUpdates coordination
function createMockPlugin() {
  return {
    app: {
      workspace: {
        on: vi.fn(),
        onLayoutReady: vi.fn(),
      },
      vault: {
        on: vi.fn(),
      },
      metadataCache: {
        on: vi.fn(),
      },
    },
    settings: {
      core: {
        enableContextMenus: true,
      },
    },
    registerEvent: vi.fn(),
  } as any;
}

// Icons stand in for item identity: each command in the menu sets a distinct one,
// and unlike the titles they don't move with the locale.
const PUT_FIRST_LINE_IN_TITLE = 'file-type-corner';
const DISABLE_RENAMING = 'pen-off';
const ENABLE_RENAMING = 'file-pen';

/**
 * Mock plugin for the context-menu handlers. Registration itself only needs the
 * event registrars; the `files-menu` callback then reads the command flags and,
 * for a folder selection, hands off to the context menu manager.
 */
function createMenuMockPlugin(coreOverrides: Record<string, boolean> = {}) {
  return {
    app: {
      workspace: { on: vi.fn(), onLayoutReady: vi.fn() },
      vault: { on: vi.fn() },
      metadataCache: { on: vi.fn() },
    },
    settings: {
      core: {
        enableContextMenus: true,
        enableFileCommands: true,
        enableFolderCommands: true,
        enableSearchCommands: true,
        ...coreOverrides,
      },
      exclusions: createTestSettings().exclusions,
    },
    contextMenuManager: {
      addMultiFolderMenuItems: vi.fn(),
    },
    registerEvent: vi.fn(),
    registerDomEvent: vi.fn(),
  } as any;
}

/**
 * Registers every handler and hands back the callback Obsidian invokes for a workspace event: `files-menu` when a multi-item selection is right-clicked, `search:results-menu` when the search results header is, `editor-change` on an edit.
 */
function captureWorkspaceHandler(
  plugin: any,
  eventName: 'files-menu' | 'search:results-menu' | 'editor-change'
): (...args: any[]) => any {
  new EventHandlerManager(plugin).registerAllHandlers();

  const registration = plugin.app.workspace.on.mock.calls.find(
    (call: unknown[]) => call[0] === eventName
  );
  if (!registration) throw new Error(`${eventName} handler was not registered`);

  return registration[1];
}

/** Mock plugin with what the `editor-change` callback reads before handing an edit to the throttle. */
function createEditorChangeMockPlugin() {
  return {
    app: {
      workspace: {
        on: vi.fn(),
        onLayoutReady: vi.fn(),
        getLeavesOfType: vi.fn(() => []),
      },
      vault: { on: vi.fn(), cachedRead: vi.fn().mockResolvedValue('') },
      metadataCache: { on: vi.fn(), getFileCache: vi.fn(() => null) },
    },
    settings: {
      core: {
        renameAutomatically: true,
        debug: false,
        enableContextMenus: true,
      },
      exclusions: {
        disableRenamingKey: 'no rename',
        disableRenamingValue: 'true',
      },
      firstLineProperty: createTestSettings().firstLineProperty,
    },
    editorLifecycle: {
      isFileInCreationWindow: vi.fn(() => false),
      handleEditorChangeWithThrottle: vi.fn(),
    },
    fileStateManager: {
      getLastSavedContent: vi.fn(),
      setLastSavedContent: vi.fn(),
    },
    isFullyLoaded: true,
    registerEvent: vi.fn(),
    registerDomEvent: vi.fn(),
  } as any;
}

/**
 * Registers every handler and hands back the metadata cache `changed` callback that updates the first line property.
 */
function captureFirstLinePropertyMetadataHandler(
  plugin: any
): (file: any, data?: string, cache?: unknown) => Promise<void> {
  new EventHandlerManager(plugin).registerAllHandlers();

  // The rename-blocking property's `changed` handler registers first; the first line property's is the last one.
  const registration = plugin.app.metadataCache.on.mock.calls
    .filter((call: unknown[]) => call[0] === 'changed')
    .at(-1);
  if (!registration) {
    throw new Error('metadata changed handler was not registered');
  }

  return registration[1];
}

/** Search results reach the handler as file-bearing nodes on the leaf's tree. */
function searchLeafHolding(...files: unknown[]) {
  return { dom: { vChildren: { children: files.map((file) => ({ file })) } } };
}

describe('EventHandlerManager', () => {
  let plugin: any;
  let manager: EventHandlerManager;

  beforeEach(() => {
    plugin = createMockPlugin();
    manager = new EventHandlerManager(plugin);
  });

  describe('pendingFirstLinePropertyUpdates coordination', () => {
    it('should initially have no pending updates', () => {
      expect(manager.isFirstLinePropertyUpdatePending('test.md')).toBe(false);
    });

    it('should mark first line property update as pending', () => {
      manager.markFirstLinePropertyUpdatePending('test.md');
      expect(manager.isFirstLinePropertyUpdatePending('test.md')).toBe(true);
    });

    it('should clear pending first line property update', () => {
      manager.markFirstLinePropertyUpdatePending('test.md');
      manager.clearFirstLinePropertyUpdatePending('test.md');
      expect(manager.isFirstLinePropertyUpdatePending('test.md')).toBe(false);
    });

    it('should handle multiple files independently', () => {
      manager.markFirstLinePropertyUpdatePending('file1.md');
      manager.markFirstLinePropertyUpdatePending('file2.md');

      expect(manager.isFirstLinePropertyUpdatePending('file1.md')).toBe(true);
      expect(manager.isFirstLinePropertyUpdatePending('file2.md')).toBe(true);
      expect(manager.isFirstLinePropertyUpdatePending('file3.md')).toBe(false);

      manager.clearFirstLinePropertyUpdatePending('file1.md');
      expect(manager.isFirstLinePropertyUpdatePending('file1.md')).toBe(false);
      expect(manager.isFirstLinePropertyUpdatePending('file2.md')).toBe(true);
    });

    it('should handle clear on non-existent path', () => {
      expect(() =>
        manager.clearFirstLinePropertyUpdatePending('nonexistent.md')
      ).not.toThrow();
    });

    it('should handle double mark', () => {
      manager.markFirstLinePropertyUpdatePending('test.md');
      manager.markFirstLinePropertyUpdatePending('test.md');
      expect(manager.isFirstLinePropertyUpdatePending('test.md')).toBe(true);
    });

    it('should handle double clear', () => {
      manager.markFirstLinePropertyUpdatePending('test.md');
      manager.clearFirstLinePropertyUpdatePending('test.md');
      manager.clearFirstLinePropertyUpdatePending('test.md');
      expect(manager.isFirstLinePropertyUpdatePending('test.md')).toBe(false);
    });
  });

  describe('constructor', () => {
    it('should initialize with plugin reference', () => {
      const manager = new EventHandlerManager(plugin);
      expect(manager).toBeDefined();
    });
  });

  describe('registerAllHandlers', () => {
    it('should call plugin.registerEvent for each handler type', () => {
      // Mock the workspace and vault event registrations
      plugin.app.workspace.on = vi.fn().mockReturnValue({});
      plugin.app.vault.on = vi.fn().mockReturnValue({});
      plugin.app.metadataCache.on = vi.fn().mockReturnValue({});

      // Additional mocks needed for registerAllHandlers
      plugin.settings = {
        core: {
          enableContextMenus: true,
          renameAutomatically: true,
        },
        firstLineProperty: {
          propertyKey: 'aliases',
        },
      };
      plugin.contextMenuManager = {
        addFileMenuItems: vi.fn(),
        addFolderMenuItems: vi.fn(),
      };
      plugin.editorLifecycleManager = {
        handleEditorChange: vi.fn(),
      };
      plugin.fileStateManager = {
        notifyFileDeleted: vi.fn(),
        getLastEditorContent: vi.fn(),
        setLastEditorContent: vi.fn(),
        notifyFileRenamed: vi.fn(),
        deleteLastEditorContent: vi.fn(),
        setLastSavedContent: vi.fn(),
        getLastSavedContent: vi.fn(),
        isSavedContentStale: vi.fn(),
      };
      plugin.firstLinePropertyManager = {
        updateFirstLinePropertyIfNeeded: vi.fn(),
      };
      plugin.cacheManager = {
        notifyFileRenamed: vi.fn(),
        notifyFileDeleted: vi.fn(),
      };
      plugin.registerDomEvent = vi.fn();
      plugin.register = vi.fn();

      manager.registerAllHandlers();

      // Should register multiple events
      expect(plugin.registerEvent).toHaveBeenCalled();
    });
  });

  describe('files-menu handler', () => {
    it('should add nothing when the selection mixes notes and folders', () => {
      const handler = captureWorkspaceHandler(
        createMenuMockPlugin(),
        'files-menu'
      );
      const menu = new Menu();

      handler(menu, [new TFile('Notes/note.md'), new TFolder('Notes')]);

      expect(menu.addItem).not.toHaveBeenCalled();
    });

    it('should add nothing to a note selection when note commands are off', () => {
      const handler = captureWorkspaceHandler(
        createMenuMockPlugin({ enableFileCommands: false }),
        'files-menu'
      );
      const menu = new Menu();

      handler(menu, [new TFile('Notes/one.md'), new TFile('Notes/two.md')]);

      expect(menu.addItem).not.toHaveBeenCalled();
    });

    it('should add its three commands to a note selection', () => {
      const handler = captureWorkspaceHandler(
        createMenuMockPlugin(),
        'files-menu'
      );
      const menu = new Menu();

      handler(menu, [new TFile('Notes/one.md'), new TFile('Notes/two.md')]);

      expect(menu.addItem).toHaveBeenCalledTimes(3);
      expect(captureMenuItems(menu.addItem).map((item) => item.icon)).toEqual([
        PUT_FIRST_LINE_IN_TITLE,
        DISABLE_RENAMING,
        ENABLE_RENAMING,
      ]);
    });

    it('should add no separator before its note commands, which would split the section-less group Obsidian shares between plugins', () => {
      const handler = captureWorkspaceHandler(
        createMenuMockPlugin(),
        'files-menu'
      );
      const menu = new Menu();

      handler(menu, [new TFile('Notes/one.md'), new TFile('Notes/two.md')]);

      expect(menu.addSeparator).not.toHaveBeenCalled();
    });

    it('should hand a selection of two or more folders to addMultiFolderMenuItems', () => {
      const plugin = createMenuMockPlugin();
      const handler = captureWorkspaceHandler(plugin, 'files-menu');
      const menu = new Menu();
      const folders = [new TFolder('Notes'), new TFolder('Archive')];

      handler(menu, folders);

      expect(
        plugin.contextMenuManager.addMultiFolderMenuItems
      ).toHaveBeenCalledWith(menu, folders);
    });
  });

  describe('search:results-menu handler', () => {
    it('should add nothing when search commands are off', () => {
      const handler = captureWorkspaceHandler(
        createMenuMockPlugin({ enableSearchCommands: false }),
        'search:results-menu'
      );
      const menu = new Menu();

      handler(menu, searchLeafHolding(new TFile('Notes/one.md')));

      expect(menu.addItem).not.toHaveBeenCalled();
    });

    it('should add nothing when the results hold no notes', () => {
      const handler = captureWorkspaceHandler(
        createMenuMockPlugin(),
        'search:results-menu'
      );
      const menu = new Menu();

      handler(menu, searchLeafHolding(new TFile('Assets/diagram.png')));

      expect(menu.addItem).not.toHaveBeenCalled();
    });

    it('should add its three commands for a set of matched notes', () => {
      const handler = captureWorkspaceHandler(
        createMenuMockPlugin(),
        'search:results-menu'
      );
      const menu = new Menu();

      handler(
        menu,
        searchLeafHolding(new TFile('Notes/one.md'), new TFile('Notes/two.md'))
      );

      expect(menu.addItem).toHaveBeenCalledTimes(3);
      expect(captureMenuItems(menu.addItem).map((item) => item.icon)).toEqual([
        PUT_FIRST_LINE_IN_TITLE,
        DISABLE_RENAMING,
        ENABLE_RENAMING,
      ]);
    });

    it('should add no separator before its search commands, which would split the section-less group Obsidian shares between plugins', () => {
      const handler = captureWorkspaceHandler(
        createMenuMockPlugin(),
        'search:results-menu'
      );
      const menu = new Menu();

      handler(menu, searchLeafHolding(new TFile('Notes/one.md')));

      expect(menu.addSeparator).not.toHaveBeenCalled();
    });
  });

  describe('tag context menus', () => {
    /** A Markdown leaf whose view sits in `doc`, as a leaf in a pop-out window does */
    const leafIn = (doc: Document) => ({
      view: { containerEl: { ownerDocument: doc } },
    });

    /** A tag pane entry for `#project` in `doc` */
    function tagPaneEntryIn(doc: Document): HTMLElement {
      const entry = doc.createElement('div');
      entry.className = 'tag-pane-tag';
      const text = doc.createElement('span');
      text.className = 'tag-pane-tag-text';
      text.textContent = '#project';
      entry.appendChild(text);
      doc.body.appendChild(entry);
      return text;
    }

    function rightClick(target: HTMLElement): MouseEvent {
      // The setup's jsdom window, since the test environment installs no global `MouseEvent`
      const event = new window.MouseEvent('contextmenu', { bubbles: true });
      target.dispatchEvent(event);
      return event;
    }

    /** Mock plugin with a menu manager recording tag menus; `openLeaves` are the leaves open when the layout is ready */
    function createTagMenuMockPlugin(openLeaves: unknown[] = []) {
      const plugin = createMenuMockPlugin();
      plugin.app.workspace.onLayoutReady = vi.fn((callback: () => void) =>
        callback()
      );
      plugin.app.workspace.iterateAllLeaves = vi.fn(
        (callback: (leaf: unknown) => void) => openLeaves.forEach(callback)
      );
      plugin.app.workspace.getLeavesOfType = vi.fn(() => []);
      plugin.addChild = vi.fn((child: unknown) => child);
      plugin.removeChild = vi.fn((child: { unload(): void }) => {
        child.unload();
        return child;
      });
      plugin.contextMenuManager.menuForEvent = vi.fn(() => new Menu());
      plugin.contextMenuManager.addTagMenuItems = vi.fn();
      return plugin;
    }

    function workspaceCallback(plugin: any, eventName: string) {
      const registration = plugin.app.workspace.on.mock.calls.find(
        (call: unknown[]) => call[0] === eventName
      );
      if (!registration) throw new Error(`${eventName} was not registered`);
      return registration[1];
    }

    it("adds tag items in a pop-out already open at load, showing the menu in that window's document", () => {
      const popout = document.implementation.createHTMLDocument('Pop-out');
      const plugin = createTagMenuMockPlugin([
        leafIn(document),
        leafIn(popout),
        leafIn(popout),
      ]);
      new EventHandlerManager(plugin).registerAllHandlers();

      const event = rightClick(tagPaneEntryIn(popout));

      expect(plugin.addChild).toHaveBeenCalledTimes(1);
      expect(plugin.contextMenuManager.menuForEvent).toHaveBeenCalledWith(
        event,
        popout
      );
      expect(plugin.contextMenuManager.addTagMenuItems).toHaveBeenCalledTimes(
        1
      );
    });

    it('adds tag items in a pop-out opened later, and stops listening once it closes', () => {
      const plugin = createTagMenuMockPlugin();
      new EventHandlerManager(plugin).registerAllHandlers();
      const popout = document.implementation.createHTMLDocument('Pop-out');
      const win = { document: popout };

      workspaceCallback(plugin, 'window-open')({}, win);
      rightClick(tagPaneEntryIn(popout));

      expect(plugin.contextMenuManager.addTagMenuItems).toHaveBeenCalledWith(
        expect.anything(),
        'project'
      );

      workspaceCallback(plugin, 'window-close')({}, win);
      rightClick(tagPaneEntryIn(popout));

      expect(plugin.removeChild).toHaveBeenCalledTimes(1);
      expect(plugin.contextMenuManager.addTagMenuItems).toHaveBeenCalledTimes(
        1
      );
    });

    it('listens once to a pop-out both open at load and announced by window-open', () => {
      const popout = document.implementation.createHTMLDocument('Pop-out');
      const plugin = createTagMenuMockPlugin([leafIn(popout)]);
      new EventHandlerManager(plugin).registerAllHandlers();

      workspaceCallback(plugin, 'window-open')({}, { document: popout });
      rightClick(tagPaneEntryIn(popout));

      expect(plugin.addChild).toHaveBeenCalledTimes(1);
      expect(plugin.contextMenuManager.addTagMenuItems).toHaveBeenCalledTimes(
        1
      );
    });
  });

  describe('editor-change handler', () => {
    // A page preview or Canvas card passes itself as `info`, carrying the section it shows.
    it('should not track an edit in an embed showing one section', () => {
      const plugin = createEditorChangeMockPlugin();
      const handler = captureWorkspaceHandler(plugin, 'editor-change');
      const note = new TFile('Notes/note.md');

      handler({}, { file: note, subpath: '#Heading' });

      expect(
        plugin.editorLifecycle.handleEditorChangeWithThrottle
      ).not.toHaveBeenCalled();
    });

    it('should track an edit in an embed showing the whole note', () => {
      const plugin = createEditorChangeMockPlugin();
      const handler = captureWorkspaceHandler(plugin, 'editor-change');
      const note = new TFile('Notes/note.md');
      const editor = {};
      const embed = { file: note, subpath: '' };

      handler(editor, embed);

      expect(
        plugin.editorLifecycle.handleEditorChangeWithThrottle
      ).toHaveBeenCalledWith(editor, note, {
        inCanvasCard: false,
        owner: embed,
      });
    });

    // Another plugin writing into a Reading view's hidden editor fires the event too, and the view never saves that text
    it("should not track a write into a Reading view's editor", () => {
      const plugin = createEditorChangeMockPlugin();
      const handler = captureWorkspaceHandler(plugin, 'editor-change');
      const view = new MarkdownView();
      view.file = new TFile('Notes/note.md');
      vi.mocked(view.getMode).mockReturnValue('preview');

      handler(view.editor, view);

      expect(
        plugin.editorLifecycle.handleEditorChangeWithThrottle
      ).not.toHaveBeenCalled();
    });

    it('should track an edit in a tab in Live Preview', () => {
      const plugin = createEditorChangeMockPlugin();
      const handler = captureWorkspaceHandler(plugin, 'editor-change');
      const view = new MarkdownView();
      const note = new TFile('Notes/note.md');
      view.file = note;

      handler(view.editor, view);

      expect(
        plugin.editorLifecycle.handleEditorChangeWithThrottle
      ).toHaveBeenCalledWith(view.editor, note, {
        inCanvasCard: false,
        owner: view,
      });
    });

    // A card just added to a canvas is not among its resolved links until the canvas saves and is re-indexed.
    it('should flag an edit in a Canvas card', () => {
      const plugin = createEditorChangeMockPlugin();
      const note = new TFile('Notes/note.md');
      const card = { file: note, subpath: '' };
      plugin.app.workspace.getLeavesOfType = vi.fn((type: string) =>
        type === 'canvas'
          ? [{ view: { canvas: { nodes: new Map([['n', { child: card }]]) } } }]
          : []
      );
      const handler = captureWorkspaceHandler(plugin, 'editor-change');
      const editor = {};

      handler(editor, card);

      expect(
        plugin.editorLifecycle.handleEditorChangeWithThrottle
      ).toHaveBeenCalledWith(editor, note, { inCanvasCard: true, owner: card });
    });

    // Templater writes its merged text before its event arrives, while the new-note pipeline still waits
    it('should leave a note in its creation window to the new-note pipeline', () => {
      const plugin = createEditorChangeMockPlugin();
      const handler = captureWorkspaceHandler(plugin, 'editor-change');
      const view = new MarkdownView();
      const note = new TFile('Untitled.md');
      view.file = note;
      plugin.editorLifecycle.isFileInCreationWindow = vi.fn(
        (file: TFile) => file === note
      );

      handler(view.editor, view);

      expect(
        plugin.editorLifecycle.isFileInCreationWindow
      ).toHaveBeenCalledWith(note);
      expect(
        plugin.editorLifecycle.handleEditorChangeWithThrottle
      ).not.toHaveBeenCalled();
    });
  });

  describe('modify handler', () => {
    it('should leave a note in its creation window to the new-note pipeline, but not a later note at its path', async () => {
      const plugin = createEditorChangeMockPlugin();
      plugin.settings.core.contentReadMethod = 'Cache';
      plugin.fileStateManager.isLocked = vi.fn(() => false);
      plugin.fileStateManager.hasThrottleTimer = vi.fn(() => false);
      plugin.renameEngine = {
        processFile: vi.fn().mockResolvedValue(undefined),
      };
      const note = new TFile('Untitled.md');
      plugin.editorLifecycle.isFileInCreationWindow = vi.fn(
        (file: TFile) => file === note
      );
      new EventHandlerManager(plugin).registerAllHandlers();
      const modify = plugin.app.vault.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'modify'
      )[1];

      await modify(note);
      expect(plugin.renameEngine.processFile).not.toHaveBeenCalled();

      const laterNote = new TFile(note.path);
      await modify(laterNote);
      expect(plugin.renameEngine.processFile).toHaveBeenCalledWith(laterNote);
    });
  });

  describe('metadata changed handler', () => {
    // A bulk or menu rename in manual mode writes the property; left flagged, the note's next save once automatic renaming is back would skip its property update.
    it('should clear the pending metadata flag with automatic renaming off', async () => {
      const plugin = createEditorChangeMockPlugin();
      plugin.settings.core.renameAutomatically = false;
      plugin.settings.firstLineProperty = { propertyKey: 'aliases' };
      const note = new TFile('Notes/note.md');
      plugin.fileStateManager = new FileStateManager({} as any);
      plugin.fileStateManager.markPendingMetadataUpdate(note.path);
      const handler = captureFirstLinePropertyMetadataHandler(plugin);

      await handler(note);

      expect(plugin.fileStateManager.hasPendingMetadataUpdate(note.path)).toBe(
        false
      );
    });

    describe('first line property update after a save', () => {
      const SAVED_TEXT = 'Title\nBody';
      let note: TFile;
      let view: MarkdownView;

      /** A mock plugin whose note is open in a Source view, with a property name set */
      function createSaveMockPlugin() {
        const plugin = createEditorChangeMockPlugin();
        plugin.settings.firstLineProperty = {
          ...createTestSettings().firstLineProperty,
          propertyKey: 'aliases',
        };
        plugin.fileStateManager.isLocked = vi.fn(() => false);
        plugin.fileStateManager.hasPendingMetadataUpdate = vi.fn(() => false);
        plugin.fileStateManager.clearPendingMetadataUpdate = vi.fn();
        plugin.fileStateManager.hasThrottleTimer = vi.fn(() => false);
        plugin.fileStateManager.deleteLastSavedContent = vi.fn();
        plugin.firstLinePropertyManager = {
          updateFirstLinePropertyIfNeeded: vi.fn().mockResolvedValue(true),
        };
        plugin.app.vault.read = vi.fn().mockResolvedValue('stale disk text');
        plugin.app.workspace.getLeavesOfType = vi.fn((type: string) =>
          type === 'markdown' ? [{ view }] : []
        );
        plugin.app.workspace.getActiveViewOfType = vi.fn(() => view);
        plugin.app.workspace.iterateAllLeaves = vi.fn();
        return plugin;
      }

      /** Makes the Source view's editor hold `text`, with a CodeMirror document of the same length */
      function showInEditor(text: string, documentLength = text.length) {
        const editor = new Editor();
        vi.mocked(editor.getValue).mockReturnValue(text);
        (editor as unknown as { cm: unknown }).cm = {
          state: { doc: { length: documentLength } },
        };
        view.editor = editor;
        return editor;
      }

      beforeEach(() => {
        note = new TFile('Notes/note.md');
        view = Object.assign(new MarkdownView(new App()), {
          file: note,
          dirty: false,
          getMode: () => 'source',
          requestSave: vi.fn(),
        });
      });

      it('leaves a note in its creation window to the new-note pipeline', async () => {
        const plugin = createSaveMockPlugin();
        showInEditor(SAVED_TEXT);
        plugin.editorLifecycle.isFileInCreationWindow = vi.fn(
          (file: TFile) => file === note
        );
        const handler = captureFirstLinePropertyMetadataHandler(plugin);

        await handler(note, SAVED_TEXT, {});

        expect(
          plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
        ).not.toHaveBeenCalled();
      });

      it('compares the text Obsidian just indexed, without reading the note again', async () => {
        const plugin = createSaveMockPlugin();
        showInEditor(SAVED_TEXT);
        const handler = captureFirstLinePropertyMetadataHandler(plugin);

        await handler(note, SAVED_TEXT, {});

        expect(plugin.app.vault.read).not.toHaveBeenCalled();
        expect(
          plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
        ).toHaveBeenCalledWith(
          note,
          SAVED_TEXT,
          expect.objectContaining({ editor: view.editor })
        );
        expect(
          plugin.fileStateManager.setLastSavedContent
        ).toHaveBeenCalledWith(note.path, SAVED_TEXT);
      });

      it('writes the file without joining the editor text when the lengths differ', async () => {
        const plugin = createSaveMockPlugin();
        const editor = showInEditor(SAVED_TEXT, SAVED_TEXT.length + 4);
        const handler = captureFirstLinePropertyMetadataHandler(plugin);

        await handler(note, SAVED_TEXT, {});

        expect(editor.getValue).not.toHaveBeenCalled();
        expect(
          plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
        ).toHaveBeenCalledWith(note, SAVED_TEXT, null);
      });

      it('writes the file when the editor holds other text of the same length', async () => {
        const plugin = createSaveMockPlugin();
        showInEditor('Other\nBody');
        const handler = captureFirstLinePropertyMetadataHandler(plugin);

        await handler(note, SAVED_TEXT, {});

        expect(
          plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
        ).toHaveBeenCalledWith(note, SAVED_TEXT, null);
      });
    });
  });

  describe('saved-content baseline', () => {
    it('reads no baseline when no first line property name is set', () => {
      const plugin = createEditorChangeMockPlugin();
      const handler = captureWorkspaceHandler(plugin, 'editor-change');

      handler({}, { file: new TFile('Notes/note.md') });

      expect(plugin.app.vault.cachedRead).not.toHaveBeenCalled();
      expect(
        plugin.fileStateManager.getLastSavedContent
      ).not.toHaveBeenCalled();
    });

    it('seeds the baseline from the file when a property name is set', async () => {
      const plugin = createEditorChangeMockPlugin();
      plugin.settings.firstLineProperty.propertyKey = 'aliases';
      plugin.app.vault.cachedRead = vi.fn().mockResolvedValue('Saved\nBody');
      const handler = captureWorkspaceHandler(plugin, 'editor-change');
      const note = new TFile('Notes/note.md');

      handler({}, { file: note });
      await Promise.resolve();

      expect(plugin.app.vault.cachedRead).toHaveBeenCalledWith(note);
      expect(plugin.fileStateManager.setLastSavedContent).toHaveBeenCalledWith(
        note.path,
        'Saved\nBody'
      );
    });
  });
});
