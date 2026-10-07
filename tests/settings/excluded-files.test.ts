/**
 * Tests for the Exclusions page's Excluded files group, its rows' Edit and
 * Delete buttons, and the "Add exclusion" dialog, which replicates the dialog
 * of Obsidian's own Excluded files setting and doubles as "Edit exclusion".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  PluginSettingTab,
  SettingDefinitionGroup,
  SettingDefinitionList,
  SettingDefinitionRender,
} from 'obsidian';
import {
  App,
  Platform,
  Setting,
  TFolder,
  displayTooltip,
} from '../mockObsidian';

const { openedModals, folderSuggests } = vi.hoisted(() => ({
  openedModals: [] as unknown[],
  folderSuggests: [] as unknown[],
}));

vi.mock('../../src/i18n', () => ({
  t: vi.fn((key: string) => key),
  getCurrentLocale: vi.fn(() => 'en'),
}));

// The base mocks declare `open`, `onOpen` and the suggester methods as instance fields, so instances are recorded here and driven through the real prototypes below
vi.mock('../../src/modals/add-excluded-file', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modals/add-excluded-file')
  >('../../src/modals/add-excluded-file');
  class RecordingAddExcludedFileModal extends actual.AddExcludedFileModal {
    constructor(
      ...args: ConstructorParameters<typeof actual.AddExcludedFileModal>
    ) {
      super(...args);
      openedModals.push(this);
    }
  }
  return { AddExcludedFileModal: RecordingAddExcludedFileModal };
});

vi.mock('../../src/suggests', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/suggests')>(
      '../../src/suggests'
    );
  class RecordingFolderSuggest extends actual.FolderSuggest {
    constructor(...args: ConstructorParameters<typeof actual.FolderSuggest>) {
      super(...args);
      folderSuggests.push(this);
    }
  }
  return { ...actual, FolderSuggest: RecordingFolderSuggest };
});

import { buildExclusionsPage } from '../../src/settings/exclusions';
import { AddExcludedFileModal } from '../../src/modals/add-excluded-file';
import { FolderSuggest } from '../../src/suggests';
import type { FirstLineIsTitlePlugin } from '../../src/settings/settings-base';
import { DEFAULT_SETTINGS } from '../../src/constants';
import { EXCLUSION_STRATEGY } from '../../src/types';

/** Lets an awaited save settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

interface Harness {
  exclusions: typeof DEFAULT_SETTINGS.exclusions;
  app: App;
  update: ReturnType<typeof vi.fn>;
  saveSettings: ReturnType<typeof vi.fn>;
  group: SettingDefinitionGroup;
  list: SettingDefinitionList;
}

function buildHarness(excludedFiles: string[] = []): Harness {
  const exclusions = structuredClone(DEFAULT_SETTINGS.exclusions);
  exclusions.excludedFiles = excludedFiles;
  const app = new App();
  const saveSettings = vi.fn().mockResolvedValue(undefined);
  const plugin = {
    app,
    settings: { exclusions },
    saveSettings,
    debugLog: vi.fn(),
  } as unknown as FirstLineIsTitlePlugin;
  const update = vi.fn();
  const tab = { update } as unknown as PluginSettingTab;

  const items = buildExclusionsPage(plugin, tab).items ?? [];
  const groupIndex = items.findIndex(
    (item) =>
      (item as SettingDefinitionGroup).heading ===
      'settings.exclusions.files.title'
  );
  return {
    exclusions,
    app,
    update,
    saveSettings,
    group: items[groupIndex] as SettingDefinitionGroup,
    list: items[groupIndex + 1] as SettingDefinitionList,
  };
}

interface OpenedDialog {
  modal: AddExcludedFileModal;
  inputEl: HTMLInputElement;
  buttonContainer: HTMLElement | null;
  doneButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  headerButtons: HTMLElement[];
}

/** Renders a list row into a mock `Setting`, whose extra buttons record their icon and click handler. */
function renderRow(harness: Harness, index: number): Setting {
  const setting = new Setting(document.createElement('div'));
  (harness.list.items?.[index] as SettingDefinitionRender).render(
    setting as never,
    {} as never
  );
  return setting;
}

