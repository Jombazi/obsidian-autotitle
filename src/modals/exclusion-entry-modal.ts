import { App, Modal, TextComponent, displayTooltip } from 'obsidian';
import { t } from '../i18n';
import { addFlitModalClass } from './flit-modal-class';
import { addFormSheetActions } from './form-sheet-header';

export interface ExclusionEntryField {
  /** Empty for a one-field dialog, as Obsidian's own "Add exclusion" names no field. */
  label: string;
  /** Omitted for a field the label explains on its own; no help line is drawn then. */
  help?: string;
  initialValue?: string;
  /** Attaches a suggester whose pick submits the dialog with the picked text in this field. */
  attachSuggest?: (
    inputEl: HTMLInputElement,
    submitPick: (value: string) => void
  ) => void;
}

interface ExclusionEntryModalOptions {
  title: string;
  fields: ExclusionEntryField[];
  /** Records the trimmed values, in field order, and resolves null once persisted, or resolves the error to show on the first field, recording nothing. */
  submitEntry: (values: string[]) => Promise<string | null>;
  /** Runs once the dialog has closed on a submit. */
  onSubmitted: () => void;
}

/**
 * Replicates the "Add exclusion" dialog of Obsidian's own Excluded files setting
 * (measured in Obsidian 1.14.4), so FLIT's list of the same syntax is edited the same way.
 * The tag and property lists open the same dialog, so every list on the page edits alike.
 * A plain `Modal`, as Obsidian's own form sheet is: a `ConfirmationModal` Cancel carries `mod-cancel`, which tablets move below Done, and the API offers no localized Done to pair with Obsidian's localized Cancel, so both labels come from FLIT's locale.
 */
export class ExclusionEntryModal extends Modal {
  private readonly options: ExclusionEntryModalOptions;
  /** Where an error shows; set as the dialog opens. */
  private firstInputEl: HTMLInputElement | null = null;
  private isSubmitting = false;

  constructor(app: App, options: ExclusionEntryModalOptions) {
    super(app);
    addFlitModalClass(this);
    this.options = options;
  }

  onOpen(): void {
    const { title, fields } = this.options;
    this.modalEl.addClass('mod-lg', 'mod-form-sheet');
    this.setTitle(title);
    this.isSubmitting = false;

    const inputEls: HTMLInputElement[] = [];
    const readValues = () => inputEls.map((inputEl) => inputEl.value);
    fields.forEach((field, index) => {
      inputEls.push(
        this.buildField(field, (value) => {
          // The pick runs before the suggester writes it into the field, so it is put in place here
          const values = readValues();
          values[index] = value;
          void this.submit(values);
        })
      );
    });
    this.firstInputEl = inputEls[0] ?? null;

    addFormSheetActions(this, {
      submitText: t('modals.buttons.done'),
      submit: () => {
        void this.submit(readValues());
      },
      submitOnEnterEls: inputEls,
      mobileFocusEl: inputEls[0],
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** Builds one labeled field with its help line and suggester, each if any; returns its input. */
  private buildField(
    field: ExclusionEntryField,
    submitPick: (value: string) => void
  ): HTMLInputElement {
    const fieldEl = this.contentEl.createEl('p', { cls: 'form-field' });
    // Obsidian's form field always opens with a label, left empty in its own "Add exclusion" dialog, which names no field
    fieldEl.createEl('label', { text: field.label });
    const text = new TextComponent(fieldEl);
    const inputEl = text.inputEl;
    inputEl.spellcheck = false;
    const initialValue = field.initialValue ?? '';
    text.setValue(initialValue);
    if (field.help !== undefined) {
      fieldEl.createDiv({ cls: 'form-field-help', text: field.help });
    }

    const { attachSuggest } = field;
    if (!attachSuggest) return inputEl;
    if (initialValue === '') {
      attachSuggest(inputEl, submitPick);
    } else {
      // The suggester opens on focus and preselects its first item, so on a prefilled field Enter would swap the entry for that item until the user types
      inputEl.addEventListener(
        'input',
        () => {
          attachSuggest(inputEl, submitPick);
          // A listener added during dispatch misses that event, so the suggester would first open on the next keystroke; re-running the other `input` listeners is harmless because the field has none
          inputEl.trigger('input');
        },
        { once: true }
      );
    }
    return inputEl;
  }

  private async submit(values: string[]): Promise<void> {
    // A second Enter while the save is pending, or while the dialog animates closed, would otherwise find the entry just recorded and report it as a duplicate
    if (this.isSubmitting) return;
    this.isSubmitting = true;
    const error = await this.options.submitEntry(
      values.map((value) => value.trim())
    );
    if (error !== null) {
      this.isSubmitting = false;
      if (this.firstInputEl) {
        displayTooltip(this.firstInputEl, error, { classes: ['mod-error'] });
      }
      return;
    }
    this.close();
    this.options.onSubmitted();
  }
}
