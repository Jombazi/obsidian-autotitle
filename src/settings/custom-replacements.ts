import {
  PluginSettingTab,
  SettingDefinitionPage,
  SettingDefinitionRender,
} from 'obsidian';
import { SettingPath } from './settings-paths';
import {
  buildReplacedWithSummary,
  buildSummaryRow,
  createRowIdRegistry,
  FirstLineIsTitlePlugin,
  LIST_NOTE_CLASS,
  quoteLabel,
  saveSettingsOrWarn,
  withListNote,
} from './settings-base';
import { t, tp } from '../i18n';
import { CustomReplacement } from '../types';
import { EntryEditModal } from '../modals/entry-edit-modal';
import { customReplacementMatchKey } from '../utils/custom-replacement-rules';

/** A rule's search text as plain text that keeps its runs of spaces, or the muted "Empty" label. */
function appendRuleSide(parent: DocumentFragment, text: string): void {
  if (text === '') {
    parent.createSpan({
      cls: 'u-muted',
      text: t('settings.common.emptyPlaceholder'),
    });
    return;
  }
  parent.createSpan({ cls: 'flit-rule-text', text });
}

function ruleSideLabel(text: string): string {
  return text === '' ? t('settings.common.emptyPlaceholder') : text;
}

/** What the rule does, worded like a character's summary so both sections read alike; the quotes show a replacement's leading and trailing spaces. */
function buildRuleSummary(rule: CustomReplacement): string | DocumentFragment {
  let options = '';
  if (rule.onlyAtStart) {
    options += t('settings.customReplacements.summary.onlyAtLineStart');
  }
  if (rule.onlyWholeLine) {
    options += t('settings.customReplacements.summary.onlyWholeLine');
  }
  return rule.replaceText === ''
    ? t('settings.common.summary.removed') + options
    : buildReplacedWithSummary(rule.replaceText, options);
}

const getRuleRowId =
  createRowIdRegistry<CustomReplacement>('custom-replacement');

/** A mapped copy of the rule's fields, because the dialog's values need an index signature that an interface lacks. */
type RuleValues = Pick<CustomReplacement, keyof CustomReplacement>;

/** Opens the rule dialog; `rule` null adds a rule on Save, otherwise Save rewrites that rule in place. */
function openRuleDialog(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab,
  rule: CustomReplacement | null
): void {
  const initialValues: RuleValues = {
    searchText: rule?.searchText ?? '',
    replaceText: rule?.replaceText ?? '',
    onlyAtStart: rule?.onlyAtStart ?? false,
    onlyWholeLine: rule?.onlyWholeLine ?? false,
  };

  new EntryEditModal<RuleValues>(plugin.app, {
    title: rule
      ? t('settings.customReplacements.editReplacement')
      : t('settings.customReplacements.addReplacement'),
    initialValues,
    fields: [
      {
        type: 'text',
        key: 'searchText',
        name: t('settings.customReplacements.headers.textToReplace'),
        desc: t('settings.customReplacements.whitespacePreserved'),
        placeholder: t('settings.common.emptyPlaceholder'),
        required: true,
      },
      {
        type: 'text',
        key: 'replaceText',
        name: t('settings.customReplacements.headers.replaceWith'),
        desc: `${t('settings.customReplacements.whitespacePreserved')} ${t('settings.customReplacements.leaveBlank')}`,
        placeholder: t('settings.common.emptyPlaceholder'),
        stripForbiddenChars: true,
      },
      {
        type: 'toggle',
        key: 'onlyAtStart',
        name: t('settings.customReplacements.headers.onlyMatchLineStart'),
        // The engine takes only the whole-line branch when both are on, so the two are kept exclusive
        onChange: (value, setOther) => {
          if (value) setOther('onlyWholeLine', false);
        },
      },
      {
        type: 'toggle',
        key: 'onlyWholeLine',
        name: t('settings.customReplacements.headers.onlyMatchWholeLine'),
        onChange: (value, setOther) => {
          if (value) setOther('onlyAtStart', false);
        },
      },
    ],
    findError: (values) =>
      plugin.settings.customReplacements.rules.some(
        (other) =>
          other !== rule &&
          customReplacementMatchKey(other) === customReplacementMatchKey(values)
      )
        ? t('settings.customReplacements.duplicate')
        : null,
    onSave: async (values) => {
      const saved: CustomReplacement = {
        searchText: values.searchText,
        replaceText: values.replaceText,
        onlyAtStart: values.onlyAtStart,
        onlyWholeLine: values.onlyWholeLine,
      };
      const rules = plugin.settings.customReplacements.rules;
      if (rule) {
        Object.assign(rule, saved);
      } else {
        rules.push(saved);
      }
      plugin.debugLog('customReplacements', rules);
      await saveSettingsOrWarn(plugin);
      tab.update();
    },
    // Editing a rule often only flips an option, so the keyboard comes up by itself only for a new rule, which starts with typing its text
    focusFirstTextFieldOnMobile: rule === null,
  }).open();
}

