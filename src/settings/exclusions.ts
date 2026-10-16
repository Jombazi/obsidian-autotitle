import {
  PluginSettingTab,
  SettingDefinitionAddItem,
  SettingDefinitionList,
  SettingDefinitionPage,
  SettingDefinitionRender,
} from 'obsidian';
import { SettingPath } from './settings-paths';
import {
  addRestoreDefaultButton,
  appendLines,
  FirstLineIsTitlePlugin,
  buildDescRow,
  buildExclusionEntryFragment,
  buildSummaryRow,
  createRowIdRegistry,
  LIST_NOTE_CLASS,
  quoteLabel,
  saveSettingsOrWarn,
  withListNote,
} from './settings-base';
import {
  EXCLUSION_STRATEGY,
  ExcludedProperty,
  ExclusionStrategy,
  TagMatchingMode,
} from '../types';
import { FolderSuggest, TagSuggest } from '../suggests';
import { t, tp } from '../i18n';
import { DEFAULT_SETTINGS } from '../constants';
import { TIMING } from '../constants/timing';
import { ExclusionEntryModal } from '../modals/exclusion-entry-modal';
import {
  folderExclusionEntry,
  hasExcludedFileEntry,
  stripExcludedFileLeadingSlashes,
} from '../utils/file-exclusions';
import { excludedPropertyEntryKey } from '../utils/exclusion-pattern';
import { hasDuplicateTagEntry, isBlankTagEntry } from '../utils/tag-utils';

/** Notes drawn above the first entry of each list, as on the replacement pages; see `withListNote`. */
function buildFilesListNote(): string {
  return t('settings.exclusions.files.renamedWarning');
}

/** An "Exclusion mode" desc whose second line notes what "Exclude all except listed" also excludes; there rather than in the group intro, because the note only applies to that option. Takes whole keys so the locale tests can resolve them. */
function buildExclusionModeDesc(
  descKey: string,
  excludeAllNoteKey: string
): DocumentFragment {
  const excludeAllNote = t(excludeAllNoteKey, {
    // The option's own label, which all three Exclusion mode dropdowns share
    option: quoteLabel(
      t('settings.exclusions.files.exclusionMode.excludeAllExcept')
    ),
  });
  return createFragment((frag) => {
    appendLines(frag, [
      (target) => target.appendText(t(descKey)),
      (target) => target.appendText(excludeAllNote),
    ]);
  });
}

/** The "renamed elsewhere" warning alone: case is not mentioned, since a pattern can turn case-sensitive with an inline `(?-i:…)` group, so the claim would not always hold. */
function buildPropertiesListNote(): string {
  return t('settings.exclusions.properties.renamedWarning');
}

/** The disable property's caveats, one per line: what the property does before what changing it leaves behind; case-insensitivity is noted on the dialog's two fields instead, where the name and value are typed. */
function buildDisablePropertyIntro(): string {
  return [
    t('settings.exclusions.disableProperty.alwaysRespected'),
    t('settings.exclusions.disableProperty.updateWarning'),
  ].join('\n');
}

/** One side of the disable property as its row shows it: the text, or the muted "Empty" label as a custom replacement's summary draws a blank side. No `Regex` badge: the property is matched literally. */
function buildDisablePropertySide(text: string): DocumentFragment {
  return createFragment((frag) => {
    if (text === '') {
      frag.createSpan({
        cls: 'u-muted',
        text: t('settings.common.emptyPlaceholder'),
      });
      return;
    }
    frag.appendText(text);
  });
}

/** Writes both halves of the disable property, then saves. */
async function writeDisableProperty(
  plugin: FirstLineIsTitlePlugin,
  key: string,
  value: string
): Promise<void> {
  const { exclusions } = plugin.settings;
  exclusions.disableRenamingKey = key;
  exclusions.disableRenamingValue = value;
  plugin.debugLog('disableRenaming', { key, value });
  await saveSettingsOrWarn(plugin);
}

