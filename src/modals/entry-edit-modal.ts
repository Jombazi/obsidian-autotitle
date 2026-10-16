import {
  App,
  ConfirmationModal,
  Setting,
  TextComponent,
  ToggleComponent,
  displayTooltip,
} from 'obsidian';
import { t } from '../i18n';
import {
  addForbiddenCharProtection,
  addRestoreDefaultButton,
} from '../settings/settings-base';
import { addFlitModalClass } from './flit-modal-class';
import { restoreFocusOnlyIfOpenedByKeyboard } from './focus-restore';
import { FormSheetActions, addFormSheetActions } from './form-sheet-header';

export type EntryFieldValue = string | boolean;

/** Writes another field's value, both in the values Save hands over and on screen. */
export type SetOtherEntryField<K extends string> = (
  key: K,
  value: EntryFieldValue
) => void;

interface EntryFieldBase<K extends string> {
  key: K;
  name: string;
  desc?: string | DocumentFragment;
}

export interface EntryTextField<
  K extends string = string,
> extends EntryFieldBase<K> {
  type: 'text';
  placeholder?: string;
  /** Adds a restore button that writes this value, dimmed while the field already holds it. */
  restoreDefault?: string;
  /** Strips both forbidden character sets as they are typed, on every OS: the engine's policy for titles. Left off a search text, which can match characters a rule sees before forbidden characters are processed. */
  stripForbiddenChars?: true;
  /** Save stays disabled while this field is empty. */
  required?: boolean;
  onChange?: (value: string, setOther: SetOtherEntryField<K>) => void;
}

export interface EntryToggleField<
  K extends string = string,
> extends EntryFieldBase<K> {
  type: 'toggle';
  onChange?: (value: boolean, setOther: SetOtherEntryField<K>) => void;
}

export type EntryField<K extends string = string> =
  EntryTextField<K> | EntryToggleField<K>;

export interface EntryEditModalOptions<
  V extends Record<string, EntryFieldValue>,
> {
  title: string;
  fields: EntryField<Extract<keyof V, string>>[];
  /** Prefills the fields; a key with no field reaches `onSave` unchanged. */
  initialValues: V;
  /** Runs on Save before `onSave`; a message keeps the dialog open and shows as an error tooltip on the first text field. */
  findError?: (values: V) => string | null;
  /** Runs on Save, or the header's submit button on phones, with every value; Cancel and closing the dialog never call it. */
  onSave: (values: V) => Promise<void>;
  /** On mobile, focuses the first text field as the dialog opens, raising the on-screen keyboard. */
  focusFirstTextFieldOnMobile?: boolean;
}

/** The add and edit dialog behind FLIT's summary-row lists, shaped like the one Obsidian 1.14.4's own Maps settings open: one row per field, then Save and Cancel, which phones swap for a close and a submit button in the header as Obsidian's own form sheets do. */
export class EntryEditModal<
  V extends Record<string, EntryFieldValue>,
