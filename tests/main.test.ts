/**
 * Tests for FirstLineIsTitle.loadSettings.
 *
 * 4.0.0 dropped every per-key migration in favour of a one-time reset: stored data
 * whose `dataSchemaVersion` is not the current one is discarded and replaced with the
 * defaults. These cover both sides of that branch, and that the reset result is
 * stamped with the current version so it does not reset again on the next load.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { App, PluginManifest } from 'obsidian';
import * as mockObsidian from './mockObsidian';
import { TFile } from './mockObsidian';
import FirstLineIsTitle from '../main';
import {
  CURRENT_DATA_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
} from '../src/constants';
import { WorkspaceIntegration } from '../src/core/workspace-integration';
import type { PluginSettings } from '../src/types';

type SettingsRecord = Record<string, Record<string, unknown>> & {
  dataSchemaVersion: number;
};

/** Runs loadSettings against the given data.json contents and returns the result. */
async function loadStoredSettings(stored: unknown): Promise<SettingsRecord> {
  const plugin = new FirstLineIsTitle({} as App, {} as PluginManifest);
  plugin.loadData = vi.fn().mockResolvedValue(stored);
  plugin.saveData = vi.fn().mockResolvedValue(undefined);

  await plugin.loadSettings();

  return plugin.settings as unknown as SettingsRecord;
}

