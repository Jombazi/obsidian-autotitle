import { Modal } from 'obsidian';

/** Lets the dialog hand focus back to its opener on close only when the opener holds keyboard focus; call in the constructor, before `open()` moves focus into the dialog. */
export function restoreFocusOnlyIfOpenedByKeyboard(modal: Modal): void {
  // A tap- or click-opened dialog handing focus back to the row's Edit button makes the settings re-render focus the row's first button, which iOS draws with a focus ring; keyboard users keep their place
  modal.shouldRestoreSelection =
    activeDocument.activeElement?.matches(':focus-visible') ?? false;
}
