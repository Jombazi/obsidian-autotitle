import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import { verboseLog } from '../utils';
import { EXCLUSION_STRATEGY, PluginSettings } from '../types';
import { t } from '../i18n';
import {
  excludedFileEntryKey,
  folderExclusionEntry,
  hasExcludedFileEntry,
} from '../utils/file-exclusions';

export class FolderOperations {
  constructor(
    private app: App,
    public settings: PluginSettings,
    private saveSettings: () => Promise<void>,
    private debugLog: (settingName: string, value: unknown) => void,
    private processMultipleFiles: (
      files: TFile[],
      action: 'rename'
    ) => Promise<void>
  ) {}

  async toggleFolderExclusion(
    folderPath: string,
    suppressNotice: boolean = false
  ): Promise<void> {
    // Normalize folder path to handle cross-platform differences and user typos
    folderPath = normalizePath(folderPath);
    const folderEntry = folderExclusionEntry(folderPath);

    const isInList = hasExcludedFileEntry(
      this.settings.exclusions.excludedFiles,
      folderEntry
    );
    const isInverted =
      this.settings.exclusions.fileScopeStrategy ===
      EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT;

    if (isInList) {
      const folderEntryKey = excludedFileEntryKey(folderEntry);
      this.settings.exclusions.excludedFiles =
        this.settings.exclusions.excludedFiles.filter(
          (entry) => excludedFileEntryKey(entry) !== folderEntryKey
        );

      if (!suppressNotice) {
        if (isInverted) {
          // In inverted mode, removing from list = disabling renaming
          verboseLog(
            this,
            `Showing notice: Renaming disabled for folder: ${folderPath}`
          );
          new Notice(
            t('notifications.disabledRenamingInFolder').replace(
              '{{folder}}',
              () => folderPath
            )
          );
        } else {
          // In normal mode, removing from list = enabling renaming
          verboseLog(
            this,
            `Showing notice: Renaming enabled for folder: ${folderPath}`
          );
          new Notice(
            t('notifications.enabledRenamingInFolder').replace(
              '{{folder}}',
              () => folderPath
            )
          );
        }
      }
    } else {
      this.settings.exclusions.excludedFiles.push(folderEntry);

      if (!suppressNotice) {
        if (isInverted) {
          // In inverted mode, adding to list = enabling renaming
          verboseLog(
            this,
            `Showing notice: Renaming enabled for folder: ${folderPath}`
          );
          new Notice(
            t('notifications.enabledRenamingInFolder').replace(
              '{{folder}}',
              () => folderPath
            )
          );
        } else {
          // In normal mode, adding to list = disabling renaming
          verboseLog(
            this,
            `Showing notice: Renaming disabled for folder: ${folderPath}`
          );
          new Notice(
            t('notifications.disabledRenamingInFolder').replace(
              '{{folder}}',
              () => folderPath
            )
          );
        }
      }
    }

    this.debugLog('excludedFiles', this.settings.exclusions.excludedFiles);
    await this.saveSettings();
    verboseLog(this, `Folder exclusion toggled for: ${folderPath}`, {
      isNowInList: !isInList,
    });
  }

  getSelectedFolders(): TFolder[] {
    const selectedFolders: TFolder[] = [];

    // Try multiple selection patterns that Obsidian might use
    const selectors = [
      '.nav-folder.is-selected',
      '.nav-folder.is-active',
      '.nav-folder-title.is-selected',
      '.nav-folder-title.is-active',
      '.tree-item.is-selected .nav-folder-title',
      '.tree-item.is-active .nav-folder-title',
    ];

    selectors.forEach((selector) => {
      const elements = document.querySelectorAll(selector);
      elements.forEach((element) => {
        let folderPath = element.getAttribute('data-path');

        if (!folderPath) {
          const parent = element.closest('.nav-folder, .tree-item');
          if (parent) {
            folderPath = parent.getAttribute('data-path');
          }
        }

        if (folderPath) {
          const folder = this.app.vault.getAbstractFileByPath(folderPath);
          if (folder instanceof TFolder && !selectedFolders.includes(folder)) {
            selectedFolders.push(folder);
          }
        }
      });
    });

    return selectedFolders;
  }

