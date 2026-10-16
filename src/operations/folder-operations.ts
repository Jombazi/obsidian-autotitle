import { Notice, TFolder, normalizePath } from 'obsidian';
import { verboseLog } from '../utils';
import { PluginSettings } from '../types';
import { t, tp } from '../i18n';
import {
  folderExclusionEntry,
  hasExcludedFileEntry,
} from '../utils/file-exclusions';
import { exclusionEntryKey } from '../utils/exclusion-pattern';
import { listedEntryDisablesRenaming } from '../utils/exclusion-strategy';

export class FolderOperations {
  constructor(
    private getSettings: () => PluginSettings,
    private saveSettings: () => Promise<void>,
    private debugLog: (settingName: string, value: unknown) => void
  ) {}

  /** Read live, because Clear settings and Import replace the plugin's settings object; public because `verboseLog(this, …)` takes `{ settings }`. */
  get settings(): PluginSettings {
    return this.getSettings();
  }

  async toggleFolderExclusion(
    folderPath: string,
    suppressNotice: boolean = false
  ): Promise<void> {
    this.toggleFolderExclusionEntry(folderPath, suppressNotice);
    await this.saveSettings();
  }

  /** Toggles the folder's entry without saving, so a several-folder action writes `data.json` (a synced file) once. */
  private toggleFolderExclusionEntry(
    folderPath: string,
    suppressNotice: boolean
  ): void {
    // Normalize folder path to handle cross-platform differences and user typos
    folderPath = normalizePath(folderPath);
    const folderEntry = folderExclusionEntry(folderPath);

    const isInList = hasExcludedFileEntry(
      this.settings.exclusions.excludedFiles,
      folderEntry
    );

    if (isInList) {
      const folderEntryKey = exclusionEntryKey(folderEntry);
      this.settings.exclusions.excludedFiles =
        this.settings.exclusions.excludedFiles.filter(
          (entry) => exclusionEntryKey(entry) !== folderEntryKey
        );
    } else {
      this.settings.exclusions.excludedFiles.push(folderEntry);
    }

    if (!suppressNotice) {
      const isNowDisabled =
        !isInList ===
        listedEntryDisablesRenaming(this.settings.exclusions.fileScopeStrategy);
      verboseLog(
        this,
        `Showing notice: Renaming ${isNowDisabled ? 'disabled' : 'enabled'} for folder: ${folderPath}`
      );
      new Notice(
        t(
          isNowDisabled
            ? 'notifications.disabledRenamingInFolder'
            : 'notifications.enabledRenamingInFolder'
        ).replace('{{folder}}', () => folderPath)
      );
    }

    this.debugLog('excludedFiles', this.settings.exclusions.excludedFiles);
    verboseLog(this, `Folder exclusion toggled for: ${folderPath}`, {
      isNowInList: !isInList,
    });
  }

  async processMultipleFolders(
    folders: TFolder[],
    action: 'disable' | 'enable'
  ): Promise<void> {
    if (folders.length === 0) return;

    const shouldBeListed =
      (action === 'disable') ===
      listedEntryDisablesRenaming(this.settings.exclusions.fileScopeStrategy);
    let hasToggledAny = false;
    for (const folder of folders) {
      // The vault root has no entry of its own, as in Obsidian's Excluded files, where `//` matches nothing
      if (folder.isRoot()) continue;
      try {
        const isListed = hasExcludedFileEntry(
          this.settings.exclusions.excludedFiles,
          folderExclusionEntry(folder.path)
        );

        if (isListed !== shouldBeListed) {
          this.toggleFolderExclusionEntry(folder.path, true);
          hasToggledAny = true;
        }
      } catch (error) {
        console.error(`Error processing folder ${folder.path}:`, error);
      }
    }
    if (hasToggledAny) {
      // Logged rather than thrown, as a failed folder is, so the summary notice still shows
      try {
        await this.saveSettings();
      } catch (error) {
        console.error('Error saving folder exclusions:', error);
      }
    }

    verboseLog(
      this,
      `${action === 'disable' ? 'Disabled' : 'Enabled'} renaming for ${folders.length} folders.`
    );
    new Notice(
      tp(
        action === 'enable'
          ? 'notifications.enabledRenamingInNFolders'
          : 'notifications.disabledRenamingInNFolders',
        folders.length
      )
    );
  }
}
