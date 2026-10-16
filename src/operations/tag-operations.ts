import { Notice } from 'obsidian';
import { verboseLog } from '../utils';
import { PluginSettings } from '../types';
import { t } from '../i18n';
import {
  excludedTagEntryKey,
  hasExcludedTagEntry,
  tagKey,
} from '../utils/tag-utils';
import { listedEntryDisablesRenaming } from '../utils/exclusion-strategy';

export class TagOperations {
  constructor(
    private getSettings: () => PluginSettings,
    private saveSettings: () => Promise<void>,
    private debugLog: (settingName: string, value: unknown) => void
  ) {}

  /** Read live, because Clear settings and Import replace the plugin's settings object; public because `verboseLog(this, …)` takes `{ settings }`. */
  get settings(): PluginSettings {
    return this.getSettings();
  }

  async toggleTagExclusion(tagName: string): Promise<void> {
    const tagToFind = tagName.startsWith('#') ? tagName : `#${tagName}`;
    const isInList = hasExcludedTagEntry(
      this.settings.exclusions.excludedTags,
      tagToFind
    );

    if (isInList) {
      // Every entry with the tag's key goes, so `project` and `#Project` cannot leave the tag listed; a pattern entry's key never equals a tag's, so patterns stay
      const targetTagKey = tagKey(tagToFind);
      this.settings.exclusions.excludedTags =
        this.settings.exclusions.excludedTags.filter(
          (tag) => excludedTagEntryKey(tag) !== targetTagKey
        );
    } else {
      this.settings.exclusions.excludedTags.push(tagToFind);
    }

    const isNowDisabled =
      !isInList ===
      listedEntryDisablesRenaming(this.settings.exclusions.tagScopeStrategy);
    verboseLog(
      this,
      `Showing notice: Renaming ${isNowDisabled ? 'disabled' : 'enabled'} for ${tagToFind}`
    );
    new Notice(
      t(
        isNowDisabled
          ? 'notifications.disabledRenamingForTag'
          : 'notifications.enabledRenamingForTag',
        { tag: tagToFind }
      )
    );

    this.debugLog('excludedTags', this.settings.exclusions.excludedTags);
    await this.saveSettings();
    verboseLog(this, `Tag exclusion toggled for: ${tagToFind}`, {
      isNowInList: !isInList,
    });
  }
}
