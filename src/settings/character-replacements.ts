import {
  PluginSettingTab,
  SettingDefinitionPage,
  SettingDefinitionRender,
} from 'obsidian';
import { SettingPath } from './settings-paths';
import {
  buildDescRow,
  buildReplacedWithSummary,
  buildSummaryRow,
  FirstLineIsTitlePlugin,
  saveSettingsOrWarn,
} from './settings-base';
import { DEFAULT_SETTINGS } from '../constants';
import { t } from '../i18n';
import {
  CharKey,
  CharReplacementConfig,
  PRIMARY_CHAR_KEYS,
  WINDOWS_ANDROID_CHAR_KEYS,
} from '../types/char-replacement';
import { EntryEditModal, EntryField } from '../modals/entry-edit-modal';

/** Characters whose dialog explains them in the Replace toggle's description. */
const CHAR_NOTE_KEYS: Partial<Record<CharKey, string>> = {
  backslash: 'backslashNote',
  dot: 'dotNote',
};

/** The character's display label, keyed in the locale files by the setting key itself. */
function charLabel(key: CharKey): string {
  return t(`settings.characterReplacements.characters.${key}`);
}

/** What `processForbiddenChars` does with the character under this config, in the row's own words. */
function buildCharSummary(
  key: CharKey,
  config: CharReplacementConfig
): string | DocumentFragment {
  if (!config.enabled) {
    // An unreplaced dot is kept unless it leads the file name
    return key === 'dot'
      ? t('settings.characterReplacements.summary.keptExceptAtStart')
      : t('settings.common.summary.removed');
  }
  // Trims apply only alongside a non-empty replacement
  if (config.replacement === '') {
    return t('settings.common.summary.removed');
  }
  let trims = '';
  if (config.trimLeft && config.trimRight) {
    trims = t('settings.characterReplacements.summary.trimsBoth');
  } else if (config.trimLeft) {
    trims = t('settings.characterReplacements.summary.trimsLeft');
  } else if (config.trimRight) {
    trims = t('settings.characterReplacements.summary.trimsRight');
  }
  return buildReplacedWithSummary(config.replacement, trims);
}

type CharValues = Pick<
  CharReplacementConfig,
  'enabled' | 'replacement' | 'trimLeft' | 'trimRight'
>;

function openCharDialog(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab,
  key: CharKey
): void {
  const config = plugin.settings.characterReplacements.charReplacements[key];
  const noteKey = CHAR_NOTE_KEYS[key];
  const fields: EntryField<keyof CharValues>[] = [
    {
      type: 'toggle',
      key: 'enabled',
      name: t('settings.characterReplacements.dialog.replace'),
      desc: noteKey
        ? t(`settings.characterReplacements.characters.${noteKey}`)
        : undefined,
    },
    {
      type: 'text',
      key: 'replacement',
      name: t('settings.characterReplacements.headers.replaceWith'),
      placeholder: t('settings.common.emptyPlaceholder'),
      restoreDefault:
        DEFAULT_SETTINGS.characterReplacements.charReplacements[key]
          .replacement,
      stripForbiddenChars: true,
    },
    {
      type: 'toggle',
      key: 'trimLeft',
      name: t('settings.characterReplacements.headers.trimLeft'),
      desc: t('settings.characterReplacements.dialog.trimLeftDesc'),
    },
    {
      type: 'toggle',
      key: 'trimRight',
      name: t('settings.characterReplacements.headers.trimRight'),
      desc: t('settings.characterReplacements.dialog.trimRightDesc'),
    },
  ];

  new EntryEditModal<CharValues>(plugin.app, {
    title: charLabel(key),
    fields,
    initialValues: {
      enabled: config.enabled,
      replacement: config.replacement,
      trimLeft: config.trimLeft,
      trimRight: config.trimRight,
    },
    onSave: async (values) => {
      config.enabled = values.enabled;
      config.replacement = values.replacement;
      config.trimLeft = values.trimLeft;
      config.trimRight = values.trimRight;
      plugin.debugLog(`charReplacements.${key}`, config);
      await saveSettingsOrWarn(plugin);
      tab.update();
    },
  }).open();
}

/** One summary row per fixed character: no Add, Delete or drag, because the set never changes. */
function buildCharRows(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab,
  chars: CharKey[]
): SettingDefinitionRender[] {
  return chars.map((key) =>
    buildSummaryRow({
      name: charLabel(key),
      // Reads the stored config directly, matching what the engine applies
      buildDesc: () =>
        buildCharSummary(
          key,
          plugin.settings.characterReplacements.charReplacements[key]
        ),
      searchable: true,
      editEntry: () => openCharDialog(plugin, tab, key),
    })
  );
}

/** Character replacements sub-page. Each group lists its fixed characters as summary rows; a row's Edit opens a dialog holding that character's switch, replacement and trims. */
export function buildCharacterReplacementsPage(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab
): SettingDefinitionPage<SettingPath> {
  return {
    type: 'page',
    name: t('settings.sections.characterReplacements'),
    desc: t('settings.characterReplacements.desc'),
    // Blank rather than "Disabled" when off — see the note on the First line property page.
    displayValue: () =>
      plugin.settings.characterReplacements.enableForbiddenCharReplacements
        ? t('settings.common.enabled')
        : '',
    items: [
      {
        name: t('settings.characterReplacements.name'),
        // Deliberately not the section desc: the section summarizes what the page is for, the toggle explains what each position does.
        desc: t('settings.characterReplacements.toggleDesc'),
        control: {
          type: 'toggle',
          key: 'characterReplacements.enableForbiddenCharReplacements',
        },
      },
      {
        // A list, not a plain group, though nothing is added, deleted or dragged: on phones Obsidian stacks a plain group's control under the row text at full width, and only list rows keep the Edit button to the right
        type: 'list',
        heading: t('settings.characterReplacements.allOSes.title'),
        visible: () =>
          plugin.settings.characterReplacements.enableForbiddenCharReplacements,
        items: [
          buildDescRow(t('settings.characterReplacements.allOSes.desc')),
          ...buildCharRows(plugin, tab, PRIMARY_CHAR_KEYS),
        ],
      },
      {
        type: 'list',
        heading: t('settings.characterReplacements.windowsAndroid.title'),
        visible: () =>
          plugin.settings.characterReplacements.enableForbiddenCharReplacements,
        items: [
          buildDescRow(t('settings.characterReplacements.windowsAndroid.desc')),
          ...buildCharRows(plugin, tab, WINDOWS_ANDROID_CHAR_KEYS),
        ],
      },
    ],
  };
}
