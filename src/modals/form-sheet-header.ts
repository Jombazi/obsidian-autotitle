import { Modal, setIcon } from 'obsidian';

/**
 * Puts the close and submit buttons Obsidian's own form sheets show on phones (measured in Obsidian 1.14.4) into a dialog's header, in place of a bottom button row.
 * Returns the submit button, or null when the header cannot be found and the caller should keep its bottom buttons.
 */
export function addFormSheetHeaderButtons(
  modal: Modal,
  onSubmit: () => void
): HTMLElement | null {
  // `headerEl` is not public API, so the header is reached through the title it holds
  const headerEl = modal.titleEl.parentElement;
  if (!(headerEl instanceof HTMLElement)) return null;

  // Lets `styles.css` show the buttons and keep the title clear of them, which Obsidian's confirmation-sheet rules would otherwise undo
  modal.modalEl.addClass('flit-header-actions');
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
    onSubmit();
  });
  return submitEl;
}
