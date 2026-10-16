/**
 * Tests for the shared add/edit dialog behind the custom and character
 * replacement lists. The base `Modal` mock declares `onOpen` as an instance
 * field, so each dialog is opened through the real prototype.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  App,
  ConfirmationModal,
  Platform,
  displayTooltip,
} from '../mockObsidian';
import {
  EntryEditModal,
  EntryEditModalOptions,
} from '../../src/modals/entry-edit-modal';
import { flush, pressEnter, typeInto } from '../testUtils';

type RuleValues = {
  searchText: string;
  replaceText: string;
  onlyAtStart: boolean;
  onlyWholeLine: boolean;
  untouched: string;
};

interface OpenedDialog {
  modal: EntryEditModal<RuleValues>;
  onSave: ReturnType<typeof vi.fn>;
  rows: HTMLElement[];
  inputs: HTMLInputElement[];
  toggles: HTMLElement[];
  saveButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  buttonContainer: HTMLElement | null;
  /** The close then submit button phones put in the header. */
  headerButtons: HTMLElement[];
}

function openDialog(
  overrides: Partial<EntryEditModalOptions<RuleValues>> = {},
  initialValues: Partial<RuleValues> = {}
): OpenedDialog {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const modal = new EntryEditModal<RuleValues>(new App(), {
    title: 'Edit replacement',
    initialValues: {
      searchText: 'TODO',
      replaceText: 'Done',
      onlyAtStart: true,
      onlyWholeLine: false,
      untouched: 'kept',
      ...initialValues,
    },
    fields: [
      {
        type: 'text',
        key: 'searchText',
        name: 'Text to replace',
        desc: 'Whitespace preserved.',
        required: true,
      },
      {
        type: 'text',
        key: 'replaceText',
        name: 'Replace with',
        placeholder: 'Empty',
        restoreDefault: '-',
        stripForbiddenChars: true,
      },
      {
        type: 'toggle',
        key: 'onlyAtStart',
        name: 'Only match line start',
        onChange: (value, setOther) => {
          if (value) setOther('onlyWholeLine', false);
        },
      },
      {
        type: 'toggle',
        key: 'onlyWholeLine',
        name: 'Only match whole line',
        onChange: (value, setOther) => {
          if (value) setOther('onlyAtStart', false);
        },
      },
    ],
    onSave,
    ...overrides,
  });
  // The mock leaves the title detached, while Obsidian nests it in the header that phones add their buttons to
  modal.modalEl.createDiv('modal-header').appendChild(modal.titleEl);
  // Connected, with the content inside the dialog, so focus can be observed
  document.body.appendChild(modal.modalEl);
  modal.modalEl.appendChild(modal.contentEl);
  EntryEditModal.prototype.onOpen.call(modal);

  const buttons = modal.modalEl.querySelectorAll<HTMLButtonElement>(
    '.modal-button-container button'
  );
  return {
    modal,
    onSave,
    rows: Array.from(modal.contentEl.querySelectorAll('.setting-item')),
    inputs: Array.from(modal.contentEl.querySelectorAll('input')),
    toggles: Array.from(
      modal.contentEl.querySelectorAll('.checkbox-container')
    ),
    saveButton: buttons[0],
    cancelButton: buttons[1],
    buttonContainer: modal.modalEl.querySelector('.modal-button-container'),
    headerButtons: Array.from(
      modal.modalEl.querySelectorAll<HTMLElement>(
        '.modal-header .modal-header-button'
      )
    ),
  };
}

