import {
  App,
  ButtonComponent,
  ConfirmationModal,
  ExtraButtonComponent,
  Platform,
  Setting,
  TextComponent,
  ToggleComponent,
} from 'obsidian';
import { t } from '../i18n';
import { addForbiddenCharProtection } from '../settings/settings-base';
import { addFlitModalClass } from './flit-modal-class';
import { addFormSheetHeaderButtons } from './form-sheet-header';

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
  /** Strips characters a file name cannot hold as they are typed; `windowsAndroid` forbids that platform's set on every OS. */
  forbiddenChars?: 'currentOS' | 'windowsAndroid';
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
  private saveButton: ButtonComponent | null = null;
  /** The header's submit button, which replaces Save and Cancel on phones. */
  private headerSaveEl: HTMLElement | null = null;
  private hasSaved = false;

  constructor(app: App, options: EntryEditModalOptions<V>) {
    super(app);
    addFlitModalClass(this);
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

    this.headerSaveEl = Platform.isPhone
      ? addFormSheetHeaderButtons(this, () => {
          this.save();
        })
      : null;
    if (this.headerSaveEl === null) {
      this.addButton((btn) => {
        this.saveButton = btn
          .setCta()
          .setButtonText(t('modals.buttons.save'))
          .onClick(() => this.save());
      });
      this.addCancelButton(t('modals.buttons.cancel'));
    } else {
      // ConfirmationModal builds the row in its constructor; left empty, it would still leave a margin under the fields
      this.buttonContainerEl.remove();
    }
    this.syncSaveButton();

    const firstTextInputEl = textInputEls[0];
    if (
      firstTextInputEl &&
      this.options.focusFirstTextFieldOnMobile &&
      Platform.isMobile
    ) {
      // Synchronous because the dialog usually opens from a tap, and only a focus inside that tap's handling lets the on-screen keyboard come up
      firstTextInputEl.focus({ preventScroll: true });
    }
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
    // Created before the input so it sits to the input's left, as FLIT's other restore buttons do
    const restoreButton =
      field.restoreDefault === undefined
        ? null
        : new ExtraButtonComponent(setting.controlEl)
            .setIcon('rotate-ccw')
            .setTooltip(t('settings.common.restoreDefault'));
    const text = new TextComponent(setting.controlEl);
    if (field.placeholder !== undefined) text.setPlaceholder(field.placeholder);
    text.setValue(String(this.values[field.key] ?? ''));

    // Mirrors Obsidian's own restore controls: `aria-disabled` dims the button while the value is already the default, and it stays clickable because restoring then changes nothing
    const syncRestoreButton = () => {
      restoreButton?.extraSettingsEl.setAttribute(
        'aria-disabled',
        String(this.values[field.key] === field.restoreDefault)
      );
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
    restoreButton?.onClick(() => {
      const defaultValue = field.restoreDefault ?? '';
      text.setValue(defaultValue);
      applyValue(defaultValue);
      field.onChange?.(defaultValue, this.setOtherField);
    });
    this.fieldSetters.set(field.key, (value) => {
      text.setValue(String(value));
      applyValue(String(value));
    });
    syncRestoreButton();

    if (field.forbiddenChars !== undefined) {
      addForbiddenCharProtection(
        text.inputEl,
        field.forbiddenChars === 'windowsAndroid'
      );
    }

    text.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.isComposing || event.key !== 'Enter') return;
      event.preventDefault();
      this.save();
    });
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
    const cannotSave = !this.canSave();
    this.saveButton?.setDisabled(cannotSave);
    // Obsidian's own form sheets mark a disabled header button with `is-disabled` alone; `aria-disabled` tells assistive tech too
    this.headerSaveEl?.toggleClass('is-disabled', cannotSave);
    this.headerSaveEl?.setAttribute('aria-disabled', String(cannotSave));
  }

  /** Returns true to keep the dialog open, the ConfirmationButton contract, when a required field is empty. */
  private save(): true | undefined {
    if (!this.canSave()) return true;
    // A second Enter while the dialog animates closed would otherwise save the entry twice
    if (this.hasSaved) return;
    this.hasSaved = true;
    void this.options.onSave({ ...this.values } as V);
    this.close();
  }
}
