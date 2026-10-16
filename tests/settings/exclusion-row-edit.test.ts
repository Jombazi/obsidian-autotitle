/**
 * Tests for the Exclusions page's tag and property rows, which read like the
 * Excluded files rows and edit through the exclusion entry dialog, and for the
 * disable-property row, which shows its pair as text and edits through the same
 * dialog.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  PluginSettingTab,
  SettingDefinitionGroup,
  SettingDefinitionList,
  SettingDefinitionRender,
} from 'obsidian';
import type { SettingPath } from '../../src/settings/settings-paths';
import { App, Setting, displayTooltip } from '../mockObsidian';

const { openedModals, tagSuggests } = vi.hoisted(() => ({
  openedModals: [] as unknown[],
  tagSuggests: [] as unknown[],
}));

vi.mock('../../src/i18n', () => ({
  t: vi.fn((key: string) => key),
  tp: vi.fn((key: string) => key),
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
import {
  clickExtraButton,
  flush,
  openLatestExclusionEntryDialog,
  typeInto,
} from '../testUtils';

function buildHarness() {
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
  const build = () => {
    const page = buildExclusionsPage(plugin, {
      update,
    } as unknown as PluginSettingTab);
    const lists = (page.items ?? []).filter(
      (item): item is SettingDefinitionList<SettingPath> =>
        (item as { type?: string }).type === 'list'
    );
    const disablePropertyGroup = (page.items ?? []).find(
      (item) =>
        (item as SettingDefinitionGroup<SettingPath>).heading ===
        'settings.exclusions.disableProperty.title'
    ) as SettingDefinitionGroup<SettingPath>;
    return {
      tags: lists[1],
      properties: lists[2],
      disablePropertyRow: disablePropertyGroup
        .items?.[1] as SettingDefinitionRender,
    };
  };
  return {
    exclusions,
    app,
    saveSettings,
    update,
    build,
  };
}

function renderDefinition(definition: SettingDefinitionRender): Setting {
  const setting = new Setting(document.createElement('div'));
  definition.render(setting as never, {} as never);
  return setting;
}

/** Clicks the Edit of a list's row and opens the dialog it creates. */
function openEditDialog(
  list: SettingDefinitionList<SettingPath>,
  index: number
) {
  clickExtraButton(
    renderDefinition(list.items?.[index] as SettingDefinitionRender),
    'lucide-pen-line'
  );
  return openLatestExclusionEntryDialog(openedModals);
}

