/**
 * Tests for the Custom replacements page: rules as summary rows in a native
 * list, edited through the shared entry dialog.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  PluginSettingTab,
  SettingDefinitionGroup,
  SettingDefinitionList,
  SettingDefinitionPage,
  SettingDefinitionRender,
} from 'obsidian';
import { App, Platform, Setting } from '../mockObsidian';

const { openedModals } = vi.hoisted(() => ({
  openedModals: [] as unknown[],
}));

// The base Modal mock declares `onOpen` as an instance field, so instances are recorded here and opened through the real prototype
vi.mock('../../src/modals/entry-edit-modal', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modals/entry-edit-modal')
  >('../../src/modals/entry-edit-modal');
  class RecordingEntryEditModal<
    V extends Record<string, string | boolean>,
  > extends actual.EntryEditModal<V> {
    constructor(
      ...args: ConstructorParameters<typeof actual.EntryEditModal<V>>
    ) {
      super(...args);
      openedModals.push(this);
    }
  }
  return { ...actual, EntryEditModal: RecordingEntryEditModal };
});

import { buildCustomReplacementsPage } from '../../src/settings/custom-replacements';
import { EntryEditModal } from '../../src/modals/entry-edit-modal';
import {
  LIST_NOTE_ATTRIBUTE,
  LIST_NOTE_CLASS,
  type FirstLineIsTitlePlugin,
} from '../../src/settings/settings-base';
import { DEFAULT_SETTINGS } from '../../src/constants';
import type { CustomReplacement, PluginSettings } from '../../src/types';

/** Lets an awaited save settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

interface Harness {
  settings: PluginSettings;
  rules: CustomReplacement[];
  update: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
  page: SettingDefinitionPage;
  group: SettingDefinitionGroup;
  list: SettingDefinitionList;
}

function buildHarness(rules?: CustomReplacement[]): Harness {
  const settings = structuredClone(DEFAULT_SETTINGS);
  if (rules) settings.customReplacements.rules = rules;
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const plugin = {
    app: new App(),
    settings,
    saveSettings,
    debugLog: vi.fn(),
  } as unknown as FirstLineIsTitlePlugin;
  const update = vi.fn();
  const page = buildCustomReplacementsPage(plugin, {
    update,
  } as unknown as PluginSettingTab);
  const group = (page.items ?? []).find(
    (item) => (item as { type?: string }).type === 'group'
  ) as SettingDefinitionGroup;
  const list = (page.items ?? []).find(
    (item) => (item as { type?: string }).type === 'list'
  ) as SettingDefinitionList;
  return {
    settings,
    rules: settings.customReplacements.rules,
    update,
    saveSettings,
    page,
    group,
    list,
  };
}

function rule(overrides: Partial<CustomReplacement> = {}): CustomReplacement {
  return {
    searchText: 'TODO',
    replaceText: 'Done',
    onlyAtStart: false,
    onlyWholeLine: false,
    ...overrides,
  };
}

/** The task-checkbox rule older defaults shipped, kept for its leading and trailing whitespace. */
function taskCheckboxRule(): CustomReplacement {
  return rule({ searchText: '- [ ] ', replaceText: '✔️ ', onlyAtStart: true });
}

/** Whether a page item's `visible` predicate passes. */
function isVisible(item: unknown): boolean {
  return (item as { visible?: () => boolean }).visible?.() ?? true;
}

function ruleRowDefinition(
  harness: Harness,
  ruleIndex: number
): SettingDefinitionRender {
  return harness.list.items?.[ruleIndex] as SettingDefinitionRender;
}

function renderDefinition(
  definition: SettingDefinitionRender,
  containerEl: HTMLElement = document.createElement('div')
): Setting {
  const setting = new Setting(containerEl);
  definition.render(setting as never, {} as never);
  return setting;
}

/** A rows container inside a list group carrying `cls`, as Obsidian builds a native list. */
function buildRowsContainer(cls: string): HTMLElement {
  const groupEl = document.createElement('div');
  groupEl.className = `setting-group mod-list ${cls}`;
  const rowsEl = document.createElement('div');
  rowsEl.className = 'setting-items';
  groupEl.appendChild(rowsEl);
  return rowsEl;
}

