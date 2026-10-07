import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Menu as ObsidianMenu } from 'obsidian';
import { EventHandlerManager } from '../../src/core/event-handler-manager';
import { ContextMenuManager } from '../../src/ui/context-menus';
import { Menu, TFile, TFolder } from '../mockObsidian';
import { captureMenuItems, createTestSettings } from '../testUtils';

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
    getAllMarkdownFilesInFolder: vi.fn(() => []),
    registerEvent: vi.fn(),
    registerDomEvent: vi.fn(),
  } as any;
}

/**
 * Registers every handler and hands back the `files-menu` callback - the one
 * Obsidian invokes when a multi-item selection is right-clicked.
 */
function captureFilesMenuHandler(
  plugin: any
): (menu: any, files: any[]) => void {
  new EventHandlerManager(plugin).registerAllHandlers();

  const registration = plugin.app.workspace.on.mock.calls.find(
    (call: unknown[]) => call[0] === 'files-menu'
  );
  if (!registration) throw new Error('files-menu handler was not registered');

  return registration[1];
}

/**
 * Registers every handler and hands back the `search:results-menu` callback -
 * the one Obsidian invokes when the search results header is right-clicked.
 */
function captureSearchResultsMenuHandler(
  plugin: any
): (menu: any, leaf: any) => void {
  new EventHandlerManager(plugin).registerAllHandlers();

  const registration = plugin.app.workspace.on.mock.calls.find(
    (call: unknown[]) => call[0] === 'search:results-menu'
  );
  if (!registration) {
    throw new Error('search:results-menu handler was not registered');
  }

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
    },
    editorLifecycle: {
      isFileInCreationDelay: vi.fn(() => false),
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
 * Registers every handler and hands back the `editor-change` callback.
 */
function captureEditorChangeHandler(
  plugin: any
): (editor: any, info: any) => void {
  new EventHandlerManager(plugin).registerAllHandlers();

  const registration = plugin.app.workspace.on.mock.calls.find(
    (call: unknown[]) => call[0] === 'editor-change'
  );
  if (!registration) {
    throw new Error('editor-change handler was not registered');
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
        isFileInCreationDelay: vi.fn(),
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
        isLocked: vi.fn(),
      };
      plugin.renameEngine = {
        updateTitleRegionCacheKey: vi.fn(),
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
      const handler = captureFilesMenuHandler(createMenuMockPlugin());
      const menu = new Menu();

      handler(menu, [new TFile('Notes/note.md'), new TFolder('Notes')]);

      expect(menu.addItem).not.toHaveBeenCalled();
    });

    it('should add nothing to a note selection when note commands are off', () => {
      const handler = captureFilesMenuHandler(
        createMenuMockPlugin({ enableFileCommands: false })
      );
      const menu = new Menu();

      handler(menu, [new TFile('Notes/one.md'), new TFile('Notes/two.md')]);

      expect(menu.addItem).not.toHaveBeenCalled();
    });

    it('should add its three commands to a note selection', () => {
      const handler = captureFilesMenuHandler(createMenuMockPlugin());
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
      const handler = captureFilesMenuHandler(createMenuMockPlugin());
      const menu = new Menu();

      handler(menu, [new TFile('Notes/one.md'), new TFile('Notes/two.md')]);

      expect(menu.addSeparator).not.toHaveBeenCalled();
    });

    it('should hand a selection of two or more folders to addMultiFolderMenuItems', () => {
      const plugin = createMenuMockPlugin();
      const handler = captureFilesMenuHandler(plugin);
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
      const handler = captureSearchResultsMenuHandler(
        createMenuMockPlugin({ enableSearchCommands: false })
      );
      const menu = new Menu();

      handler(menu, searchLeafHolding(new TFile('Notes/one.md')));

      expect(menu.addItem).not.toHaveBeenCalled();
    });

    it('should add nothing when the results hold no notes', () => {
      const handler = captureSearchResultsMenuHandler(createMenuMockPlugin());
      const menu = new Menu();

      handler(menu, searchLeafHolding(new TFile('Assets/diagram.png')));

      expect(menu.addItem).not.toHaveBeenCalled();
    });

    it('should add its three commands for a set of matched notes', () => {
      const handler = captureSearchResultsMenuHandler(createMenuMockPlugin());
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
      const handler = captureSearchResultsMenuHandler(createMenuMockPlugin());
      const menu = new Menu();

      handler(menu, searchLeafHolding(new TFile('Notes/one.md')));

      expect(menu.addSeparator).not.toHaveBeenCalled();
    });
  });

  describe('editor-change handler', () => {
    // A page preview or Canvas card passes itself as `info`, carrying the section it shows.
    it('should not track an edit in an embed showing one section', () => {
      const plugin = createEditorChangeMockPlugin();
      const handler = captureEditorChangeHandler(plugin);
      const note = new TFile('Notes/note.md');

      handler({}, { file: note, subpath: '#Heading' });

      expect(
        plugin.editorLifecycle.handleEditorChangeWithThrottle
      ).not.toHaveBeenCalled();
    });

    it('should track an edit in an embed showing the whole note', () => {
      const plugin = createEditorChangeMockPlugin();
      const handler = captureEditorChangeHandler(plugin);
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
      const handler = captureEditorChangeHandler(plugin);
      const editor = {};

      handler(editor, card);

      expect(
        plugin.editorLifecycle.handleEditorChangeWithThrottle
      ).toHaveBeenCalledWith(editor, note, { inCanvasCard: true, owner: card });
    });
  });
});

