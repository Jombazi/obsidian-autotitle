/**
 * Tests for the Character replacements page: one summary row per fixed
 * character, each edited through the shared entry dialog.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  PluginSettingTab,
  SettingDefinitionGroup,
  SettingDefinitionRender,
} from 'obsidian';
import type { SettingPath } from '../../src/settings/settings-paths';
import { App, Setting } from '../mockObsidian';

const { openedModals } = vi.hoisted(() => ({
  openedModals: [] as unknown[],
}));

vi.mock('../../src/modals/entry-edit-modal', async (importOriginal) => {
  const { withRecordedEntryEditModals } = await import('../testUtils');
  return withRecordedEntryEditModals(
    await importOriginal<typeof import('../../src/modals/entry-edit-modal')>(),
    openedModals
  );
});

import { buildCharacterReplacementsPage } from '../../src/settings/character-replacements';
import { EntryEditModal } from '../../src/modals/entry-edit-modal';
import {
  LIST_NOTE_ATTRIBUTE,
  type FirstLineIsTitlePlugin,
} from '../../src/settings/settings-base';
import { DEFAULT_SETTINGS } from '../../src/constants';
import type { PluginSettings } from '../../src/types';
import {
  CharKey,
  PRIMARY_CHAR_KEYS,
  WINDOWS_ANDROID_CHAR_KEYS,
} from '../../src/types/char-replacement';
import { flush } from '../testUtils';

interface Harness {
  settings: PluginSettings;
  update: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
  allOSes: SettingDefinitionGroup<SettingPath>;
  windowsAndroid: SettingDefinitionGroup<SettingPath>;
}

function buildHarness(): Harness {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.characterReplacements.enableForbiddenCharReplacements = true;
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const plugin = {
    app: new App(),
    settings,
    saveSettings,
    debugLog: vi.fn(),
  } as unknown as FirstLineIsTitlePlugin;
  const update = vi.fn();
  const page = buildCharacterReplacementsPage(plugin, {
    update,
  } as unknown as PluginSettingTab);
  const groups = (page.items ?? []).filter(
    (item): item is SettingDefinitionGroup<SettingPath> =>
      (item as { type?: string }).type === 'list'
  );
  return {
    settings,
    update,
    saveSettings,
    allOSes: groups[0],
    windowsAndroid: groups[1],
  };
}

/** A group's character rows, past its description row. */
function charRows(
  group: SettingDefinitionGroup<SettingPath>
): SettingDefinitionRender[] {
  return (group.items ?? []).slice(1) as SettingDefinitionRender[];
}

function findRow(harness: Harness, key: CharKey): SettingDefinitionRender {
  const index = PRIMARY_CHAR_KEYS.indexOf(key);
  return index === -1
    ? charRows(harness.windowsAndroid)[WINDOWS_ANDROID_CHAR_KEYS.indexOf(key)]
    : charRows(harness.allOSes)[index];
}

function renderRow(row: SettingDefinitionRender): Setting {
  const setting = new Setting(document.createElement('div'));
  row.render(setting as never, {} as never);
  return setting;
}

function summaryOf(harness: Harness, key: CharKey): string | null {
  return renderRow(findRow(harness, key)).descEl.textContent;
}

interface OpenedDialog {
  modal: EntryEditModal<Record<string, string | boolean>>;
  rows: HTMLElement[];
  input: HTMLInputElement;
  toggles: HTMLElement[];
  saveButton: HTMLButtonElement;
}

function openEditDialog(harness: Harness, key: CharKey): OpenedDialog {
  const setting = renderRow(findRow(harness, key));
  (setting.components[0].onClick.mock.calls[0][0] as () => void)();
  const modal = openedModals[openedModals.length - 1] as EntryEditModal<
    Record<string, string | boolean>
  >;
  EntryEditModal.prototype.onOpen.call(modal);
  return {
    modal,
    rows: Array.from(modal.contentEl.querySelectorAll('.setting-item')),
    input: modal.contentEl.querySelector('input') as HTMLInputElement,
    toggles: Array.from(
      modal.contentEl.querySelectorAll('.checkbox-container')
    ),
    saveButton: modal.modalEl.querySelector(
      '.modal-button-container button'
    ) as HTMLButtonElement,
  };
}

