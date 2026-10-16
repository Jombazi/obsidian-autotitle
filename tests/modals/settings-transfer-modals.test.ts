/**
 * Tests for the settings export and import dialogs' confirmation buttons. The
 * base `Modal` mock declares `onOpen` as an instance field, so each dialog is
 * opened through the real prototype.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  App,
  ConfirmationModal,
  Platform,
  PluginSettingTab,
} from '../mockObsidian';
import { createTestSettings, flush } from '../testUtils';

vi.mock('../../src/settings/settings-base', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/settings/settings-base')
  >('../../src/settings/settings-base');
  return { ...actual, showNotice: vi.fn() };
});

import FirstLineIsTitle from '../../main';
import {
  SettingsExportModal,
  SettingsImportModal,
} from '../../src/modals/settings-transfer';
import { showNotice } from '../../src/settings/settings-base';
import {
  createSettingsTransferJson,
  SettingsTransfer,
} from '../../src/settings/transfer';
import { CURRENT_DATA_SCHEMA_VERSION } from '../../src/constants';

type PluginStub = ConstructorParameters<typeof SettingsExportModal>[1];

/** The export dialog's private actions, reached so a test can stub them. */
interface ExportActions {
  copyToClipboard(contents: string): Promise<void>;
  downloadTransfer(contents: string): void;
}

/** The import dialog's private steps, reached so a test can drive them one at a time. */
interface ImportSteps {
  applyTransfer(transfer: SettingsTransfer): Promise<void>;
  loadSelectedFile(): Promise<void>;
  fileInputEl: HTMLInputElement;
}

const TIMESTAMP = '2026-10-11T09:00:00.000Z';
const SAVED_PATH = 'first-line-is-title-settings-20261011-090000.json';

function createPluginStub(): PluginStub {
  const plugin = {
    settings: createTestSettings(),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    writeSettingsBackup: vi.fn().mockResolvedValue(SAVED_PATH),
    createSettingsFileAtVaultRoot: vi.fn().mockResolvedValue(SAVED_PATH),
    updatePropertyVisibility: vi.fn(),
    getCurrentTimestamp: vi.fn(() => TIMESTAMP),
    outputAllSettings: vi.fn(),
  } as unknown as PluginStub;
  // The plugin's own replacement path, so an import exercises its cascades and rollback
  plugin.replaceSettings = (next) =>
    FirstLineIsTitle.prototype.replaceSettings.call(plugin, next);
  return plugin;
}

function transferOf(settings: Record<string, unknown>): SettingsTransfer {
  return {
    plugin: 'first-line-is-title',
    dataSchemaVersion: CURRENT_DATA_SCHEMA_VERSION,
    settings,
  };
}

function buttonEls(modal: { modalEl: HTMLElement }): HTMLButtonElement[] {
  return Array.from(
    modal.modalEl.querySelectorAll<HTMLButtonElement>(
      '.modal-button-container button'
    )
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(showNotice).mockClear();
});