function renderRow(harness: Harness, ruleIndex: number): Setting {
  return renderDefinition(ruleRowDefinition(harness, ruleIndex));
}

function clickExtraButton(setting: Setting, icon: string): void {
  const button = setting.components.find(
    (component) => component.setIcon.mock.calls[0]?.[0] === icon
  );
  (button.onClick.mock.calls[0][0] as () => void)();
}

interface OpenedDialog {
  modal: EntryEditModal<Record<string, string | boolean>>;
  inputs: HTMLInputElement[];
  toggles: HTMLElement[];
  saveButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
}

function openLatestDialog(): OpenedDialog {
  const modal = openedModals[openedModals.length - 1] as EntryEditModal<
    Record<string, string | boolean>
  >;
  // Connected, with the content inside the dialog, so focus can be observed
  document.body.appendChild(modal.modalEl);
  modal.modalEl.appendChild(modal.contentEl);
  EntryEditModal.prototype.onOpen.call(modal);
  const buttons = modal.modalEl.querySelectorAll<HTMLButtonElement>(
    '.modal-button-container button'
  );
  return {
    modal,
    inputs: Array.from(modal.contentEl.querySelectorAll('input')),
    toggles: Array.from(
      modal.contentEl.querySelectorAll('.checkbox-container')
    ),
    saveButton: buttons[0],
    cancelButton: buttons[1],
  };
}

function typeInto(inputEl: HTMLInputElement, value: string): void {
  inputEl.value = value;
  inputEl.dispatchEvent(new window.Event('input', { bubbles: true }));
}

