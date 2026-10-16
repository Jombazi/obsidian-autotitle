import {
  Debouncer,
  PluginSettingTab,
  SettingDefinitionItem,
  SettingDefinitionPage,
  TextComponent,
} from 'obsidian';
import { SettingPath } from './settings-paths';
import {
  FirstLineIsTitlePlugin,
  addRestoreDefaultButton,
  quoteLabel,
} from './settings-base';
import { t } from '../i18n';
import { DEFAULT_SETTINGS } from '../constants';
import { hasFirstLinePropertyName } from '../utils/first-line-property-keys';
import { PropertyHidingOption } from '../types';

/** Description for the property name row: prose plus bare newline-separated notes. */
function buildPropertyKeyDescription(): DocumentFragment {
  return createFragment((frag) => {
    frag.appendText(t('settings.firstLineProperty.propertyName.desc'));

    const notes = frag.createDiv();

    notes.appendText(
      t('settings.firstLineProperty.propertyName.multipleProperties')
    );
    notes.createEl('br');
    notes.appendText(
      t('settings.firstLineProperty.propertyName.quickSwitcher')
    );
  });
}

/** `requestPropertyKeyCascade` applies the property name to property hiding; the tab owns it, so it can run a pending call when Settings closes. */
export function buildFirstLinePropertyPage(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab,
  requestPropertyKeyCascade: Debouncer<[], void>
): SettingDefinitionPage<SettingPath> {
  // A blank name turns the feature off, so everything below the name field is meaningless and hidden rather than shown grayed out.
  const firstLinePropertyEnabled = () =>
    hasFirstLinePropertyName(plugin.settings);

  const items: SettingDefinitionItem<SettingPath>[] = [
    // A plain row, not a group: every row on this page is plain, so the renderer folds them all into one box.
    {
      // `render`, not `control`: `SettingControlBase` exposes only `key`, `defaultValue`, `validate` and `disabled`, so a control can neither mount the restore button nor store a trimmed name while the field keeps what was typed.
      name: t('settings.firstLineProperty.propertyName.name'),
      desc: buildPropertyKeyDescription(),
      render: (setting) => {
        const defaultKey = DEFAULT_SETTINGS.firstLineProperty.propertyKey;
        let textComponent: TextComponent | null = null;

        // The save and property hiding wait for typing to pause, so partial names neither write data.json nor rebuild hiding; without the cascade, clearing the key would leave the old key's properties hidden
        const persist = () => {
          plugin.debugLog(
            'propertyKey',
            plugin.settings.firstLineProperty.propertyKey
          );
          plugin.requestSaveSettings();
          requestPropertyKeyCascade();
          // Per keystroke, so the rows below show or hide as the name is typed. Not `update()`: it would tear down and rebuild this focused `render` row, losing the caret, while only the `visible` predicates of the rows below changed.
          tab.refreshDomState();
        };

        // Before the text field, so the button sits to its left
        const setRestoreDimmed = addRestoreDefaultButton(
          setting.controlEl,
          () => {
            const isStoredDefault =
              plugin.settings.firstLineProperty.propertyKey === defaultKey;
            textComponent?.setValue(defaultKey);
            syncRestoreState();
            // The field is reset either way, since it can hold spaces the stored, trimmed name lacks; the name is written only when it changes
            if (isStoredDefault) return;
            plugin.settings.firstLineProperty.propertyKey = defaultKey;
            persist();
            // A click, not typing: run both at once rather than after the pause
            plugin.flushSettingsSave();
            requestPropertyKeyCascade.run();
          }
        );
        // Gauged on the FIELD, not the stored value, so it dims exactly when restoring would leave the box looking the same
        const syncRestoreState = () => {
          const shown =
            textComponent?.getValue() ??
            plugin.settings.firstLineProperty.propertyKey;
          setRestoreDimmed(shown === defaultKey);
        };

        setting.addText((text) => {
          textComponent = text;
          text
            .setPlaceholder(
              t('settings.firstLineProperty.propertyName.placeholder')
            )
            .setValue(plugin.settings.firstLineProperty.propertyKey)
            .onChange((value) => {
              // Stored trimmed, while the field keeps what was typed. An empty name is a valid choice meaning "no first line property": both `first-line-property-manager.ts` and `property-visibility.ts` no-op entirely on it.
              plugin.settings.firstLineProperty.propertyKey = value.trim();
              syncRestoreState();
              persist();
            });
        });

        syncRestoreState();
      },
    },
    {
      visible: firstLinePropertyEnabled,
      name: t('settings.firstLineProperty.addOnlyIfTitleDiffers.name'),
      desc: t('settings.firstLineProperty.addOnlyIfTitleDiffers.desc'),
      control: {
        type: 'toggle',
        key: 'firstLineProperty.addOnlyIfTitleDiffers',
      },
    },
    {
      visible: firstLinePropertyEnabled,
      name: t('settings.firstLineProperty.truncate.name'),
      desc: t('settings.firstLineProperty.truncate.desc', {
        setting: quoteLabel(t('settings.other.charCount.name')),
        section: quoteLabel(t('settings.sections.other')),
      }),
      control: {
        type: 'toggle',
        key: 'firstLineProperty.truncate',
      },
    },
    {
      // Hidden with a blank name like every row below the name field, and also while there are no custom replacement rules to apply.
      visible: () =>
        firstLinePropertyEnabled() &&
        plugin.settings.customReplacements.rules.length > 0,
      name: t('settings.firstLineProperty.applyCustomReplacements.name'),
      desc: t('settings.firstLineProperty.applyCustomReplacements.desc', {
        section: quoteLabel(t('settings.sections.customReplacements')),
      }),
      control: {
        type: 'toggle',
        key: 'markupStripping.applyCustomReplacementsInFirstLineProperty',
      },
    },
    {
      visible: firstLinePropertyEnabled,
      name: t('settings.firstLineProperty.stripMarkup.name'),
      desc: t('settings.firstLineProperty.stripMarkup.desc', {
        section: quoteLabel(t('settings.sections.markupStripping')),
      }),
      control: {
        type: 'toggle',
        key: 'markupStripping.stripMarkupInFirstLineProperty',
      },
    },
    {
      visible: firstLinePropertyEnabled,
      name: t('settings.firstLineProperty.keepEmptyProperty.name'),
      desc: t('settings.firstLineProperty.keepEmptyProperty.desc'),
      control: {
        type: 'toggle',
        key: 'firstLineProperty.keepEmptyProperty',
      },
    },
    {
      visible: firstLinePropertyEnabled,
      name: t('settings.firstLineProperty.placeLast.name'),
      desc: t('settings.firstLineProperty.placeLast.desc'),
      control: {
        type: 'toggle',
        key: 'firstLineProperty.placeLast',
      },
    },
    {
      visible: firstLinePropertyEnabled,
      name: t('settings.firstLineProperty.hideProperty.name'),
      desc: t('settings.firstLineProperty.hideProperty.desc'),
      control: {
        type: 'dropdown',
        key: 'firstLineProperty.hideProperty',
        options: {
          never: t('settings.firstLineProperty.hideProperty.never'),
          when_empty: t(
            'settings.firstLineProperty.hideProperty.onlyWhenEmpty'
          ),
          always: t('settings.firstLineProperty.hideProperty.always'),
        } satisfies Record<PropertyHidingOption, string>,
      },
    },
    {
      name: t('settings.firstLineProperty.hideInSidebar.name'),
      desc: t('settings.firstLineProperty.hideInSidebar.desc'),
      visible: () =>
        firstLinePropertyEnabled() &&
        ['when_empty', 'always'].includes(
          plugin.settings.firstLineProperty.hideProperty
        ),
      control: {
        type: 'toggle',
        key: 'firstLineProperty.hideInSidebar',
      },
    },
  ];

  return {
    type: 'page',
    name: t('settings.sections.firstLineProperty'),
    desc: t('settings.firstLineProperty.desc'),
    // Blank rather than "Disabled" when off, matching the rule-count rows: the value summarizes what is active, and absence already reads as inactive.
    displayValue: () =>
      firstLinePropertyEnabled() ? t('settings.common.enabled') : '',
    items,
  };
}
