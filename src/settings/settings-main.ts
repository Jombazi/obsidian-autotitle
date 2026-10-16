import {
  PluginSettingTab,
  App,
  Plugin,
  SettingDefinitionItem,
  debounce,
} from 'obsidian';
import {
  FirstLineIsTitlePlugin,
  saveSettingsOrWarn,
  TYPED_SETTING_DEBOUNCE_MS,
} from './settings-base';
import { getCurrentLocale, t } from '../i18n';
import { getPath, setPath, SettingPath } from './settings-paths';
import { PluginSettings } from '../types';

import {
  buildGeneralDefinitions,
  buildNewNotesGroup,
  buildFooterDefinitions,
  buildSupportGroup,
} from './general';
import { buildExclusionsPage } from './exclusions';
import { buildCharacterReplacementsPage } from './character-replacements';
import { buildCustomReplacementsPage } from './custom-replacements';
import { buildMarkupStrippingPage } from './markup-stripping';
import { buildFirstLinePropertyPage } from './first-line-property';
import { buildCommandsPage } from './commands';
import { buildOtherPage } from './other';

type Cascade = (plugin: FirstLineIsTitlePlugin) => void;

// One function shared by every key it serves, so `runChangedCascades` runs it once however many of them changed
const refreshPropertyVisibility: Cascade = (plugin) =>
  plugin.updatePropertyVisibility();

// Stamps when debugging was switched on so log output is attributable
const stampDebugEnabled: Cascade = (plugin) => {
  const enabled = plugin.settings.core.debug;
  plugin.settings.core.debugEnabledTimestamp = enabled
    ? plugin.getCurrentTimestamp()
    : '';
  if (enabled) plugin.outputAllSettings();
};

/** Side effects that must run when a given key changes. The declarative API has no per-control onChange hook, but every `control` write is routed through `setControlValue`, which runs the key's entry; a wholesale replacement runs every entry whose key changed through `runChangedCascades`. Cascades mutate settings directly and never re-enter either, so there is no recursion and exactly one save per user action. */
const CASCADES: Partial<Record<SettingPath, Cascade>> = {
  'firstLineProperty.hideProperty': refreshPropertyVisibility,
  'firstLineProperty.hideInSidebar': refreshPropertyVisibility,
  // No control writes this key: the property name row runs it through the tab's debouncer, and a replacement through `runChangedCascades`
  'firstLineProperty.propertyKey': refreshPropertyVisibility,

  'core.debug': stampDebugEnabled,
};

/** Runs the cascade of every key whose value differs between `previous` and the plugin's current settings, after the settings were replaced wholesale. Every cascade key is a primitive leaf, so `!==` is a complete comparison. */
export function runChangedCascades(
  plugin: FirstLineIsTitlePlugin,
  previous: PluginSettings
): void {
  const pending = new Set<Cascade>();
  // `Object.keys` types its result as plain strings; every key is one CASCADES was declared with
  for (const key of Object.keys(CASCADES) as SettingPath[]) {
    const cascade = CASCADES[key];
    if (cascade && getPath(previous, key) !== getPath(plugin.settings, key)) {
      pending.add(cascade);
    }
  }
  // A hand-trimmed import can turn debug on without its timestamp, which would leave the 24-hour auto-disable in `onload` nothing to measure from
  const { core } = plugin.settings;
  if (core.debug && !core.debugEnabledTimestamp) {
    pending.add(stampDebugEnabled);
  }
  for (const cascade of pending) cascade(plugin);
}

export class FirstLineIsTitleSettings extends PluginSettingTab {
  plugin: FirstLineIsTitlePlugin;

  /** Applies a typed property name once typing pauses, so property hiding is not rebuilt for every partial name. Obsidian's `debounce` schedules on `activeWindow`, which is the Settings window while it is open, and a timer pending there dies when that window closes (measured), so `hide()` runs it first. */
  private readonly requestPropertyKeyCascade = debounce(
    () => refreshPropertyVisibility(this.plugin),
    TYPED_SETTING_DEBOUNCE_MS,
    true
  );

  constructor(app: App, plugin: FirstLineIsTitlePlugin) {
    // PluginSettingTab expects Plugin, but we use minimal interface for flexibility
    super(app, plugin as unknown as Plugin);
    this.plugin = plugin;
    this.icon = 'file-type-corner';
  }

  // Narrower than Obsidian's `string`: every control on this tab is declared with a SettingPath key, and Obsidian passes back the key it was given
  getControlValue(key: SettingPath): unknown {
    return getPath(this.plugin.settings, key);
  }

  async setControlValue(key: SettingPath, value: unknown): Promise<void> {
    setPath(this.plugin.settings, key, value);
    CASCADES[key]?.(this.plugin);

    // Not awaited: the settings object already holds the value, so the control's refresh need not wait on the disk
    void saveSettingsOrWarn(this.plugin);

    // No `refreshDomState()` here: Obsidian's control binding awaits this method and then calls it itself (app.js 1.14.4, `getControlBinding`). No cascade writes a value another row shows, so nothing needs a full `update()` either
  }

  getSettingDefinitions(): SettingDefinitionItem<SettingPath>[] {
    return [
      // General settings stay at the top level with no heading, per Obsidian's convention that a tab's primary section is unlabeled.
      ...buildGeneralDefinitions(this.plugin),
      // Page-level action closes out the everyday settings, above the Exclusions row.
      ...buildFooterDefinitions(this.plugin),
      buildExclusionsPage(this.plugin, this),
      buildNewNotesGroup(this.plugin),
      {
        type: 'group',
        heading: t('settings.sections.advancedGroup'),
        items: [
          // Sorted by displayed name so the order is alphabetical in every locale.
          ...[
            buildFirstLinePropertyPage(
              this.plugin,
              this,
              this.requestPropertyKeyCascade
            ),
            buildCharacterReplacementsPage(this.plugin, this),
            buildCommandsPage(this.plugin),
            buildCustomReplacementsPage(this.plugin, this),
            buildMarkupStrippingPage(this.plugin),
          ].sort((a, b) => a.name.localeCompare(b.name, getCurrentLocale())),
          // Last whatever its name: it holds what fits no other page.
          buildOtherPage(this.plugin, this),
        ],
      },
      buildSupportGroup(),
    ];
  }

  hide(): void {
    // Before the Settings window can close and take the pending timer with it
    this.requestPropertyKeyCascade.run();
    // A save typing left pending would die with the Settings window's timers, like the cascade above
    this.plugin.flushSettingsSave();
    super.hide();
  }
}