// The folder branch of the files-menu handler delegates straight here.
describe('ContextMenuManager.addMultiFolderMenuItems', () => {
  const folders = [new TFolder('Notes'), new TFolder('Archive')];

  it('should omit the rename command when the folders hold no notes', () => {
    const plugin = createMenuMockPlugin();
    const menu = new Menu();

    new ContextMenuManager(plugin).addMultiFolderMenuItems(
      menu as unknown as ObsidianMenu,
      folders
    );

    expect(menu.addItem).toHaveBeenCalledTimes(2);
    expect(captureMenuItems(menu.addItem).map((item) => item.icon)).toEqual([
      DISABLE_RENAMING,
      ENABLE_RENAMING,
    ]);
  });

  // Counterpart to the test above: without it, dropping the rename command
  // outright would still leave that one passing.
  it('should add the rename command when the folders hold notes', () => {
    const plugin = createMenuMockPlugin();
    plugin.getAllMarkdownFilesInFolder = vi.fn(() => [new TFile('Notes/a.md')]);
    const menu = new Menu();

    new ContextMenuManager(plugin).addMultiFolderMenuItems(
      menu as unknown as ObsidianMenu,
      folders
    );

    expect(captureMenuItems(menu.addItem).map((item) => item.icon)).toEqual([
      PUT_FIRST_LINE_IN_TITLE,
      DISABLE_RENAMING,
      ENABLE_RENAMING,
    ]);
  });

  it('should omit the rename command when the rules exclude every selected folder', () => {
    const plugin = createMenuMockPlugin();
    plugin.getAllMarkdownFilesInFolder = vi.fn(() => [new TFile('Notes/a.md')]);
    plugin.settings.exclusions.excludedFiles = ['Notes/', 'Archive/'];
    const menu = new Menu();

    new ContextMenuManager(plugin).addMultiFolderMenuItems(
      menu as unknown as ObsidianMenu,
      folders
    );

    expect(captureMenuItems(menu.addItem).map((item) => item.icon)).toEqual([
      DISABLE_RENAMING,
      ENABLE_RENAMING,
    ]);
  });

  it('should add the rename command when the rules spare one selected folder', () => {
    const plugin = createMenuMockPlugin();
    plugin.getAllMarkdownFilesInFolder = vi.fn(() => [new TFile('Notes/a.md')]);
    plugin.settings.exclusions.excludedFiles = ['Notes/'];
    const menu = new Menu();

    new ContextMenuManager(plugin).addMultiFolderMenuItems(
      menu as unknown as ObsidianMenu,
      folders
    );

    expect(captureMenuItems(menu.addItem).map((item) => item.icon)).toEqual([
      PUT_FIRST_LINE_IN_TITLE,
      DISABLE_RENAMING,
      ENABLE_RENAMING,
    ]);
  });

  it('should add no separator between its folder commands, which would split the section-less group Obsidian shares between plugins', () => {
    const plugin = createMenuMockPlugin();
    const menu = new Menu();

    new ContextMenuManager(plugin).addMultiFolderMenuItems(
      menu as unknown as ObsidianMenu,
      folders
    );

    expect(menu.addSeparator).not.toHaveBeenCalled();
  });

  it('should add nothing when folder commands are off', () => {
    const plugin = createMenuMockPlugin({ enableFolderCommands: false });
    const menu = new Menu();

    new ContextMenuManager(plugin).addMultiFolderMenuItems(
      menu as unknown as ObsidianMenu,
      folders
    );

    expect(menu.addItem).not.toHaveBeenCalled();
  });
});
