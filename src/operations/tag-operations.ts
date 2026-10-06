import { Notice } from 'obsidian';
import { verboseLog } from '../utils';
import { EXCLUSION_STRATEGY, PluginSettings } from '../types';
import { t } from '../i18n';

export class TagOperations {
  constructor(
    public settings: PluginSettings,
    private saveSettings: () => Promise<void>,
    private debugLog: (settingName: string, value: unknown) => void
  ) {}

  async toggleTagExclusion(tagName: string): Promise<void> {
    const tagToFind = tagName.startsWith('#') ? tagName : `#${tagName}`;
    const isInList = this.settings.exclusions.excludedTags.includes(tagToFind);
    const isInverted =
      this.settings.exclusions.tagScopeStrategy ===
      EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT;

    if (isInList) {
      this.settings.exclusions.excludedTags =
        this.settings.exclusions.excludedTags.filter(
          (tag) => tag !== tagToFind
        );
      // Ensure there's always at least one entry (even if empty)
      if (this.settings.exclusions.excludedTags.length === 0) {
        this.settings.exclusions.excludedTags.push('');
      }

      if (isInverted) {
        // In inverted mode, removing from list = disabling renaming
        verboseLog(this, `Showing notice: Renaming disabled for ${tagToFind}`);
        new Notice(
          t('notifications.disabledRenamingFor', { filename: tagToFind })
        );
      } else {
        // In normal mode, removing from list = enabling renaming
        verboseLog(this, `Showing notice: Renaming enabled for ${tagToFind}`);
        new Notice(
          t('notifications.enabledRenamingFor', { filename: tagToFind })
        );
      }
    } else {
      if (
        this.settings.exclusions.excludedTags.length === 1 &&
        this.settings.exclusions.excludedTags[0] === ''
      ) {
        this.settings.exclusions.excludedTags[0] = tagToFind;
      } else {
        this.settings.exclusions.excludedTags.push(tagToFind);
      }

      if (isInverted) {
        // In inverted mode, adding to list = enabling renaming
        verboseLog(this, `Showing notice: Renaming enabled for ${tagToFind}`);
        new Notice(
          t('notifications.enabledRenamingFor', { filename: tagToFind })
        );
      } else {
        // In normal mode, adding to list = disabling renaming
        verboseLog(this, `Showing notice: Renaming disabled for ${tagToFind}`);
        new Notice(
          t('notifications.disabledRenamingFor', { filename: tagToFind })
        );
      }
    }

    this.debugLog('excludedTags', this.settings.exclusions.excludedTags);
    await this.saveSettings();
    verboseLog(this, `Tag exclusion toggled for: ${tagToFind}`, {
      isNowInList: !isInList,
    });
  }
}
