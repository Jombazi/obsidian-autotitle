/**
 * Tests for the trash-bin Delete on the Exclusions page's tag and property
 * rows, which replaced the native list `onDelete` and its fixed x icon.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  PluginSettingTab,
  SettingDefinitionGroup,
  SettingDefinitionList,
  SettingDefinitionRender,
} from 'obsidian';
import { Setting } from '../mockObsidian';

vi.mock('../../src/i18n', () => ({
  t: vi.fn((key: string) => key),
  tp: vi.fn((key: string) => key),
  getCurrentLocale: vi.fn(() => 'en'),
}));

import { buildExclusionsPage } from '../../src/settings/exclusions';
import type { FirstLineIsTitlePlugin } from '../../src/settings/settings-base';
import { DEFAULT_SETTINGS } from '../../src/constants';

/** Lets an awaited save settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function buildHarness() {
  const exclusions = structuredClone(DEFAULT_SETTINGS.exclusions);
  exclusions.excludedTags = ['draft', 'archive'];
  exclusions.excludedProperties = [
    { key: 'status', value: 'done' },
    { key: 'type', value: '' },
  ];
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const plugin = {
    settings: { exclusions },
    saveSettings,
    debugLog: vi.fn(),
  } as unknown as FirstLineIsTitlePlugin;
  const update = vi.fn();
  const page = buildExclusionsPage(plugin, {
    update,
  } as unknown as PluginSettingTab);
  const lists = (page.items ?? []).filter(
    (item): item is SettingDefinitionList =>
      (item as { type?: string }).type === 'list'
  );
  const disablePropertyGroup = (page.items ?? []).find(
    (item) =>
      (item as SettingDefinitionGroup).heading ===
      'settings.exclusions.disableProperty.title'
  ) as SettingDefinitionGroup;
  return {
    exclusions,
    saveSettings,
    update,
    disablePropertyRow: disablePropertyGroup
      .items?.[1] as SettingDefinitionRender,
    files: lists[0],
    tags: lists[1],
    properties: lists[2],
  };
}

function renderRow(list: SettingDefinitionList, index: number): Setting {
  const setting = new Setting(document.createElement('div'));
  (list.items?.[index] as SettingDefinitionRender).render(
    setting as never,
    {} as never
  );
  return setting;
}

/** The row's last extra button, which is its Delete. */
function deleteButtonOf(setting: Setting) {
  return setting.components[setting.components.length - 1];
}

describe('Exclusion row Delete', () => {
  it('leaves no list with a native onDelete', () => {
    const { files, tags, properties } = buildHarness();

    expect([files, tags, properties].map((list) => list.onDelete)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it.each(['tags', 'properties'] as const)(
    'draws a trash bin titled Delete on each %s row',
    (listName) => {
      const harness = buildHarness();
      const button = deleteButtonOf(renderRow(harness[listName], 0));

      expect(button.setIcon).toHaveBeenCalledWith('lucide-trash-2');
      expect(button.setTooltip).toHaveBeenCalledWith('settings.common.delete');
    }
  );

  it('keeps the inline tag field ahead of the Delete', () => {
    const setting = renderRow(buildHarness().tags, 1);

    expect(setting.addText).toHaveBeenCalledTimes(1);
    expect(setting.addExtraButton).toHaveBeenCalledTimes(1);
  });

  it('gives the single disable-property row, which sits outside any list, no Delete', () => {
    const setting = new Setting(document.createElement('div'));
    buildHarness().disablePropertyRow.render(setting as never, {} as never);

    expect(setting.addExtraButton).not.toHaveBeenCalled();
  });

  it('deletes a tag, then persists and re-renders', async () => {
    const harness = buildHarness();

    deleteButtonOf(renderRow(harness.tags, 0)).onClick.mock.calls[0][0]();
    await flush();

    expect(harness.exclusions.excludedTags).toEqual(['archive']);
    expect(harness.saveSettings).toHaveBeenCalledTimes(1);
    expect(harness.update).toHaveBeenCalledTimes(1);
  });

  it("deletes the property row's own entry, then persists and re-renders", async () => {
    const harness = buildHarness();
    const [, second] = harness.exclusions.excludedProperties;
    const setting = renderRow(harness.properties, 0);

    expect(
      setting.controlEl.querySelector('.flit-property-key-input')
    ).not.toBeNull();
    deleteButtonOf(setting).onClick.mock.calls[0][0]();
    await flush();

    expect(harness.exclusions.excludedProperties).toEqual([second]);
    expect(harness.saveSettings).toHaveBeenCalledTimes(1);
    expect(harness.update).toHaveBeenCalledTimes(1);
  });
});