/** Opens the disable property's dialog, both fields prefilled; `onSaved` runs once it has closed on a submit. Each field's help line says only that matching ignores case: the property is matched literally, so the regex hints of the Excluded properties dialog do not apply. */
function openDisablePropertyDialog(
  plugin: FirstLineIsTitlePlugin,
  onSaved: () => void
): void {
  const { disableRenamingKey, disableRenamingValue } =
    plugin.settings.exclusions;
  new ExclusionEntryModal(plugin.app, {
    title: t('settings.exclusions.disableProperty.title'),
    fields: [
      {
        label: t('settings.exclusions.properties.keyPlaceholder'),
        help: t('settings.exclusions.disableProperty.caseInsensitive'),
        initialValue: disableRenamingKey,
      },
      {
        label: t('settings.exclusions.properties.valuePlaceholder'),
        help: t('settings.exclusions.disableProperty.caseInsensitive'),
        initialValue: disableRenamingValue,
      },
    ],
    submitEntry: async ([key, value]) => {
      // The disable and enable commands write this property into notes, so a blank name would have them write an empty key
      if (key === '') return t('modals.excludedProperty.emptyName');
      await writeDisableProperty(plugin, key, value);
      return null;
    },
    onSubmitted: onSaved,
  }).open();
}

/** Builds the "property to disable renaming" row: the key over its value, with a restore button and Edit, edited through the exclusion entry dialog. No Delete: it is a single setting, not a list entry. */
function buildDisablePropertyRow(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab
): SettingDefinitionRender {
  const exclusions = () => plugin.settings.exclusions;
  const restoreDefault = {
    key: DEFAULT_SETTINGS.exclusions.disableRenamingKey,
    value: DEFAULT_SETTINGS.exclusions.disableRenamingValue,
  };
  const isAtDefault = () =>
    exclusions().disableRenamingKey === restoreDefault.key &&
    exclusions().disableRenamingValue === restoreDefault.value;

  const summaryRow = buildSummaryRow({
    // The static title keeps the row findable in settings search; the name fragment shows the key in its place
    name: t('settings.exclusions.disableProperty.title'),
    buildNameFragment: () =>
      buildDisablePropertySide(exclusions().disableRenamingKey),
    buildDesc: () =>
      buildDisablePropertySide(exclusions().disableRenamingValue),
    searchable: true,
    editEntry: () => {
      openDisablePropertyDialog(plugin, () => tab.update());
    },
  });

  return {
    ...summaryRow,
    aliases: [
      t('settings.exclusions.properties.keyPlaceholder'),
      t('settings.exclusions.properties.valuePlaceholder'),
    ],
    render: (setting, group) => {
      // Mounted before the summary row adds Edit, so the button sits to Edit's left
      const setRestoreDimmed = addRestoreDefaultButton(
        setting.controlEl,
        () => {
          // Nothing to write when the pair already holds the default
          if (isAtDefault()) return;
          void (async () => {
            await writeDisableProperty(
              plugin,
              restoreDefault.key,
              restoreDefault.value
            );
            tab.update();
          })();
        }
      );
      setRestoreDimmed(isAtDefault());
      return summaryRow.render(setting, group);
    },
  };
}

/** Focuses a list's row at `index` as Obsidian focuses the row its own dialog adds: the row itself, scrolled into view only as far as needed. */
function focusListRow(listGroup: Element | null, index: number): void {
  const rowEl = listGroup?.querySelectorAll<HTMLElement>(
    '.setting-items > .setting-item:not(.mod-empty-state):not(.mod-add-item)'
  )[index];
  if (!rowEl) return;
  rowEl.focus({ preventScroll: true });
  rowEl.scrollIntoView({ block: 'nearest' });
}

