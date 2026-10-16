/**
 * Tests for the Exclusions page's native list `addItem` affordances, which add
 * tags and properties through the exclusion entry dialog and then focus the
 * new row, as the Excluded files list does.
 *
 * `settings-main.test.ts` mocks this module wholesale, so the dialog wiring and
 * the focus-after-add follow-up are pinned here or nowhere.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginSettingTab, SettingDefinitionList } from 'obsidian';
import type { SettingPath } from '../../src/settings/settings-paths';
import { AbstractInputSuggest, App, displayTooltip } from '../mockObsidian';

const { openedModals, tagSuggests } = vi.hoisted(() => ({
  openedModals: [] as unknown[],
  tagSuggests: [] as unknown[],
}));

vi.mock('../../src/i18n', () => ({
  t: vi.fn((key: string) => key),
  getCurrentLocale: vi.fn(() => 'en'),
}));

vi.mock('../../src/modals/exclusion-entry-modal', async (importOriginal) => {
  const { withRecordedExclusionEntryModals } = await import('../testUtils');
  return withRecordedExclusionEntryModals(
    await importOriginal<
      typeof import('../../src/modals/exclusion-entry-modal')
    >(),
    openedModals
  );
});

// The suggester mock declares its methods as instance fields, so instances are recorded here and driven through the real prototype below
vi.mock('../../src/suggests', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/suggests')>(
      '../../src/suggests'
    );
  class RecordingTagSuggest extends actual.TagSuggest {
    constructor(...args: ConstructorParameters<typeof actual.TagSuggest>) {
      super(...args);
      tagSuggests.push(this);
    }
  }
  return { ...actual, TagSuggest: RecordingTagSuggest };
});

import { buildExclusionsPage } from '../../src/settings/exclusions';
import { TagSuggest } from '../../src/suggests';
import type { FirstLineIsTitlePlugin } from '../../src/settings/settings-base';
import { DEFAULT_SETTINGS } from '../../src/constants';
import { flush, openLatestExclusionEntryDialog } from '../testUtils';

// The shared mock records `onSelect` without keeping the callback; Obsidian's own `selectSuggestion`, which the tag suggester runs first, calls the callback `onSelect` registered
Object.assign(AbstractInputSuggest.prototype, {
  selectSuggestion(this: AbstractInputSuggest, value: unknown, evt: unknown) {
    vi.mocked(this.onSelect).mock.lastCall?.[0]?.(value, evt);
  },
});

/** Mirrors the framework's DOM: the affordance sits inside the list's group, beside the rows container. */
function mountListGroup(): {
  group: HTMLElement;
  rows: HTMLElement;
  affordance: HTMLElement;
} {
  const group = document.body.createDiv('setting-group mod-list');
  const heading = group.createDiv('setting-item setting-item-heading');
  const affordance = heading.createDiv('clickable-icon extra-setting-button');
  const rows = group.createDiv('setting-items');
  return { group, rows, affordance };
}

/** Appends a row as Obsidian's list renders one: focusable by script only. */
function appendRow(rows: HTMLElement): HTMLElement {
  const rowEl = rows.createDiv({
    cls: 'setting-item',
    attr: { tabindex: '-1' },
  });
  rowEl.scrollIntoView = vi.fn();
  return rowEl;
}

interface Harness {
  exclusions: typeof DEFAULT_SETTINGS.exclusions;
  app: App;
  update: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
  lists: SettingDefinitionList<SettingPath>[];
}

function buildHarness(): Harness {
  const exclusions = structuredClone(DEFAULT_SETTINGS.exclusions);
  const app = new App();
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const plugin = {
    app,
    settings: { exclusions },
    saveSettings,
    debugLog: vi.fn(),
  } as unknown as FirstLineIsTitlePlugin;

  const update = vi.fn();
  const tab = { update } as unknown as PluginSettingTab;

  const page = buildExclusionsPage(plugin, tab);
  const lists = (page.items ?? []).filter(
    (item): item is SettingDefinitionList<SettingPath> =>
      (item as { type?: string }).type === 'list'
  );

  return { exclusions, app, update, saveSettings, lists };
}

/** Runs a list's add affordance and opens the dialog it creates. */
function openAddDialog(
  list: SettingDefinitionList<SettingPath>,
  affordance: HTMLElement = document.createElement('div')
) {
  list.addItem?.action(affordance);
  return openLatestExclusionEntryDialog(openedModals);
}