describe('Exclusion row edits', () => {
  beforeEach(() => {
    openedModals.length = 0;
    tagSuggests.length = 0;
    vi.mocked(displayTooltip).mockClear();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  describe('row summaries', () => {
    /** A rendered row's name or description text, and its `Regex` badges. */
    function readSide(el: HTMLElement) {
      return {
        text: el.textContent,
        badges: Array.from(
          el.querySelectorAll('.flair.mod-flat'),
          (badge) => badge.textContent
        ),
      };
    }

    it('shows each tag as text, with a `Regex` badge on a pattern and no text field', () => {
      const harness = buildHarness();
      harness.exclusions.excludedTags = ['draft', '/^wip/'];
      const { tags } = harness.build();

      const settings = [0, 1].map((index) =>
        renderDefinition(tags.items?.[index] as SettingDefinitionRender)
      );

      expect(settings.map((setting) => readSide(setting.nameEl))).toEqual([
        { text: 'draft', badges: [] },
        { text: '/^wip/Regex', badges: ['Regex'] },
      ]);
      expect(
        settings.map((setting) => setting.settingEl.querySelector('input'))
      ).toEqual([null, null]);
    });

    it('shows a property name over its value, "Any value" for a blank one, each side badged on its own', () => {
      const harness = buildHarness();
      harness.exclusions.excludedProperties = [
        { key: 'status', value: 'done' },
        { key: '/^st/', value: '' },
        { key: 'type', value: '/draft|wip/' },
      ];
      const { properties } = harness.build();

      const settings = [0, 1, 2].map((index) =>
        renderDefinition(properties.items?.[index] as SettingDefinitionRender)
      );

      expect(
        settings.map((setting) => [
          readSide(setting.nameEl),
          readSide(setting.descEl),
        ])
      ).toEqual([
        [
          { text: 'status', badges: [] },
          { text: 'done', badges: [] },
        ],
        [
          { text: '/^st/Regex', badges: ['Regex'] },
          { text: 'settings.exclusions.properties.anyValue', badges: [] },
        ],
        [
          { text: 'type', badges: [] },
          { text: '/draft|wip/Regex', badges: ['Regex'] },
        ],
      ]);
      expect(
        settings.map((setting) => setting.settingEl.querySelector('input'))
      ).toEqual([null, null, null]);
    });

    it('keeps rows out of the settings search, and keys property rows by id', () => {
      const harness = buildHarness();
      harness.exclusions.excludedTags = ['draft'];
      harness.exclusions.excludedProperties = [
        { key: 'status', value: 'done' },
        { key: 'status', value: 'wip' },
      ];
      const { tags, properties } = harness.build();
      const [first, second] = (properties.items ?? []) as {
        id?: string;
        searchable?: boolean;
      }[];

      expect(tags.items?.[0]).toMatchObject({ searchable: false });
      expect([first.searchable, second.searchable]).toEqual([false, false]);
      expect(first.id).toEqual(expect.any(String));
      expect(first.id).not.toBe(second.id);
    });
  });

  describe('tag rows', () => {
    it('open "Edit excluded tag" with the entry prefilled and the tag help line', () => {
      const harness = buildHarness();
      harness.exclusions.excludedTags = ['draft', '/^wip/'];

      const { modal, inputs, labels, helps } = openEditDialog(
        harness.build().tags,
        1
      );

      expect(modal.setTitle).toHaveBeenCalledWith(
        'modals.excludedTag.editTitle'
      );
      expect(inputs.map((input) => input.value)).toEqual(['/^wip/']);
      expect(labels).toEqual(['']);
      expect(helps).toEqual(['modals.excludedTag.help']);
    });

    it('replace the entry in place on Done, then close and re-render', async () => {
      const harness = buildHarness();
      harness.exclusions.excludedTags = ['draft', 'wip', 'archive'];
      const { modal, inputs, doneButton } = openEditDialog(
        harness.build().tags,
        1
      );

      inputs[0].value = '  #review ';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedTags).toEqual([
        'draft',
        '#review',
        'archive',
      ]);
      expect(harness.saveSettings).toHaveBeenCalledTimes(1);
      expect(modal.close).toHaveBeenCalledTimes(1);
      expect(harness.update).toHaveBeenCalledTimes(1);
    });

    it('keep a change of "#" or case alone, which is not a duplicate of itself', async () => {
      const harness = buildHarness();
      harness.exclusions.excludedTags = ['draft', 'wip'];
      const { inputs, doneButton } = openEditDialog(harness.build().tags, 0);

      inputs[0].value = '#Draft';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedTags).toEqual(['#Draft', 'wip']);
    });

    it.each([
      ['a plain entry, "#" and case aside', ['draft', 'wip'], '#DRAFT'],
      ['a pattern', ['/^draft/', 'wip'], '/^draft/'],
    ])(
      'keep the dialog open with the duplicate error for an edit matching another entry: %s',
      async (_case, entries, edited) => {
        const harness = buildHarness();
        harness.exclusions.excludedTags = [...entries];
        const { modal, inputs, doneButton } = openEditDialog(
          harness.build().tags,
          1
        );

        inputs[0].value = edited;
        doneButton.click();
        await flush();

        expect(displayTooltip).toHaveBeenCalledWith(
          inputs[0],
          'modals.exclusionEntry.duplicate',
          { classes: ['mod-error'] }
        );
        expect(harness.exclusions.excludedTags).toEqual(entries);
        expect(harness.saveSettings).not.toHaveBeenCalled();
        expect(modal.close).not.toHaveBeenCalled();
      }
    );

    it.each(['   ', ' # '])(
      'refuse a blank entry, a bare "#" included: %j',
      async (edited) => {
        const harness = buildHarness();
        harness.exclusions.excludedTags = ['draft'];
        const { modal, inputs, doneButton } = openEditDialog(
          harness.build().tags,
          0
        );

        inputs[0].value = edited;
        doneButton.click();
        await flush();

        expect(displayTooltip).toHaveBeenCalledWith(
          inputs[0],
          'modals.excludedTag.emptyTag',
          { classes: ['mod-error'] }
        );
        expect(harness.exclusions.excludedTags).toEqual(['draft']);
        expect(modal.close).not.toHaveBeenCalled();
      }
    );

    it('close without writing when a tag menu dropped the entry while the dialog was open', async () => {
      const harness = buildHarness();
      harness.exclusions.excludedTags = ['draft', 'wip'];
      const { modal, inputs, doneButton } = openEditDialog(
        harness.build().tags,
        1
      );
      harness.exclusions.excludedTags.splice(1, 1);

      inputs[0].value = 'review';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedTags).toEqual(['draft']);
      expect(harness.saveSettings).not.toHaveBeenCalled();
      expect(modal.close).toHaveBeenCalledTimes(1);
      expect(harness.update).toHaveBeenCalledTimes(1);
    });

    it('attach tag suggestions once the entry is typed into, leaving out the other entries but not the one being edited', () => {
      const harness = buildHarness();
      harness.exclusions.excludedTags = ['draft', 'wip'];
      (
        harness.app.metadataCache as unknown as {
          getTags: () => Record<string, number>;
        }
      ).getTags = () => ({ '#draft': 1, '#wip': 1, '#archive': 1 });
      const { inputs } = openEditDialog(harness.build().tags, 1);
      expect(tagSuggests).toHaveLength(0);

      typeInto(inputs[0], '');

      expect(tagSuggests).toHaveLength(1);
      expect(
        TagSuggest.prototype.getSuggestions.call(
          tagSuggests[0] as TagSuggest,
          ''
        )
      ).toEqual(['#wip', '#archive']);
    });
  });

  describe('property rows', () => {
    it('open "Edit excluded property" with the name and value prefilled, each labeled with its help line', () => {
      const harness = buildHarness();
      harness.exclusions.excludedProperties = [
        { key: 'status', value: 'done' },
      ];

      const { modal, inputs, labels, helps } = openEditDialog(
        harness.build().properties,
        0
      );

      expect(modal.setTitle).toHaveBeenCalledWith(
        'modals.excludedProperty.editTitle'
      );
      expect(inputs.map((input) => input.value)).toEqual(['status', 'done']);
      expect(labels).toEqual([
        'settings.exclusions.properties.keyPlaceholder',
        'settings.exclusions.properties.valuePlaceholder',
      ]);
      expect(helps).toEqual([
        'modals.excludedProperty.nameHelp',
        'modals.excludedProperty.valueHelp',
      ]);
    });

    it('rewrite the same property object, trimmed, on Done, then close and re-render', async () => {
      const property = { key: 'status', value: 'done' };
      const harness = buildHarness();
      harness.exclusions.excludedProperties = [
        property,
        { key: 'type', value: '' },
      ];
      const { modal, inputs, doneButton } = openEditDialog(
        harness.build().properties,
        0
      );

      inputs[0].value = ' state ';
      inputs[1].value = ' /^draft/ ';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedProperties[0]).toBe(property);
      expect(property).toEqual({ key: 'state', value: '/^draft/' });
      expect(harness.saveSettings).toHaveBeenCalledTimes(1);
      expect(modal.close).toHaveBeenCalledTimes(1);
      expect(harness.update).toHaveBeenCalledTimes(1);
    });

    it('keep the row id across an edit, since the name it would otherwise be keyed by changes', async () => {
      const harness = buildHarness();
      harness.exclusions.excludedProperties = [{ key: 'status', value: '' }];
      const idBefore = (
        harness.build().properties.items?.[0] as { id?: string }
      ).id;
      const { inputs, doneButton } = openEditDialog(
        harness.build().properties,
        0
      );

      inputs[0].value = 'state';
      doneButton.click();
      await flush();

      const rowAfter = harness.build().properties.items?.[0] as {
        id?: string;
        name: string;
      };
      expect(idBefore).toEqual(expect.any(String));
      expect(rowAfter).toMatchObject({ id: idBefore, name: 'state' });
    });

    it('keep the dialog open with the empty-name error for a blank name', async () => {
      const harness = buildHarness();
      harness.exclusions.excludedProperties = [
        { key: 'status', value: 'done' },
      ];
      const { modal, inputs, doneButton } = openEditDialog(
        harness.build().properties,
        0
      );

      inputs[0].value = '  ';
      doneButton.click();
      await flush();

      expect(displayTooltip).toHaveBeenCalledWith(
        inputs[0],
        'modals.excludedProperty.emptyName',
        { classes: ['mod-error'] }
      );
      expect(harness.exclusions.excludedProperties).toEqual([
        { key: 'status', value: 'done' },
      ]);
      expect(modal.close).not.toHaveBeenCalled();
    });

    it('keep the dialog open with the duplicate error for an edit matching another rule on both sides, case aside', async () => {
      const harness = buildHarness();
      harness.exclusions.excludedProperties = [
        { key: 'status', value: 'done' },
        { key: 'type', value: '' },
      ];
      const { modal, inputs, doneButton } = openEditDialog(
        harness.build().properties,
        1
      );

      inputs[0].value = 'Status';
      inputs[1].value = 'DONE';
      doneButton.click();
      await flush();

      expect(displayTooltip).toHaveBeenCalledWith(
        inputs[0],
        'modals.exclusionEntry.duplicate',
        { classes: ['mod-error'] }
      );
      expect(harness.exclusions.excludedProperties[1]).toEqual({
        key: 'type',
        value: '',
      });
      expect(modal.close).not.toHaveBeenCalled();
    });

    it('keep a change of case alone, which is not a duplicate of itself', async () => {
      const harness = buildHarness();
      harness.exclusions.excludedProperties = [
        { key: 'status', value: 'done' },
      ];
      const { inputs, doneButton } = openEditDialog(
        harness.build().properties,
        0
      );

      inputs[0].value = 'Status';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedProperties).toEqual([
        { key: 'Status', value: 'done' },
      ]);
    });

    it('close without writing when the rule was deleted while the dialog was open', async () => {
      const harness = buildHarness();
      harness.exclusions.excludedProperties = [
        { key: 'status', value: 'done' },
      ];
      const { modal, inputs, doneButton } = openEditDialog(
        harness.build().properties,
        0
      );
      harness.exclusions.excludedProperties = [];

      inputs[0].value = 'state';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedProperties).toEqual([]);
      expect(harness.saveSettings).not.toHaveBeenCalled();
      expect(modal.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('disable-property row', () => {
    function renderDisablePropertyRow(
      harness: ReturnType<typeof buildHarness>
    ) {
      const setting = renderDefinition(harness.build().disablePropertyRow);
      return {
        setting,
        restoreButton: setting.controlEl.querySelector(
          '.extra-setting-button'
        ) as HTMLElement,
      };
    }

    function openDisablePropertyDialog(
      harness: ReturnType<typeof buildHarness>
    ) {
      clickExtraButton(
        renderDisablePropertyRow(harness).setting,
        'lucide-pen-line'
      );
      return openLatestExclusionEntryDialog(openedModals);
    }

    it('shows the name over the value as text, with no text field', () => {
      const harness = buildHarness();
      harness.exclusions.disableRenamingKey = 'skip';
      harness.exclusions.disableRenamingValue = '/yes/';

      const { setting } = renderDisablePropertyRow(harness);

      expect(setting.nameEl.textContent).toBe('skip');
      // Matched literally, so a pattern-shaped value carries no `Regex` badge
      expect(setting.descEl.textContent).toBe('/yes/');
      expect(setting.settingEl.querySelector('.flair')).toBeNull();
      expect(setting.settingEl.querySelector('input')).toBeNull();
    });

    it('shows a blank value as the muted "Empty" label', () => {
      const harness = buildHarness();
      harness.exclusions.disableRenamingValue = '';

      const { setting } = renderDisablePropertyRow(harness);

      const emptyLabel = setting.descEl.querySelector('.u-muted');
      expect(emptyLabel?.textContent).toBe('settings.common.emptyPlaceholder');
      expect(setting.descEl.textContent).toBe(
        'settings.common.emptyPlaceholder'
      );
    });

    it('stays in the settings search under its title, its labels as aliases', () => {
      const { disablePropertyRow } = buildHarness().build();

      expect(disablePropertyRow).toMatchObject({
        name: 'settings.exclusions.disableProperty.title',
        searchable: true,
        aliases: [
          'settings.exclusions.properties.keyPlaceholder',
          'settings.exclusions.properties.valuePlaceholder',
        ],
      });
    });

    it('puts the restore button to the left of Edit', () => {
      const { setting, restoreButton } =
        renderDisablePropertyRow(buildHarness());

      expect(setting.controlEl.firstElementChild).toBe(restoreButton);
      expect(restoreButton.getAttribute('data-icon')).toBe('rotate-ccw');
      expect(
        setting.components.map(
          (component) => component.setIcon.mock.calls[0]?.[0] as string
        )
      ).toEqual(['lucide-pen-line']);
    });

    it('opens the dialog under the row title with both fields prefilled, each noting that case is ignored', () => {
      const harness = buildHarness();
      harness.exclusions.disableRenamingKey = 'skip';
      harness.exclusions.disableRenamingValue = 'yes';

      const { modal, inputs, labels, helps } =
        openDisablePropertyDialog(harness);

      expect(modal.setTitle).toHaveBeenCalledWith(
        'settings.exclusions.disableProperty.title'
      );
      expect(inputs.map((input) => input.value)).toEqual(['skip', 'yes']);
      expect(labels).toEqual([
        'settings.exclusions.properties.keyPlaceholder',
        'settings.exclusions.properties.valuePlaceholder',
      ]);
      expect(helps).toEqual([
        'settings.exclusions.disableProperty.caseInsensitive',
        'settings.exclusions.disableProperty.caseInsensitive',
      ]);
    });

    it('writes both halves, trimmed, on Done, then closes and re-renders', async () => {
      const harness = buildHarness();
      const { modal, inputs, doneButton } = openDisablePropertyDialog(harness);

      inputs[0].value = ' skip ';
      inputs[1].value = ' yes ';
      doneButton.click();
      await flush();

      expect(harness.exclusions.disableRenamingKey).toBe('skip');
      expect(harness.exclusions.disableRenamingValue).toBe('yes');
      expect(harness.saveSettings).toHaveBeenCalledTimes(1);
      expect(modal.close).toHaveBeenCalledTimes(1);
      expect(harness.update).toHaveBeenCalledTimes(1);
    });

    it('keeps the dialog open with the empty-name error for a blank name', async () => {
      const harness = buildHarness();
      const { modal, inputs, doneButton } = openDisablePropertyDialog(harness);

      inputs[0].value = '  ';
      inputs[1].value = 'yes';
      doneButton.click();
      await flush();

      expect(displayTooltip).toHaveBeenCalledWith(
        inputs[0],
        'modals.excludedProperty.emptyName',
        { classes: ['mod-error'] }
      );
      expect(harness.exclusions.disableRenamingKey).toBe(
        DEFAULT_SETTINGS.exclusions.disableRenamingKey
      );
      expect(harness.exclusions.disableRenamingValue).toBe(
        DEFAULT_SETTINGS.exclusions.disableRenamingValue
      );
      expect(harness.saveSettings).not.toHaveBeenCalled();
      expect(modal.close).not.toHaveBeenCalled();
    });

    it('restores both defaults, then saves and re-renders', async () => {
      const harness = buildHarness();
      harness.exclusions.disableRenamingKey = 'skip';
      harness.exclusions.disableRenamingValue = 'yes';
      const { restoreButton } = renderDisablePropertyRow(harness);
      expect(restoreButton.getAttribute('aria-disabled')).toBe('false');

      restoreButton.click();
      await flush();

      expect(harness.exclusions.disableRenamingKey).toBe(
        DEFAULT_SETTINGS.exclusions.disableRenamingKey
      );
      expect(harness.exclusions.disableRenamingValue).toBe(
        DEFAULT_SETTINGS.exclusions.disableRenamingValue
      );
      expect(harness.saveSettings).toHaveBeenCalledTimes(1);
      expect(harness.update).toHaveBeenCalledTimes(1);
      expect(
        renderDisablePropertyRow(harness).restoreButton.getAttribute(
          'aria-disabled'
        )
      ).toBe('true');
    });

    it('dims the restore button at the default, where a click writes nothing', async () => {
      const harness = buildHarness();
      const { restoreButton } = renderDisablePropertyRow(harness);
      expect(restoreButton.getAttribute('aria-disabled')).toBe('true');

      restoreButton.click();
      await flush();

      expect(harness.saveSettings).not.toHaveBeenCalled();
      expect(harness.update).not.toHaveBeenCalled();
    });
  });
});