describe('SettingsExportModal', () => {
  function openExport() {
    const plugin = createPluginStub();
    const modal = new SettingsExportModal(new App() as never, plugin);
    SettingsExportModal.prototype.onOpen.call(modal);
    const editorEl = modal.contentEl.querySelector(
      'textarea'
    ) as HTMLTextAreaElement;
    return { modal, plugin, editorEl, buttons: buttonEls(modal) };
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
    await flush();

    expect(copy).toHaveBeenCalledWith('{"edited":true}');
    expect(modal.close).not.toHaveBeenCalled();
  });

  it('downloads the edited JSON and stays open', async () => {
    const { modal, editorEl, buttons } = openExport();
    // The real download reaches `activeDocument`, which the test setup does not define
    const download = vi
      .spyOn(modal as unknown as ExportActions, 'downloadTransfer')
      .mockImplementation(() => {});

    editorEl.value = '{"edited":true}';
    buttons[1].click();
    await flush();

    expect(download).toHaveBeenCalledWith('{"edited":true}');
    expect(modal.close).not.toHaveBeenCalled();
  });

  it('closes on Done', async () => {
    const { modal, buttons } = openExport();

    buttons[2].click();
    await flush();

    expect(modal.close).toHaveBeenCalledTimes(1);
  });

  describe('download', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('saves the payload through a timestamped download link, revoking it on the next tick', async () => {
      vi.stubGlobal('activeDocument', document);
      const createObjectUrl = vi
        .spyOn(URL, 'createObjectURL')
        .mockReturnValue('blob:settings');
      const revokeObjectUrl = vi
        .spyOn(URL, 'revokeObjectURL')
        .mockImplementation(() => {});
      const clicked: HTMLAnchorElement[] = [];
      // jsdom has no download behavior, so the click only records which link was pressed; reached through `window`, since the setup installs only some DOM classes as globals
      vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(
        function (this: HTMLAnchorElement) {
          clicked.push(this);
        }
      );
      const { modal } = openExport();

      (modal as unknown as ExportActions).downloadTransfer('{"a":1}');

      expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
      expect(clicked).toHaveLength(1);
      expect(clicked[0].getAttribute('href')).toBe('blob:settings');
      expect(clicked[0].getAttribute('download')).toMatch(
        /^first-line-is-title-settings-\d{8}-\d{6}\.json$/
      );
      expect(clicked[0].isConnected).toBe(false);
      expect(revokeObjectUrl).not.toHaveBeenCalled();

      await flush();
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:settings');
    });
  });

  describe('on mobile', () => {
    afterEach(() => {
      Platform.isMobileApp = false;
    });

    function openMobileExport() {
      Platform.isMobileApp = true;
      return openExport();
    }

    it('offers Save to vault as the primary in place of Download', () => {
      const { buttons } = openMobileExport();

      expect(buttons.map((button) => button.textContent)).toEqual([
        'Copy',
        'Save to vault',
        'Done',
      ]);
      expect(buttons[1].classList.contains('mod-cta')).toBe(true);
    });

    it('saves the edited JSON to the vault root, names the file and stays open', async () => {
      const { modal, plugin, editorEl, buttons } = openMobileExport();
      const download = vi.spyOn(
        modal as unknown as ExportActions,
        'downloadTransfer'
      );

      editorEl.value = '{"edited":true}';
      buttons[1].click();
      await flush();

      expect(plugin.createSettingsFileAtVaultRoot).toHaveBeenCalledWith(
        '{"edited":true}'
      );
      expect(download).not.toHaveBeenCalled();
      expect(showNotice).toHaveBeenCalledWith(
        `Settings saved to ${SAVED_PATH}`,
        'success'
      );
      expect(modal.close).not.toHaveBeenCalled();
    });

    it('warns with the reason when the file cannot be written', async () => {
      const { modal, plugin, buttons } = openMobileExport();
      vi.mocked(plugin.createSettingsFileAtVaultRoot).mockRejectedValue(
        new Error('disk full')
      );

      buttons[1].click();
      await flush();

      expect(showNotice).toHaveBeenCalledWith(
        'Failed to save settings: disk full',
        'warning'
      );
      expect(modal.close).not.toHaveBeenCalled();
    });
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
    await flush();

    expect(addButton).not.toHaveBeenCalled();
    expect(modal.close).not.toHaveBeenCalled();
  });

  it('stays open under the nested confirmation when the JSON is valid', async () => {
    const { modal, plugin, editorEl, buttons } = openImport();
    const addButton = vi.spyOn(ConfirmationModal.prototype, 'addButton');

    editorEl.value = createSettingsTransferJson(plugin.settings);
    buttons[0].click();
    await flush();

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
    await flush();

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
    await flush();

    expect(modal.close).toHaveBeenCalledTimes(1);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  describe('applying an import', () => {
    function openWithTab() {
      const opened = openImport();
      const tab = (opened.modal as unknown as { tab: PluginSettingTab }).tab;
      return { ...opened, tab, steps: opened.modal as unknown as ImportSteps };
    }

    it('imports nothing, with a warning, when the current settings cannot be backed up', async () => {
      const { modal, plugin, tab, steps, buttons } = openWithTab();
      vi.mocked(plugin.writeSettingsBackup).mockResolvedValue(null);
      const before = plugin.settings;
      const snapshot = structuredClone(before);

      await steps.applyTransfer(transferOf({ core: { charCount: 42 } }));

      expect(plugin.settings).toBe(before);
      expect(plugin.settings).toEqual(snapshot);
      expect(plugin.saveSettings).not.toHaveBeenCalled();
      expect(showNotice).toHaveBeenCalledWith(
        'Your current settings could not be backed up. Nothing was imported.',
        'warning'
      );
      expect(tab.update).not.toHaveBeenCalled();
      expect(modal.close).not.toHaveBeenCalled();
      expect(buttons[0].disabled).toBe(false);
    });

    it('applies the import, runs what changed, re-renders and closes', async () => {
      const { modal, plugin, tab, steps } = openWithTab();

      await steps.applyTransfer(
        transferOf({
          core: { charCount: 42, debug: true },
          firstLineProperty: { propertyKey: 'aliases', hideProperty: 'always' },
        })
      );

      expect(plugin.settings.core.charCount).toBe(42);
      // Property hiding and the debug stamp follow the import without a reload
      expect(plugin.updatePropertyVisibility).toHaveBeenCalledTimes(1);
      expect(plugin.settings.core.debugEnabledTimestamp).toBe(TIMESTAMP);
      expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
      expect(showNotice).toHaveBeenCalledWith(
        'Settings have been imported successfully',
        'success'
      );
      expect(tab.update).toHaveBeenCalledTimes(1);
      expect(modal.close).toHaveBeenCalledTimes(1);
    });

    it('keeps the previous settings and stays open when the save fails', async () => {
      const { modal, plugin, tab, steps, buttons } = openWithTab();
      vi.mocked(plugin.saveSettings).mockRejectedValue(new Error('disk full'));
      const snapshot = structuredClone(plugin.settings);

      await steps.applyTransfer(transferOf({ core: { charCount: 42 } }));

      expect(plugin.settings).toEqual(snapshot);
      expect(tab.update).not.toHaveBeenCalled();
      expect(modal.close).not.toHaveBeenCalled();
      expect(buttons[0].disabled).toBe(false);
    });

    it('re-enables Import even when the backup throws', async () => {
      const { plugin, steps, buttons } = openWithTab();
      vi.mocked(plugin.writeSettingsBackup).mockRejectedValue(
        new Error('vault gone')
      );

      await expect(
        steps.applyTransfer(transferOf({ core: { charCount: 42 } }))
      ).rejects.toThrow('vault gone');

      expect(buttons[0].disabled).toBe(false);
    });
  });

  describe('loading a file', () => {
    function chooseFile(steps: ImportSteps, text: () => Promise<string>): void {
      Object.defineProperty(steps.fileInputEl, 'files', {
        value: [{ text }],
        configurable: true,
      });
    }

    it('fills the editor with the file, disabling Import only while it reads', async () => {
      const { modal, editorEl, buttons } = openImport();
      const steps = modal as unknown as ImportSteps;
      let finishRead: (text: string) => void = () => {};
      chooseFile(
        steps,
        () =>
          new Promise<string>((resolve) => {
            finishRead = resolve;
          })
      );

      const loading = steps.loadSelectedFile();
      expect(buttons[0].disabled).toBe(true);
      finishRead('{"from":"file"}');
      await loading;

      expect(editorEl.value).toBe('{"from":"file"}');
      expect(buttons[0].disabled).toBe(false);
    });

    it('warns and re-enables Import when the file cannot be read', async () => {
      const { modal, editorEl, buttons } = openImport();
      const steps = modal as unknown as ImportSteps;
      chooseFile(steps, () => Promise.reject(new Error('unreadable')));

      await steps.loadSelectedFile();

      expect(editorEl.value).toBe('');
      expect(showNotice).toHaveBeenCalledWith(
        expect.stringContaining('unreadable'),
        'warning'
      );
      expect(buttons[0].disabled).toBe(false);
    });
  });
});
