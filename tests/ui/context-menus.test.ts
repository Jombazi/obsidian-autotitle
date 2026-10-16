/**
 * Tests for `ContextMenuManager.addMultiFolderMenuItems`, the commands the
 * files-menu handler adds for a selection of two or more folders, and
 * `addTagMenuItems`, the commands added to a tag's menu.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Menu as ObsidianMenu } from 'obsidian';
import { ContextMenuManager } from '../../src/ui/context-menus';
import { Menu, TFile, TFolder } from '../mockObsidian';
import { captureMenuItems, createTestSettings } from '../testUtils';
import { EXCLUSION_STRATEGY } from '../../src/types';

// Icons stand in for item identity: each command in the menu sets a distinct one,
// and unlike the titles they don't move with the locale.
const PUT_FIRST_LINE_IN_TITLE = 'file-type-corner';
const DISABLE_RENAMING = 'pen-off';
const ENABLE_RENAMING = 'file-pen';

/** Mock plugin with what the menu reads: the command flags and the exclusion rules. */
function createMenuMockPlugin(coreOverrides: Record<string, boolean> = {}) {
  return {
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
    processMultipleFolders: vi.fn(),
  } as any;
}

/** A folder holding the given children, each linked back to it. */
function folderWith(path: string, children: (TFile | TFolder)[]): TFolder {
  const folder = new TFolder(path);
  for (const child of children) {
    child.parent = folder;
    folder.children.push(child);
  }
  return folder;
}

/** The icons of the commands `addMultiFolderMenuItems` adds for these folders. */
function menuIconsFor(plugin: any, folders: TFolder[]): string[] {
  const menu = new Menu();
  new ContextMenuManager(plugin).addMultiFolderMenuItems(
    menu as unknown as ObsidianMenu,
    folders
  );
  return captureMenuItems(menu.addItem).map((item) => item.icon);
}