/** Builds the native `addItem` affordance of a list whose entries are added through a dialog: `openAddDialog` opens it, and the `onAdded` it receives re-renders the list and focuses the row the dialog added. */
function buildDialogAddItem(
  name: string,
  tab: PluginSettingTab,
  openAddDialog: (onAdded: (addedIndex: number) => void) => void
): SettingDefinitionAddItem {
  return {
    name,
    action: (affordanceEl) => {
      // The affordance is a `+` button in the list's header row on desktop but a row inside the list itself on mobile, so its group is found by walking up rather than assumed. Resolved before the add because the framework reuses the group element across renders, so this reference outlives `tab.update()` even where the affordance itself would not.
      const listGroup = affordanceEl.closest('.setting-group');
      openAddDialog((addedIndex) => {
        tab.update();
        // The new row only exists once `tab.update()` has re-rendered; on the affordance's own window, which is the Settings window when Settings opens in a window of its own
        affordanceEl.win.setTimeout(
          () => focusListRow(listGroup, addedIndex),
          TIMING.NEXT_TICK_MS
        );
      });
    },
  };
}

interface StringEntryListSpec {
  getEntries: () => string[];
  debugLabel: string;
  emptyState: string;
  addButtonText: string;
  listNote: string;
  dialogTitle: string;
  dialogEditTitle: string;
  dialogHelp: string;
  /** Rewrites the trimmed entry before every other check and the save. */
  normalizeEntry?: (trimmedEntry: string) => string;
  /** Takes the trimmed, normalized entry. */
  isBlank: (entry: string) => boolean;
  blankError: string;
  hasEntry: (entries: string[], entry: string) => boolean;
  attachSuggest: (
    inputEl: HTMLInputElement,
    otherEntries: string[],
    submitPick: (value: string) => void
  ) => void;
}

/** Opens a string list's dialog; `entryToEdit` undefined adds an entry. `onSaved` runs once the dialog has closed on a submit, with the entry's index, or -1 when the entry being edited was gone. */
function openStringEntryDialog(
  plugin: FirstLineIsTitlePlugin,
  spec: StringEntryListSpec,
  entryToEdit: string | undefined,
  onSaved: (index: number) => void
): void {
  const findEditedIndex = (entries: string[]) =>
    entryToEdit === undefined ? -1 : entries.indexOf(entryToEdit);
  let savedIndex = -1;

  new ExclusionEntryModal(plugin.app, {
    title: entryToEdit === undefined ? spec.dialogTitle : spec.dialogEditTitle,
    fields: [
      {
        label: '',
        help: spec.dialogHelp,
        initialValue: entryToEdit,
        attachSuggest: (inputEl, submitPick) => {
          const entries = spec.getEntries();
          const editedIndex = findEditedIndex(entries);
          spec.attachSuggest(
            inputEl,
            entries.filter((_, index) => index !== editedIndex),
            submitPick
          );
        },
      },
    ],
    submitEntry: async ([trimmedEntry]) => {
      const entry = spec.normalizeEntry?.(trimmedEntry) ?? trimmedEntry;
      if (spec.isBlank(entry)) return spec.blankError;
      const entries = spec.getEntries();
      const editedIndex = findEditedIndex(entries);
      // Gone since the dialog opened, so there is nothing left to edit and the dialog just closes
      if (entryToEdit !== undefined && editedIndex === -1) return null;
      // Checked against the others only, so a case-only change or an unchanged Done is not mistaken for a duplicate of itself
      const otherEntries = entries.filter((_, index) => index !== editedIndex);
      if (spec.hasEntry(otherEntries, entry)) {
        return t('modals.exclusionEntry.duplicate');
      }
      if (editedIndex === -1) {
        savedIndex = entries.push(entry) - 1;
      } else {
        entries[editedIndex] = entry;
        savedIndex = editedIndex;
      }
      plugin.debugLog(spec.debugLabel, entries);
      await saveSettingsOrWarn(plugin);
      return null;
    },
    onSubmitted: () => onSaved(savedIndex),
  }).open();
}

/** One string list row with Edit and Delete; Edit departs from Obsidian's own list, which offers Delete only, because a regex entry is tedious to retype. Handlers look the entry up when clicked rather than capturing its index, because a file or tag menu action can drop entries while this page is open. */
function buildStringEntryRow(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab,
  spec: StringEntryListSpec,
  entry: string
): SettingDefinitionRender {
  return withListNote(
    buildSummaryRow({
      name: entry,
      buildNameFragment: () => buildExclusionEntryFragment(entry),
      // User data, so it stays out of the settings search index
      searchable: false,
      editEntry: () => {
        openStringEntryDialog(plugin, spec, entry, () => tab.update());
      },
      deleteEntry: () => {
        void (async () => {
          const entries = spec.getEntries();
          const index = entries.indexOf(entry);
          if (index === -1) return;
          entries.splice(index, 1);
          plugin.debugLog(spec.debugLabel, entries);
          await saveSettingsOrWarn(plugin);
          tab.update();
        })();
      },
    }),
    spec.listNote
  );
}

