import {
  PluginSettingTab,
  SettingDefinitionItem,
  SettingDefinitionPage,
  Notice,
  TextComponent,
} from 'obsidian';
import { FirstLineIsTitlePlugin, appendEmphasisedTerm } from './settings-base';
import { t } from '../i18n';
import { DEFAULT_SETTINGS } from '../constants';
import { hasFirstLinePropertyName } from '../utils/first-line-property-keys';

/**
 * Builds a `part1 + <emphasised label> + part2` description, the shape shared
 * by the two cross-referencing toggles on this page.
 */
function buildLabelReferenceDescription(
  descKey: string,
  labelKey: string
): DocumentFragment {
  return createFragment((frag) => {
    frag.appendText(t(`${descKey}.part1`));
    appendEmphasisedTerm(frag, t(`${descKey}.${labelKey}`));
    frag.appendText(t(`${descKey}.part2`));
  });
}

/** Description for the property name row: prose plus bare newline-separated notes. */
function buildPropertyKeyDescription(): DocumentFragment {
  return createFragment((frag) => {
    frag.appendText(t('settings.firstLineProperty.propertyName.desc'));

    const notes = frag.createDiv({
      cls: 'flit-margin-bottom-0',
    });

    notes.appendText(
      t('settings.firstLineProperty.propertyName.multipleProperties')
    );
    notes.createEl('br');
    notes.appendText(
      t('settings.firstLineProperty.propertyName.quickSwitcher')
    );
  });
}

/** Description for the truncate toggle: two emphasised labels across three parts. */
function buildTruncateDescription(): DocumentFragment {
  return createFragment((frag) => {
    frag.appendText(t('settings.firstLineProperty.truncate.desc.part1'));
    appendEmphasisedTerm(
      frag,
      t('settings.firstLineProperty.truncate.desc.charCount')
    );
    frag.appendText(t('settings.firstLineProperty.truncate.desc.part2'));
    appendEmphasisedTerm(
      frag,
      t('settings.firstLineProperty.truncate.desc.other')
    );
    frag.appendText(t('settings.firstLineProperty.truncate.desc.part3'));
  });
}

export function buildFirstLinePropertyPage(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab
): SettingDefinitionPage {
  // A blank name turns the feature off, so everything below the name field is meaningless and hidden rather than shown greyed out.
  const firstLinePropertyEnabled = () =>
    hasFirstLinePropertyName(plugin.settings);

  const items: SettingDefinitionItem[] = [
    // A plain row, not a group: every row on this page is plain, so the renderer folds them all into one box.
    {
      // `render`, not `control`: `SettingControlBase` exposes only `key`,
      // `defaultValue`, `validate` and `disabled`, so it can express neither
      // the restore button nor the visibility refresh this row needs on change.
      name: t('settings.firstLineProperty.propertyName.name'),
      desc: buildPropertyKeyDescription(),
      render: (setting) => {
        const defaultKey = DEFAULT_SETTINGS.firstLineProperty.propertyKey;
        let textComponent: TextComponent | null = null;
        let syncRestoreState = () => {};

        const persist = async () => {
          plugin.debugLog(
            'propertyKey',
            plugin.settings.firstLineProperty.propertyKey
          );
          // Nothing else reaches property visibility on a key change: the
          // cascade map only fires for `control` rows. Without this, clearing
          // the key would leave the old key's properties hidden.
          plugin.updatePropertyVisibility?.();
          try {
            await plugin.saveSettings();
          } catch {
            const notice = new Notice(t('settings.errors.saveFailed'));
            notice.containerEl.addClass('mod-warning');
          }
          // Not `update()`: it would tear down and rebuild this focused `render` row, losing the caret, while only the `visible` predicates of the rows below changed.
          tab.refreshDomState();
        };

        // Added before the text field so it renders to its left, the order
        // Obsidian itself uses for the restore control on slider rows.
        setting.addExtraButton((button) => {
          button
            .setIcon('rotate-ccw')
            .setTooltip(t('settings.common.restoreDefault'))
            .onClick(() => {
              void (async () => {
                plugin.settings.firstLineProperty.propertyKey = defaultKey;
                textComponent?.setValue(defaultKey);
                syncRestoreState();
                await persist();
              })();
            });

          // Native dims through `aria-disabled` and leaves the button
          // clickable, since restoring to the current value does nothing.
          // Gauged on the FIELD, not the stored value, so it dims exactly when
          // restoring would leave the box looking the same.
          syncRestoreState = () => {
            const shown =
              textComponent?.getValue() ??
              plugin.settings.firstLineProperty.propertyKey;
            button.extraSettingsEl.setAttribute(
              'aria-disabled',
              String(shown === defaultKey)
            );
          };
        });

        setting.addText((text) => {
          textComponent = text;
          text
            .setPlaceholder(
              t('settings.firstLineProperty.propertyName.placeholder')
            )
            .setValue(plugin.settings.firstLineProperty.propertyKey)
            .onChange(async (value) => {
              // Stored as typed, empty included, so the field keeps what the
              // user put in it. An empty key is a valid choice meaning "no
              // first line property": both `first-line-property-manager.ts` and
              // `property-visibility.ts` no-op entirely on it.
              plugin.settings.firstLineProperty.propertyKey = value.trim();
              syncRestoreState();
              await persist();
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
      desc: buildTruncateDescription(),
      control: {
        type: 'toggle',
        key: 'firstLineProperty.truncate',
      },
    },
    {
      // Hidden, like every row below the name field, while there are no custom replacement rules to apply.
      visible: () =>
        firstLinePropertyEnabled() &&
        plugin.settings.customReplacements.rules.length > 0,
      name: t('settings.firstLineProperty.applyCustomReplacements.name'),
      desc: buildLabelReferenceDescription(
        'settings.firstLineProperty.applyCustomReplacements.desc',
        'customReplacements'
      ),
      control: {
        type: 'toggle',
        key: 'markupStripping.applyCustomReplacementsInFirstLineProperty',
      },
    },
    {
      visible: firstLinePropertyEnabled,
      name: t('settings.firstLineProperty.stripMarkup.name'),
      desc: buildLabelReferenceDescription(
        'settings.firstLineProperty.stripMarkup.desc',
        'markupStripping'
      ),
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
        },
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
    // Blank rather than "Disabled" when off, matching the rule-count rows: the
    // value summarises what is active, and absence already reads as inactive.
    displayValue: () =>
      firstLinePropertyEnabled() ? t('settings.common.enabled') : '',
    items,
  };
}
