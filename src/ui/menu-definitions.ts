import { TFile, TFolder } from 'obsidian';
import { MenuConfig } from './menu-config';
import FirstLineIsTitlePlugin from '../../main';
import { ProcessTagModal, RenameFolderModal } from '../modals';
import { t } from '../i18n';
import { IGNORE_ALL_EXCLUSIONS } from '../types';
import { hasDisablePropertyInFile } from '../utils/disable-property';
import {
  isFolderFullyExcludedByFileRules,
  isTagFullyExcludedByTagRules,
} from '../utils/file-exclusions';

/**
 * Declarative Menu Definitions
 *
 * All context menu configurations defined as data structures.
 * Each menu type has its own configuration with visibility rules and actions.
 */

interface TagContext {
  tagName: string;
}

interface FolderContext {
  folder: TFolder;
}

interface FileContext {
  file: TFile;
}

/** The checks deciding which half of a folder's or tag's Disable/Enable pair a menu shows; the scope strategy flips which half, never its wording, so each action has one title. */
export interface DisableMenuVisibility {
  shouldShowDisableMenuForFolder(folderPath: string): boolean;
  shouldShowDisableMenuForTag(tagName: string): boolean;
}

export class MenuDefinitions {
  constructor(
    private plugin: FirstLineIsTitlePlugin,
    private visibility: DisableMenuVisibility
  ) {}

  /**
   * Tag context menu configuration
   */
  getTagMenuConfig(): MenuConfig<TagContext> {
    return {
      items: [
        {
          title: t('commands.putFirstLineInTitle'),
          icon: 'file-type-corner',
          // Hidden when exclusions leave no note to rename, since the dialog would only say so
          visible: ({ tagName }) =>
            this.plugin.settings.core.enableTagCommands &&
            !isTagFullyExcludedByTagRules(
              tagName,
              this.plugin.settings,
              this.plugin.app
            ),
          onClick: ({ tagName }) => {
            new ProcessTagModal(this.plugin.app, this.plugin, tagName).open();
          },
        },
        {
          title: t('commands.disableRenamingForTag'),
          icon: 'pen-off',
          visible: ({ tagName }) =>
            this.plugin.settings.core.enableTagCommands &&
            this.visibility.shouldShowDisableMenuForTag(tagName),
          onClick: async ({ tagName }) => {
            await this.plugin.toggleTagExclusion(tagName);
          },
        },
        {
          title: t('commands.enableRenamingForTag'),
          icon: 'file-pen',
          visible: ({ tagName }) =>
            this.plugin.settings.core.enableTagCommands &&
            !this.visibility.shouldShowDisableMenuForTag(tagName),
          onClick: async ({ tagName }) => {
            await this.plugin.toggleTagExclusion(tagName);
          },
        },
      ],
    };
  }

  /**
   * Folder context menu configuration
   */
  getFolderMenuConfig(): MenuConfig<FolderContext> {
    return {
      items: [
        {
          title: t('commands.putFirstLineInTitle'),
          icon: 'file-type-corner',
          // Hidden when exclusions leave no note to rename, since the dialog would only say so
          visible: ({ folder }) =>
            this.plugin.settings.core.enableFolderCommands &&
            !isFolderFullyExcludedByFileRules(folder, this.plugin.settings),
          onClick: ({ folder }) => {
            new RenameFolderModal(this.plugin.app, this.plugin, folder).open();
          },
        },
        {
          title: t('commands.disableRenamingInFolder'),
          icon: 'pen-off',
          // The vault root has no entry of its own, as in Obsidian's Excluded files; the explorer passes it on a blank-area right-click
          visible: ({ folder }) =>
            this.plugin.settings.core.enableFolderCommands &&
            !folder.isRoot() &&
            this.visibility.shouldShowDisableMenuForFolder(folder.path),
          onClick: async ({ folder }) => {
            await this.plugin.toggleFolderExclusion(folder.path);
          },
        },
        {
          title: t('commands.enableRenamingInFolder'),
          icon: 'file-pen',
          visible: ({ folder }) =>
            this.plugin.settings.core.enableFolderCommands &&
            !folder.isRoot() &&
            !this.visibility.shouldShowDisableMenuForFolder(folder.path),
          onClick: async ({ folder }) => {
            await this.plugin.toggleFolderExclusion(folder.path);
          },
        },
      ],
    };
  }

  /**
   * File context menu configuration
   */
  getFileMenuConfig(): MenuConfig<FileContext> {
    return {
      items: [
        {
          title: t('commands.putFirstLineInTitle'),
          icon: 'file-type-corner',
          visible: () => this.plugin.settings.core.enableFileCommands,
          onClick: async ({ file }) => {
            await this.plugin.renameEngine.processFile(file, {
              isManualCommand: true,
              exclusionOverrides: IGNORE_ALL_EXCLUSIONS,
            });
          },
        },
        {
          title: t('commands.disableRenamingForNote'),
          icon: 'pen-off',
          visible: ({ file }) =>
            this.plugin.settings.core.enableFileCommands &&
            !this.hasDisableProperty(file),
          onClick: async ({ file }) => {
            await this.plugin.setRenamingDisabledForNote(file, true);
          },
        },
        {
          title: t('commands.enableRenamingForNote'),
          icon: 'file-pen',
          visible: ({ file }) =>
            this.plugin.settings.core.enableFileCommands &&
            this.hasDisableProperty(file),
          onClick: async ({ file }) => {
            await this.plugin.setRenamingDisabledForNote(file, false);
          },
        },
      ],
    };
  }

  private hasDisableProperty(file: TFile): boolean {
    return hasDisablePropertyInFile(
      file,
      this.plugin.app,
      this.plugin.settings
    );
  }
}
