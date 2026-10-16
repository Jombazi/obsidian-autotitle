/**
 * Tests for the notes drawn above the first entry of each Exclusions list,
 * which replaced the description rows at the top of each section's group.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  PluginSettingTab,
  SettingDefinitionGroup,
  SettingDefinitionList,
  SettingDefinitionRender,
} from 'obsidian';
import type { SettingPath } from '../../src/settings/settings-paths';
import { Setting } from '../mockObsidian';

vi.mock('../../src/i18n', () => ({
  // Variables are shown after the key, so a test can see which label filled a placeholder
  t: vi.fn((key: string, variables?: Record<string, string>) =>
    variables ? `${key}(${Object.values(variables).join(', ')})` : key
  ),
  tp: vi.fn((key: string) => key),
  getCurrentLocale: vi.fn(() => 'en'),
}));

import { buildExclusionsPage } from '../../src/settings/exclusions';
import {
  LIST_NOTE_ATTRIBUTE,
  LIST_NOTE_CLASS,
  type FirstLineIsTitlePlugin,
} from '../../src/settings/settings-base';
import { DEFAULT_SETTINGS } from '../../src/constants';

function buildPage() {
  const exclusions = structuredClone(DEFAULT_SETTINGS.exclusions);
  exclusions.excludedFiles = ['Templates/'];
  exclusions.excludedTags = ['draft'];
  exclusions.excludedProperties = [{ key: 'status', value: 'done' }];
  const plugin = {
    settings: { exclusions },
    saveSettings: vi.fn().mockResolvedValue(undefined),
    debugLog: vi.fn(),
  } as unknown as FirstLineIsTitlePlugin;
  const page = buildExclusionsPage(plugin, {
    update: vi.fn(),
  } as unknown as PluginSettingTab);
  const items = page.items ?? [];
  const lists = items.filter(
    (item): item is SettingDefinitionList<SettingPath> =>
      (item as { type?: string }).type === 'list'
  );
  const groups = items.filter(
    (item): item is SettingDefinitionGroup<SettingPath> =>
      (item as { type?: string }).type === 'group'
  );
  return { files: lists[0], tags: lists[1], properties: lists[2], groups };
}

/** Renders the list's first row inside a rows container shaped like Obsidian's list group. */
function renderFirstRow(list: SettingDefinitionList<SettingPath>): HTMLElement {
  const groupEl = document.createElement('div');
  groupEl.className = `setting-group mod-list ${list.cls ?? ''}`;
  const rowsEl = groupEl.createDiv({ cls: 'setting-items' });
  const setting = new Setting(rowsEl);
  (list.items?.[0] as SettingDefinitionRender).render(
    setting as never,
    {} as never
  );
  return rowsEl;
}

describe('Exclusion list notes', () => {
  it('marks every exclusion list for a note', () => {
    const { files, tags, properties } = buildPage();

    expect([files, tags, properties].map((list) => list.cls)).toEqual([
      LIST_NOTE_CLASS,
      LIST_NOTE_CLASS,
      LIST_NOTE_CLASS,
    ]);
  });

  it.each([
    ['files', 'settings.exclusions.files.renamedWarning'],
    ['tags', 'settings.exclusions.tags.tagWranglerWarning'],
  ] as const)('puts the %s note on its rows container', (listName, note) => {
    const rowsEl = renderFirstRow(buildPage()[listName]);

    expect(rowsEl.getAttribute(LIST_NOTE_ATTRIBUTE)).toBe(note);
  });

  // The input hints moved into the add and edit dialogs, leaving the lists their warnings
  it('puts only the renamed warning in the properties note', () => {
    const rowsEl = renderFirstRow(buildPage().properties);

    expect(rowsEl.getAttribute(LIST_NOTE_ATTRIBUTE)).toBe(
      'settings.exclusions.properties.renamedWarning'
    );
  });

  it('leaves no description row at the top of the files, tags or properties group', () => {
    const { groups } = buildPage();
    const sectionGroups = groups.filter((group) =>
      [
        'settings.exclusions.files.title',
        'settings.exclusions.tags.title',
        'settings.exclusions.properties.title',
      ].includes(group.heading ?? '')
    );

    expect(sectionGroups).toHaveLength(3);
    for (const group of sectionGroups) {
      expect((group.items?.[0] as { name?: string }).name).not.toBe('');
    }
  });
});
