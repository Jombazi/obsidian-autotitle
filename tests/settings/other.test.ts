/**
 * Tests for the Other page's Clear settings, which replaces every setting with
 * the defaults through the plugin's one replacement path and then re-runs the
 * exclusion setup a fresh install gets.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  PluginSettingTab,
  SettingDefinitionItem,
  SettingDefinitionRender,
} from 'obsidian';
import { App, ConfirmationModal, Setting } from '../mockObsidian';

vi.mock('../../src/i18n', () => ({
  t: vi.fn((key: string) => key),
  tp: vi.fn((key: string) => key),
  getCurrentLocale: vi.fn(() => 'en'),
}));

import FirstLineIsTitle from '../../main';
import { buildOtherPage } from '../../src/settings/other';
import { PluginInitializer } from '../../src/core/plugin-initializer';
import type { FirstLineIsTitlePlugin } from '../../src/settings/settings-base';
import { DEFAULT_SETTINGS } from '../../src/constants';
import type { PluginSettings } from '../../src/types';
import { flush } from '../testUtils';

function buildHarness(options: { saveFails?: boolean } = {}) {
  const settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
  settings.core.charCount = 42;
  settings.firstLineProperty.propertyKey = 'aliases';
  settings.firstLineProperty.hideProperty = 'always';
  const plugin = {
    app: new App(),
    settings,
    saveSettings: options.saveFails
      ? vi.fn().mockRejectedValue(new Error('disk full'))
      : vi.fn().mockResolvedValue(undefined),
    debugLog: vi.fn(),
    updatePropertyVisibility: vi.fn(),
    getCurrentTimestamp: vi.fn(() => ''),
    outputAllSettings: vi.fn(),
  } as unknown as FirstLineIsTitlePlugin;
  // The plugin's own replacement path, so the reset exercises its rollback and cascades
  plugin.replaceSettings = (next) =>
    FirstLineIsTitle.prototype.replaceSettings.call(plugin, next);
  const update = vi.fn();
  const page = buildOtherPage(plugin, {
    update,
  } as unknown as PluginSettingTab);
  return { plugin, update, page };
}

/** Finds a row by name anywhere in the page's groups. */
function findRow(
  items: SettingDefinitionItem[],
  name: string
): SettingDefinitionRender | undefined {
  for (const item of items) {
    if ((item as { name?: string }).name === name) {
      return item as SettingDefinitionRender;
    }
    const nested = (item as { items?: SettingDefinitionItem[] }).items;
    const found = nested && findRow(nested, name);
    if (found) return found;
  }
  return undefined;
}

/** Clicks Clear settings, then Clear in the confirmation it opens. */
async function clearSettings(
  harness: ReturnType<typeof buildHarness>
): Promise<void> {
  const addButton = vi.spyOn(ConfirmationModal.prototype, 'addButton');
  const row = findRow(
    harness.page.items ?? [],
    'settings.other.clearSettings.name'
  );
  const setting = new Setting(document.createElement('div'));
  row?.render(setting as never, {} as never);
  (setting.components[0].onClick.mock.calls[0][0] as () => void)();

  const confirmation = addButton.mock.contexts[0] as ConfirmationModal;
  confirmation.buttons[0].buttonEl.click();
  await flush();
}

describe('Clear settings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replaces every setting with a copy of the defaults', async () => {
    const harness = buildHarness();
    // The setup pass marks itself done; held off here so the comparison sees only the replacement
    vi.spyOn(
      PluginInitializer.prototype,
      'checkFirstTimeExclusionsSetup'
    ).mockResolvedValue(undefined);

    await clearSettings(harness);

    expect(harness.plugin.settings).toEqual(DEFAULT_SETTINGS);
    expect(harness.plugin.settings).not.toBe(DEFAULT_SETTINGS);
    expect(harness.plugin.settings.core).not.toBe(DEFAULT_SETTINGS.core);
  });

  it('brings property hiding in line without a reload', async () => {
    const harness = buildHarness();

    await clearSettings(harness);

    expect(harness.plugin.updatePropertyVisibility).toHaveBeenCalledTimes(1);
  });

  it('re-runs the exclusion setup, then re-renders', async () => {
    const harness = buildHarness();
    const exclusionsSetup = vi
      .spyOn(PluginInitializer.prototype, 'checkFirstTimeExclusionsSetup')
      .mockResolvedValue(undefined);

    await clearSettings(harness);

    expect(exclusionsSetup).toHaveBeenCalledTimes(1);
    expect(harness.update).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous settings, and stops there, when the save fails', async () => {
    const harness = buildHarness({ saveFails: true });
    const previous = structuredClone(harness.plugin.settings);
    const exclusionsSetup = vi.spyOn(
      PluginInitializer.prototype,
      'checkFirstTimeExclusionsSetup'
    );

    await clearSettings(harness);

    expect(harness.plugin.settings).toEqual(previous);
    expect(exclusionsSetup).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
  });
});