/** The icons of a rendered row's extra buttons, in the order they were added. */
function extraButtonIcons(setting: Setting): string[] {
  return setting.components.map(
    (component) => component.setIcon.mock.calls[0]?.[0] as string
  );
}

function clickExtraButton(setting: Setting, icon: string): void {
  const button = setting.components.find(
    (component) => component.setIcon.mock.calls[0]?.[0] === icon
  );
  (button.onClick.mock.calls[0][0] as () => void)();
}

/** Opens the dialog the most recent `new AddExcludedFileModal` created. */
function openLatestDialog(): OpenedDialog {
  const modal = openedModals[openedModals.length - 1] as AddExcludedFileModal;
  // The mock leaves the title detached, while Obsidian nests it in the header that phones add their buttons to
  modal.modalEl.createDiv('modal-header').appendChild(modal.titleEl);
  // Connected, with the content inside the dialog, so focus can be observed
  document.body.appendChild(modal.modalEl);
  modal.modalEl.appendChild(modal.contentEl);
  AddExcludedFileModal.prototype.onOpen.call(modal);
  const buttons = modal.modalEl.querySelectorAll<HTMLButtonElement>(
    '.modal-button-container button'
  );
  return {
    modal,
    inputEl: modal.contentEl.querySelector('input') as HTMLInputElement,
    buttonContainer: modal.modalEl.querySelector('.modal-button-container'),
    doneButton: buttons[0],
    cancelButton: buttons[1],
    headerButtons: Array.from(
      modal.modalEl.querySelectorAll<HTMLElement>(
        '.modal-header .modal-header-button'
      )
    ),
  };
}

/** Runs the list's add affordance and opens the dialog it creates. */
function openDialog(harness: Harness): OpenedDialog {
  harness.list.addItem?.action(document.createElement('div'));
  return openLatestDialog();
}

/** Clicks a row's Edit button and opens the dialog it creates. */
function openEditDialog(harness: Harness, index: number): OpenedDialog {
  clickExtraButton(renderRow(harness, index), 'lucide-pen-line');
  return openLatestDialog();
}

function pressEnter(inputEl: HTMLInputElement, isComposing = false): void {
  inputEl.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', isComposing })
  );
}

