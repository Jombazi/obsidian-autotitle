/*
 * Adapted from Notebook Navigator (https://github.com/johansan/notebook-navigator)
 * Copyright (c) 2025-2026 Johan Sanneblad
 * Modified 2026 for First Line is Title.
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later version.
 */
// Import and export behavior and styles are ported from Notebook Navigator and aim to match it as closely as possible, so users of both plugins get the same familiar experience.

import {
  App,
  ButtonComponent,
  ConfirmationButton,
  ConfirmationModal,
  Platform,
  PluginSettingTab,
  Setting,
} from 'obsidian';
import { t } from '../i18n';
import { evaluateSettingsImport } from '../settings/import-guard';
import { FirstLineIsTitlePlugin, showNotice } from '../settings/settings-base';
import {
  applySettingsTransfer,
  createSettingsTransferFilename,
  createSettingsTransferJson,
  SettingsTransfer,
} from '../settings/transfer';
import { addFlitModalClass } from './flit-modal-class';

const JSON_MIME_TYPE = 'application/json';

/** Message for a notice, without leaking `[object Object]` from a non-Error throw. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // The message closes the notice ("Failed to copy settings: …"): a one-sentence notice ends without a period, so a one-sentence message drops its own, while a longer one keeps it
  return /[.!?]\s+\S/.test(message) ? message : message.replace(/\.$/, '');
}

/** The JSON editor both modals are built around. Monospace and resizable via the stylesheet; spellcheck off because every "word" in it is a settings key. */
function createTransferEditor(
  parent: HTMLElement,
  options: { value?: string; placeholder?: string }
): HTMLTextAreaElement {
  const editorEl = parent.createEl('textarea', {
    cls: 'flit-settings-transfer-editor',
  });
  editorEl.spellcheck = false;
  if (options.value !== undefined) editorEl.value = options.value;
  if (options.placeholder !== undefined) {
    editorEl.placeholder = options.placeholder;
  }
  return editorEl;
}

/** Shows the current settings as transfer JSON, to copy to the clipboard or save as a file. The JSON stays editable: Copy and the save button (Download on desktop, Save to vault on mobile) both read the textarea, so a user can trim the payload before taking it anywhere. */
export class SettingsExportModal extends ConfirmationModal {
  private readonly plugin: FirstLineIsTitlePlugin;

