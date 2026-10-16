import {
  ConfirmationModal,
  Notice,
  PluginSettingTab,
  SettingDefinitionPage,
} from 'obsidian';
import { SettingPath } from './settings-paths';
import { buildButtonRow, FirstLineIsTitlePlugin } from './settings-base';
import { ContentReadMethod, NotificationMode, TitleCase } from '../types';
import { DEFAULT_SETTINGS } from '../constants';
import { verboseLog } from '../utils';
import { t } from '../i18n';
import { PluginInitializer } from '../core/plugin-initializer';
import { createPluginLink, buildPluginLinkRouterGroup } from './plugin-links';
import {
  SettingsExportModal,
  SettingsImportModal,
} from '../modals/settings-transfer';
import { addFlitModalClass } from '../modals/flit-modal-class';

// Plugin names (proper nouns, not subject to sentence case)
const PLUGIN_AUTO_CARD_LINK = 'Auto Card Link';
const PLUGIN_LINK_EMBED = 'Link Embed';

/** Common file systems cap a file name at 255 characters or bytes, and the title still takes the `.md` extension. */
const MAX_CHAR_COUNT = 255 - '.md'.length;

/** Card link description interleaves two plugin links with three text fragments. */
function buildCardLinkDescription(): DocumentFragment {
  return createFragment((frag) => {
    frag.appendText(t('settings.other.grabTitleFromCardLink.desc.part1'));
    createPluginLink(frag, 'obsidian-link-embed', PLUGIN_LINK_EMBED);
    frag.appendText(t('settings.other.grabTitleFromCardLink.desc.part2'));
    createPluginLink(frag, 'auto-card-link', PLUGIN_AUTO_CARD_LINK);
    frag.appendText(t('settings.other.grabTitleFromCardLink.desc.part3'));
  });
}

/** Restores DEFAULT_SETTINGS wholesale and re-runs the exclusion setup so the plugin ends up in the same state as a fresh install. */
async function resetAllSettings(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab
): Promise<void> {
  // A copy, never DEFAULT_SETTINGS itself: the replacement becomes the live object, which is mutated in place
  if (!(await plugin.replaceSettings(structuredClone(DEFAULT_SETTINGS)))) {
    return;
  }

  await new PluginInitializer(plugin).checkFirstTimeExclusionsSetup();

  verboseLog(plugin, `Showing notice: ${t('notifications.settingsCleared')}`);
  new Notice(t('notifications.settingsCleared'));

  tab.update();
}