describe('ContextMenuManager.addMultiFolderMenuItems', () => {
  const emptyFolders = [new TFolder('Notes'), new TFolder('Archive')];

  /** Two folders, the first holding a note. */
  function foldersWithNotes(): TFolder[] {
    return [
      folderWith('Notes', [new TFile('Notes/a.md')]),
      new TFolder('Archive'),
    ];
  }

  it('should omit the rename command when the folders hold no notes', () => {
    const plugin = createMenuMockPlugin();
    const menu = new Menu();

    new ContextMenuManager(plugin).addMultiFolderMenuItems(
      menu as unknown as ObsidianMenu,
      emptyFolders
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
    expect(menuIconsFor(createMenuMockPlugin(), foldersWithNotes())).toEqual([
      PUT_FIRST_LINE_IN_TITLE,
      DISABLE_RENAMING,
      ENABLE_RENAMING,
    ]);
  });

  it('should add the rename command for a note in a subfolder', () => {
    const folders = [
      folderWith('Notes', [
        folderWith('Notes/Work', [new TFile('Notes/Work/a.md')]),
      ]),
      new TFolder('Archive'),
    ];

    expect(menuIconsFor(createMenuMockPlugin(), folders)).toEqual([
      PUT_FIRST_LINE_IN_TITLE,
      DISABLE_RENAMING,
      ENABLE_RENAMING,
    ]);
  });

  it('should omit the rename command when the folders hold only files that are not notes', () => {
    const folders = [
      folderWith('Notes', [new TFile('Notes/photo.png')]),
      folderWith('Archive', [new TFile('Archive/board.canvas')]),
    ];

    expect(menuIconsFor(createMenuMockPlugin(), folders)).toEqual([
      DISABLE_RENAMING,
      ENABLE_RENAMING,
    ]);
  });

  it('should stop looking at the first note it finds', () => {
    const unvisitedChildren = vi.fn(() => [new TFile('Later/b.md')]);
    const laterSubfolder = new TFolder('Notes/Later');
    Object.defineProperty(laterSubfolder, 'children', {
      get: unvisitedChildren,
    });
    const laterFolder = new TFolder('Archive');
    Object.defineProperty(laterFolder, 'children', { get: unvisitedChildren });
    const folders = [
      folderWith('Notes', [new TFile('Notes/a.md'), laterSubfolder]),
      laterFolder,
    ];

    expect(menuIconsFor(createMenuMockPlugin(), folders)).toContain(
      PUT_FIRST_LINE_IN_TITLE
    );
    expect(unvisitedChildren).not.toHaveBeenCalled();
  });

  it('should omit the rename command when the rules exclude every selected folder', () => {
    const plugin = createMenuMockPlugin();
    plugin.settings.exclusions.excludedFiles = ['Notes/', 'Archive/'];

    expect(menuIconsFor(plugin, foldersWithNotes())).toEqual([
      DISABLE_RENAMING,
      ENABLE_RENAMING,
    ]);
  });

  it('should add the rename command when the rules spare one selected folder', () => {
    const plugin = createMenuMockPlugin();
    plugin.settings.exclusions.excludedFiles = ['Notes/'];

    expect(menuIconsFor(plugin, foldersWithNotes())).toEqual([
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
      emptyFolders
    );

    expect(menu.addSeparator).not.toHaveBeenCalled();
  });

  it('should add nothing when folder commands are off', () => {
    const plugin = createMenuMockPlugin({ enableFolderCommands: false });
    const menu = new Menu();

    new ContextMenuManager(plugin).addMultiFolderMenuItems(
      menu as unknown as ObsidianMenu,
      emptyFolders
    );

    expect(menu.addItem).not.toHaveBeenCalled();
  });
});

describe('ContextMenuManager.addTagMenuItems', () => {
  /** The icons of the commands `addTagMenuItems` adds for this tag. */
  function tagMenuIconsFor(plugin: any, tagName: string): string[] {
    const menu = new Menu();
    new ContextMenuManager(plugin).addTagMenuItems(
      menu as unknown as ObsidianMenu,
      tagName
    );
    return captureMenuItems(menu.addItem).map((item) => item.icon);
  }

  // The tag menus ignore patterns, so a pattern never makes the menu offer to remove it
  it('should offer "Disable renaming" for a tag only a pattern covers under "Only exclude..."', () => {
    const plugin = createMenuMockPlugin({ enableTagCommands: true });
    plugin.settings.exclusions.tagScopeStrategy =
      EXCLUSION_STRATEGY.ONLY_EXCLUDE;
    plugin.settings.exclusions.excludedTags = ['/^draft/'];

    expect(tagMenuIconsFor(plugin, 'draft-2024')).toEqual([
      PUT_FIRST_LINE_IN_TITLE,
      DISABLE_RENAMING,
    ]);
  });
});

describe('ContextMenuManager.menuForEvent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a new menu at the pointer in the document the event fired in', () => {
    vi.useFakeTimers();
    const popoutDocument = document.implementation.createHTMLDocument();
    const evt = { pageX: 12, pageY: 34 } as MouseEvent;

    const menu = new ContextMenuManager(createMenuMockPlugin()).menuForEvent(
      evt,
      popoutDocument
    ) as unknown as Menu;
    vi.runAllTimers();

    expect(menu.showAtPosition).toHaveBeenCalledWith(
      { x: 12, y: 34 },
      popoutDocument
    );
  });

  it('hands back the menu another handler already opened for the event, without showing it again', () => {
    vi.useFakeTimers();
    const evt = { pageX: 12, pageY: 34 } as MouseEvent;
    const existing = new Menu();
    evt.obsidian_contextmenu = existing as unknown as ObsidianMenu;

    const menu = new ContextMenuManager(createMenuMockPlugin()).menuForEvent(
      evt,
      document
    );
    vi.runAllTimers();

    expect(menu).toBe(existing);
    expect(existing.showAtPosition).not.toHaveBeenCalled();
  });
});
