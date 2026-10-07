/**
 * Tests for the settings export and import dialogs' confirmation buttons. The
 * base `Modal` mock declares `onOpen` as an instance field, so each dialog is
 * opened through the real prototype.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { App, ConfirmationModal, PluginSettingTab } from '../mockObsidian';
import { createTestSettings } from '../testUtils';
import {
  SettingsExportModal,
  SettingsImportModal,
} from '../../src/modals/settings-transfer';
import { createSettingsTransferJson } from '../../src/settings/transfer';

type PluginStub = ConstructorParameters<typeof SettingsExportModal>[1];

/** The export dialog's private actions, reached so a test can stub them. */
interface ExportActions {
  copyToClipboard(contents: string): Promise<void>;
  downloadTransfer(contents: string): Promise<void>;
}

function createPluginStub(): PluginStub {
  return {
    settings: createTestSettings(),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    writeSettingsBackup: vi.fn().mockResolvedValue(undefined),
  } as unknown as PluginStub;
}

function buttonEls(modal: { modalEl: HTMLElement }): HTMLButtonElement[] {
  return Array.from(
    modal.modalEl.querySelectorAll<HTMLButtonElement>(
      '.modal-button-container button'
    )
  );
}

/** Lets a confirmation button's async click finish. */
async function flushClicks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsExportModal', () => {
  function openExport() {
    const modal = new SettingsExportModal(
      new App() as never,
      createPluginStub()
    );
    SettingsExportModal.prototype.onOpen.call(modal);
    const editorEl = modal.contentEl.querySelector(
      'textarea'
    ) as HTMLTextAreaElement;
    return { modal, editorEl, buttons: buttonEls(modal) };
  }

  it('is a confirmation dialog with Copy, then Download as the primary, then Done', () => {
    const { modal, buttons } = openExport();

    expect(modal).toBeInstanceOf(ConfirmationModal);
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Copy',
      'Download',
      'Done',
    ]);
    expect(buttons[1].classList.contains('mod-cta')).toBe(true);
    expect(buttons[2].classList.contains('mod-cancel')).toBe(true);
  });

  it("carries FLIT's dialog class", () => {
    const { modal } = openExport();

    expect(modal.containerEl.classList.contains('flit-modal')).toBe(true);
  });

  it('copies the edited JSON and stays open', async () => {
    const { modal, editorEl, buttons } = openExport();
    const copy = vi
      .spyOn(modal as unknown as ExportActions, 'copyToClipboard')
      .mockResolvedValue(undefined);

    editorEl.value = '{"edited":true}';
    buttons[0].click();
    await flushClicks();

    expect(copy).toHaveBeenCalledWith('{"edited":true}');
    expect(modal.close).not.toHaveBeenCalled();
  });

  it('downloads the edited JSON and stays open', async () => {
    const { modal, editorEl, buttons } = openExport();
    // The real download reaches `activeDocument`, which the test setup does not define
    const download = vi
      .spyOn(modal as unknown as ExportActions, 'downloadTransfer')
      .mockResolvedValue(undefined);

    editorEl.value = '{"edited":true}';
    buttons[1].click();
    await flushClicks();

    expect(download).toHaveBeenCalledWith('{"edited":true}');
    expect(modal.close).not.toHaveBeenCalled();
  });

  it('closes on Done', async () => {
    const { modal, buttons } = openExport();

    buttons[2].click();
    await flushClicks();

    expect(modal.close).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsImportModal', () => {
  function openImport() {
    const app = new App();
    const plugin = createPluginStub();
    const modal = new SettingsImportModal(
      app as never,
      plugin,
      new PluginSettingTab(app, plugin as never) as never
    );
    SettingsImportModal.prototype.onOpen.call(modal);
    const editorEl = modal.contentEl.querySelector(
      'textarea'
    ) as HTMLTextAreaElement;
    return { modal, plugin, editorEl, buttons: buttonEls(modal) };
  }

  it('is a confirmation dialog with Import as the primary, then Cancel', () => {
    const { modal, buttons } = openImport();

    expect(modal).toBeInstanceOf(ConfirmationModal);
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Import',
      'Cancel',
    ]);
    expect(buttons[0].classList.contains('mod-cta')).toBe(true);
    expect(buttons[1].classList.contains('mod-cancel')).toBe(true);
  });

  it("carries FLIT's dialog class", () => {
    const { modal } = openImport();

    expect(modal.containerEl.classList.contains('flit-modal')).toBe(true);
  });

  it('stays open, with no confirmation, when the JSON is unreadable', async () => {
    const { modal, editorEl, buttons } = openImport();
    const addButton = vi.spyOn(ConfirmationModal.prototype, 'addButton');

    editorEl.value = 'not json';
    buttons[0].click();
    await flushClicks();

    expect(addButton).not.toHaveBeenCalled();
    expect(modal.close).not.toHaveBeenCalled();
  });

  it('stays open under the nested confirmation when the JSON is valid', async () => {
    const { modal, plugin, editorEl, buttons } = openImport();
    const addButton = vi.spyOn(ConfirmationModal.prototype, 'addButton');

    editorEl.value = createSettingsTransferJson(plugin.settings);
    buttons[0].click();
    await flushClicks();

    const nestedDialogs = addButton.mock.contexts.filter(
      (context) => context !== modal
    );
    expect(nestedDialogs.length).toBeGreaterThan(0);
    expect(modal.close).not.toHaveBeenCalled();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it("gives the nested confirmation FLIT's dialog class", async () => {
    const { modal, plugin, editorEl, buttons } = openImport();
    const addButton = vi.spyOn(ConfirmationModal.prototype, 'addButton');

    editorEl.value = createSettingsTransferJson(plugin.settings);
    buttons[0].click();
    await flushClicks();

    const nestedDialogs = addButton.mock.contexts.filter(
      (context) => context !== modal
    );
    expect(nestedDialogs.length).toBeGreaterThan(0);
    for (const nested of nestedDialogs as ConfirmationModal[]) {
      expect(nested.containerEl.classList.contains('flit-modal')).toBe(true);
    }
  });

  it('disables Import while a read or a save is in flight', () => {
    const { modal, buttons } = openImport();

    modal['setBusy'](true);
    expect(buttons[0].disabled).toBe(true);

    modal['setBusy'](false);
    expect(buttons[0].disabled).toBe(false);
  });

  it('closes without importing on Cancel', async () => {
    const { modal, plugin, editorEl, buttons } = openImport();

    editorEl.value = createSettingsTransferJson(plugin.settings);
    buttons[1].click();
    await flushClicks();

    expect(modal.close).toHaveBeenCalledTimes(1);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });
});
