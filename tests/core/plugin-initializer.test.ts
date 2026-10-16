/**
 * Tests for PluginInitializer's first-load exclusion setup.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { App } from '../mockObsidian';
import { DEFAULT_SETTINGS } from '../../src/constants';
import type { PluginSettings } from '../../src/types';

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