describe('FirstLineIsTitle.loadSettings', () => {
  describe('schema-version reset', () => {
    it('discards stored settings when dataSchemaVersion is absent', async () => {
      const settings = await loadStoredSettings({
        core: { charCount: 42, renameAutomatically: false },
        exclusions: { excludedFiles: ['Notes/'] },
      });

      expect(settings.core.charCount).toBe(DEFAULT_SETTINGS.core.charCount);
      expect(settings.core.renameAutomatically).toBe(
        DEFAULT_SETTINGS.core.renameAutomatically
      );
      expect(settings.exclusions.excludedFiles).toEqual(
        DEFAULT_SETTINGS.exclusions.excludedFiles
      );
    });

    it('discards stored settings when dataSchemaVersion is an older number', async () => {
      const settings = await loadStoredSettings({
        dataSchemaVersion: 3,
        core: { charCount: 42 },
      });

      expect(settings.core.charCount).toBe(DEFAULT_SETTINGS.core.charCount);
    });

    it('discards stored settings when dataSchemaVersion is a newer number', async () => {
      const settings = await loadStoredSettings({
        dataSchemaVersion: 5,
        core: { charCount: 42 },
      });

      expect(settings.core.charCount).toBe(DEFAULT_SETTINGS.core.charCount);
    });

    it('discards stored settings when dataSchemaVersion is the version as a string', async () => {
      // The comparison is strict, so a stringified version is a mismatch like any other
      const settings = await loadStoredSettings({
        dataSchemaVersion: '4',
        core: { charCount: 42 },
      });

      expect(settings.core.charCount).toBe(DEFAULT_SETTINGS.core.charCount);
    });

    it('drops flat legacy top-level keys rather than carrying them forward', async () => {
      // Pre-nesting data.json files stored settings flat alongside the nested sections;
      // deepMerge would copy any survivor back into data.json on the next save.
      const settings = await loadStoredSettings({
        excludedFolders: ['Templates'],
        charCount: 60,
        safewords: [{ text: 'keep' }],
        commandVisibility: { renameCurrentFile: false },
      });

      expect('excludedFolders' in settings).toBe(false);
      expect('charCount' in settings).toBe(false);
      expect('safewords' in settings).toBe(false);
      expect('commandVisibility' in settings).toBe(false);
    });

    it('resets the exclusion-setup flag so auto-detection runs again', async () => {
      const settings = await loadStoredSettings({
        core: { hasSetupExclusions: true },
      });

      expect(settings.core.hasSetupExclusions).toBe(false);
    });

    it('starts from the defaults when there is no stored data at all', async () => {
      const settings = await loadStoredSettings(null);

      expect(settings.core.charCount).toBe(DEFAULT_SETTINGS.core.charCount);
      expect(settings.dataSchemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
    });

    it('does not hand out the shared DEFAULT_SETTINGS object', async () => {
      // Settings are mutated in place (the settings tab and the folder commands write into them), so a shared reference would leak one vault's state into the module-level defaults.
      const settings = await loadStoredSettings({});

      expect(settings).not.toBe(DEFAULT_SETTINGS);
      expect(settings.core).not.toBe(DEFAULT_SETTINGS.core);
      expect(settings.exclusions).not.toBe(DEFAULT_SETTINGS.exclusions);
    });
  });

  describe('current-schema merge', () => {
    it('preserves stored values when dataSchemaVersion matches', async () => {
      const settings = await loadStoredSettings({
        dataSchemaVersion: CURRENT_DATA_SCHEMA_VERSION,
        core: { charCount: 42, renameAutomatically: false },
        exclusions: { excludedFiles: ['Notes/'] },
      });

      expect(settings.core.charCount).toBe(42);
      expect(settings.core.renameAutomatically).toBe(false);
      expect(settings.exclusions.excludedFiles).toEqual(['Notes/']);
    });

    it('fills unstored keys from the defaults', async () => {
      const settings = await loadStoredSettings({
        dataSchemaVersion: CURRENT_DATA_SCHEMA_VERSION,
        core: { charCount: 42 },
      });

      expect(settings.core.charCount).toBe(42);
      expect(settings.core.insertTitle).toBe(DEFAULT_SETTINGS.core.insertTitle);
      expect(settings.firstLineProperty.propertyKey).toBe(
        DEFAULT_SETTINGS.firstLineProperty.propertyKey
      );
    });

    it('keeps the exclusion-setup flag that was already set', async () => {
      const settings = await loadStoredSettings({
        dataSchemaVersion: CURRENT_DATA_SCHEMA_VERSION,
        core: { hasSetupExclusions: true },
      });

      expect(settings.core.hasSetupExclusions).toBe(true);
    });

    it('loads, with that list at its default, when a stored list holds the wrong types', async () => {
      // A non-string tag used to throw in the exclusion-list cleanup on every start
      const settings = await loadStoredSettings({
        dataSchemaVersion: CURRENT_DATA_SCHEMA_VERSION,
        core: { charCount: 42 },
        exclusions: { excludedTags: [1, 'draft'], excludedFiles: ['Notes/'] },
      });

      expect(settings.exclusions.excludedTags).toEqual(
        DEFAULT_SETTINGS.exclusions.excludedTags
      );
      expect(settings.exclusions.excludedFiles).toEqual(['Notes/']);
      expect(settings.core.charCount).toBe(42);
    });

    it('takes the default for a stored option no longer offered', async () => {
      const settings = await loadStoredSettings({
        dataSchemaVersion: CURRENT_DATA_SCHEMA_VERSION,
        firstLineProperty: { hideProperty: 'sometimes' },
      });

      expect(settings.firstLineProperty.hideProperty).toBe(
        DEFAULT_SETTINGS.firstLineProperty.hideProperty
      );
    });

    it('drops stored keys the defaults lack', async () => {
      const settings = await loadStoredSettings({
        dataSchemaVersion: CURRENT_DATA_SCHEMA_VERSION,
        retiredSection: { flag: true },
        core: { retiredOption: 1 },
      });

      expect('retiredSection' in settings).toBe(false);
      expect('retiredOption' in settings.core).toBe(false);
    });

    it('drops a stored osPreset, which nothing reads any more', async () => {
      const settings = await loadStoredSettings({
        dataSchemaVersion: CURRENT_DATA_SCHEMA_VERSION,
        characterReplacements: {
          osPreset: 'Windows',
          enableForbiddenCharReplacements: true,
        },
      });

      expect('osPreset' in settings.characterReplacements).toBe(false);
      expect(
        settings.characterReplacements.enableForbiddenCharReplacements
      ).toBe(true);
    });
  });

  describe('reset result', () => {
    it('carries the current dataSchemaVersion after a reset', async () => {
      const settings = await loadStoredSettings({
        core: { charCount: 42 },
      });

      expect(settings.dataSchemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
    });

    it('does not reset a second time once the version has been written', async () => {
      // Feeding the reset result back in is what the next plugin load does, so a value
      // stored after the reset must survive it.
      const reset = await loadStoredSettings({ core: { charCount: 42 } });
      reset.core.charCount = 42;

      const reloaded = await loadStoredSettings(reset);

      expect(reloaded.core.charCount).toBe(42);
      expect(reloaded.dataSchemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
    });
  });
});

describe('pre-4.0.0 settings backup', () => {
  /** loadSettings against a stubbed vault, reporting what it wrote where. */
  async function loadWithAdapter(
    stored: unknown,
    opts: {
      readFails?: boolean;
      createFails?: boolean;
      dir?: string | undefined;
    } = {}
  ) {
    const writes: Record<string, string> = {};
    const adapter = {
      read: vi.fn(async (p: string) => {
        if (opts.readFails) throw new Error('unreadable');
        return JSON.stringify(stored);
      }),
      write: vi.fn(async (p: string, data: string) => {
        writes[p] = data;
      }),
    };
    const create = vi.fn(async (p: string, data: string) => {
      if (opts.createFails) throw new Error('File already exists.');
      writes[p] = data;
      return { path: p };
    });
    const app = { vault: { adapter, create } } as unknown as App;
    const manifest = {
      dir: 'dir' in opts ? opts.dir : '.obsidian/plugins/first-line-is-title',
    } as PluginManifest;

    const plugin = new FirstLineIsTitle(app, manifest);
    // The mocked Plugin base ignores its constructor arguments and builds its
    // own app/manifest, so these have to be assigned after construction.
    plugin.app = app;
    plugin.manifest = manifest;
    plugin.loadData = vi.fn().mockResolvedValue(stored);
    plugin.saveData = vi.fn().mockResolvedValue(undefined);
    await plugin.loadSettings();
    return { plugin, writes, adapter, create };
  }

  /** `first-line-is-title-settings-YYYYMMDD-HHmmss.json`, at the vault root. */
  const BACKUP_NAME = /^first-line-is-title-settings-\d{8}-\d{6}\.json$/;

  it('copies data.json to the vault root before discarding a pre-4.0.0 file', async () => {
    const { writes } = await loadWithAdapter({
      renameNotes: 'automatically',
      core: { charCount: 42 },
    });

    const [path, contents] = Object.entries(writes)[0];
    // Vault root, not the plugin folder: a backup under .obsidian/ is one the user
    // cannot open from inside their own vault.
    expect(path).toMatch(BACKUP_NAME);
    expect(contents).toContain('renameNotes');
  });

  it('copies the prior file verbatim rather than as a transfer payload', async () => {
    // Every pre-4.0.0 key was renamed, and a transfer payload only ever visits keys the
    // current defaults still have — so a diff would drop exactly what this preserves.
    const stored = { renameNotes: 'automatically', charCount: 42 };
    const { writes } = await loadWithAdapter(stored);

    expect(Object.values(writes)[0]).toBe(JSON.stringify(stored));
  });

  it('writes no backup for a genuinely new install', async () => {
    // Nothing stored means nothing to lose; a backup here would be an empty file
    // and would wrongly make a new user look like an upgrader.
    const { create } = await loadWithAdapter({});
    expect(create).not.toHaveBeenCalled();
  });

  it('writes no backup when the stored file is already current', async () => {
    const { create } = await loadWithAdapter({
      dataSchemaVersion: CURRENT_DATA_SCHEMA_VERSION,
      core: { charCount: 42 },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('still resets when the backup cannot be read', async () => {
    // Losing the backup must not block the reset, or a corrupt data.json would
    // wedge the plugin on every load.
    const { plugin } = await loadWithAdapter(
      { renameNotes: 'automatically', core: { charCount: 42 } },
      { readFails: true }
    );
    expect(plugin.settings.core.charCount).toBe(
      DEFAULT_SETTINGS.core.charCount
    );
  });

  it('still resets when the backup cannot be written', async () => {
    const { plugin } = await loadWithAdapter(
      { renameNotes: 'automatically', core: { charCount: 42 } },
      { createFails: true }
    );
    expect(plugin.settings.dataSchemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
  });

  it('suffixes the name rather than giving up when the first one is taken', async () => {
    // Nothing stored means loadSettings writes no backup, so the plugin here is just a
    // vehicle for calling the writer directly.
    const { plugin } = await loadWithAdapter({});
    // `vault.create` throws on an existing path; only the unsuffixed name is taken.
    const create = vi.fn(async (path: string) => {
      if (/-\d{6}\.json$/.test(path)) throw new Error('File already exists.');
      return { path };
    });
    (plugin.app.vault as unknown as { create: unknown }).create = create;

    expect(await plugin.writeSettingsBackup('{}')).toMatch(
      /^first-line-is-title-settings-\d{8}-\d{6}-1\.json$/
    );
  });

  it('throws the last write error when no name can be created, which the backup turns into null', async () => {
    const { plugin } = await loadWithAdapter({});
    // Each failure names its path, so the thrown one shows which attempt it came from
    const create = vi.fn(async (path: string) => {
      throw new Error(`Cannot create ${path}`);
    });
    (plugin.app.vault as unknown as { create: unknown }).create = create;

    await expect(plugin.createSettingsFileAtVaultRoot('{}')).rejects.toThrow(
      /^Cannot create first-line-is-title-settings-\d{8}-\d{6}-5\.json$/
    );
    // The unsuffixed name plus every suffixed retry
    expect(create).toHaveBeenCalledTimes(6);
    expect(await plugin.writeSettingsBackup('{}')).toBeNull();
  });

  it('resets without a backup when the plugin folder is unknown', async () => {
    const { plugin, adapter } = await loadWithAdapter(
      { renameNotes: 'automatically', core: { charCount: 42 } },
      { dir: undefined }
    );
    expect(adapter.read).not.toHaveBeenCalled();
    expect(plugin.settings.dataSchemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
  });
});

/** A plugin past `loadSettings`, with its saves and property hiding stubbed. */
function createLoadedPlugin(): FirstLineIsTitle {
  const plugin = new FirstLineIsTitle({} as App, {} as PluginManifest);
  plugin.settings = structuredClone(DEFAULT_SETTINGS);
  plugin.saveData = vi.fn().mockResolvedValue(undefined);
  plugin.updatePropertyVisibility = vi.fn();
  return plugin;
}

function defaultsWith(
  change: (settings: PluginSettings) => void
): PluginSettings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  change(settings);
  return settings;
}

describe('FirstLineIsTitle.replaceSettings', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('makes the replacement the live settings and saves it once', async () => {
    const plugin = createLoadedPlugin();
    const next = defaultsWith((settings) => {
      settings.core.charCount = 42;
    });

    expect(await plugin.replaceSettings(next)).toBe(true);

    expect(plugin.settings).toBe(next);
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    expect(plugin.saveData).toHaveBeenCalledWith(next);
  });

  it('applies changed property hiding without a reload', async () => {
    const plugin = createLoadedPlugin();

    await plugin.replaceSettings(
      defaultsWith((settings) => {
        settings.firstLineProperty.propertyKey = 'aliases';
        settings.firstLineProperty.hideProperty = 'always';
      })
    );

    expect(plugin.updatePropertyVisibility).toHaveBeenCalledTimes(1);
  });

  it('saves what a cascade writes, such as the debug stamp', async () => {
    const plugin = createLoadedPlugin();

    await plugin.replaceSettings(
      defaultsWith((settings) => {
        settings.core.debug = true;
      })
    );

    const saved = vi.mocked(plugin.saveData).mock.calls[0][0] as PluginSettings;
    expect(saved.core.debugEnabledTimestamp).not.toBe('');
  });

  it("cleans the replacement's exclusion lists", async () => {
    const plugin = createLoadedPlugin();

    await plugin.replaceSettings(
      defaultsWith((settings) => {
        settings.exclusions.excludedFiles = ['Notes/', 'Notes/', ' '];
      })
    );

    expect(plugin.settings.exclusions.excludedFiles).toEqual(['Notes/']);
  });

  it('keeps the previous settings and reports false when the save fails', async () => {
    const plugin = createLoadedPlugin();
    plugin.settings.core.charCount = 7;
    const snapshot = structuredClone(plugin.settings);
    plugin.saveData = vi.fn().mockRejectedValue(new Error('disk full'));
    const next = defaultsWith((settings) => {
      settings.core.charCount = 42;
    });

    expect(await plugin.replaceSettings(next)).toBe(false);

    expect(plugin.settings).not.toBe(next);
    expect(plugin.settings).toEqual(snapshot);
  });

  describe('code holding the plugin across a replacement', () => {
    it('lets the tag toggle write into the new settings', async () => {
      const plugin = createLoadedPlugin();
      // Built before the replacement, as a toggle used earlier in the session would be
      void plugin.tagOperations;
      const previous = plugin.settings;
      const next = structuredClone(DEFAULT_SETTINGS);

      await plugin.replaceSettings(next);
      await plugin.toggleTagExclusion('project');

      expect(next.exclusions.excludedTags).toEqual(['#project']);
      expect(previous.exclusions.excludedTags).toEqual([]);
    });

    it('lets the folder toggle write into the new settings', async () => {
      const plugin = createLoadedPlugin();
      void plugin.folderOperations;
      const previous = plugin.settings;
      const next = structuredClone(DEFAULT_SETTINGS);

      await plugin.replaceSettings(next);
      await plugin.toggleFolderExclusion('Notes');

      expect(next.exclusions.excludedFiles).toEqual(['Notes/']);
      expect(previous.exclusions.excludedFiles).toEqual([]);
    });

    it('lets rename on save follow the new settings', async () => {
      const plugin = createLoadedPlugin();
      const saveCommand = {
        checkCallback: vi.fn((_checking: boolean) => true),
      };
      (
        plugin.app as unknown as {
          commands: { commands: Record<string, unknown> };
        }
      ).commands.commands['editor:save-file'] = saveCommand;
      const executeRenameUnlessExcluded = vi.fn();
      plugin.commandRegistrar = {
        executeRenameUnlessExcluded,
      } as unknown as FirstLineIsTitle['commandRegistrar'];
      plugin.app.workspace.getActiveFile = vi.fn(() => new TFile('note.md'));
      new WorkspaceIntegration(plugin).setupSaveEventHook();

      await plugin.replaceSettings(
        defaultsWith((settings) => {
          settings.core.renameOnSave = true;
        })
      );
      vi.useFakeTimers();
      saveCommand.checkCallback(false);
      vi.advanceTimersByTime(100);

      expect(executeRenameUnlessExcluded).toHaveBeenCalledTimes(1);
    });
  });
});

describe('FirstLineIsTitle debounced settings save', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves once, 500 ms after the last request', () => {
    vi.useFakeTimers();
    const plugin = createLoadedPlugin();

    plugin.requestSaveSettings();
    vi.advanceTimersByTime(300);
    plugin.requestSaveSettings();
    vi.advanceTimersByTime(499);
    expect(plugin.saveData).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(plugin.saveData).toHaveBeenCalledTimes(1);
  });

  it('writes a pending save at once on flush, and nothing when none is pending', () => {
    vi.useFakeTimers();
    const plugin = createLoadedPlugin();

    plugin.flushSettingsSave();
    expect(plugin.saveData).not.toHaveBeenCalled();
    plugin.requestSaveSettings();
    plugin.flushSettingsSave();
    expect(plugin.saveData).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);

    expect(plugin.saveData).toHaveBeenCalledTimes(1);
  });

  it('writes a pending save when the plugin unloads', () => {
    vi.useFakeTimers();
    const plugin = createLoadedPlugin();

    plugin.requestSaveSettings();
    // The mocked Plugin base sets `onunload` as an instance field, which shadows the real method
    FirstLineIsTitle.prototype.onunload.call(plugin);

    expect(plugin.saveData).toHaveBeenCalledTimes(1);
  });
});

describe('FirstLineIsTitle.setRenamingDisabledForNote', () => {
  function createPluginWithNote(frontmatter: Record<string, unknown>) {
    const plugin = createLoadedPlugin();
    const file = new TFile('note.md');
    plugin.app.metadataCache.getFileCache = vi.fn(() => ({ frontmatter }));
    const steps: string[] = [];
    const ensurePropertyTypeIsCheckbox = vi.fn(async () => {
      steps.push('checkbox type');
    });
    plugin.propertyManager = {
      ensurePropertyTypeIsCheckbox,
    } as unknown as FirstLineIsTitle['propertyManager'];
    const written: Record<string, unknown> = { ...frontmatter };
    plugin.app.fileManager.processFrontMatter = vi.fn(
      async (_file: unknown, edit: (fm: Record<string, unknown>) => void) => {
        steps.push('write');
        edit(written);
      }
    ) as never;
    return { plugin, file, steps, written, ensurePropertyTypeIsCheckbox };
  }

  /** The message and classes of every notice raised while `run` runs. */
  async function capturedNotices(
    run: () => Promise<void>
  ): Promise<string[][]> {
    const notices: mockObsidian.Notice[] = [];
    const NoticeClass = mockObsidian.Notice;
    const noticeSpy = vi
      .spyOn(mockObsidian, 'Notice')
      .mockImplementation(function (message: string) {
        const notice = new NoticeClass(message);
        notices.push(notice);
        return notice;
      } as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await run();
    } finally {
      noticeSpy.mockRestore();
      consoleSpy.mockRestore();
    }
    return notices.map((notice) => [
      notice.message,
      notice.containerEl.className,
    ]);
  }

  it('writes the disable property, as a checkbox value, after making its type a checkbox', async () => {
    const { plugin, file, steps, written } = createPluginWithNote({
      title: 'x',
    });

    await plugin.setRenamingDisabledForNote(file, true);

    expect(steps).toEqual(['checkbox type', 'write']);
    expect(written).toEqual({ title: 'x', 'no rename': true });
  });

  it('writes nothing, but still confirms, when the note already carries the property', async () => {
    const { plugin, file, steps } = createPluginWithNote({
      'no rename': true,
    });

    const notices = await capturedNotices(() =>
      plugin.setRenamingDisabledForNote(file, true)
    );

    expect(steps).toEqual(['checkbox type']);
    expect(notices).toEqual([['Disabled renaming for “note”', '']]);
  });

  it('removes every case variant of the disable property', async () => {
    const { plugin, file, written, ensurePropertyTypeIsCheckbox } =
      createPluginWithNote({
        title: 'x',
        'no rename': true,
        'No Rename': true,
        'NO RENAME': 'true',
      });

    await plugin.setRenamingDisabledForNote(file, false);

    expect(written).toEqual({ title: 'x' });
    expect(ensurePropertyTypeIsCheckbox).not.toHaveBeenCalled();
  });

  it.each([
    [true, 'Failed to disable renaming. Check console for details.'],
    [false, 'Failed to enable renaming. Check console for details.'],
  ])(
    'shows a warning-tinted notice when the property cannot be written (disabled: %s)',
    async (disabled, message) => {
      const { plugin, file } = createPluginWithNote(
        disabled ? {} : { 'no rename': true }
      );
      plugin.app.fileManager.processFrontMatter = vi
        .fn()
        .mockRejectedValue(new Error('locked'));

      const notices = await capturedNotices(() =>
        plugin.setRenamingDisabledForNote(file, disabled)
      );

      expect(notices).toEqual([[message, 'mod-warning']]);
    }
  );
});

describe('FirstLineIsTitle.outputAllSettings', () => {
  /** The first argument of every `console.debug` call `run` makes. */
  function debugOutput(run: () => void): unknown[] {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    debugSpy.mockClear();
    try {
      run();
      return debugSpy.mock.calls.map((call) => call[0]);
    } finally {
      debugSpy.mockRestore();
    }
  }

  it('logs nothing while debug is off', () => {
    const plugin = createLoadedPlugin();

    expect(debugOutput(() => plugin.outputAllSettings())).toEqual([]);
  });

  it('logs each settings section that differs from the defaults, and no other', () => {
    const plugin = createLoadedPlugin();
    plugin.settings.core.debug = true;
    plugin.settings.exclusions.excludedFiles = ['Archive/'];

    expect(debugOutput(() => plugin.outputAllSettings())).toEqual([
      '🔧 Settings (non-default values only):',
      '  core:',
      '  exclusions:',
    ]);
  });
});
