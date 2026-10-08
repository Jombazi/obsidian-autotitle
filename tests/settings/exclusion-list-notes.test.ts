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
import { Setting } from '../mockObsidian';

vi.mock('../../src/i18n', () => ({
  t: vi.fn((key: string) => key),
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
    (item): item is SettingDefinitionList =>
      (item as { type?: string }).type === 'list'
  );
  const groups = items.filter(
    (item): item is SettingDefinitionGroup =>
      (item as { type?: string }).type === 'group'
  );
  return { files: lists[0], tags: lists[1], properties: lists[2], groups };
}

/** Renders the list's first row inside a rows container shaped like Obsidian's list group. */
function renderFirstRow(list: SettingDefinitionList): HTMLElement {
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

  it('puts the three property notes on separate lines, with the value label quoted', () => {
    const rowsEl = renderFirstRow(buildPage().properties);

    expect(rowsEl.getAttribute(LIST_NOTE_ATTRIBUTE)?.split('\n')).toEqual([
      'settings.exclusions.properties.renamedWarning',
      'settings.exclusions.properties.leaveBlank.part1' +
        '“settings.exclusions.properties.leaveBlank.value”' +
        'settings.exclusions.properties.leaveBlank.part2',
      'settings.exclusions.properties.caseInsensitive',
    ]);
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