  getSelectedFiles(): TFile[] {
    const selectedFiles: TFile[] = [];

    const selectors = [
      '.nav-file.is-selected',
      '.nav-file.is-active',
      '.nav-file-title.is-selected',
      '.nav-file-title.is-active',
      '.tree-item.is-selected .nav-file-title',
      '.tree-item.is-active .nav-file-title',
    ];

    selectors.forEach((selector) => {
      const elements = document.querySelectorAll(selector);
      elements.forEach((element) => {
        let filePath = element.getAttribute('data-path');

        if (!filePath) {
          const parent = element.closest('.nav-file, .tree-item');
          if (parent) {
            filePath = parent.getAttribute('data-path');
          }
        }

        if (filePath) {
          const file = this.app.vault.getAbstractFileByPath(filePath);
          if (
            file instanceof TFile &&
            file.extension === 'md' &&
            !selectedFiles.includes(file)
          ) {
            selectedFiles.push(file);
          }
        }
      });
    });

    return selectedFiles;
  }

  getAllMarkdownFilesInFolder(folder: TFolder): TFile[] {
    const files: TFile[] = [];

    // Always recurse: the exclusion rules, not this walk, decide which notes in subfolders a folder-menu bulk rename skips
    const processFolder = (currentFolder: TFolder) => {
      currentFolder.children.forEach((child) => {
        if (child instanceof TFile && child.extension === 'md') {
          files.push(child);
        } else if (child instanceof TFolder) {
          processFolder(child);
        }
      });
    };

    processFolder(folder);
    return files;
  }

  async processMultipleFolders(
    folders: TFolder[],
    action: 'rename' | 'disable' | 'enable'
  ): Promise<void> {
    if (folders.length === 0) return;

    if (action === 'rename') {
      const allFiles: TFile[] = [];
      folders.forEach((folder) => {
        const folderFiles = this.getAllMarkdownFilesInFolder(folder);
        allFiles.push(...folderFiles);
      });

      if (allFiles.length === 0) {
        verboseLog(
          this,
          `Showing notice: No Markdown files found in selected folders.`
        );
        new Notice(t('notifications.noNotesFoundInFolders'));
        return;
      }

      verboseLog(
        this,
        `Showing notice: Renaming ${allFiles.length} files from ${folders.length} folders...`
      );
      new Notice(
        t('notifications.renamingNNotes').replace(
          '{{count}}',
          String(allFiles.length)
        )
      );

      await this.processMultipleFiles(allFiles, 'rename');
    } else {
      // Under "Exclude all except..." a listed folder is one renaming is enabled in, so the action maps to the opposite list state
      const isInverted =
        this.settings.exclusions.fileScopeStrategy ===
        EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT;
      const shouldBeListed = (action === 'disable') !== isInverted;
      for (const folder of folders) {
        // The vault root has no entry of its own, as in Obsidian's Excluded files, where `//` matches nothing
        if (folder.isRoot()) continue;
        try {
          const isListed = hasExcludedFileEntry(
            this.settings.exclusions.excludedFiles,
            folderExclusionEntry(folder.path)
          );

          if (isListed !== shouldBeListed) {
            await this.toggleFolderExclusion(folder.path, true);
          }
        } catch (error) {
          console.error(`Error processing folder ${folder.path}:`, error);
        }
      }

      verboseLog(
        this,
        `${action === 'disable' ? 'Disabled' : 'Enabled'} renaming for ${folders.length} folders.`
      );
      new Notice(
        (action === 'enable'
          ? t('notifications.enabledRenamingInNFolders')
          : t('notifications.disabledRenamingInNFolders')
        ).replace('{{count}}', String(folders.length))
      );
    }
  }
}