/** One rule's summary row: its search text, then what it is replaced with and its match options, then Edit and Delete. */
function buildRuleRow(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab,
  rule: CustomReplacement
): SettingDefinitionRender {
  const summaryRow = buildSummaryRow({
    name: `${ruleSideLabel(rule.searchText)} → ${ruleSideLabel(rule.replaceText)}`,
    buildNameFragment: () =>
      createFragment((frag) => appendRuleSide(frag, rule.searchText)),
    buildDesc: () => buildRuleSummary(rule),
    // User data, so it stays out of the settings search index
    searchable: false,
    editEntry: () => openRuleDialog(plugin, tab, rule),
    deleteEntry: () => {
      void (async () => {
        const rules = plugin.settings.customReplacements.rules;
        const index = rules.indexOf(rule);
        if (index === -1) return;
        rules.splice(index, 1);
        plugin.debugLog('customReplacements', rules);
        await saveSettingsOrWarn(plugin);
        tab.update();
      })();
    },
  });
  return withListNote(
    // Obsidian keys a row by `id` before its name (app.js 1.14.4, the list's row-key function), and two rules can share both texts, so the name cannot be the key
    { ...summaryRow, id: getRuleRowId(rule) },
    t('settings.customReplacements.rulesApplyTopToBottom')
  );
}

/** Custom replacements sub-page. Rules are a native list of summary rows, edited in a dialog: the list draws the add and drag affordances, each row its own Edit and Delete. List `items` are captured when the definitions are built, so every mutation that changes the row set calls `tab.update()`. */
export function buildCustomReplacementsPage(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab
): SettingDefinitionPage<SettingPath> {
  const rules = () => plugin.settings.customReplacements.rules;
  const hasRules = () => rules().length > 0;

  return {
    type: 'page',
    name: t('settings.sections.customReplacements'),
    desc: t('settings.customReplacements.desc'),
    // Counts what the plugin acts on, not what the list holds: a blank-search rule never fires, so counting it would overstate the page. Silent at zero rather than reading "0 rules": the count is an at-a-glance summary, and a summary of nothing is noise the native affordance does not show either.
    displayValue: () => {
      const active = rules().filter((rule) => rule.searchText).length;
      return active ? tp('settings.ruleCount', active) : '';
    },
    items: [
      {
        type: 'group',
        // Ordering options mean nothing with no rules to order; every add and delete calls `tab.update()`, which re-evaluates this.
        visible: hasRules,
        items: [
          {
            name: t(
              'settings.customReplacements.processingOrder.applyAfterForbidden'
            ),
            desc: t('settings.customReplacements.processingOrder.asSetIn', {
              section: quoteLabel(t('settings.sections.characterReplacements')),
            }),
            control: {
              type: 'toggle',
              key: 'customReplacements.applyAfterForbiddenChars',
            },
          },
          {
            name: t(
              'settings.customReplacements.processingOrder.applyAfterMarkup'
            ),
            desc: t('settings.customReplacements.processingOrder.asSetIn', {
              section: quoteLabel(t('settings.sections.markupStripping')),
            }),
            control: {
              type: 'toggle',
              key: 'markupStripping.applyCustomReplacementsAfterMarkupStripping',
            },
          },
        ],
      },
      {
        type: 'list',
        // The rule-order note above the first rule comes from `withListNote` in `buildRuleRow`
        cls: LIST_NOTE_CLASS,
        emptyState: t('settings.customReplacements.emptyState'),
        items: rules().map((rule) => buildRuleRow(plugin, tab, rule)),
        onReorder: (oldIndex, newIndex) => {
          void (async () => {
            const [moved] = rules().splice(oldIndex, 1);
            rules().splice(newIndex, 0, moved);
            // A keyboard move (Alt+Up/Down) reports the new order without moving the rows, so re-render from the stored order; before the save's await, because Obsidian focuses the row at the new index right after this handler returns
            tab.update();
            await saveSettingsOrWarn(plugin);
          })();
        },
        addItem: {
          name: t('settings.customReplacements.addReplacement'),
          action: () => openRuleDialog(plugin, tab, null),
        },
      },
    ],
  };
}