describe('EntryEditModal', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  describe('layout', () => {
    it('is a confirmation dialog, which Obsidian opens as a bottom sheet on phones', () => {
      const { modal } = openDialog();

      expect(modal).toBeInstanceOf(ConfirmationModal);
    });

    it("carries FLIT's dialog class", () => {
      const { modal } = openDialog();

      expect(modal.containerEl.classList.contains('flit-modal')).toBe(true);
    });

    it('renders one row per field, with its name and description', () => {
      const { modal, rows } = openDialog();

      expect(modal.setTitle).toHaveBeenCalledWith('Edit replacement');
      expect(
        rows.map((row) => row.querySelector('.setting-item-name')?.textContent)
      ).toEqual([
        'Text to replace',
        'Replace with',
        'Only match line start',
        'Only match whole line',
      ]);
      expect(
        rows[0].querySelector('.setting-item-description')?.textContent
      ).toBe('Whitespace preserved.');
    });

    it('marks toggle rows mod-toggle and text rows not', () => {
      const { rows } = openDialog();

      expect(rows.map((row) => row.classList.contains('mod-toggle'))).toEqual([
        false,
        false,
        true,
        true,
      ]);
    });

    it('puts Save then Cancel on the dialog itself, Cancel marked for the mobile button order', () => {
      const { modal, saveButton, cancelButton, headerButtons } = openDialog();

      expect(headerButtons).toEqual([]);
      expect(saveButton.parentElement?.parentElement).toBe(modal.modalEl);
      expect(saveButton.textContent).toBe('Save');
      expect(saveButton.classList.contains('mod-cta')).toBe(true);
      expect(cancelButton.textContent).toBe('Cancel');
      expect(cancelButton.classList.contains('mod-cancel')).toBe(true);
    });

    it('prefills text fields and toggles from the initial values', () => {
      const { inputs, toggles } = openDialog();

      expect(inputs.map((input) => input.value)).toEqual(['TODO', 'Done']);
      expect(inputs[1].placeholder).toBe('Empty');
      expect(
        toggles.map((toggle) => toggle.classList.contains('is-enabled'))
      ).toEqual([true, false]);
    });
  });

  describe('saving', () => {
    it('saves every value on Save, keys without a field unchanged, then closes', () => {
      const { modal, onSave, inputs, toggles, saveButton } = openDialog();

      typeInto(inputs[0], ' x ');
      toggles[1].click();
      saveButton.click();

      expect(onSave).toHaveBeenCalledWith({
        searchText: ' x ',
        replaceText: 'Done',
        onlyAtStart: false,
        onlyWholeLine: true,
        untouched: 'kept',
      });
      expect(modal.close).toHaveBeenCalledTimes(1);
      expect(onSave.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(modal.close).mock.invocationCallOrder[0]
      );
    });

    it('saves on Enter in a text field', () => {
      const { onSave, inputs } = openDialog();

      pressEnter(inputs[1]);

      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('ignores Enter while an input method is composing', () => {
      const { onSave, inputs } = openDialog();

      pressEnter(inputs[0], true);

      expect(onSave).not.toHaveBeenCalled();
    });

    it('saves once when Enter repeats before the dialog is gone', () => {
      const { onSave, inputs } = openDialog();

      pressEnter(inputs[0]);
      pressEnter(inputs[0]);

      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('disables Save while a required field is empty, and Enter then does nothing', () => {
      const { onSave, inputs, saveButton } = openDialog({}, { searchText: '' });

      expect(saveButton.disabled).toBe(true);
      pressEnter(inputs[1]);
      expect(onSave).not.toHaveBeenCalled();

      typeInto(inputs[0], ' ');
      expect(saveButton.disabled).toBe(false);
    });

    it('neither saves nor closes when the disabled Save is clicked', async () => {
      const { modal, onSave, saveButton } = openDialog({}, { searchText: '' });

      saveButton.click();
      await flush();

      expect(onSave).not.toHaveBeenCalled();
      expect(modal.close).not.toHaveBeenCalled();
    });

    it('allows an optional field to be empty', () => {
      const { onSave, inputs, saveButton } = openDialog();

      typeInto(inputs[1], '');
      saveButton.click();

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ replaceText: '' })
      );
    });

    it('keeps the dialog open, saving nothing, and shows the message on the first text field when findError reports one', async () => {
      vi.mocked(displayTooltip).mockClear();
      const findError = vi.fn(() => 'Another rule already replaces this text');
      const { modal, onSave, inputs, saveButton } = openDialog({ findError });

      typeInto(inputs[1], 'x');
      saveButton.click();
      await flush();

      expect(findError).toHaveBeenCalledWith(
        expect.objectContaining({ searchText: 'TODO', replaceText: 'x' })
      );
      expect(displayTooltip).toHaveBeenCalledWith(
        inputs[0],
        'Another rule already replaces this text',
        { classes: ['mod-error'] }
      );
      expect(onSave).not.toHaveBeenCalled();
      expect(modal.close).not.toHaveBeenCalled();
    });

    it('saves once findError reports nothing', () => {
      const { modal, onSave, saveButton } = openDialog({
        findError: () => null,
      });

      saveButton.click();

      expect(onSave).toHaveBeenCalledTimes(1);
      expect(modal.close).toHaveBeenCalledTimes(1);
    });

    // On Add, the save records the entry at once, so the repeated Enter would find it
    it('shows no error for an Enter repeated after a save, though findError would now find the saved entry', () => {
      vi.mocked(displayTooltip).mockClear();
      const { onSave, inputs } = openDialog({
        findError: () =>
          onSave.mock.calls.length > 0 ? 'Already in the list' : null,
      });

      pressEnter(inputs[0]);
      pressEnter(inputs[0]);

      expect(onSave).toHaveBeenCalledTimes(1);
      expect(displayTooltip).not.toHaveBeenCalled();
    });

    it('discards edits on Cancel', async () => {
      const { modal, onSave, inputs, cancelButton } = openDialog();

      typeInto(inputs[0], 'changed');
      cancelButton.click();
      await flush();

      expect(onSave).not.toHaveBeenCalled();
      expect(modal.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('on phones', () => {
    beforeEach(() => {
      Platform.isPhone = true;
    });

    afterEach(() => {
      Platform.isPhone = false;
    });

    it('replaces the button row with a close button and a submit button in the header', () => {
      const { modal, buttonContainer, headerButtons } = openDialog();

      expect(buttonContainer).toBeNull();
      expect(modal.modalEl.querySelector('button')).toBeNull();
      expect(modal.modalEl.classList.contains('flit-header-actions')).toBe(
        true
      );
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

    it('saves every value on the submit button, then closes', () => {
      const { modal, onSave, inputs, headerButtons } = openDialog();

      typeInto(inputs[0], 'changed');
      headerButtons[1].click();

      expect(onSave).toHaveBeenCalledWith({
        searchText: 'changed',
        replaceText: 'Done',
        onlyAtStart: true,
        onlyWholeLine: false,
        untouched: 'kept',
      });
      expect(modal.close).toHaveBeenCalledTimes(1);
    });

    it('closes on the close button without saving', async () => {
      const { modal, onSave, inputs, headerButtons } = openDialog();

      typeInto(inputs[0], 'changed');
      headerButtons[0].click();
      await flush();

      expect(onSave).not.toHaveBeenCalled();
      expect(modal.close).toHaveBeenCalledTimes(1);
    });

    it('still saves on Enter in a text field', () => {
      const { onSave, inputs } = openDialog();

      pressEnter(inputs[1]);

      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('marks the submit button disabled while a required field is empty, ignores its click, and enables it once filled', async () => {
      const { modal, onSave, inputs, headerButtons } = openDialog(
        {},
        { searchText: '' }
      );
      const submitButton = headerButtons[1];

      expect(submitButton.classList.contains('is-disabled')).toBe(true);
      expect(submitButton.getAttribute('aria-disabled')).toBe('true');
      submitButton.click();
      await flush();
      expect(onSave).not.toHaveBeenCalled();
      expect(modal.close).not.toHaveBeenCalled();

      typeInto(inputs[0], ' ');
      expect(submitButton.classList.contains('is-disabled')).toBe(false);
      expect(submitButton.getAttribute('aria-disabled')).toBe('false');
      submitButton.click();
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ searchText: ' ' })
      );
      expect(modal.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('on tablets', () => {
    beforeEach(() => {
      Platform.isMobile = true;
      Platform.isTablet = true;
    });

    afterEach(() => {
      Platform.isMobile = false;
      Platform.isTablet = false;
    });

    it('keeps Save and Cancel at the bottom, with nothing in the header', () => {
      const { modal, saveButton, cancelButton, headerButtons } = openDialog();

      expect(saveButton.textContent).toBe('Save');
      expect(cancelButton.textContent).toBe('Cancel');
      expect(headerButtons).toEqual([]);
      expect(modal.modalEl.classList.contains('flit-header-actions')).toBe(
        false
      );
    });
  });

  describe('field behavior', () => {
    it("lets a field's onChange switch another field off", () => {
      const { onSave, toggles, saveButton } = openDialog();

      toggles[1].click();

      expect(toggles[0].classList.contains('is-enabled')).toBe(false);
      saveButton.click();
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ onlyAtStart: false, onlyWholeLine: true })
      );
    });

    it('places the restore button left of its input and dims it while the value is the default', () => {
      const { rows, inputs } = openDialog();
      const controlEl = rows[1].querySelector('.setting-item-control');
      const restoreButton = controlEl?.firstElementChild as HTMLElement;

      expect(restoreButton.getAttribute('data-icon')).toBe('rotate-ccw');
      expect(restoreButton.nextElementSibling).toBe(inputs[1]);
      expect(restoreButton.getAttribute('aria-disabled')).toBe('false');

      typeInto(inputs[1], '-');
      expect(restoreButton.getAttribute('aria-disabled')).toBe('true');
    });

    it('restores the default value, dims the button, and saves it', () => {
      const { onSave, rows, inputs, saveButton } = openDialog();
      const restoreButton = rows[1].querySelector(
        '.extra-setting-button'
      ) as HTMLElement;

      restoreButton.click();

      expect(inputs[1].value).toBe('-');
      expect(restoreButton.getAttribute('aria-disabled')).toBe('true');
      saveButton.click();
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ replaceText: '-' })
      );
    });

    it('strips forbidden characters as they are typed', () => {
      // The guard re-dispatches `input` through the global Event, which jsdom only delivers when it is jsdom's own
      vi.stubGlobal('Event', window.Event);
      const { onSave, inputs, saveButton } = openDialog();

      typeInto(inputs[1], 'a/b?c');
      saveButton.click();

      expect(inputs[1].value).toBe('abc');
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ replaceText: 'abc' })
      );
    });

    it('strips a dot only whitespace precedes, as a name refuses it', () => {
      vi.stubGlobal('Event', window.Event);
      const { inputs } = openDialog();

      typeInto(inputs[1], ' .a.b');

      expect(inputs[1].value).toBe(' a.b');
    });

    it('strips the Windows and Android set on macOS too, as the engine does', () => {
      vi.stubGlobal('Event', window.Event);
      Platform.isMacOS = true;
      try {
        const { inputs } = openDialog();

        typeInto(inputs[1], 'a*"<>?b');

        expect(inputs[1].value).toBe('ab');
      } finally {
        Platform.isMacOS = false;
      }
    });

    it('leaves a field without the option as typed', () => {
      // A search text can match characters a rule sees before forbidden characters are processed
      vi.stubGlobal('Event', window.Event);
      const { onSave, inputs, saveButton } = openDialog();

      typeInto(inputs[0], 'a/b?c');
      saveButton.click();

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ searchText: 'a/b?c' })
      );
    });
  });

  describe('initial focus', () => {
    it('moves focus to the first text field when Obsidian focused the dialog', async () => {
      const { inputs, saveButton } = openDialog();

      saveButton.focus();
      await flush();

      expect(document.activeElement).toBe(inputs[0]);
    });

    it('leaves focus alone when Obsidian focused nothing, so no on-screen keyboard opens', async () => {
      const { inputs } = openDialog();

      await flush();

      expect(document.activeElement).not.toBe(inputs[0]);
    });

    it('leaves focus alone on desktop even when asked to focus on mobile', async () => {
      const { inputs } = openDialog({ focusFirstTextFieldOnMobile: true });

      expect(document.activeElement).not.toBe(inputs[0]);
      await flush();
      expect(document.activeElement).not.toBe(inputs[0]);
    });

    describe('on mobile', () => {
      beforeEach(() => {
        Platform.isMobile = true;
      });

      afterEach(() => {
        Platform.isMobile = false;
      });

      it('focuses the first text field as the dialog opens, inside the opening tap, when asked to', () => {
        const { inputs } = openDialog({ focusFirstTextFieldOnMobile: true });

        expect(document.activeElement).toBe(inputs[0]);
      });

      it('leaves focus alone when not asked to, so no on-screen keyboard opens', async () => {
        const { inputs } = openDialog();

        expect(document.activeElement).not.toBe(inputs[0]);
        await flush();
        expect(document.activeElement).not.toBe(inputs[0]);
      });
    });
  });
});