> extends ConfirmationModal {
  private readonly options: EntryEditModalOptions<V>;
  private values: Record<string, EntryFieldValue> = {};
  private readonly fieldSetters = new Map<
    string,
    (value: EntryFieldValue) => void
  >();
  /** Disables Save, or on phones the header's submit button that replaces Save and Cancel; set as the dialog opens. */
  private formSheetActions: FormSheetActions | null = null;
  private hasSaved = false;
  /** Where a `findError` message shows; set as the dialog opens. */
  private firstTextInputEl: HTMLInputElement | null = null;

  constructor(app: App, options: EntryEditModalOptions<V>) {
    super(app);
    addFlitModalClass(this);
    restoreFocusOnlyIfOpenedByKeyboard(this);
    this.options = options;
  }

  onOpen(): void {
    this.setTitle(this.options.title);
    this.values = { ...this.options.initialValues };
    this.fieldSetters.clear();
    this.hasSaved = false;

    const textInputEls: HTMLInputElement[] = [];
    for (const field of this.options.fields) {
      const setting = new Setting(this.contentEl).setName(field.name);
      if (field.desc !== undefined) setting.setDesc(field.desc);
      if (field.type === 'text') {
        textInputEls.push(this.buildTextField(setting, field));
      } else {
        this.buildToggleField(setting, field);
      }
    }

    const firstTextInputEl = textInputEls[0];
    this.firstTextInputEl = firstTextInputEl ?? null;
    this.formSheetActions = addFormSheetActions(this, {
      submitText: t('modals.buttons.save'),
      submit: () => this.save(),
      submitOnEnterEls: textInputEls,
      mobileFocusEl: this.options.focusFirstTextFieldOnMobile
        ? firstTextInputEl
        : undefined,
    });
    this.syncSaveButton();

    if (firstTextInputEl) {
      // Deferred because Modal.open() focuses the first focusable element (in the character dialog, a toggle where Enter flips the switch) after onOpen; only when focus already landed inside, which Obsidian does only with a physical keyboard, so no on-screen keyboard pops; on the dialog's own window, because a hidden main window throttles its timers
      this.modalEl.win.setTimeout(() => {
        if (this.modalEl.contains(this.modalEl.doc.activeElement)) {
          firstTextInputEl.focus({ preventScroll: true });
        }
      }, 0);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private buildTextField(
    setting: Setting,
    field: EntryTextField<Extract<keyof V, string>>
  ): HTMLInputElement {
    const { restoreDefault } = field;
    // Before the input, so the button sits to its left
    const setRestoreDimmed =
      restoreDefault === undefined
        ? null
        : addRestoreDefaultButton(setting.controlEl, () => {
            text.setValue(restoreDefault);
            applyValue(restoreDefault);
            field.onChange?.(restoreDefault, this.setOtherField);
          });
    const text = new TextComponent(setting.controlEl);
    if (field.placeholder !== undefined) text.setPlaceholder(field.placeholder);
    text.setValue(String(this.values[field.key] ?? ''));

    const syncRestoreButton = () => {
      setRestoreDimmed?.(this.values[field.key] === restoreDefault);
    };
    const applyValue = (value: string) => {
      this.values[field.key] = value;
      syncRestoreButton();
      this.syncSaveButton();
    };

    text.onChange((value) => {
      applyValue(value);
      field.onChange?.(value, this.setOtherField);
    });
    this.fieldSetters.set(field.key, (value) => {
      text.setValue(String(value));
      applyValue(String(value));
    });
    syncRestoreButton();

    if (field.stripForbiddenChars) {
      addForbiddenCharProtection(text.inputEl);
    }
    return text.inputEl;
  }

  private buildToggleField(
    setting: Setting,
    field: EntryToggleField<Extract<keyof V, string>>
  ): void {
    // `Setting.addToggle` adds this class and direct construction does not; without it Obsidian's phone layout drops the switch onto a line of its own
    setting.setClass('mod-toggle');
    const toggle = new ToggleComponent(setting.controlEl);
    toggle.setValue(this.values[field.key] === true);
    toggle.onChange((value) => {
      this.values[field.key] = value;
      field.onChange?.(value, this.setOtherField);
    });
    this.fieldSetters.set(field.key, (value) => {
      this.values[field.key] = value === true;
      toggle.setValue(value === true);
    });
  }

  private readonly setOtherField = (
    key: Extract<keyof V, string>,
    value: EntryFieldValue
  ): void => {
    this.fieldSetters.get(key)?.(value);
  };

  private canSave(): boolean {
    return this.options.fields.every(
      (field) =>
        field.type !== 'text' ||
        !field.required ||
        this.values[field.key] !== ''
    );
  }

  private syncSaveButton(): void {
    this.formSheetActions?.setSubmitDisabled(!this.canSave());
  }

  /** Returns true to keep the dialog open, the ConfirmationButton contract, when a required field is empty or `findError` reports a message. */
  private save(): true | undefined {
    if (!this.canSave()) return true;
    // A second Enter while the dialog animates closed would otherwise save the entry twice
    if (this.hasSaved) return;
    const values = { ...this.values } as V;
    // After the `hasSaved` guard: on Add, `onSave` records the entry at once, so a second Enter while the dialog animates closed would find it and show the error on a closing dialog
    const error = this.options.findError?.(values) ?? null;
    if (error !== null) {
      if (this.firstTextInputEl) {
        displayTooltip(this.firstTextInputEl, error, {
          classes: ['mod-error'],
        });
      }
      return true;
    }
    this.hasSaved = true;
    void this.options.onSave(values);
    this.close();
  }
}
