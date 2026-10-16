import {
  ButtonComponent,
  ConfirmationModal,
  Modal,
  Platform,
  setIcon,
} from 'obsidian';
import { t } from '../i18n';

export interface FormSheetActionsOptions {
  /** Label of the bottom row's submit button; phones show a check mark in the header instead. */
  submitText: string;
  /** Runs on either submit button and on Enter in `submitOnEnterEls`; a truthy return keeps a `ConfirmationModal` open after its bottom button, the `ConfirmationButton` contract. */
  submit: () => unknown;
  /** Text fields in which Enter submits. */
  submitOnEnterEls: HTMLInputElement[];
  /** Focused as the dialog opens on mobile, with the cursor after any prefilled text; on desktop, Modal.open() focuses the dialog's first focusable element itself. */
  mobileFocusEl?: HTMLInputElement;
}

export interface FormSheetActions {
  /** Marks whichever submit button the platform shows as disabled, as Obsidian's own form sheets do. */
  setSubmitDisabled(disabled: boolean): void;
}

/**
 * Gives a dialog the actions of Obsidian's own form sheets (measured in Obsidian 1.14.4): a close and a submit button in the header on phones, a submit and a Cancel button at the bottom elsewhere, and Enter submitting from its text fields.
 * Call it from `onOpen` once the fields exist, since the mobile focus must run inside the opening tap.
 */
export function addFormSheetActions(
  modal: Modal,
  options: FormSheetActionsOptions
): FormSheetActions {
  const { submit, submitOnEnterEls, mobileFocusEl } = options;
  const setHeaderSubmitDisabled = Platform.isPhone
    ? addHeaderButtons(modal, submit)
    : null;
  const setSubmitDisabled =
    setHeaderSubmitDisabled ?? addBottomButtons(modal, options);

  for (const inputEl of submitOnEnterEls) {
    inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
      // An Enter that confirms an IME composition (e.g., CJK input) belongs to the input method, not to the dialog
      if (event.isComposing || event.key !== 'Enter') return;
      event.preventDefault();
      submit();
    });
  }

  if (mobileFocusEl && Platform.isMobile) {
    // Synchronous because the dialog usually opens from a tap, and only a focus inside that tap's handling lets the on-screen keyboard come up
    mobileFocusEl.focus({ preventScroll: true });
    const endOfText = mobileFocusEl.value.length;
    mobileFocusEl.setSelectionRange(endOfText, endOfText);
  }

  return { setSubmitDisabled };
}

/** Puts the close and submit buttons into the header; returns null when the header cannot be found, so the bottom buttons stand in. */
function addHeaderButtons(
  modal: Modal,
  submit: () => unknown
): ((disabled: boolean) => void) | null {
  // `headerEl` is not public API, so the header is reached through the title it holds
  const headerEl = modal.titleEl.parentElement;
  if (!(headerEl instanceof HTMLElement)) return null;

  // Lets `styles.css` show the buttons and keep the title clear of them, which Obsidian's confirmation-sheet rules would otherwise undo
  modal.modalEl.addClass('flit-header-actions');
  if (modal instanceof ConfirmationModal) {
    // ConfirmationModal builds the row in its constructor; left empty, it would still leave a margin under the fields
    modal.buttonContainerEl.remove();
  }
  const closeEl = headerEl.createDiv(
    'modal-header-button mod-raised clickable-icon mod-start'
  );
  setIcon(closeEl, 'x');
  closeEl.addEventListener('click', () => {
    modal.close();
  });
  const submitEl = headerEl.createDiv(
    'modal-header-button mod-raised clickable-icon mod-cta'
  );
  setIcon(submitEl, 'lucide-check');
  submitEl.addEventListener('click', () => {
    submit();
  });
  return (disabled) => {
    // Obsidian's own form sheets mark a disabled header button with `is-disabled` alone; `aria-disabled` tells assistive tech too
    submitEl.toggleClass('is-disabled', disabled);
    submitEl.setAttribute('aria-disabled', String(disabled));
  };
}

/** Adds the submit and Cancel buttons at the bottom of the dialog. */
function addBottomButtons(
  modal: Modal,
  { submitText, submit }: FormSheetActionsOptions
): (disabled: boolean) => void {
  if (modal instanceof ConfirmationModal) {
    let submitButton: ButtonComponent | undefined;
    modal.addButton((btn) => {
      submitButton = btn.setCta().setButtonText(submitText).onClick(submit);
    });
    // Obsidian's own Cancel, labeled in Obsidian's language
    modal.addCancelButton();
    return (disabled) => {
      submitButton?.setDisabled(disabled);
    };
  }

  // Built as Obsidian's own form sheet builds its row: a plain `Modal` has none, and its Cancel carries no `mod-cancel`
  const buttonContainerEl = modal.modalEl.createDiv('modal-button-container');
  const submitButton = new ButtonComponent(buttonContainerEl)
    .setCta()
    .setButtonText(submitText)
    .onClick(() => {
      submit();
    });
  new ButtonComponent(buttonContainerEl)
    .setButtonText(t('modals.buttons.cancel'))
    .onClick(() => {
      modal.close();
    });
  return (disabled) => {
    submitButton.setDisabled(disabled);
  };
}
