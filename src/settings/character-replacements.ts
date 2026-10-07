import {
  Notice,
  PluginSettingTab,
  SettingDefinitionPage,
  SettingDefinitionRender,
} from 'obsidian';
import {
  buildDescRow,
  buildReplacedWithSummary,
  buildSummaryRow,
  FirstLineIsTitlePlugin,
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

/**
 * Sub-key under `settings.characterReplacements.characters` holding each
 * character's display label. Two keys differ from the setting key itself.
 */
const CHAR_LABEL_KEYS: Record<CharKey, string> = {
  leftBracket: 'leftBracket',
  rightBracket: 'rightBracket',
  hash: 'hash',
  caret: 'caret',
  pipe: 'pipe',
  backslash: 'backslash',
  slash: 'forwardSlash',
  colon: 'colon',
  dot: 'dot',
  asterisk: 'asterisk',
  quote: 'quote',
  lessThan: 'lessThan',
  greaterThan: 'greaterThan',
  question: 'questionMark',
};

/** Characters whose dialog explains them in the Replace toggle's description. */
const CHAR_NOTE_KEYS: Partial<Record<CharKey, string>> = {
  backslash: 'backslashNote',
  dot: 'dotNote',
};

async function persistSettings(plugin: FirstLineIsTitlePlugin): Promise<void> {
  try {
    await plugin.saveSettings();
  } catch {
    const notice = new Notice(t('settings.errors.saveFailed'));
    notice.containerEl.addClass('mod-warning');
  }
}

function charLabel(key: CharKey): string {
  return t(`settings.characterReplacements.characters.${CHAR_LABEL_KEYS[key]}`);
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
      : t('settings.characterReplacements.summary.removed');
  }
  // Trims apply only alongside a non-empty replacement
  if (config.replacement === '') {
    return t('settings.characterReplacements.summary.removed');
  }
  const trimsLeft = config.trimLeft;
  let trims = '';
  if (trimsLeft && config.trimRight) {
    trims = t('settings.characterReplacements.summary.trimsBoth');
  } else if (trimsLeft) {
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
  key: CharKey,
  isWindowsAndroid: boolean
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
      placeholder: t('settings.characterReplacements.emptyPlaceholder'),
      restoreDefault:
        DEFAULT_SETTINGS.characterReplacements.charReplacements[key]
          .replacement,
      forbiddenChars: isWindowsAndroid ? 'windowsAndroid' : 'currentOS',
    },
  ];
  fields.push({
    type: 'toggle',
    key: 'trimLeft',
    name: t('settings.characterReplacements.headers.trimLeft'),
    desc: t('settings.characterReplacements.dialog.trimLeftDesc'),
  });
  fields.push({
    type: 'toggle',
    key: 'trimRight',
    name: t('settings.characterReplacements.headers.trimRight'),
    desc: t('settings.characterReplacements.dialog.trimRightDesc'),
  });

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
      await persistSettings(plugin);
      tab.update();
    },
  }).open();
}

/** One summary row per fixed character: no Add, Delete or drag, because the set never changes. */
function buildCharRows(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab,
  chars: CharKey[],
  isWindowsAndroid: boolean
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
      editEntry: () => openCharDialog(plugin, tab, key, isWindowsAndroid),
    })
  );
}

/**
 * Character replacements sub-page.
 *
 * Each group lists its fixed characters as summary rows; a row's Edit opens a
 * dialog holding that character's switch, replacement and trims.
 */
export function buildCharacterReplacementsPage(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab
): SettingDefinitionPage {
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
        // Deliberately not the section desc: the section summarises what the
        // page is for, the toggle explains what each position does.
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
          ...buildCharRows(plugin, tab, PRIMARY_CHAR_KEYS, false),
        ],
      },
      {
        type: 'list',
        heading: t('settings.characterReplacements.windowsAndroid.title'),
        visible: () =>
          plugin.settings.characterReplacements.enableForbiddenCharReplacements,
        items: [
          buildDescRow(t('settings.characterReplacements.windowsAndroid.desc')),
          ...buildCharRows(plugin, tab, WINDOWS_ANDROID_CHAR_KEYS, true),
        ],
      },
    ],
  };
}
