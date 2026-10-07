import {
  App,
  ButtonComponent,
  Modal,
  Platform,
  TextComponent,
  displayTooltip,
} from 'obsidian';
import { t } from '../i18n';
import { FolderSuggest } from '../suggests';
import { addFlitModalClass } from './flit-modal-class';
import { addFormSheetHeaderButtons } from './form-sheet-header';

interface AddExcludedFileModalOptions {
  /** Opens the dialog in edit mode, prefilled with this entry. */
  entryToEdit?: string;
  /** Records a trimmed, non-empty entry and resolves once it is persisted. */
  submitEntry: (entry: string) => Promise<void>;
  /** Runs once the dialog has closed. */
  onSubmitted: () => void;
}

/**
 * Replicates the "Add exclusion" dialog of Obsidian's own Excluded files setting
 * (measured in Obsidian 1.14.4), so FLIT's list of the same syntax is edited the same way.
 */
export class AddExcludedFileModal extends Modal {
  private readonly options: AddExcludedFileModalOptions;

  constructor(app: App, options: AddExcludedFileModalOptions) {
    super(app);
    addFlitModalClass(this);
    this.options = options;
  }

  onOpen(): void {
    const { entryToEdit } = this.options;
    this.modalEl.addClass('mod-lg', 'mod-form-sheet');
    this.setTitle(
      entryToEdit === undefined
        ? t('modals.addExcludedFile.title')
        : t('modals.addExcludedFile.editTitle')
    );

    const fieldEl = this.contentEl.createEl('p', { cls: 'form-field' });
    fieldEl.createEl('label');
    const text = new TextComponent(fieldEl);
    const inputEl = text.inputEl;
    inputEl.spellcheck = false;
    if (entryToEdit !== undefined) text.setValue(entryToEdit);
    fieldEl.createDiv({
      cls: 'form-field-help',
      text: t('modals.addExcludedFile.help'),
    });

    inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.isComposing || event.key !== 'Enter') return;
      event.preventDefault();
      void this.submit(inputEl, inputEl.value);
    });

    const attachFolderSuggest = () =>
      new FolderSuggest(this.app, inputEl, (folderPath) => {
        // FolderSuggest overwrites the input with the slash-less path after this callback, so the entry comes from the argument
        const entry = `${folderPath}/`;
        inputEl.value = entry;
        void this.submit(inputEl, entry);
      });
    if (entryToEdit === undefined) {
      attachFolderSuggest();
    } else {
      // The suggester opens on focus and preselects its first folder, so on a prefilled entry Enter would swap it for a subfolder until the user types
      inputEl.addEventListener(
        'input',
        () => {
          attachFolderSuggest();
          // A listener added during dispatch misses that event, so the suggester would first open on the next keystroke; re-running the other `input` listeners is harmless because the field has none
          inputEl.trigger('input');
        },
        { once: true }
      );
    }

    const headerSubmitEl = Platform.isPhone
      ? addFormSheetHeaderButtons(this, () => {
          void this.submit(inputEl, inputEl.value);
        })
      : null;
    if (headerSubmitEl === null) {
      const buttonContainerEl = this.modalEl.createDiv(
        'modal-button-container'
      );
      new ButtonComponent(buttonContainerEl)
        .setCta()
        .setButtonText(t('modals.buttons.done'))
        .onClick(() => {
          void this.submit(inputEl, inputEl.value);
        });
      new ButtonComponent(buttonContainerEl)
        .setButtonText(t('modals.buttons.cancel'))
        .onClick(() => {
          this.close();
        });
    }

    if (Platform.isMobile) {
      // Synchronous because the dialog usually opens from a tap, and only a focus inside that tap's handling lets the on-screen keyboard come up
      inputEl.focus({ preventScroll: true });
      if (entryToEdit !== undefined) {
        const endOfEntry = inputEl.value.length;
        inputEl.setSelectionRange(endOfEntry, endOfEntry);
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(
    inputEl: HTMLInputElement,
    value: string
  ): Promise<void> {
    const entry = value.trim();
    if (entry === '') {
      displayTooltip(inputEl, t('modals.addExcludedFile.emptyFilter'), {
        classes: ['mod-error'],
      });
      return;
    }
    await this.options.submitEntry(entry);
    this.close();
    this.options.onSubmitted();
  }
}
