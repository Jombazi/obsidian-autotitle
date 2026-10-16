/**
 * Tests for the declarative settings tab (Obsidian 1.13+).
 *
 * Focus is `setControlValue`: the declarative API has no per-control onChange,
 * so this one method owns dot-path persistence, every cross-setting cascade,
 * and whether a write needs `update()`.
 *
 * That choice is load-bearing. `refreshDomState()`, which Obsidian runs after
 * every control write, re-evaluates visible/disabled predicates WITHOUT
 * re-reading control values, so any cascade that force-writes a sibling's value
 * must use `update()` or that sibling keeps rendering a stale value while the
 * stored setting says otherwise.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { App } from '../mockObsidian';
import { DEFAULT_SETTINGS } from '../../src/constants';
import type { PluginSettings } from '../../src/types';
import type { SettingPath } from '../../src/settings/settings-paths';

vi.mock('../../src/i18n', () => ({
  t: vi.fn((key: string) => key),
  getCurrentLocale: vi.fn(() => 'en'),
}));

vi.mock('../../src/utils', () => ({
  verboseLog: vi.fn(),
}));

// Page builders are covered by their own tabs; stub them to isolate the shell.
vi.mock('../../src/settings/general', () => ({
  buildGeneralDefinitions: vi.fn(() => []),
  buildNewNotesGroup: vi.fn(() => ({
    type: 'group',
    heading: 'settings.sections.newNotesGroup',
    items: [{ name: 'settings.general.insertTitle.name' }],
  })),
  buildFooterDefinitions: vi.fn(() => [
    { name: 'settings.general.renameAllNotes.name', render: vi.fn() },
  ]),
  buildSupportGroup: vi.fn(() => ({
    type: 'group',
    items: [{ name: 'settings.general.sendFeedback.name', render: vi.fn() }],
  })),
}));
vi.mock('../../src/settings/exclusions', () => ({
  buildExclusionsPage: vi.fn(() => ({ type: 'page', name: 'Exclusions' })),
}));
vi.mock('../../src/settings/character-replacements', () => ({
  buildCharacterReplacementsPage: vi.fn(() => ({
    type: 'page',
    name: 'Character replacements',
  })),
}));
vi.mock('../../src/settings/custom-replacements', () => ({
  buildCustomReplacementsPage: vi.fn(() => ({
    type: 'page',
    name: 'Custom replacements',
  })),
}));
vi.mock('../../src/settings/markup-stripping', () => ({
  buildMarkupStrippingPage: vi.fn(() => ({
    type: 'page',
    name: 'Markup stripping',
  })),
}));
vi.mock('../../src/settings/first-line-property', () => ({
  buildFirstLinePropertyPage: vi.fn(() => ({
    type: 'page',
    name: 'First line property',
  })),
}));
vi.mock('../../src/settings/commands', () => ({
  buildCommandsPage: vi.fn(() => ({ type: 'page', name: 'Commands' })),
}));
vi.mock('../../src/settings/other', () => ({
  buildOtherPage: vi.fn(() => ({ type: 'page', name: 'Advanced' })),
}));

import {
  FirstLineIsTitleSettings,
  runChangedCascades,
} from '../../src/settings/settings-main';
import { buildSupportGroup } from '../../src/settings/general';
import { buildFirstLinePropertyPage } from '../../src/settings/first-line-property';

interface TestPlugin {
  app: App;
  settings: PluginSettings;
  saveSettings: Mock<() => Promise<void>>;
  requestSaveSettings: Mock<() => void>;
  flushSettingsSave: Mock<() => void>;
  debugLog: ReturnType<typeof vi.fn>;
  updatePropertyVisibility: ReturnType<typeof vi.fn>;
  getCurrentTimestamp: ReturnType<typeof vi.fn>;
  outputAllSettings: ReturnType<typeof vi.fn>;
}

const TIMESTAMP = '2026-10-11T09:00:00.000Z';

function makePlugin(): TestPlugin {
  // A pending flag in place of the plugin's debouncer, so a request followed by a flush counts as the one write it is
  let isSavePending = false;
  const plugin: TestPlugin = {
    app: new App(),
    settings: structuredClone(DEFAULT_SETTINGS) as PluginSettings,
    saveSettings: vi.fn().mockResolvedValue(undefined),
    requestSaveSettings: vi.fn(() => {
      isSavePending = true;
    }),
    flushSettingsSave: vi.fn(() => {
      if (!isSavePending) return;
      isSavePending = false;
      void plugin.saveSettings();
    }),
    debugLog: vi.fn(),
    updatePropertyVisibility: vi.fn(),
    getCurrentTimestamp: vi.fn(() => TIMESTAMP),
    outputAllSettings: vi.fn(),
  };
  return plugin;
}

describe('FirstLineIsTitleSettings', () => {
  let plugin: TestPlugin;
  let tab: FirstLineIsTitleSettings;
  let update: ReturnType<typeof vi.fn>;
  let refreshDomState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = makePlugin();
    tab = new FirstLineIsTitleSettings(plugin.app as never, plugin as never);
    update = tab.update as unknown as ReturnType<typeof vi.fn>;
    refreshDomState = tab.refreshDomState as unknown as ReturnType<
      typeof vi.fn
    >;
    update.mockClear();
    refreshDomState.mockClear();
  });

  describe('getSettingDefinitions', () => {
    const topLevel = () =>
      tab
        .getSettingDefinitions()
        .filter((def) => (def as { type?: string }).type === 'page')
        .map((def) => (def as { name?: string }).name);

    // Matched by heading, not by type — other groups sit alongside this one.
    const ADVANCED_HEADING = 'settings.sections.advancedGroup';

    const advancedGroupIndex = () =>
      tab
        .getSettingDefinitions()
        .findIndex(
          (def) => (def as { heading?: string }).heading === ADVANCED_HEADING
        );

    const advancedGroup = () =>
      tab.getSettingDefinitions()[advancedGroupIndex()] as
        { heading?: string; items?: { name?: string }[] } | undefined;

    it('keeps only Exclusions as a top-level page', () => {
      expect(topLevel()).toEqual(['Exclusions']);
    });

    it('nests the remaining six sections under the Advanced group', () => {
      const group = advancedGroup();
      expect(group?.heading).toBe(ADVANCED_HEADING);
      expect(group?.items?.map((i) => i.name)).toEqual([
        'Character replacements',
        'Commands',
        'Custom replacements',
        'First line property',
        'Markup stripping',
        'Advanced',
      ]);
    });

    it('orders the page-level action, Exclusions and New notes between General and Advanced', () => {
      const defs = tab.getSettingDefinitions();
      const advanced = advancedGroupIndex();

      expect((defs[advanced - 1] as { heading?: string }).heading).toBe(
        'settings.sections.newNotesGroup'
      );
      expect((defs[advanced - 2] as { name?: string }).name).toBe('Exclusions');
      expect((defs[advanced - 3] as { name?: string }).name).toBe(
        'settings.general.renameAllNotes.name'
      );
    });

    it('puts the feedback group last', () => {
      const defs = tab.getSettingDefinitions();
      // general.ts is mocked here, so asserting the group's shape would only
      // re-read this file's own fixture. Placement is the one thing
      // settings-main actually decides; the shape is pinned in
      // general.test.ts against the real builder.
      expect(defs[defs.length - 1]).toBe(
        vi.mocked(buildSupportGroup).mock.results[0].value
      );
    });
  });

  describe('getControlValue', () => {
    it('reads a nested key by dot-path', () => {
      plugin.settings.core.renameOnSave = true;
      expect(tab.getControlValue('core.renameOnSave')).toBe(true);
    });

    it('returns undefined for an unknown path rather than throwing', () => {
      // Ruled out by the key type, but Obsidian hands back whatever string a control carries
      expect(
        tab.getControlValue('core.nope.deeper' as SettingPath)
      ).toBeUndefined();
    });
  });

  describe('setControlValue', () => {
    it('persists a nested key by dot-path and saves once', async () => {
      await tab.setControlValue('core.renameOnSave', true);
      expect(plugin.settings.core.renameOnSave).toBe(true);
      expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    });

    it('calls neither update() nor refreshDomState() when no value-mutating cascade applies', async () => {
      // Obsidian's control binding refreshes the DOM state itself once this resolves
      await tab.setControlValue('core.renameOnSave', true);
      expect(refreshDomState).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('character replacements switch', () => {
    it('preserves convertReplacementChars when switched off', async () => {
      plugin.settings.core.convertReplacementChars = true;
      await tab.setControlValue(
        'characterReplacements.enableForbiddenCharReplacements',
        false
      );
      expect(plugin.settings.core.convertReplacementChars).toBe(true);
    });
  });

  describe('side-effect cascades', () => {
    it('refreshes property visibility when the hiding mode changes', async () => {
      await tab.setControlValue('firstLineProperty.hideProperty', 'always');
      expect(plugin.updatePropertyVisibility).toHaveBeenCalledTimes(1);
    });

    it('refreshes property visibility when sidebar hiding changes', async () => {
      await tab.setControlValue('firstLineProperty.hideInSidebar', true);
      expect(plugin.updatePropertyVisibility).toHaveBeenCalledTimes(1);
    });

    it('stamps the time and dumps the settings when debug goes on', async () => {
      await tab.setControlValue('core.debug', true);

      expect(plugin.settings.core.debugEnabledTimestamp).toBe(TIMESTAMP);
      expect(plugin.outputAllSettings).toHaveBeenCalledTimes(1);
      // Stamped before the save, so the timestamp is persisted with the switch
      expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    });

    it('clears the stamp, with no dump, when debug goes off', async () => {
      plugin.settings.core.debug = true;
      plugin.settings.core.debugEnabledTimestamp = TIMESTAMP;

      await tab.setControlValue('core.debug', false);

      expect(plugin.settings.core.debugEnabledTimestamp).toBe('');
      expect(plugin.outputAllSettings).not.toHaveBeenCalled();
    });
  });

  describe('runChangedCascades', () => {
    it('runs the cascade of a key the replacement changed', () => {
      const previous = structuredClone(plugin.settings);
      plugin.settings.firstLineProperty.hideProperty = 'always';

      runChangedCascades(plugin as never, previous);

      expect(plugin.updatePropertyVisibility).toHaveBeenCalledTimes(1);
    });

    it('runs nothing when no cascade key changed', () => {
      const previous = structuredClone(plugin.settings);
      plugin.settings.core.charCount = 42;

      runChangedCascades(plugin as never, previous);

      expect(plugin.updatePropertyVisibility).not.toHaveBeenCalled();
      expect(plugin.outputAllSettings).not.toHaveBeenCalled();
    });

    it('applies a changed property name to property hiding', () => {
      const previous = structuredClone(plugin.settings);
      plugin.settings.firstLineProperty.propertyKey = 'aliases';

      runChangedCascades(plugin as never, previous);

      expect(plugin.updatePropertyVisibility).toHaveBeenCalledTimes(1);
    });

    it('rebuilds property hiding once though all three of its keys changed', () => {
      const previous = structuredClone(plugin.settings);
      plugin.settings.firstLineProperty.propertyKey = 'aliases';
      plugin.settings.firstLineProperty.hideProperty = 'always';
      plugin.settings.firstLineProperty.hideInSidebar = true;

      runChangedCascades(plugin as never, previous);

      expect(plugin.updatePropertyVisibility).toHaveBeenCalledTimes(1);
    });

    it('stamps and dumps for debug turned on by the replacement', () => {
      const previous = structuredClone(plugin.settings);
      plugin.settings.core.debug = true;

      runChangedCascades(plugin as never, previous);

      expect(plugin.settings.core.debugEnabledTimestamp).toBe(TIMESTAMP);
      expect(plugin.outputAllSettings).toHaveBeenCalledTimes(1);
    });

    it('stamps debug that was already on when the replacement left its timestamp empty', () => {
      // A hand-trimmed import: without a stamp, the 24-hour auto-disable has nothing to measure from
      plugin.settings.core.debug = true;
      const previous = structuredClone(plugin.settings);

      runChangedCascades(plugin as never, previous);

      expect(plugin.settings.core.debugEnabledTimestamp).toBe(TIMESTAMP);
    });

    it('keeps the stamp of debug that stayed on', () => {
      plugin.settings.core.debug = true;
      plugin.settings.core.debugEnabledTimestamp = 'earlier';
      const previous = structuredClone(plugin.settings);

      runChangedCascades(plugin as never, previous);

      expect(plugin.settings.core.debugEnabledTimestamp).toBe('earlier');
      expect(plugin.outputAllSettings).not.toHaveBeenCalled();
    });
  });

  describe('property name debouncer', () => {
    /** The debouncer the tab hands the First line property page. */
    function requestPropertyKeyCascade(): () => void {
      tab.getSettingDefinitions();
      return vi.mocked(buildFirstLinePropertyPage).mock.calls[0][2];
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('applies the name to property hiding once typing pauses', () => {
      vi.useFakeTimers();
      const request = requestPropertyKeyCascade();

      request();
      request();
      expect(plugin.updatePropertyVisibility).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);

      expect(plugin.updatePropertyVisibility).toHaveBeenCalledTimes(1);
    });

    it('applies a pending name at once when Settings closes', () => {
      vi.useFakeTimers();
      requestPropertyKeyCascade()();

      tab.hide();

      expect(plugin.updatePropertyVisibility).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      expect(plugin.updatePropertyVisibility).toHaveBeenCalledTimes(1);
    });
  });

  describe('hide', () => {
    it('writes a save typing left pending', () => {
      plugin.requestSaveSettings();

      tab.hide();

      expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    });
  });
});