function rowNames(dialog: OpenedDialog): (string | null)[] {
  return dialog.rows.map(
    (row) => row.querySelector('.setting-item-name')?.textContent ?? null
  );
}

describe('Character replacements page', () => {
  beforeEach(() => {
    openedModals.length = 0;
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  describe('rows', () => {
    it('lists one searchable row per character in each group, after its description', () => {
      const { allOSes, windowsAndroid } = buildHarness();

      expect(allOSes.heading).toBe('All OSes');
      const noteRow = renderRow(allOSes.items?.[0] as SettingDefinitionRender);
      expect(
        noteRow.settingEl.parentElement?.getAttribute(LIST_NOTE_ATTRIBUTE)
      ).toBe(
        'These characters are forbidden in Obsidian file names on every operating system.'
      );
      expect(charRows(allOSes).map((row) => row.name)).toEqual([
        'Left bracket [',
        'Right bracket ]',
        'Hash #',
        'Caret ^',
        'Pipe |',
        'Backslash \\',
        'Forward slash /',
        'Colon :',
        'Dot .',
      ]);
      expect(charRows(windowsAndroid).map((row) => row.name)).toEqual([
        'Asterisk *',
        'Quote "',
        'Less than <',
        'Greater than >',
        'Question mark ?',
      ]);
      expect(
        [...charRows(allOSes), ...charRows(windowsAndroid)].every(
          (row) => row.searchable === true
        )
      ).toBe(true);
    });

    it('gives each row Edit only', () => {
      const setting = renderRow(findRow(buildHarness(), 'colon'));

      expect(
        setting.components.map(
          (component) => component.setIcon.mock.calls[0]?.[0]
        )
      ).toEqual(['lucide-pen-line']);
    });
  });

  describe('summaries', () => {
    it('names the replacement while the switch is on', () => {
      const harness = buildHarness();
      const colon =
        harness.settings.characterReplacements.charReplacements.colon;
      colon.enabled = true;
      colon.replacement = '∶';

      expect(summaryOf(harness, 'colon')).toBe('Replaced with “∶”');
    });

    it('adds the trims that are on', () => {
      const harness = buildHarness();
      const chars = harness.settings.characterReplacements.charReplacements;
      Object.assign(chars.colon, { enabled: true, trimLeft: true });
      Object.assign(chars.pipe, { enabled: true, trimRight: true });
      Object.assign(chars.hash, {
        enabled: true,
        trimLeft: true,
        trimRight: true,
      });

      expect(summaryOf(harness, 'colon')).toMatch(/, trims left$/);
      expect(summaryOf(harness, 'pipe')).toMatch(/, trims right$/);
      expect(summaryOf(harness, 'hash')).toMatch(/, trims both sides$/);
    });

    it('reads "Removed", with no trims, for an empty replacement', () => {
      const harness = buildHarness();
      Object.assign(
        harness.settings.characterReplacements.charReplacements.colon,
        { enabled: true, replacement: '', trimLeft: true, trimRight: true }
      );

      expect(summaryOf(harness, 'colon')).toBe('Removed');
    });

    it('reads "Removed" while the switch is off', () => {
      const harness = buildHarness();
      harness.settings.characterReplacements.charReplacements.colon.enabled = false;

      expect(summaryOf(harness, 'colon')).toBe('Removed');
    });

    it('reads that the dot is kept except at the start while its switch is off', () => {
      const harness = buildHarness();
      harness.settings.characterReplacements.charReplacements.dot.enabled = false;

      expect(summaryOf(harness, 'dot')).toBe(
        'Kept, except at the start of the file name'
      );
    });

    it('names both trims for the dot, which is replaced at any position', () => {
      const harness = buildHarness();
      Object.assign(
        harness.settings.characterReplacements.charReplacements.dot,
        {
          enabled: true,
          trimLeft: true,
          trimRight: true,
        }
      );

      expect(summaryOf(harness, 'dot')).toBe(
        'Replaced with “․”, trims both sides'
      );
    });

    it('reads the stored config even while the section is off', () => {
      const harness = buildHarness();
      harness.settings.characterReplacements.enableForbiddenCharReplacements = false;
      harness.settings.characterReplacements.charReplacements.colon.enabled = true;

      expect(summaryOf(harness, 'colon')).toMatch(/^Replaced with/);
    });
  });

  describe('edit dialog', () => {
    it('is titled with the character and holds Replace, Replace with and both trims', () => {
      const dialog = openEditDialog(buildHarness(), 'colon');

      expect(dialog.modal.setTitle).toHaveBeenCalledWith('Colon :');
      expect(rowNames(dialog)).toEqual([
        'Replace',
        'Replace with',
        'Trim left',
        'Trim right',
      ]);
      expect(
        dialog.rows[2].querySelector('.setting-item-description')?.textContent
      ).toBe('Remove spaces before the character in the file name.');
      expect(
        dialog.rows[3].querySelector('.setting-item-description')?.textContent
      ).toBe('Remove spaces after the character in the file name.');
    });

    it('gives the dot dialog both trims', () => {
      const dialog = openEditDialog(buildHarness(), 'dot');

      expect(rowNames(dialog)).toEqual([
        'Replace',
        'Replace with',
        'Trim left',
        'Trim right',
      ]);
    });

    it.each([
      [
        'backslash',
        "Note: The backslash is replaced only when it's visible in Reading view.",
      ],
      ['dot', 'Note: The dot is forbidden only at the start of the file name.'],
    ] as const)('shows the %s note under Replace', (key, note) => {
      const dialog = openEditDialog(buildHarness(), key);

      expect(
        dialog.rows[0].querySelector('.setting-item-description')?.textContent
      ).toBe(note);
    });

    it('prefills from the stored config, with a restore button for the default replacement', () => {
      const harness = buildHarness();
      Object.assign(
        harness.settings.characterReplacements.charReplacements.colon,
        { enabled: true, replacement: '-', trimLeft: false, trimRight: true }
      );
      const dialog = openEditDialog(harness, 'colon');

      expect(dialog.input.value).toBe('-');
      expect(
        dialog.toggles.map((toggle) => toggle.classList.contains('is-enabled'))
      ).toEqual([true, false, true]);
      const restoreButton = dialog.rows[1].querySelector(
        '.extra-setting-button'
      ) as HTMLElement;
      restoreButton.click();
      expect(dialog.input.value).toBe(
        DEFAULT_SETTINGS.characterReplacements.charReplacements.colon
          .replacement
      );
    });

    it('strips the Windows and Android set from a replacement in the every-OS group, on this OS too', () => {
      // The guard re-dispatches `input` through the global Event, which jsdom only delivers when it is jsdom's own
      vi.stubGlobal('Event', window.Event);
      try {
        const dialog = openEditDialog(buildHarness(), 'colon');

        dialog.input.value = 'a?b*c';
        dialog.input.dispatchEvent(new window.Event('input'));

        expect(dialog.input.value).toBe('abc');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('writes the switch, replacement and trims on Save, then persists and re-renders', async () => {
      const harness = buildHarness();
      const colon =
        harness.settings.characterReplacements.charReplacements.colon;
      Object.assign(colon, {
        enabled: true,
        replacement: '∶',
        trimLeft: false,
        trimRight: false,
      });
      const dialog = openEditDialog(harness, 'colon');

      dialog.input.value = ' - ';
      dialog.input.dispatchEvent(new window.Event('input', { bubbles: true }));
      dialog.toggles[0].click();
      dialog.toggles[1].click();
      dialog.toggles[2].click();
      dialog.saveButton.click();
      await flush();

      expect(colon).toEqual({
        enabled: false,
        replacement: ' - ',
        trimLeft: true,
        trimRight: true,
      });
      expect(harness.saveSettings).toHaveBeenCalledTimes(1);
      expect(harness.update).toHaveBeenCalledTimes(1);
    });

    it("writes the dot's Trim left on Save", async () => {
      const harness = buildHarness();
      const dot = harness.settings.characterReplacements.charReplacements.dot;
      dot.trimLeft = false;
      const dialog = openEditDialog(harness, 'dot');

      dialog.toggles[1].click();
      dialog.saveButton.click();
      await flush();

      expect(dot.trimLeft).toBe(true);
    });
  });
});