describe('Custom replacements page', () => {
  beforeEach(() => {
    openedModals.length = 0;
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  describe('defaults', () => {
    it('stores no per-rule enable, so every rule that exists is in effect', async () => {
      const harness = buildHarness([]);

      harness.list.addItem?.action(document.createElement('div'));
      const { inputs, saveButton } = openLatestDialog();
      typeInto(inputs[0], 'a');
      saveButton.click();
      await flush();

      expect(Object.keys(harness.rules[0]).sort()).toEqual([
        'onlyAtStart',
        'onlyWholeLine',
        'replaceText',
        'searchText',
      ]);
    });
  });

  describe('visibility', () => {
    it('has no row that switches the rules on or off', () => {
      const harness = buildHarness([]);

      expect(
        [...(harness.page.items ?? []), ...(harness.group.items ?? [])].map(
          (item) => (item as { control?: { key: string } }).control?.key
        )
      ).not.toContain('customReplacements.enableCustomReplacements');
    });

    it('shows only the list, empty so its empty state applies, when there are no rules', () => {
      const harness = buildHarness([]);

      expect(isVisible(harness.group)).toBe(false);
      expect(isVisible(harness.list)).toBe(true);
      expect(harness.list.items).toEqual([]);
      expect(harness.list.emptyState).toBe('No custom replacements.');
    });

    it('shows a group of just the two ordering options above the list once a rule exists', () => {
      const harness = buildHarness([rule()]);

      expect(
        (harness.page.items ?? []).map(
          (item) => (item as { type?: string }).type
        )
      ).toEqual(['group', 'list']);
      expect(isVisible(harness.group)).toBe(true);
      expect((harness.group.items ?? []).map((item) => item.name)).toEqual([
        'Apply after stripping or replacing forbidden characters',
        'Apply after markup stripping',
      ]);
    });

    it('lists only the rules, so the drag sorter has nothing to move but rules', () => {
      const harness = buildHarness([
        rule({ searchText: 'A' }),
        rule({ searchText: 'B' }),
      ]);

      expect((harness.list.items ?? []).map((row) => row.name)).toEqual([
        'A → Done',
        'B → Done',
      ]);
    });

    it("has a rendered rule row put the rule-order note on the rule list's rows container", () => {
      const harness = buildHarness([rule()]);
      const rowsEl = buildRowsContainer(harness.list.cls ?? '');

      renderDefinition(ruleRowDefinition(harness, 0), rowsEl);

      expect(harness.list.cls).toBe(LIST_NOTE_CLASS);
      expect(rowsEl.getAttribute(LIST_NOTE_ATTRIBUTE)).toBe(
        'Rules apply top to bottom.'
      );
    });

    it('leaves the rows container of any other list without the note', () => {
      const harness = buildHarness([rule()]);
      const rowsEl = buildRowsContainer('some-other-list');

      renderDefinition(ruleRowDefinition(harness, 0), rowsEl);

      expect(rowsEl.hasAttribute(LIST_NOTE_ATTRIBUTE)).toBe(false);
    });
  });

  describe('row summary', () => {
    it('names the row after the search text, keeping its whitespace', () => {
      const harness = buildHarness([taskCheckboxRule()]);
      const setting = renderRow(harness, 0);

      expect(ruleRowDefinition(harness, 0).name).toBe('- [ ]  → ✔️ ');
      const sideEls = setting.nameEl.querySelectorAll('span.flit-rule-text');
      expect(Array.from(sideEls, (el) => el.textContent)).toEqual(['- [ ] ']);
      expect(setting.nameEl.textContent).toBe('- [ ] ');
    });

    it('quotes the replacement in the description, keeping its whitespace', () => {
      const harness = buildHarness([taskCheckboxRule()]);

      expect(renderRow(harness, 0).descEl.textContent).toBe(
        'Replaced with “✔️ ”, only at line start'
      );
      expect(
        renderRow(harness, 0).descEl.querySelector('.flit-rule-text')
          ?.textContent
      ).toBe('✔️ ');
    });

    it('describes an empty replacement as removed', () => {
      const harness = buildHarness([rule({ replaceText: '' })]);

      expect(renderRow(harness, 0).descEl.textContent).toBe('Removed');
      expect(ruleRowDefinition(harness, 0).name).toBe('TODO → Empty');
    });

    it('shows an empty search text as the muted "Empty" label', () => {
      const harness = buildHarness([rule({ searchText: '' })]);
      const setting = renderRow(harness, 0);

      expect(setting.nameEl.querySelector('.u-muted')?.textContent).toBe(
        'Empty'
      );
    });

    it('appends the match options that are on to the description', () => {
      const harness = buildHarness([
        rule({ onlyAtStart: true }),
        rule({ onlyWholeLine: true }),
      ]);

      expect(renderRow(harness, 0).descEl.textContent).toBe(
        'Replaced with “Done”, only at line start'
      );
      expect(renderRow(harness, 1).descEl.textContent).toBe(
        'Replaced with “Done”, only as the whole line'
      );
    });

    it('gives each row Edit then a trash-bin Delete, with the native list adding the drag handle', () => {
      const harness = buildHarness([rule()]);
      const setting = renderRow(harness, 0);

      expect(
        setting.components.map(
          (component) => component.setIcon.mock.calls[0]?.[0]
        )
      ).toEqual(['lucide-pen-line', 'lucide-trash-2']);
      expect(ruleRowDefinition(harness, 0).searchable).toBe(false);
      expect(harness.list.onReorder).toBeTypeOf('function');
      expect(harness.list.onDelete).toBeUndefined();
    });

    it('counts rules with search text on the page row', () => {
      const harness = buildHarness([rule(), rule({ searchText: '' })]);

      const { displayValue } = harness.page;
      expect(typeof displayValue === 'function' && displayValue()).toBe(
        '1 rule'
      );
    });
  });

  describe('add', () => {
    it('opens "Add replacement" and adds nothing before Save', () => {
      const harness = buildHarness([]);

      harness.list.addItem?.action(document.createElement('div'));
      const { modal, inputs, saveButton } = openLatestDialog();

      expect(modal.setTitle).toHaveBeenCalledWith('Add replacement');
      expect(inputs.map((input) => input.value)).toEqual(['', '']);
      expect(saveButton.disabled).toBe(true);
      expect(harness.rules).toEqual([]);
    });

    it('adds the rule on Save, then persists and re-renders', async () => {
      const harness = buildHarness([]);

      harness.list.addItem?.action(document.createElement('div'));
      const { inputs, toggles, saveButton } = openLatestDialog();
      typeInto(inputs[0], ' a ');
      typeInto(inputs[1], 'b');
      toggles[1].click();
      saveButton.click();
      await flush();

      expect(harness.rules).toEqual([
        {
          searchText: ' a ',
          replaceText: 'b',
          onlyAtStart: false,
          onlyWholeLine: true,
        },
      ]);
      expect(harness.saveSettings).toHaveBeenCalledTimes(1);
      expect(harness.update).toHaveBeenCalledTimes(1);
    });

    it('adds nothing on Cancel', async () => {
      const harness = buildHarness([]);

      harness.list.addItem?.action(document.createElement('div'));
      const { inputs, cancelButton } = openLatestDialog();
      typeInto(inputs[0], 'a');
      cancelButton.click();
      await flush();

      expect(harness.rules).toEqual([]);
      expect(harness.saveSettings).not.toHaveBeenCalled();
    });

    describe('on mobile', () => {
      beforeEach(() => {
        Platform.isMobile = true;
      });

      afterEach(() => {
        Platform.isMobile = false;
      });

      it('focuses "Text to replace" as the dialog opens, so the on-screen keyboard comes up', () => {
        const harness = buildHarness([]);

        harness.list.addItem?.action(document.createElement('div'));
        const { inputs } = openLatestDialog();

        expect(document.activeElement).toBe(inputs[0]);
      });
    });
  });

  describe('edit', () => {
    it('opens "Edit replacement" prefilled from the rule', () => {
      const harness = buildHarness([rule({ onlyAtStart: true })]);

      clickExtraButton(renderRow(harness, 0), 'lucide-pen-line');
      const { modal, inputs, toggles } = openLatestDialog();

      expect(modal.setTitle).toHaveBeenCalledWith('Edit replacement');
      expect(inputs.map((input) => input.value)).toEqual(['TODO', 'Done']);
      expect(
        toggles.map((toggle) => toggle.classList.contains('is-enabled'))
      ).toEqual([true, false]);
    });

    it('leaves the fields unfocused on mobile, so no on-screen keyboard comes up', () => {
      Platform.isMobile = true;
      try {
        const harness = buildHarness([rule()]);

        clickExtraButton(renderRow(harness, 0), 'lucide-pen-line');
        const { inputs } = openLatestDialog();

        expect(inputs).not.toContain(document.activeElement);
      } finally {
        Platform.isMobile = false;
      }
    });

    it('rewrites the same rule object on Save, then persists and re-renders', async () => {
      const original = rule({ onlyAtStart: true });
      const harness = buildHarness([original, rule({ searchText: 'B' })]);

      clickExtraButton(renderRow(harness, 0), 'lucide-pen-line');
      const { inputs, toggles, saveButton } = openLatestDialog();
      typeInto(inputs[1], 'Finished');
      toggles[1].click();
      saveButton.click();
      await flush();

      expect(harness.rules[0]).toBe(original);
      expect(original).toEqual({
        searchText: 'TODO',
        replaceText: 'Finished',
        onlyAtStart: false,
        onlyWholeLine: true,
      });
      expect(harness.rules).toHaveLength(2);
      expect(harness.update).toHaveBeenCalledTimes(1);
    });

    it('keeps the two match options exclusive', () => {
      const harness = buildHarness([rule({ onlyWholeLine: true })]);

      clickExtraButton(renderRow(harness, 0), 'lucide-pen-line');
      const { toggles } = openLatestDialog();
      toggles[0].click();

      expect(
        toggles.map((toggle) => toggle.classList.contains('is-enabled'))
      ).toEqual([true, false]);
    });
  });

  describe('delete and reorder', () => {
    it("deletes the row's own rule, even after a reorder moved it", async () => {
      const first = rule({ searchText: 'A' });
      const second = rule({ searchText: 'B' });
      const harness = buildHarness([first, second]);
      const firstRow = renderRow(harness, 0);

      harness.list.onReorder?.(0, 1);
      await flush();
      clickExtraButton(firstRow, 'lucide-trash-2');
      await flush();

      expect(harness.rules).toEqual([second]);
      expect(harness.update).toHaveBeenCalledTimes(2);
    });

    it('persists a reorder, then re-renders because a keyboard move leaves the rows in place', async () => {
      const first = rule({ searchText: 'A' });
      const second = rule({ searchText: 'B' });
      const third = rule({ searchText: 'C' });
      const harness = buildHarness([first, second, third]);

      harness.list.onReorder?.(2, 1);
      await flush();

      expect(harness.rules).toEqual([first, third, second]);
      expect(harness.saveSettings).toHaveBeenCalledTimes(1);
      expect(harness.update).toHaveBeenCalledTimes(1);
    });
  });
});
