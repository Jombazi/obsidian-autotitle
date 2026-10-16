import { Menu, TFile, TFolder } from 'obsidian';
import { verboseLog } from '../utils';
import { RenameMultipleFoldersModal } from '../modals';
import FirstLineIsTitlePlugin from '../../main';
import { tp } from '../i18n';
import { MenuRenderer } from './menu-config';
import { DisableMenuVisibility, MenuDefinitions } from './menu-definitions';
import { TIMING } from '../constants/timing';
import {
  folderExclusionEntry,
  hasExcludedFileEntry,
  isFolderFullyExcludedByFileRules,
} from '../utils/file-exclusions';
import { hasExcludedTagEntry } from '../utils/tag-utils';
import { listedEntryDisablesRenaming } from '../utils/exclusion-strategy';

/** Stops at the first note, so opening the menu never collects every note under a large folder only to learn whether there is one. */
function folderHasMarkdownFile(folder: TFolder): boolean {
  for (const child of folder.children) {
    if (child instanceof TFile) {
      if (child.extension === 'md') return true;
    } else if (child instanceof TFolder && folderHasMarkdownFile(child)) {
      return true;
    }
  }
  return false;
}

/**
 * Manages all context menu operations for the First Line is Title plugin.
 * Handles folder/tag menu creation and bulk operations.
 * Uses declarative menu configuration for clean, maintainable menu definitions.
 */
export class ContextMenuManager implements DisableMenuVisibility {
  private plugin: FirstLineIsTitlePlugin;
  private menuRenderer: MenuRenderer;
  private menuDefinitions: MenuDefinitions;

  constructor(plugin: FirstLineIsTitlePlugin) {
    this.plugin = plugin;
    this.menuRenderer = new MenuRenderer();
    this.menuDefinitions = new MenuDefinitions(plugin, this);
  }

  /**
   * Creates or retrieves a context menu for the given mouse event.
   * Uses Tag Wrangler's menuForEvent pattern.
   * @param evt - The `contextmenu` event
   * @param doc - The document the event fired in, so a menu opened in a pop-out window shows in that window rather than the main one
   */
  menuForEvent(evt: MouseEvent, doc?: Document): Menu {
    let menu = evt.obsidian_contextmenu;
    if (!menu) {
      menu = evt.obsidian_contextmenu = new Menu();
      window.setTimeout(
        () => menu!.showAtPosition({ x: evt.pageX, y: evt.pageY }, doc),
        TIMING.NEXT_TICK_MS
      );
    }
    return menu;
  }

  /**
   * Determines whether to show disable menu option for a folder based on scope strategy.
   */
  shouldShowDisableMenuForFolder(folderPath: string): boolean {
    const folderEntry = folderExclusionEntry(folderPath);
    const isInList = hasExcludedFileEntry(
      this.plugin.settings.exclusions.excludedFiles,
      folderEntry
    );

    // Disable shows while renaming is on, which is when the folder's listing does not disable it
    const result =
      isInList !==
      listedEntryDisablesRenaming(
        this.plugin.settings.exclusions.fileScopeStrategy
      );

    verboseLog(this.plugin, `shouldShowDisableMenuForFolder(${folderPath})`, {
      fileScopeStrategy: this.plugin.settings.exclusions.fileScopeStrategy,
      folderEntry,
      isInList,
      result,
      willShow: result ? 'DISABLE menu' : 'ENABLE menu',
    });

    return result;
  }

  /**
   * Determines whether to show disable menu option for a tag based on scope strategy.
   */
  shouldShowDisableMenuForTag(tagName: string): boolean {
    const tagToFind = tagName.startsWith('#') ? tagName : `#${tagName}`;
    const isInList = hasExcludedTagEntry(
      this.plugin.settings.exclusions.excludedTags,
      tagToFind
    );

    // Disable shows while renaming is on, which is when the tag's listing does not disable it
    const result =
      isInList !==
      listedEntryDisablesRenaming(
        this.plugin.settings.exclusions.tagScopeStrategy
      );

    verboseLog(this.plugin, `shouldShowDisableMenuForTag(${tagName})`, {
      tagScopeStrategy: this.plugin.settings.exclusions.tagScopeStrategy,
      tagToFind,
      isInList,
      result,
      willShow: result ? 'DISABLE menu' : 'ENABLE menu',
    });

    return result;
  }

  /**
   * Adds tag-related menu items to a context menu.
   * Uses declarative menu configuration for clean, maintainable code.
   */
  addTagMenuItems(menu: Menu, tagName: string): void {
    const config = this.menuDefinitions.getTagMenuConfig();
    const context = { tagName };
    this.menuRenderer.render(menu, config, context);
  }

  /**
   * Adds folder-related menu items to a context menu.
   * Uses declarative menu configuration for clean, maintainable code.
   */
  addFolderMenuItems(menu: Menu, folder: TFolder): void {
    const config = this.menuDefinitions.getFolderMenuConfig();
    const context = { folder };
    this.menuRenderer.render(menu, config, context);
  }

  /**
   * Adds file-related menu items to a context menu.
   * Uses declarative menu configuration for clean, maintainable code.
   */
  addFileMenuItems(menu: Menu, file: TFile): void {
    const config = this.menuDefinitions.getFileMenuConfig();
    const context = { file };
    this.menuRenderer.render(menu, config, context);
  }

  /**
   * Adds menu items for bulk operations on multiple folders.
   */
  addMultiFolderMenuItems(menu: Menu, folders: TFolder[]): void {
    if (!this.plugin.settings.core.enableFolderCommands) return;

    // Hidden when exclusions leave no note to rename, since the dialog would only say so
    const hasRenameCommand =
      folders.some(folderHasMarkdownFile) &&
      !folders.every((folder) =>
        isFolderFullyExcludedByFileRules(folder, this.plugin.settings)
      );

    // No separator here — see MenuRenderer.render for why.
    if (hasRenameCommand) {
      menu.addItem((item) => {
        item
          .setTitle(tp('commands.putFirstLineInTitleNFolders', folders.length))
          .setIcon('file-type-corner')
          .onClick(() => {
            new RenameMultipleFoldersModal(
              this.plugin.app,
              this.plugin,
              folders
            ).open();
          });
      });
    }

    menu.addItem((item) => {
      item
        .setTitle(tp('commands.disableRenamingNFolders', folders.length))
        .setIcon('pen-off')
        .onClick(async () => {
          await this.plugin.processMultipleFolders(folders, 'disable');
        });
    });

    menu.addItem((item) => {
      item
        .setTitle(tp('commands.enableRenamingNFolders', folders.length))
        .setIcon('file-pen')
        .onClick(async () => {
          await this.plugin.processMultipleFolders(folders, 'enable');
        });
    });
  }
}