/** A list of plain-string entries shaped like Obsidian's own Excluded files list: no reorder, and entries are added and edited through a dialog rather than typed into a blank row. */
function buildStringEntryList(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab,
  spec: StringEntryListSpec
): SettingDefinitionList<SettingPath> {
  return {
    type: 'list',
    cls: LIST_NOTE_CLASS,
    emptyState: spec.emptyState,
    items: spec
      .getEntries()
      .map((entry) => buildStringEntryRow(plugin, tab, spec, entry)),
    addItem: buildDialogAddItem(spec.addButtonText, tab, (onAdded) =>
      openStringEntryDialog(plugin, spec, undefined, onAdded)
    ),
  };
}

function buildExcludedFilesSpec(
  plugin: FirstLineIsTitlePlugin
): StringEntryListSpec {
  return {
    getEntries: () => plugin.settings.exclusions.excludedFiles,
    debugLabel: 'excludedFiles',
    emptyState: t('settings.exclusions.files.emptyState'),
    addButtonText: t('settings.exclusions.files.addButton'),
    listNote: buildFilesListNote(),
    dialogTitle: t('modals.excludedFile.title'),
    dialogEditTitle: t('modals.excludedFile.editTitle'),
    dialogHelp: t('modals.excludedFile.help'),
    normalizeEntry: stripExcludedFileLeadingSlashes,
    isBlank: (entry) => entry === '',
    blankError: t('modals.excludedFile.emptyFilter'),
    hasEntry: hasExcludedFileEntry,
    attachSuggest: (inputEl, otherEntries, submitPick) => {
      new FolderSuggest(plugin.app, inputEl, (folderPath) => {
        // The `+ <typed>` row: while suggestions show, Obsidian's keymap takes Enter before the input's keydown listener, so this row is how the typed text is submitted
        submitPick(
          folderPath === null ? inputEl.value : folderExclusionEntry(folderPath)
        );
      });
    },
  };
}

function buildExcludedTagsSpec(
  plugin: FirstLineIsTitlePlugin
): StringEntryListSpec {
  return {
    getEntries: () => plugin.settings.exclusions.excludedTags,
    debugLabel: 'excludedTags',
    emptyState: t('settings.exclusions.tags.emptyState'),
    addButtonText: t('settings.exclusions.tags.addButton'),
    listNote: t('settings.exclusions.tags.tagWranglerWarning'),
    dialogTitle: t('modals.excludedTag.title'),
    dialogEditTitle: t('modals.excludedTag.editTitle'),
    dialogHelp: t('modals.excludedTag.help'),
    isBlank: isBlankTagEntry,
    blankError: t('modals.excludedTag.emptyTag'),
    hasEntry: hasDuplicateTagEntry,
    attachSuggest: (inputEl, otherEntries, submitPick) => {
      new TagSuggest(
        plugin.app,
        inputEl,
        (tag) => {
          // The `+ <typed>` row, as in the files dialog
          submitPick(tag === null ? inputEl.value : tag);
        },
        otherEntries
      );
    },
  };
}

const getPropertyRowId =
  createRowIdRegistry<ExcludedProperty>('excluded-property');

