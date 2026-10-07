/**
 * Tests for PluginInitializer.
 *
 * The forbidden-char first-enable cascade also exists in the settings tab, and
 * both latch on `core.hasEnabledForbiddenChars` — whichever fires first locks
 * the other out permanently. Parity between the two is asserted in
 * tests/settings/settings-main.test.ts; this file pins the load-time side.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { App } from '../mockObsidian';
import { DEFAULT_SETTINGS } from '../../src/constants';
import { processForbiddenChars } from '../../src/utils/string-processing';
import type { PluginSettings } from '../../src/types';
import type { CharKey } from '../../src/types/char-replacement';

vi.mock('../../src/utils', () => ({
  verboseLog: vi.fn(),
}));

import { PluginInitializer } from '../../src/core/plugin-initializer';
import type { FirstLineIsTitlePlugin } from '../../src/settings/settings-base';

interface TestPlugin {
  app: App;
  settings: PluginSettings;
  saveSettings: ReturnType<typeof vi.fn>;
}

function makePlugin(): TestPlugin {
  return {
    app: new App(),
    settings: structuredClone(DEFAULT_SETTINGS) as PluginSettings,
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
}

function enabledCharKeys(settings: PluginSettings): CharKey[] {
  const { charReplacements } = settings.characterReplacements;
  return (Object.keys(charReplacements) as CharKey[]).filter(
    (key) => charReplacements[key].enabled
  );
}

describe('PluginInitializer', () => {
  let plugin: TestPlugin;
  let initializer: PluginInitializer;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = makePlugin();
    initializer = new PluginInitializer(
      plugin as unknown as FirstLineIsTitlePlugin
    );
  });

  describe('initializeFirstEnableLogic — forbidden chars', () => {
    beforeEach(() => {
      plugin.settings.characterReplacements.enableForbiddenCharReplacements = true;
      plugin.settings.core.hasEnabledForbiddenChars = false;
    });

    it('enables every forbidden char, backslash included', async () => {
      await initializer.initializeFirstEnableLogic();

      expect(enabledCharKeys(plugin.settings).sort()).toEqual(
        [
          'asterisk',
          'backslash',
          'caret',
          'colon',
          'dot',
          'greaterThan',
          'hash',
          'leftBracket',
          'lessThan',
          'pipe',
          'question',
          'quote',
          'rightBracket',
          'slash',
        ].sort()
      );
    });

    it('replaces rather than drops a Windows/Android-only character', async () => {
      await initializer.initializeFirstEnableLogic();

      // A forbidden char whose toggle is off is deleted outright, so the
      // Windows/Android keys have to be part of the cascade on every OS.
      expect(processForbiddenChars('What? Yes', plugin.settings)).toBe(
        'What？Yes'
      );
    });

    it('sets the latch and persists once', async () => {
      await initializer.initializeFirstEnableLogic();

      expect(plugin.settings.core.hasEnabledForbiddenChars).toBe(true);
      expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    });

    it('does nothing once the latch is set', async () => {
      plugin.settings.core.hasEnabledForbiddenChars = true;
      const before = enabledCharKeys(plugin.settings);

      await initializer.initializeFirstEnableLogic();

      expect(enabledCharKeys(plugin.settings)).toEqual(before);
      expect(plugin.saveSettings).not.toHaveBeenCalled();
    });

    it('does nothing while the master toggle is off', async () => {
      plugin.settings.characterReplacements.enableForbiddenCharReplacements = false;
      const before = enabledCharKeys(plugin.settings);

      await initializer.initializeFirstEnableLogic();

      expect(enabledCharKeys(plugin.settings)).toEqual(before);
      expect(plugin.settings.core.hasEnabledForbiddenChars).toBe(false);
    });
  });

  describe('initializeFirstEnableLogic — persistence', () => {
    it('does not save when the cascade does not apply', async () => {
      await initializer.initializeFirstEnableLogic();

      expect(plugin.saveSettings).not.toHaveBeenCalled();
    });
  });

  describe('checkFirstTimeExclusionsSetup', () => {
    function mockConfigFiles(files: Record<string, unknown>): void {
      plugin.app.vault.adapter.read = vi.fn(async (path: string) => {
        if (!(path in files)) throw new Error(`missing ${path}`);
        return JSON.stringify(files[path]);
      });
    }

    function mockLoadedPlugins(...ids: string[]): void {
      plugin.app.plugins.getPlugin = vi.fn((id: string) =>
        ids.includes(id) ? { _loaded: true } : null
      );
    }

    it('returns early once setup has already run', async () => {
      plugin.settings.core.hasSetupExclusions = true;

      await initializer.checkFirstTimeExclusionsSetup();

      expect(plugin.app.vault.adapter.read).not.toHaveBeenCalled();
      expect(plugin.saveSettings).not.toHaveBeenCalled();
    });

    it('marks setup complete so it never runs twice', async () => {
      await initializer.checkFirstTimeExclusionsSetup();

      expect(plugin.settings.core.hasSetupExclusions).toBe(true);
    });

    it('excludes Excalidraw drawings when the plugin is loaded', async () => {
      mockLoadedPlugins('obsidian-excalidraw-plugin');

      await initializer.checkFirstTimeExclusionsSetup();

      expect(plugin.settings.exclusions.excludedProperties).toContainEqual({
        key: 'excalidraw-plugin',
        value: 'parsed',
      });
    });

    it('leaves excluded properties alone when Excalidraw is absent', async () => {
      const before = structuredClone(
        plugin.settings.exclusions.excludedProperties
      );

      await initializer.checkFirstTimeExclusionsSetup();

      expect(plugin.settings.exclusions.excludedProperties).toEqual(before);
    });

    it('excludes the core Templates folder when that plugin is enabled', async () => {
      mockConfigFiles({
        '.obsidian/core-plugins.json': { templates: true },
        '.obsidian/templates.json': { folder: 'Templates' },
      });

      await initializer.checkFirstTimeExclusionsSetup();

      expect(plugin.settings.exclusions.excludedFiles).toEqual(['Templates/']);
    });

    // The form toggleFolderExclusion writes, whatever slashes the user typed into the folder setting
    it.each(['Templates/', '/Templates', '/Templates/'])(
      'writes the folder entry for a Templates folder typed as %s',
      async (typedFolder) => {
        mockConfigFiles({
          '.obsidian/core-plugins.json': { templates: true },
          '.obsidian/templates.json': { folder: typedFolder },
        });

        await initializer.checkFirstTimeExclusionsSetup();

        expect(plugin.settings.exclusions.excludedFiles).toEqual([
          'Templates/',
        ]);
      }
    );

    it('never adds an entry for a template folder set to the vault root', async () => {
      mockConfigFiles({
        '.obsidian/core-plugins.json': { templates: true },
        '.obsidian/templates.json': { folder: '/' },
      });

      await initializer.checkFirstTimeExclusionsSetup();

      expect(plugin.settings.exclusions.excludedFiles).toEqual([]);
    });

    it('does not add a folder already listed under different case', async () => {
      plugin.settings.exclusions.excludedFiles = ['templates/'];
      mockConfigFiles({
        '.obsidian/core-plugins.json': { templates: true },
        '.obsidian/templates.json': { folder: 'Templates' },
      });

      await initializer.checkFirstTimeExclusionsSetup();

      expect(plugin.settings.exclusions.excludedFiles).toEqual(['templates/']);
    });

    it('ignores the Templates folder when the core plugin is disabled', async () => {
      mockConfigFiles({
        '.obsidian/core-plugins.json': { templates: false },
        '.obsidian/templates.json': { folder: 'Templates' },
      });

      await initializer.checkFirstTimeExclusionsSetup();

      expect(plugin.settings.exclusions.excludedFiles).toEqual([]);
    });

    it('excludes the Templater folder when Templater is loaded', async () => {
      mockLoadedPlugins('templater-obsidian');
      mockConfigFiles({
        '.obsidian/plugins/templater-obsidian/data.json': {
          templates_folder: 'Meta/Templater',
        },
      });

      await initializer.checkFirstTimeExclusionsSetup();

      expect(plugin.settings.exclusions.excludedFiles).toContain(
        'Meta/Templater/'
      );
    });

    it('issues the config reads together instead of chaining them', async () => {
      const requested: string[] = [];
      const pending: (() => void)[] = [];
      plugin.app.vault.adapter.read = vi.fn((path: string) => {
        requested.push(path);
        return new Promise<string>((resolve) =>
          pending.push(() => resolve('{}'))
        );
      });
      mockLoadedPlugins('templater-obsidian');

      const setup = initializer.checkFirstTimeExclusionsSetup();
      // Not awaited yet: every read must already be in flight.
      expect(requested).toHaveLength(3);

      pending.forEach((resolve) => resolve());
      await setup;
    });

    it('does not read the Templater config when Templater is absent', async () => {
      mockConfigFiles({ '.obsidian/core-plugins.json': { templates: false } });

      await initializer.checkFirstTimeExclusionsSetup();

      expect(plugin.app.vault.adapter.read).not.toHaveBeenCalledWith(
        expect.stringContaining('templater-obsidian')
      );
    });

    it('does not add the same folder twice when both plugins share one', async () => {
      mockLoadedPlugins('templater-obsidian');
      mockConfigFiles({
        '.obsidian/core-plugins.json': { templates: true },
        '.obsidian/templates.json': { folder: 'Templates' },
        '.obsidian/plugins/templater-obsidian/data.json': {
          templates_folder: 'Templates',
        },
      });

      await initializer.checkFirstTimeExclusionsSetup();

      expect(plugin.settings.exclusions.excludedFiles).toEqual(['Templates/']);
    });
  });
});