describe('Excluded files', () => {
  beforeEach(() => {
    openedModals.length = 0;
    folderSuggests.length = 0;
    vi.mocked(displayTooltip).mockClear();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  describe('settings group', () => {
    it('renders the exclusion mode dropdown with both strategies', () => {
      const { group } = buildHarness();

      const modeRow = (group.items ?? []).find(
        (item) =>
          'control' in item &&
          item.control?.key === 'exclusions.fileScopeStrategy'
      );
      expect(modeRow).toMatchObject({
        name: 'settings.exclusions.files.exclusionMode.name',
        control: {
          type: 'dropdown',
          options: {
            [EXCLUSION_STRATEGY.ONLY_EXCLUDE]:
              'settings.exclusions.files.exclusionMode.onlyExclude',
            [EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT]:
              'settings.exclusions.files.exclusionMode.excludeAllExcept',
          },
        },
      });
    });

    it('renders one unsearchable row per entry, with no native delete or reorder', () => {
      const { list } = buildHarness(['Notes/', '/draft-/']);

      expect(list.items).toMatchObject([
        { name: 'Notes/', searchable: false },
        { name: '/draft-/', searchable: false },
      ]);
      expect(list.emptyState).toBe('settings.exclusions.files.emptyState');
      expect(list.onReorder).toBeUndefined();
      expect(list.onDelete).toBeUndefined();
      expect(list.addItem?.name).toBe('settings.exclusions.files.addButton');
    });

    it('gives each row Edit then a trash-bin Delete', () => {
      const setting = renderRow(buildHarness(['Notes/']), 0);

      expect(extraButtonIcons(setting)).toEqual([
        'lucide-pen-line',
        'lucide-trash-2',
      ]);
      expect(setting.components[1].setTooltip).toHaveBeenCalledWith(
        'settings.common.delete'
      );
    });

    it("deletes an entry through its row's Delete and re-renders", async () => {
      const harness = buildHarness(['Notes/', '/draft-/']);

      clickExtraButton(renderRow(harness, 0), 'lucide-trash-2');
      await flush();

      expect(harness.exclusions.excludedFiles).toEqual(['/draft-/']);
      expect(harness.saveSettings).toHaveBeenCalled();
      expect(harness.update).toHaveBeenCalled();
    });
  });

  describe('"Add exclusion" dialog', () => {
    it("builds Obsidian's form sheet: field, help text, then Done and Cancel", () => {
      const { modal, inputEl, buttonContainer, headerButtons } =
        openDialog(buildHarness());

      expect(modal.modalEl.classList.contains('mod-lg')).toBe(true);
      expect(modal.modalEl.classList.contains('mod-form-sheet')).toBe(true);
      expect(modal.setTitle).toHaveBeenCalledWith(
        'modals.addExcludedFile.title'
      );
      const field = modal.contentEl.querySelector('p.form-field');
      expect(
        Array.from(field?.children ?? []).map((child) => child.tagName)
      ).toEqual(['LABEL', 'INPUT', 'DIV']);
      expect(inputEl.type).toBe('text');
      expect(inputEl.spellcheck).toBe(false);
      expect(field?.querySelector('.form-field-help')?.textContent).toBe(
        'modals.addExcludedFile.help'
      );
      const buttons = Array.from(buttonContainer?.children ?? []);
      expect(buttons.map((button) => button.textContent)).toEqual([
        'modals.buttons.done',
        'modals.buttons.cancel',
      ]);
      expect(buttons[0].classList.contains('mod-cta')).toBe(true);
      expect(buttons[1].classList.contains('mod-cancel')).toBe(false);
      expect(headerButtons).toEqual([]);
    });

    it("carries FLIT's dialog class", () => {
      const { modal } = openDialog(buildHarness());

      expect(modal.containerEl.classList.contains('flit-modal')).toBe(true);
    });

    it('adds the trimmed entry on Done, then closes and re-renders the list', async () => {
      const harness = buildHarness(['Notes/']);
      const { modal, inputEl, doneButton } = openDialog(harness);

      inputEl.value = '  /draft-/  ';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedFiles).toEqual(['Notes/', '/draft-/']);
      expect(harness.saveSettings).toHaveBeenCalledTimes(1);
      expect(modal.close).toHaveBeenCalledTimes(1);
      expect(harness.update).toHaveBeenCalledTimes(1);
      expect(vi.mocked(modal.close).mock.invocationCallOrder[0]).toBeLessThan(
        harness.update.mock.invocationCallOrder[0]
      );
    });

    it('submits on Enter', async () => {
      const harness = buildHarness();
      const { inputEl } = openDialog(harness);

      inputEl.value = 'Archive/';
      pressEnter(inputEl);
      await flush();

      expect(harness.exclusions.excludedFiles).toEqual(['Archive/']);
    });

    it('ignores Enter while an input method is composing', async () => {
      const harness = buildHarness();
      const { inputEl } = openDialog(harness);

      inputEl.value = 'Archive/';
      pressEnter(inputEl, true);
      await flush();

      expect(harness.exclusions.excludedFiles).toEqual([]);
    });

    it('shows an error tooltip and adds nothing for an empty filter', async () => {
      const harness = buildHarness();
      const { modal, inputEl, doneButton } = openDialog(harness);

      inputEl.value = '   ';
      doneButton.click();
      await flush();

      expect(displayTooltip).toHaveBeenCalledWith(
        inputEl,
        'modals.addExcludedFile.emptyFilter',
        { classes: ['mod-error'] }
      );
      expect(harness.exclusions.excludedFiles).toEqual([]);
      expect(modal.close).not.toHaveBeenCalled();
    });

    it('does not add a case-insensitive duplicate', async () => {
      const harness = buildHarness(['Notes/']);
      const { modal, inputEl, doneButton } = openDialog(harness);

      inputEl.value = 'notes/';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedFiles).toEqual(['Notes/']);
      expect(harness.saveSettings).not.toHaveBeenCalled();
      expect(modal.close).toHaveBeenCalled();
    });

    it('closes on Cancel without adding', async () => {
      const harness = buildHarness();
      const { modal, inputEl, cancelButton } = openDialog(harness);

      inputEl.value = 'Archive/';
      cancelButton.click();
      await flush();

      expect(modal.close).toHaveBeenCalled();
      expect(harness.exclusions.excludedFiles).toEqual([]);
    });

    describe('on phones', () => {
      beforeEach(() => {
        Platform.isPhone = true;
      });

      afterEach(() => {
        Platform.isPhone = false;
      });

      it('replaces the button row with a close button and a submit button in the header', () => {
        const { modal, buttonContainer, headerButtons } =
          openDialog(buildHarness());

        expect(buttonContainer).toBeNull();
        const header = modal.titleEl.parentElement;
        expect(Array.from(header?.children ?? [])).toEqual([
          modal.titleEl,
          ...headerButtons,
        ]);
        expect(
          headerButtons.map((button) => [
            button.className,
            button.getAttribute('data-icon'),
          ])
        ).toEqual([
          ['modal-header-button mod-raised clickable-icon mod-start', 'x'],
          [
            'modal-header-button mod-raised clickable-icon mod-cta',
            'lucide-check',
          ],
        ]);
      });

      it('closes on the close button without adding', async () => {
        const harness = buildHarness();
        const { modal, inputEl, headerButtons } = openDialog(harness);

        inputEl.value = 'Archive/';
        headerButtons[0].click();
        await flush();

        expect(modal.close).toHaveBeenCalledTimes(1);
        expect(harness.exclusions.excludedFiles).toEqual([]);
        expect(harness.saveSettings).not.toHaveBeenCalled();
      });

      it('adds the trimmed entry on the submit button, then closes and re-renders the list', async () => {
        const harness = buildHarness(['Notes/']);
        const { modal, inputEl, headerButtons } = openDialog(harness);

        inputEl.value = '  /draft-/  ';
        headerButtons[1].click();
        await flush();

        expect(harness.exclusions.excludedFiles).toEqual([
          'Notes/',
          '/draft-/',
        ]);
        expect(harness.saveSettings).toHaveBeenCalledTimes(1);
        expect(modal.close).toHaveBeenCalledTimes(1);
        expect(harness.update).toHaveBeenCalledTimes(1);
      });

      it('shows an error tooltip and adds nothing when the submit button meets an empty filter', async () => {
        const harness = buildHarness();
        const { modal, inputEl, headerButtons } = openDialog(harness);

        inputEl.value = '   ';
        headerButtons[1].click();
        await flush();

        expect(displayTooltip).toHaveBeenCalledWith(
          inputEl,
          'modals.addExcludedFile.emptyFilter',
          { classes: ['mod-error'] }
        );
        expect(harness.exclusions.excludedFiles).toEqual([]);
        expect(modal.close).not.toHaveBeenCalled();
      });
    });

    describe('folder suggestions', () => {
      function pickFolder(path: string): void {
        const suggest = folderSuggests[
          folderSuggests.length - 1
        ] as FolderSuggest;
        FolderSuggest.prototype.selectSuggestion.call(
          suggest,
          new TFolder(path),
          new window.KeyboardEvent('keydown', { key: 'Enter' })
        );
      }

      it('adds the picked folder as `path/`, even though the suggester rewrites the input without the slash', async () => {
        const harness = buildHarness();
        const { inputEl } = openDialog(harness);

        pickFolder('Notes/Work');
        await flush();

        expect(inputEl.value).toBe('Notes/Work');
        expect(harness.exclusions.excludedFiles).toEqual(['Notes/Work/']);
      });

      it('leaves out the vault root', () => {
        const harness = buildHarness();
        openDialog(harness);
        const notes = new TFolder('Notes');
        harness.app.vault.getAllFolders = vi.fn(() => [notes]);

        const suggest = folderSuggests[0] as FolderSuggest;
        const suggestions = FolderSuggest.prototype.getSuggestions.call(
          suggest,
          ''
        );

        expect(harness.app.vault.getAllFolders).toHaveBeenCalledWith(false);
        expect(suggestions).toEqual([notes]);
      });
    });
  });

  describe('"Edit exclusion" dialog', () => {
    it('opens titled "Edit exclusion" with the entry prefilled', () => {
      const { modal, inputEl } = openEditDialog(
        buildHarness(['Notes/', '/draft-/']),
        1
      );

      expect(modal.setTitle).toHaveBeenCalledWith(
        'modals.addExcludedFile.editTitle'
      );
      expect(inputEl.value).toBe('/draft-/');
    });

    it('replaces the entry in place on Done, then closes and re-renders', async () => {
      const harness = buildHarness(['Notes/', '/draft-/', 'Archive/']);
      const { modal, inputEl, doneButton } = openEditDialog(harness, 1);

      inputEl.value = '/daily-.*/';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedFiles).toEqual([
        'Notes/',
        '/daily-.*/',
        'Archive/',
      ]);
      expect(harness.saveSettings).toHaveBeenCalledTimes(1);
      expect(modal.close).toHaveBeenCalledTimes(1);
      expect(harness.update).toHaveBeenCalledTimes(1);
    });

    it('keeps a change of case alone, which is not a duplicate of itself', async () => {
      const harness = buildHarness(['Notes/', 'Archive/']);
      const { inputEl, doneButton } = openEditDialog(harness, 0);

      inputEl.value = 'notes/';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedFiles).toEqual(['notes/', 'Archive/']);
    });

    it('drops an edit that duplicates another entry and keeps the original', async () => {
      const harness = buildHarness(['Notes/', 'Archive/']);
      const { modal, inputEl, doneButton } = openEditDialog(harness, 1);

      inputEl.value = 'notes/';
      doneButton.click();
      await flush();

      expect(harness.exclusions.excludedFiles).toEqual(['Notes/', 'Archive/']);
      expect(harness.saveSettings).not.toHaveBeenCalled();
      expect(modal.close).toHaveBeenCalled();
    });

    it('leaves the entry as it was on Cancel', async () => {
      const harness = buildHarness(['Notes/']);
      const { modal, inputEl, cancelButton } = openEditDialog(harness, 0);

      inputEl.value = 'Archive/';
      cancelButton.click();
      await flush();

      expect(modal.close).toHaveBeenCalled();
      expect(harness.exclusions.excludedFiles).toEqual(['Notes/']);
      expect(harness.saveSettings).not.toHaveBeenCalled();
    });

    it('attaches folder suggestions only once the entry is typed into', () => {
      const { inputEl } = openEditDialog(buildHarness(['Notes/']), 0);
      expect(folderSuggests).toHaveLength(0);

      inputEl.value = 'Notes/W';
      inputEl.dispatchEvent(new window.Event('input'));
      inputEl.dispatchEvent(new window.Event('input'));

      expect(folderSuggests).toHaveLength(1);
    });
  });

  describe('initial focus', () => {
    it('leaves focus alone on desktop, where Obsidian focuses the dialog itself', () => {
      const { inputEl } = openDialog(buildHarness());

      expect(document.activeElement).not.toBe(inputEl);
    });

    describe('on mobile', () => {
      beforeEach(() => {
        Platform.isMobile = true;
      });

      afterEach(() => {
        Platform.isMobile = false;
      });

      it('focuses the field as the "Add exclusion" dialog opens, inside the opening tap', () => {
        const { inputEl } = openDialog(buildHarness());

        expect(document.activeElement).toBe(inputEl);
      });

      it('focuses the field as the "Edit exclusion" dialog opens, with the cursor after the prefilled entry', () => {
        const { inputEl } = openEditDialog(buildHarness(['Notes/Work/']), 0);

        expect(document.activeElement).toBe(inputEl);
        expect(inputEl.selectionStart).toBe('Notes/Work/'.length);
        expect(inputEl.selectionEnd).toBe('Notes/Work/'.length);
      });
    });
  });
});