/** Opens the property dialog; `propertyToEdit` null adds a rule. `onSaved` runs once the dialog has closed on a submit, with the rule's index, or -1 when the rule being edited was gone. */
function openExcludedPropertyDialog(
  plugin: FirstLineIsTitlePlugin,
  propertyToEdit: ExcludedProperty | null,
  onSaved: (index: number) => void
): void {
  let savedIndex = -1;

  new ExclusionEntryModal(plugin.app, {
    title: propertyToEdit
      ? t('modals.excludedProperty.editTitle')
      : t('modals.excludedProperty.title'),
    fields: [
      {
        label: t('settings.exclusions.properties.keyPlaceholder'),
        help: t('modals.excludedProperty.nameHelp'),
        initialValue: propertyToEdit?.key,
      },
      {
        label: t('settings.exclusions.properties.valuePlaceholder'),
        help: t('modals.excludedProperty.valueHelp'),
        initialValue: propertyToEdit?.value,
      },
    ],
    submitEntry: async ([key, value]) => {
      if (key === '') return t('modals.excludedProperty.emptyName');
      const properties = plugin.settings.exclusions.excludedProperties;
      const editedIndex = propertyToEdit
        ? properties.indexOf(propertyToEdit)
        : -1;
      // Gone since the dialog opened, so there is nothing left to edit and the dialog just closes
      if (propertyToEdit && editedIndex === -1) return null;
      // Checked against the others only, so a case-only change or an unchanged Done is not mistaken for a duplicate of itself
      const entryKey = excludedPropertyEntryKey({ key, value });
      const isDuplicate = properties.some(
        (other) =>
          other !== propertyToEdit &&
          excludedPropertyEntryKey(other) === entryKey
      );
      if (isDuplicate) return t('modals.exclusionEntry.duplicate');
      if (propertyToEdit) {
        Object.assign(propertyToEdit, { key, value });
        savedIndex = editedIndex;
      } else {
        savedIndex = properties.push({ key, value }) - 1;
      }
      plugin.debugLog('excludedProperties', properties);
      await saveSettingsOrWarn(plugin);
      return null;
    },
    onSubmitted: () => onSaved(savedIndex),
  }).open();
}

/** One Excluded properties row: the name, then the value or "Any value", each side with its `Regex` badge when a pattern. Handlers close over the property object rather than its index so they cannot act on the wrong entry after a deletion. */
function buildExcludedPropertyRow(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab,
  property: ExcludedProperty
): SettingDefinitionRender {
  const summaryRow = buildSummaryRow({
    name: property.key,
    buildNameFragment: () => buildExclusionEntryFragment(property.key),
    buildDesc: () =>
      property.value === ''
        ? t('settings.exclusions.properties.anyValue')
        : buildExclusionEntryFragment(property.value),
    // User data, so it stays out of the settings search index
    searchable: false,
    editEntry: () => {
      openExcludedPropertyDialog(plugin, property, () => tab.update());
    },
    deleteEntry: () => {
      void (async () => {
        const properties = plugin.settings.exclusions.excludedProperties;
        const index = properties.indexOf(property);
        if (index === -1) return;
        properties.splice(index, 1);
        plugin.debugLog('excludedProperties', properties);
        await saveSettingsOrWarn(plugin);
        tab.update();
      })();
    },
  });
  return withListNote(
    // Obsidian keys a row by `id` before its name, and two rules can share a name, so the name cannot be the key
    { ...summaryRow, id: getPropertyRowId(property) },
    buildPropertiesListNote()
  );
}

function buildExcludedPropertiesList(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab
): SettingDefinitionList<SettingPath> {
  return {
    type: 'list',
    cls: LIST_NOTE_CLASS,
    emptyState: t('settings.exclusions.properties.emptyState'),
    items: plugin.settings.exclusions.excludedProperties.map((property) =>
      buildExcludedPropertyRow(plugin, tab, property)
    ),
    addItem: buildDialogAddItem(
      t('settings.exclusions.properties.addButton'),
      tab,
      (onAdded) => openExcludedPropertyDialog(plugin, null, onAdded)
    ),
  };
}

