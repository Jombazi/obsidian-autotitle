import { Modal } from 'obsidian';

/** Marks a dialog's container as FLIT's, so `styles.css` reaches its backdrop without touching other dialogs; returns the modal so it can open a builder chain. */
export function addFlitModalClass<T extends Modal>(modal: T): T {
  modal.containerEl.addClass('flit-modal');
  return modal;
}