function setVaultTags(harness: Harness, tags: string[]): void {
  // The mock cache has no `getTags`, the undocumented tag-to-count map `obsidian-ex.d.ts` declares
  (
    harness.app.metadataCache as unknown as {
      getTags: () => Record<string, number>;
    }
  ).getTags = () => Object.fromEntries(tags.map((tag) => [tag, 1]));
}

/** Presses Enter while the tag suggestions show, which takes the preselected first row. */
function enterOnTagSuggestions(query: string): void {
  const suggest = tagSuggests[tagSuggests.length - 1] as TagSuggest;
  const [first] = TagSuggest.prototype.getSuggestions.call(suggest, query);
  TagSuggest.prototype.selectSuggestion.call(
    suggest,
    first,
    new window.KeyboardEvent('keydown', { key: 'Enter' })
  );
}

describe('Exclusions list add affordances', () => {
  beforeEach(() => {
    openedModals.length = 0;
    tagSuggests.length = 0;
    vi.mocked(displayTooltip).mockClear();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('gives every list a native addItem rather than a sibling add row', () => {
    const { lists } = buildHarness();

    expect(lists).toHaveLength(3);
    expect(lists.map((list) => list.addItem?.name)).toEqual([
      'settings.exclusions.files.addButton',
      'settings.exclusions.tags.addButton',
      'settings.exclusions.properties.addButton',
    ]);
  });

  describe('tags', () => {
    let harness: Harness;

    beforeEach(() => {
      harness = buildHarness();
    });

    it('opens "Add tag" with one empty, unlabeled field and the tag help line', () => {
      const { modal, inputs, labels, helps } = openAddDialog(harness.lists[1]);

      expect(modal.setTitle).toHaveBeenCalledWith('modals.excludedTag.title');
      expect(inputs.map((input) => input.value)).toEqual(['']);
      expect(labels).toEqual(['']);
      expect(helps).toEqual(['modals.excludedTag.help']);
      // Attached at once, since the field opens empty
      expect(tagSuggests).toHaveLength(1);
    });

    it('adds the trimmed entry, then re-renders and focuses the new row', async () => {
      harness.exclusions.excludedTags = ['draft'];
      const { rows, affordance } = mountListGroup();
      appendRow(rows);
      harness.update.mockImplementation(() => appendRow(rows));
      const { modal, inputs, doneButton } = openAddDialog(
        harness.lists[1],
        affordance
      );

      inputs[0].value = '  #review ';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedTags).toEqual(['draft', '#review']);
      expect(harness.saveSettings).toHaveBeenCalledTimes(1);
      expect(modal.close).toHaveBeenCalledTimes(1);
      expect(harness.update).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(rows.children[1]);
    });

    it.each(['   ', '#'])('refuses a blank entry: %j', async (typed) => {
      const { modal, inputs, doneButton } = openAddDialog(harness.lists[1]);

      inputs[0].value = typed;
      doneButton.click();
      await flush();

      expect(displayTooltip).toHaveBeenCalledWith(
        inputs[0],
        'modals.excludedTag.emptyTag',
        { classes: ['mod-error'] }
      );
      expect(harness.exclusions.excludedTags).toEqual([]);
      expect(modal.close).not.toHaveBeenCalled();
    });

    it.each([
      ['a listed tag, "#" and case aside', '#DRAFT'],
      ['a listed pattern', '/^wip/'],
    ])('refuses %s as a duplicate', async (_case, typed) => {
      harness.exclusions.excludedTags = ['draft', '/^wip/'];
      const { modal, inputs, doneButton } = openAddDialog(harness.lists[1]);

      inputs[0].value = typed;
      doneButton.click();
      await flush();

      expect(displayTooltip).toHaveBeenCalledWith(
        inputs[0],
        'modals.exclusionEntry.duplicate',
        { classes: ['mod-error'] }
      );
      expect(harness.exclusions.excludedTags).toEqual(['draft', '/^wip/']);
      expect(harness.saveSettings).not.toHaveBeenCalled();
      expect(modal.close).not.toHaveBeenCalled();
    });

    it('adds a picked tag at once', async () => {
      setVaultTags(harness, ['#project', '#draft']);
      const { modal } = openAddDialog(harness.lists[1]);

      TagSuggest.prototype.selectSuggestion.call(
        tagSuggests[0] as TagSuggest,
        '#draft',
        new window.MouseEvent('click')
      );
      await flush();

      expect(harness.exclusions.excludedTags).toEqual(['#draft']);
      expect(modal.close).toHaveBeenCalledTimes(1);
    });

    // `getTags()` lists in vault-walk order, so the longer tag can come first
    it('saves the tag typed on Enter when a longer vault tag is listed ahead of it', async () => {
      setVaultTags(harness, ['#aliquam', '#aliqua']);
      const { inputs } = openAddDialog(harness.lists[1]);

      inputs[0].value = 'aliqua';
      enterOnTagSuggestions(inputs[0].value);
      await flush();

      expect(harness.exclusions.excludedTags).toEqual(['#aliqua']);
    });

    it('saves the typed text on Enter when it is only part of a vault tag', async () => {
      setVaultTags(harness, ['#drafts']);
      const { inputs } = openAddDialog(harness.lists[1]);

      inputs[0].value = 'draft';
      enterOnTagSuggestions(inputs[0].value);
      await flush();

      expect(harness.exclusions.excludedTags).toEqual(['draft']);
    });
  });

  describe('properties', () => {
    let harness: Harness;

    beforeEach(() => {
      harness = buildHarness();
    });

    it('opens "Add property" with an empty name field and an empty value field', () => {
      const { modal, inputs, labels, helps } = openAddDialog(harness.lists[2]);

      expect(modal.setTitle).toHaveBeenCalledWith(
        'modals.excludedProperty.title'
      );
      expect(inputs.map((input) => input.value)).toEqual(['', '']);
      expect(labels).toEqual([
        'settings.exclusions.properties.keyPlaceholder',
        'settings.exclusions.properties.valuePlaceholder',
      ]);
      expect(helps).toEqual([
        'modals.excludedProperty.nameHelp',
        'modals.excludedProperty.valueHelp',
      ]);
    });

    it('adds the trimmed pair, then re-renders and focuses the new row', async () => {
      harness.exclusions.excludedProperties = [{ key: 'a', value: 'b' }];
      const { rows, affordance } = mountListGroup();
      appendRow(rows);
      harness.update.mockImplementation(() => appendRow(rows));
      const { inputs, doneButton } = openAddDialog(
        harness.lists[2],
        affordance
      );

      inputs[0].value = ' status ';
      inputs[1].value = ' done ';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedProperties).toEqual([
        { key: 'a', value: 'b' },
        { key: 'status', value: 'done' },
      ]);
      expect(harness.saveSettings).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(rows.children[1]);
    });

    it('adds a name with a blank value, which matches any value', async () => {
      const { inputs, doneButton } = openAddDialog(harness.lists[2]);

      inputs[0].value = 'status';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedProperties).toEqual([
        { key: 'status', value: '' },
      ]);
    });

    it('refuses a blank name, even with a value', async () => {
      const { modal, inputs, doneButton } = openAddDialog(harness.lists[2]);

      inputs[0].value = '  ';
      inputs[1].value = 'done';
      doneButton.click();
      await flush();

      expect(displayTooltip).toHaveBeenCalledWith(
        inputs[0],
        'modals.excludedProperty.emptyName',
        { classes: ['mod-error'] }
      );
      expect(harness.exclusions.excludedProperties).toEqual([]);
      expect(modal.close).not.toHaveBeenCalled();
    });

    it('refuses a rule matching a listed one on both sides, case aside', async () => {
      harness.exclusions.excludedProperties = [
        { key: 'status', value: 'done' },
      ];
      const { modal, inputs, doneButton } = openAddDialog(harness.lists[2]);

      inputs[0].value = 'Status';
      inputs[1].value = 'DONE';
      doneButton.click();
      await flush();

      expect(displayTooltip).toHaveBeenCalledWith(
        inputs[0],
        'modals.exclusionEntry.duplicate',
        { classes: ['mod-error'] }
      );
      expect(harness.exclusions.excludedProperties).toHaveLength(1);
      expect(modal.close).not.toHaveBeenCalled();
    });

    it('adds a rule that shares only its name with a listed one', async () => {
      harness.exclusions.excludedProperties = [
        { key: 'status', value: 'done' },
      ];
      const { inputs, doneButton } = openAddDialog(harness.lists[2]);

      inputs[0].value = 'status';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedProperties).toEqual([
        { key: 'status', value: 'done' },
        { key: 'status', value: '' },
      ]);
    });
  });

  it('skips the focus follow-up when the affordance has no list group', async () => {
    const harness = buildHarness();
    // Detached from any `.setting-group`: the add must still land the entry.
    const orphan = document.body.createDiv();
    const { inputs, doneButton } = openAddDialog(harness.lists[1], orphan);

    inputs[0].value = 'draft';
    doneButton.click();
    await flush();

    expect(harness.exclusions.excludedTags).toEqual(['draft']);
  });
});