/** Exclusions sub-page. Three collections use the native list type for its add affordance; each row draws its own Edit and Delete, and entries are added and edited through a dialog. List `items` are captured when the definitions are built, so every mutation that changes the row set calls `tab.update()`. */
export function buildExclusionsPage(
  plugin: FirstLineIsTitlePlugin,
  tab: PluginSettingTab
): SettingDefinitionPage<SettingPath> {
  const exclusionModeOptions = {
    [EXCLUSION_STRATEGY.ONLY_EXCLUDE]: t(
      'settings.exclusions.files.exclusionMode.onlyExclude'
    ),
    [EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT]: t(
      'settings.exclusions.files.exclusionMode.excludeAllExcept'
    ),
  } satisfies Record<ExclusionStrategy, string>;

  return {
    type: 'page',
    name: t('settings.sections.exclusions'),
    desc: t('settings.exclusions.desc'),
    // Summed across all three lists, with no blank filter: load, Import and every writer keep blank entries out. Shows nothing at zero rather than "0 rules", matching the Custom replacements row.
    displayValue: () => {
      const { exclusions } = plugin.settings;
      const count =
        exclusions.excludedFiles.length +
        exclusions.excludedTags.length +
        exclusions.excludedProperties.length;
      return count ? tp('settings.ruleCount', count) : '';
    },
    items: [
      // The "any rule can exclude, none can re-include" caveat
      buildDescRow(t('settings.exclusions.note')),

      {
        type: 'group',
        heading: t('settings.exclusions.files.title'),
        items: [
          {
            name: t('settings.exclusions.files.exclusionMode.name'),
            desc: t('settings.exclusions.files.exclusionMode.desc'),
            control: {
              type: 'dropdown',
              key: 'exclusions.fileScopeStrategy',
              options: exclusionModeOptions,
            },
          },
        ],
      },
      buildStringEntryList(plugin, tab, buildExcludedFilesSpec(plugin)),

      {
        type: 'group',
        heading: t('settings.exclusions.tags.title'),
        // Exclusion mode leads, as in the files and properties groups, since it decides what the rest of the group means
        items: [
          {
            name: t('settings.exclusions.tags.exclusionMode.name'),
            desc: buildExclusionModeDesc(
              'settings.exclusions.tags.exclusionMode.desc',
              'settings.exclusions.tags.excludeAllNote'
            ),
            control: {
              type: 'dropdown',
              key: 'exclusions.tagScopeStrategy',
              options: exclusionModeOptions,
            },
          },
          {
            name: t('settings.exclusions.tags.matchTags.name'),
            desc: t('settings.exclusions.tags.matchTags.desc'),
            control: {
              type: 'dropdown',
              key: 'exclusions.tagMatchingMode',
              options: {
                'In Properties and note body': t(
                  'settings.exclusions.tags.matchTags.inPropertiesAndBody'
                ),
                'In Properties only': t(
                  'settings.exclusions.tags.matchTags.inPropertiesOnly'
                ),
                'In note body only': t(
                  'settings.exclusions.tags.matchTags.inBodyOnly'
                ),
              } satisfies Record<TagMatchingMode, string>,
            },
          },
          {
            name: t('settings.exclusions.tags.matchSubtags.name'),
            desc: t('settings.exclusions.tags.matchSubtags.desc'),
            control: {
              type: 'toggle',
              key: 'exclusions.matchSubtags',
            },
          },
        ],
      },
      buildStringEntryList(plugin, tab, buildExcludedTagsSpec(plugin)),

      {
        type: 'group',
        heading: t('settings.exclusions.properties.title'),
        items: [
          {
            name: t('settings.exclusions.properties.exclusionMode.name'),
            desc: buildExclusionModeDesc(
              'settings.exclusions.properties.exclusionMode.desc',
              'settings.exclusions.properties.excludeAllNote'
            ),
            control: {
              type: 'dropdown',
              key: 'exclusions.propertyScopeStrategy',
              options: exclusionModeOptions,
            },
          },
        ],
      },
      buildExcludedPropertiesList(plugin, tab),

      {
        // A list, not a plain group, though nothing is added, deleted or dragged: on phones Obsidian stacks a plain group's controls under the row text, and only list rows keep the Restore default and Edit buttons to the right
        type: 'list',
        heading: t('settings.exclusions.disableProperty.title'),
        items: [
          buildDescRow(buildDisablePropertyIntro()),
          buildDisablePropertyRow(plugin, tab),
        ],
      },
    ],
  };
}