  constructor(app: App, plugin: FirstLineIsTitlePlugin) {
    super(app);
    addFlitModalClass(this);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass('flit-settings-transfer');
    this.setTitle(t('modals.settingsTransfer.export.title'));

    new Setting(contentEl)
      .setName(t('modals.settingsTransfer.export.editor.name'))
      .setDesc(t('modals.settingsTransfer.export.editor.desc'));

    const editorEl = createTransferEditor(contentEl, {
      value: createSettingsTransferJson(this.plugin.settings),
    });

    // Copy and the save button return true to keep the dialog open, so the payload can be taken both ways
    this.addButton((btn) =>
      btn
        .setButtonText(t('modals.settingsTransfer.export.copy'))
        .onClick(() => {
          void this.copyToClipboard(editorEl.value);
          return true;
        })
    );
    // Mobile saves to the vault root instead: Obsidian's Android app has no navigator.share and ignores a click on a blob download link (measured on 1.14.4), and Notebook Navigator treats iOS the same way
    if (Platform.isMobileApp) {
      this.addButton((btn) =>
        btn
          .setButtonText(t('modals.settingsTransfer.export.saveToVault'))
          .setCta()
          .onClick(() => {
            void this.saveToVault(editorEl.value);
            return true;
          })
      );
    } else {
      this.addButton((btn) =>
        btn
          .setButtonText(t('modals.settingsTransfer.export.download'))
          .setCta()
          .onClick(() => {
            this.downloadTransfer(editorEl.value);
            return true;
          })
      );
    }
    // Done in place of Obsidian's own Cancel label, the only dialog that relabels it: Copy and the save button keep the dialog open, so this closes it after either, and it is the only way to close the phone sheet, where Obsidian hides the ✕ of a confirmation dialog
    this.addCancelButton(t('modals.buttons.done'));

    // Deferred because Modal moves focus to the first focusable child after onOpen(); selecting the payload makes a manual copy a single keystroke. On the dialog's own window, which is the Settings window when Settings opens in a window of its own.
    this.modalEl.win.setTimeout(() => editorEl.select(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async copyToClipboard(contents: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(contents);
      showNotice(t('modals.settingsTransfer.export.copied'), 'success');
    } catch (error) {
      showNotice(
        t('modals.settingsTransfer.export.errors.copyFailed', {
          message: describeError(error),
        }),
        'warning'
      );
    }
  }

  /** Writes the payload to a new timestamped file at the vault root and names it in a notice; the mobile save path. */
  private async saveToVault(contents: string): Promise<void> {
    try {
      const path = await this.plugin.createSettingsFileAtVaultRoot(contents);
      showNotice(
        t('modals.settingsTransfer.export.saved', { path }),
        'success'
      );
    } catch (error) {
      showNotice(
        t('modals.settingsTransfer.export.errors.saveFailed', {
          message: describeError(error),
        }),
        'warning'
      );
    }
  }

  /** Saves the payload as a file through an object-URL download; desktop only, since mobile saves to the vault root instead (see `onOpen`). The anchor is created on `activeDocument`, never the bare `document` — with settings open in a popout window the two are different documents, and an anchor in the wrong one is what broke the old file picker. */
  private downloadTransfer(contents: string): void {
    const fileName = createSettingsTransferFilename(new Date());
    const url = URL.createObjectURL(
      new Blob([contents], { type: JSON_MIME_TYPE })
    );
    const anchorEl = activeDocument.body.createEl('a', {
      attr: { download: fileName, href: url },
    });
    anchorEl.click();
    anchorEl.remove();
    // Revoking synchronously can cancel the download the click just started.
    this.modalEl.win.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Fills a JSON editor from a file or a paste, then applies it over the defaults. The file input is created on the modal's own `contentEl` and attached, so the picker belongs to whichever window the settings are open in. */
export class SettingsImportModal extends ConfirmationModal {
  private readonly plugin: FirstLineIsTitlePlugin;
  private readonly tab: PluginSettingTab;

  private fileInputEl: HTMLInputElement;
  private editorEl: HTMLTextAreaElement;
  private chooseFileButton?: ButtonComponent;
  private importButton?: ConfirmationButton;

  constructor(app: App, plugin: FirstLineIsTitlePlugin, tab: PluginSettingTab) {
    super(app);
    addFlitModalClass(this);
    this.plugin = plugin;
    this.tab = tab;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass('flit-settings-transfer');
    this.setTitle(t('modals.settingsTransfer.import.title'));

    // Element-scoped and attached: the global `createEl` binds to the main window's document, so a detached input built there raises no picker from a settings popout.
    this.fileInputEl = contentEl.createEl('input', {
      type: 'file',
      cls: 'flit-settings-transfer-file-input',
    });
    this.fileInputEl.accept = '.json,application/json,text/json';
    this.fileInputEl.addEventListener('change', () => {
      void this.loadSelectedFile();
    });

    new Setting(contentEl)
      .setName(t('modals.settingsTransfer.import.file.name'))
      .setDesc(t('modals.settingsTransfer.import.file.desc'))
      .addButton((button) => {
        this.chooseFileButton = button;
        button
          .setButtonText(t('modals.settingsTransfer.import.file.button'))
          .onClick(() => this.fileInputEl.click());
      });

    new Setting(contentEl)
      .setName(t('modals.settingsTransfer.import.editor.name'))
      .setDesc(t('modals.settingsTransfer.import.editor.desc'));

    this.editorEl = createTransferEditor(contentEl, {
      placeholder: t('modals.settingsTransfer.import.editor.placeholder'),
    });

    this.addButton((btn) => {
      this.importButton = btn
        .setButtonText(t('modals.settingsTransfer.import.button'))
        .setCta()
        .onClick(() => {
          this.confirmImport();
          // Stays open on every path: valid JSON opens a nested confirmation, and applyTransfer closes this dialog only once the import is saved
          return true;
        });
    });
    this.addCancelButton();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** Disables both entry points while a read or a save is in flight. */
  private setBusy(isBusy: boolean): void {
    this.chooseFileButton?.setDisabled(isBusy);
    this.importButton?.setDisabled(isBusy);
  }

  private async loadSelectedFile(): Promise<void> {
    const selectedFile = this.fileInputEl.files?.[0];
    if (!selectedFile) return;

    this.setBusy(true);
    try {
      this.editorEl.value = await selectedFile.text();
    } catch (error) {
      showNotice(
        t('modals.settingsTransfer.import.errors.readFailed', {
          message: describeError(error),
        }),
        'warning'
      );
    } finally {
      this.setBusy(false);
      // Clearing the value lets the same file be picked again — `change` fires only when the selection differs from the last one.
      this.fileInputEl.value = '';
    }
  }

  private confirmImport(): void {
    const verdict = evaluateSettingsImport(this.editorEl.value);

    if (verdict.kind === 'unreadable') {
      showNotice(
        t('modals.settingsTransfer.import.errors.invalidFile'),
        'warning'
      );
      return;
    }

    if (verdict.kind === 'incompatible-schema') {
      showNotice(
        t('modals.settingsTransfer.import.errors.incompatibleVersion'),
        'warning'
      );
      return;
    }

    const transfer = verdict.settings;
    const body = createFragment((frag) => {
      frag.createEl('p', {
        text: t('modals.settingsTransfer.import.confirm.message'),
        cls: 'mod-warning',
      });
    });

    addFlitModalClass(new ConfirmationModal(this.app))
      .setTitle(t('modals.settingsTransfer.import.confirm.title'))
      .setContent(body)
      .addButton((btn) =>
        btn
          .setButtonText(t('modals.settingsTransfer.import.confirm.button'))
          .setCta()
          .onClick(() => {
            void this.applyTransfer(transfer);
          })
      )
      .addCancelButton()
      .open();
  }

  private async applyTransfer(transfer: SettingsTransfer): Promise<void> {
    this.setBusy(true);
    try {
      // Unconditional: an import replaces every setting, so the outgoing state is written out first whether or not the user thought to export it.
      const backupPath = await this.plugin.writeSettingsBackup(
        createSettingsTransferJson(this.plugin.settings)
      );
      // Nothing is imported without that copy: once replaced, the outgoing settings exist nowhere else.
      if (backupPath === null) {
        showNotice(
          t('modals.settingsTransfer.import.errors.backupFailed'),
          'warning'
        );
        return;
      }

      // `replaceSettings` warns and rolls back by itself when the save fails
      if (
        !(await this.plugin.replaceSettings(applySettingsTransfer(transfer)))
      ) {
        return;
      }

      showNotice(t('notifications.settingsImported'), 'success');
      this.tab.update();
      this.close();
    } finally {
      this.setBusy(false);
    }
  }
}