export function buildOtherPage(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab
): SettingDefinitionPage<SettingPath> {
  return {
    type: 'page',
    name: t('settings.sections.other'),
    desc: t('settings.other.desc'),
    items: [
      {
        name: t('settings.other.charCount.name'),
        desc: t('settings.other.charCount.desc'),
        control: {
          type: 'slider',
          key: 'core.charCount',
          min: 1,
          max: MAX_CHAR_COUNT,
          step: 1,
          defaultValue: DEFAULT_SETTINGS.core.charCount,
        },
      },
      {
        name: t('settings.other.notificationMode.name'),
        desc: t('settings.other.notificationMode.desc'),
        control: {
          type: 'dropdown',
          key: 'core.manualNotificationMode',
          options: {
            Always: t('settings.other.notificationMode.always'),
            'On title change': t(
              'settings.other.notificationMode.onTitleChange'
            ),
            Never: t('settings.other.notificationMode.never'),
          } satisfies Record<NotificationMode, string>,
        },
      },
      {
        name: t('settings.other.titleCase.name'),
        desc: t('settings.other.titleCase.desc'),
        control: {
          type: 'dropdown',
          key: 'core.titleCase',
          options: {
            preserve: t('settings.other.titleCase.preserve'),
            uppercase: t('settings.other.titleCase.uppercase'),
            lowercase: t('settings.other.titleCase.lowercase'),
          } satisfies Record<TitleCase, string>,
        },
      },
      {
        name: t('settings.other.grabTitleFromCardLink.name'),
        desc: buildCardLinkDescription(),
        control: {
          type: 'toggle',
          key: 'markupStripping.grabTitleFromCardLink',
        },
      },
      {
        // Debug's dependent row travels with it: left outside the group it would appear in a separate box below, detached from its parent.
        type: 'group',
        heading: t('settings.other.troubleshooting.title'),
        items: [
          {
            name: t('settings.other.newNoteDelay.name'),
            desc: t('settings.other.newNoteDelay.desc'),
            control: {
              type: 'slider',
              key: 'core.newNoteDelay',
              min: 0,
              max: 5000,
              step: 50,
              defaultValue: DEFAULT_SETTINGS.core.newNoteDelay,
            },
          },
          {
            name: t('settings.other.contentReadMethod.name'),
            desc: t('settings.other.contentReadMethod.desc'),
            control: {
              type: 'dropdown',
              key: 'core.contentReadMethod',
              options: {
                Editor: t('settings.other.contentReadMethod.editor'),
                Cache: t('settings.other.contentReadMethod.cache'),
                File: t('settings.other.contentReadMethod.file'),
              } satisfies Record<ContentReadMethod, string>,
            },
          },
          {
            name: t('settings.other.checkInterval.name'),
            desc: t('settings.other.checkInterval.desc'),
            visible: () =>
              plugin.settings.core.renameAutomatically &&
              plugin.settings.core.contentReadMethod === 'Editor',
            control: {
              type: 'slider',
              key: 'core.checkInterval',
              min: 0,
              max: 5000,
              step: 50,
              defaultValue: DEFAULT_SETTINGS.core.checkInterval,
            },
          },
          {
            name: t('settings.other.debug.name'),
            desc: t('settings.other.debug.desc'),
            control: {
              type: 'toggle',
              key: 'core.debug',
            },
          },
          {
            name: t('settings.other.debugOutputFullContent.name'),
            desc: t('settings.other.debugOutputFullContent.desc'),
            visible: () => plugin.settings.core.debug,
            control: {
              type: 'toggle',
              key: 'core.debugOutputFullContent',
            },
          },
        ],
      },
      {
        type: 'group',
        heading: t('settings.other.configuration.title'),
        items: [
          {
            name: t('settings.other.backupSettings.name'),
            desc: t('settings.other.backupSettings.desc'),
            render: buildButtonRow([
              {
                text: t('settings.other.backupSettings.import'),
                onClick: () =>
                  new SettingsImportModal(plugin.app, plugin, tab).open(),
              },
              {
                text: t('settings.other.backupSettings.export'),
                onClick: () =>
                  new SettingsExportModal(plugin.app, plugin).open(),
              },
            ]),
          },
          {
            // `render` rather than `action` so the row carries a labeled button, matching "Rename all notes" and "Send feedback".
            name: t('settings.other.clearSettings.name'),
            desc: t('settings.other.clearSettings.desc'),
            render: buildButtonRow({
              text: t('settings.other.clearSettings.button'),
              // Red tint without the filled-CTA treatment, since this is a secondary destructive action rather than the page's primary one.
              destructive: true,
              onClick: () => {
                const body = createFragment((frag) => {
                  frag.createEl('p', {
                    text: t('modals.resetAllSettings'),
                    cls: 'mod-warning',
                  });
                });

                addFlitModalClass(new ConfirmationModal(plugin.app))
                  .setTitle(t('settings.other.clearSettings.name'))
                  .setContent(body)
                  .addButton((btn) =>
                    btn
                      .setButtonText(t('modals.buttons.clear'))
                      // Non-deprecated equivalent of setWarning()
                      .setDestructive()
                      .setCta()
                      .onClick(() => {
                        void resetAllSettings(plugin, tab);
                      })
                  )
                  .addCancelButton()
                  .open();
              },
            }),
          },
        ],
      },
      buildPluginLinkRouterGroup(plugin.app),
    ],
  };
}
