/**
 * Tests for the First line property page: the property name field is what turns the feature on, so every row below it follows the field.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  PluginSettingTab,
  SettingDefinitionPage,
  SettingDefinitionRender,
} from 'obsidian';
import { App, Setting, debounce } from '../mockObsidian';
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
  requestSaveSettings: ReturnType<typeof vi.fn>;
  updatePropertyVisibility: ReturnType<typeof vi.fn>;
}

function buildHarness(
  propertyKey: string,
  rules: CustomReplacement[] = []
): Harness {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.firstLineProperty.propertyKey = propertyKey;
  settings.customReplacements.rules = rules;
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  // A pending flag in place of the plugin's debouncer, so a request followed by a flush counts as the one write it is
  let isSavePending = false;
  const requestSaveSettings = vi.fn(() => {
    isSavePending = true;
  });
  const updatePropertyVisibility = vi.fn();
  const plugin = {
    app: new App(),
    settings,
    saveSettings,
    requestSaveSettings,
    flushSettingsSave: vi.fn(() => {
      if (!isSavePending) return;
      isSavePending = false;
      void saveSettings();
    }),
    debugLog: vi.fn(),
    updatePropertyVisibility,
  } as unknown as FirstLineIsTitlePlugin;
  const update = vi.fn();
  const refreshDomState = vi.fn();
  // Stands in for the tab's debouncer, which runs the same property-name cascade
  const requestPropertyKeyCascade = debounce(
    () => updatePropertyVisibility(),
    500,
    true
  );
  const page = buildFirstLinePropertyPage(
    plugin,
    { update, refreshDomState } as unknown as PluginSettingTab,
    requestPropertyKeyCascade
  );
  return {
    settings,
    page,
    update,
    refreshDomState,
    saveSettings,
    requestSaveSettings,
    updatePropertyVisibility,
  };
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
  const restoreButton = setting.controlEl.querySelector<HTMLElement>(
    '.extra-setting-button'
  )!;
  const [textField] = setting.components;
  return { restoreButton, textField };
}

/** Types `value` into the property name field. */
function typeName(
  textField: ReturnType<typeof renderPropertyNameRow>['textField'],
  value: string
): void {
  (textField.onChange.mock.calls[0][0] as (v: string) => unknown)(value);
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
    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-applies row visibility without rebuilding the rows while typing', () => {
      const harness = buildHarness('');
      const { textField } = renderPropertyNameRow(harness);

      typeName(textField, 'aliases');

      expect(harness.settings.firstLineProperty.propertyKey).toBe('aliases');
      expect(harness.requestSaveSettings).toHaveBeenCalledTimes(1);
      expect(harness.saveSettings).not.toHaveBeenCalled();
      expect(harness.refreshDomState).toHaveBeenCalledTimes(1);
      expect(harness.update).not.toHaveBeenCalled();
      expect(visibleRowNames(harness)).toContain('Truncate');
    });

    it('applies the name to property hiding once typing pauses, not per keystroke', () => {
      vi.useFakeTimers();
      const harness = buildHarness('');
      const { textField } = renderPropertyNameRow(harness);

      typeName(textField, 'al');
      typeName(textField, 'alias');
      expect(harness.updatePropertyVisibility).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);

      expect(harness.updatePropertyVisibility).toHaveBeenCalledTimes(1);
    });

    it('re-applies row visibility when restoring the blank default', () => {
      const harness = buildHarness('aliases');
      const { restoreButton } = renderPropertyNameRow(harness);

      restoreButton.click();

      expect(harness.settings.firstLineProperty.propertyKey).toBe('');
      expect(harness.refreshDomState).toHaveBeenCalledTimes(1);
      expect(harness.update).not.toHaveBeenCalled();
      expect(visibleRowNames(harness)).toEqual([PROPERTY_NAME_ROW]);
    });

    it('saves and applies a restored name at once, as a click rather than typing', () => {
      vi.useFakeTimers();
      const harness = buildHarness('aliases');
      const { restoreButton } = renderPropertyNameRow(harness);

      restoreButton.click();

      expect(harness.saveSettings).toHaveBeenCalledTimes(1);
      expect(harness.updatePropertyVisibility).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      expect(harness.updatePropertyVisibility).toHaveBeenCalledTimes(1);
    });

    it('writes nothing when restoring a name already at the default', () => {
      const harness = buildHarness('');
      const { restoreButton, textField } = renderPropertyNameRow(harness);

      restoreButton.click();

      expect(textField.setValue).toHaveBeenLastCalledWith('');
      expect(harness.requestSaveSettings).not.toHaveBeenCalled();
      expect(harness.saveSettings).not.toHaveBeenCalled();
      expect(harness.updatePropertyVisibility).not.toHaveBeenCalled();
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
