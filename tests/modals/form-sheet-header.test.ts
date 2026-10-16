/**
 * Tests for the form-sheet actions the three form dialogs share, for the
 * branches their own suites do not reach: a header that cannot be found, and
 * the disabled state of a plain dialog's bottom submit button.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App, ConfirmationModal, Modal, Platform } from '../mockObsidian';
import { addFormSheetActions } from '../../src/modals/form-sheet-header';

// The mock dialogs stand in for Obsidian's, whose types they do not fully implement, hence `as never` below
vi.mock('../../src/i18n', () => ({
  t: vi.fn((key: string) => key),
}));

/** The labels of the bottom row's buttons, in order. */
function bottomButtonLabels(modal: Modal): string[] {
  return Array.from(
    modal.modalEl.querySelectorAll('.modal-button-container button'),
    (button) => button.textContent ?? ''
  );
}

describe('addFormSheetActions', () => {
  describe('on phones, when the header cannot be found', () => {
    beforeEach(() => {
      Platform.isPhone = true;
    });

    afterEach(() => {
      Platform.isPhone = false;
    });

    it('keeps the submit and Cancel buttons at the bottom of a plain dialog', () => {
      const modal = new Modal(new App());

      addFormSheetActions(modal as never, {
        submitText: 'Done',
        submit: vi.fn(),
        submitOnEnterEls: [],
      });

      expect(bottomButtonLabels(modal)).toEqual([
        'Done',
        'modals.buttons.cancel',
      ]);
      expect(modal.modalEl.classList.contains('flit-header-actions')).toBe(
        false
      );
    });

    it("keeps a confirmation dialog's button row, with Obsidian's own Cancel", () => {
      const modal = new ConfirmationModal(new App());

      addFormSheetActions(modal as never, {
        submitText: 'Save',
        submit: vi.fn(),
        submitOnEnterEls: [],
      });

      expect(modal.modalEl.contains(modal.buttonContainerEl)).toBe(true);
      // Obsidian's own Cancel label, which the mock stands in for with "Cancel"
      expect(bottomButtonLabels(modal)).toEqual(['Save', 'Cancel']);
    });
  });

  it("disables a plain dialog's bottom submit button", () => {
    const modal = new Modal(new App());

    const { setSubmitDisabled } = addFormSheetActions(modal as never, {
      submitText: 'Done',
      submit: vi.fn(),
      submitOnEnterEls: [],
    });
    const submitButton = modal.modalEl.querySelector('button');

    setSubmitDisabled(true);
    expect(submitButton?.disabled).toBe(true);
    setSubmitDisabled(false);
    expect(submitButton?.disabled).toBe(false);
  });
});
