/**
 * Tests for the First line property page: the property name field is what turns the feature on, so every row below it follows the field.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  PluginSettingTab,
  SettingDefinitionPage,
  SettingDefinitionRender,
} from 'obsidian';
import { App, Setting } from '../mockObsidian';
import { buildFirstLinePropertyPage } from '../../src/settings/first-line-property';
import type { FirstLineIsTitlePlugin } from '../../src/settings/settings-base';
import { DEFAULT_SETTINGS } from '../../src/constants';
import type { CustomReplacement, PluginSettings } from '../../src/types';

const PROPERTY_NAME_ROW = 'First line property';
const APPLY_CUSTOM_REPLACEMENTS_ROW = 'Apply custom replacements';

interface Harness {
  settings: PluginSettings;
  page: SettingDefinitionPage;
  update: ReturnType<typeof vi.fn>;
  refreshDomState: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
}

function buildHarness(
  propertyKey: string,
  rules: CustomReplacement[] = []
): Harness {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.firstLineProperty.propertyKey = propertyKey;
  settings.customReplacements.rules = rules;
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const plugin = {
    app: new App(),
    settings,
    saveSettings,
    debugLog: vi.fn(),
    updatePropertyVisibility: vi.fn(),
  } as unknown as FirstLineIsTitlePlugin;
  const update = vi.fn();
  const refreshDomState = vi.fn();
  const page = buildFirstLinePropertyPage(plugin, {
    update,
    refreshDomState,
  } as unknown as PluginSettingTab);
  return { settings, page, update, refreshDomState, saveSettings };
}

function visibleRowNames(harness: Harness): string[] {
  return (harness.page.items ?? [])
    .filter((item) => (item as { visible?: () => boolean }).visible?.() ?? true)
    .map((item) => (item as { name: string }).name);
}

function propertyNameRow(harness: Harness): SettingDefinitionRender {
  return (harness.page.items ?? []).find(
    (item) => (item as { name?: string }).name === PROPERTY_NAME_ROW
  ) as SettingDefinitionRender;
}

/** Renders the property name row, returning its restore button and text field. */
function renderPropertyNameRow(harness: Harness) {
  const setting = new Setting(document.createElement('div'));
  propertyNameRow(harness).render(setting as never, {} as never);
  const [restoreButton, textField] = setting.components;
  return { restoreButton, textField };
}

/** Lets an awaited save settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const rule: CustomReplacement = {
  searchText: 'TODO',
  replaceText: 'Done',
  onlyAtStart: false,
  onlyWholeLine: false,
};

describe('First line property page', () => {
  describe('visibility', () => {
    it('shows only the property name field while it is blank', () => {
      expect(visibleRowNames(buildHarness(''))).toEqual([PROPERTY_NAME_ROW]);
    });

    it('treats a name made only of commas and spaces as blank', () => {
      expect(visibleRowNames(buildHarness(' , '))).toEqual([PROPERTY_NAME_ROW]);
    });

    it('shows the rows below once the field holds a name', () => {
      expect(visibleRowNames(buildHarness('aliases'))).toEqual([
        PROPERTY_NAME_ROW,
        'Add only if title differs from first line',
        'Truncate',
        'Strip markup',
        'Keep empty property',
        'Place last in list',
        'Hide property',
      ]);
    });

    it('hides "Apply custom replacements" while there are no rules', () => {
      expect(visibleRowNames(buildHarness('aliases', []))).not.toContain(
        APPLY_CUSTOM_REPLACEMENTS_ROW
      );
    });

    it('shows "Apply custom replacements" once a rule exists', () => {
      expect(visibleRowNames(buildHarness('aliases', [rule]))).toContain(
        APPLY_CUSTOM_REPLACEMENTS_ROW
      );
    });

    it('hides "Apply custom replacements" with rules while the name is blank', () => {
      expect(visibleRowNames(buildHarness('', [rule]))).toEqual([
        PROPERTY_NAME_ROW,
      ]);
    });

    it('has no row that switches the property on or off', () => {
      const harness = buildHarness('aliases');

      expect(
        (harness.page.items ?? []).map(
          (item) => (item as { control?: { key: string } }).control?.key
        )
      ).not.toContain('firstLineProperty.enableFirstLineProperty');
    });
  });

  describe('property name field', () => {
    it('re-applies row visibility without rebuilding the rows while typing', async () => {
      const harness = buildHarness('');
      const { textField } = renderPropertyNameRow(harness);

      await (textField.onChange.mock.calls[0][0] as (v: string) => unknown)(
        'aliases'
      );

      expect(harness.settings.firstLineProperty.propertyKey).toBe('aliases');
      expect(harness.saveSettings).toHaveBeenCalledTimes(1);
      expect(harness.refreshDomState).toHaveBeenCalledTimes(1);
      expect(harness.update).not.toHaveBeenCalled();
      expect(visibleRowNames(harness)).toContain('Truncate');
    });

    it('re-applies row visibility when restoring the blank default', async () => {
      const harness = buildHarness('aliases');
      const { restoreButton } = renderPropertyNameRow(harness);

      (restoreButton.onClick.mock.calls[0][0] as () => void)();
      await flush();

      expect(harness.settings.firstLineProperty.propertyKey).toBe('');
      expect(harness.refreshDomState).toHaveBeenCalledTimes(1);
      expect(harness.update).not.toHaveBeenCalled();
      expect(visibleRowNames(harness)).toEqual([PROPERTY_NAME_ROW]);
    });

    it('is named "First line property"', () => {
      expect(propertyNameRow(buildHarness(''))).toBeDefined();
    });

    it('lists the "aliases" note last in its description', () => {
      const desc = propertyNameRow(buildHarness('')).desc as DocumentFragment;

      expect(desc.textContent).toBe(
        'The name of the property to copy the first line to when renaming.' +
          'To populate multiple properties, separate with commas.' +
          'Use “aliases” to make the first line searchable in the Quick switcher and link suggestions.'
      );
    });
  });

  describe('page summary', () => {
    it('reads "Enabled" while the field holds a name', () => {
      const { displayValue } = buildHarness('aliases').page;

      expect(typeof displayValue === 'function' && displayValue()).toBe(
        'Enabled'
      );
    });

    it('stays blank while the field is blank', () => {
      const { displayValue } = buildHarness('').page;

      expect(typeof displayValue === 'function' && displayValue()).toBe('');
    });
  });
});
