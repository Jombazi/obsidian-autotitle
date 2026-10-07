/**
 * Tests for modal error notification behavior
 *
 * Tests cover:
 * - Success notification only shown when no errors (Issue #6 from audit)
 * - Error notification shown when errors occur
 * - No duplicate notifications (both error and success shown together)
 * - renameEngine/propertyManager null checks
 * - Bulk rename scope: subfolders, subtags, exclusions, and one list behind the preview and the run
 * - A notice in place of a dialog with nothing to rename
 * - Confirmation dialogs: primary and Cancel buttons, initial focus, Enter
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as mockObsidian from './mockObsidian';
import { App, TFile, TFolder } from './mockObsidian';
import { createTestSettings } from './testUtils';
import { shouldProcessFile, canModifyFile } from '../src/utils';

// Track Notice calls via spy
const noticeInstances: { message: string; timeout?: number }[] = [];

/** Index arithmetic rather than `.at(-1)`, which is outside the lib target. */
function lastNoticeMessage(): string | undefined {
  return noticeInstances[noticeInstances.length - 1]?.message;
}

// Mock i18n
vi.mock('../src/i18n', () => ({
  t: vi.fn((key: string) => {
    const translations: Record<string, string> = {
      'notifications.renamedNotes': 'Renamed {{renamed}}/{{total}} notes',
      'notifications.renamedNotesWithErrors':
        'Renamed {{renamed}}/{{total}} notes ({{errors}} errors)',
      'notifications.processingNNotes': 'Processing {{count}} notes...',
      'notifications.processedNotesWithErrors':
        'Processed {{processed}}/{{total}} notes ({{errors}} errors)',
      'notifications.renameEngineNotInitialized':
        'Rename engine not initialized',
      'notifications.propertyManagerNotInitialized':
        'Property manager not initialized',
      'notifications.disabledRenamingForNNotes':
        'Disabled renaming for {{count}} notes',
      'notifications.enabledRenamingForNNotes':
        'Enabled renaming for {{count}} notes',
      'modals.renameNotes': 'Rename notes',
      'modals.processingFiles': 'Processing {{count}} files...',
    };
    return translations[key] || key;
  }),
  getPluralForm: vi.fn(
    (count: number, one: string, _few: string, many: string) =>
      count === 1 ? one : many
  ),
  tpSplit: vi.fn(() => ({ before: '', noun: 'notes', after: '' })),
}));

// Mock utils
vi.mock('../src/utils', () => ({
  verboseLog: vi.fn(),
  shouldProcessFile: vi.fn(() => true),
  canModifyFile: vi.fn(() => ({ canModify: true })),
  normalizeTag: vi.fn((tag: string) => tag),
}));

describe('Modal Error Notifications', () => {
  let mockApp: App;
  let mockPlugin: any;

  beforeEach(() => {
    vi.clearAllMocks();
    noticeInstances.length = 0;

    // Spy on Notice class to track calls.
    // In vitest v4, mockImplementation must use a regular function (not an arrow
    // function) when the source calls `new Notice(...)` — arrow functions are not
    // constructable, which causes "is not a constructor" at the call site.
    vi.spyOn(mockObsidian, 'Notice').mockImplementation(function (
      message: string,
      timeout?: number
    ) {
      noticeInstances.push({ message, timeout });
      return {
        message,
        timeout,
        setMessage: vi.fn(),
        hide: vi.fn(),
        containerEl: document.createElement('div'),
      } as any;
    } as any);

    mockApp = new App();
    mockPlugin = {
      app: mockApp,
      settings: createTestSettings(),
      renameEngine: {
        // processFile returns { success: boolean; reason?: string }
        processFile: vi.fn().mockResolvedValue({ success: true }),
      },
      propertyManager: {
        ensurePropertyTypeIsCheckbox: vi.fn().mockResolvedValue(undefined),
      },
      disableRenamingForNote: vi.fn().mockResolvedValue(undefined),
      enableRenamingForNote: vi.fn().mockResolvedValue(undefined),
    };

    // Mock vault methods
    mockApp.vault.getMarkdownFiles = vi.fn().mockReturnValue([]);

    // clearAllMocks keeps implementations, so a test that narrows a gate must not leak into the next.
    vi.mocked(shouldProcessFile).mockImplementation(() => true);
    vi.mocked(canModifyFile).mockImplementation(() => ({ canModify: true }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('DisableEnableModal notification behavior', () => {
    it('should show success notice only when no errors occur', async () => {
      // Import the modal
      const { DisableEnableModal } = await import('../src/modals');

      const files = [new TFile('test1.md'), new TFile('test2.md')];
      mockPlugin.disableRenamingForNote = vi.fn().mockResolvedValue(undefined);

      const modal = new DisableEnableModal(
        mockApp,
        mockPlugin,
        files,
        'disable'
      );

      // Simulate processFiles
      await modal['processFiles']();

      // Should have success notice (plus the "please wait" notice)
      const successNotices = noticeInstances.filter((n) =>
        n.message.includes('Disabled renaming')
      );
      expect(successNotices.length).toBe(1);

      // Should NOT have error notice
      const errorNotices = noticeInstances.filter((n) =>
        n.message.includes('errors')
      );
      expect(errorNotices.length).toBe(0);
    });

    it('should show error notice only when errors occur', async () => {
      const { DisableEnableModal } = await import('../src/modals');

      const files = [new TFile('test1.md'), new TFile('test2.md')];
      // processFiles uses fileManager.processFrontMatter, not disableRenamingForNote
      mockApp.fileManager.processFrontMatter = vi
        .fn()
        .mockRejectedValue(new Error('Test error'));

      const modal = new DisableEnableModal(
        mockApp,
        mockPlugin,
        files,
        'disable'
      );

      await modal['processFiles']();

      // Should have error notice
      const errorNotices = noticeInstances.filter((n) =>
        n.message.includes('errors')
      );
      expect(errorNotices.length).toBe(1);

      // Should NOT have success notice (this was the bug - Issue #6)
      const successNotices = noticeInstances.filter((n) =>
        n.message.includes('Disabled renaming')
      );
      expect(successNotices.length).toBe(0);
    });

    it('should not show duplicate notifications', async () => {
      const { DisableEnableModal } = await import('../src/modals');

      const files = [new TFile('test1.md')];
      // processFiles uses fileManager.processFrontMatter
      mockApp.fileManager.processFrontMatter = vi
        .fn()
        .mockRejectedValue(new Error('Test error'));

      const modal = new DisableEnableModal(
        mockApp,
        mockPlugin,
        files,
        'disable'
      );

      await modal['processFiles']();

      // Count all notification types (excluding "please wait")
      const allResultNotices = noticeInstances.filter(
        (n) =>
          n.message.includes('Disabled') ||
          n.message.includes('errors') ||
          n.message.includes('Renamed')
      );

      // Should only have ONE result notification (either success OR error, not both)
      expect(allResultNotices.length).toBe(1);
    });

    it('never claims notes were renamed, since it only writes a property', async () => {
      const { DisableEnableModal } = await import('../src/modals');

      const files = [new TFile('test1.md'), new TFile('test2.md')];
      mockApp.fileManager.processFrontMatter = vi
        .fn()
        .mockRejectedValue(new Error('Test error'));

      const modal = new DisableEnableModal(
        mockApp,
        mockPlugin,
        files,
        'disable'
      );

      await modal['processFiles']();

      expect(
        noticeInstances.filter((n) => /renam/i.test(n.message))
      ).toHaveLength(0);
      expect(noticeInstances.map((n) => n.message)).toEqual([
        'Processing 2 notes...',
        'Processed 0/2 notes (2 errors)',
      ]);
    });

    it('processes every note when the batch spans several chunks', async () => {
      const { DisableEnableModal } = await import('../src/modals');

      // 20 files is larger than the internal chunk size, so this covers the
      // boundary between chunks as well as a partial trailing chunk.
      const files = Array.from(
        { length: 20 },
        (_, index) => new TFile(`note${index}.md`)
      );
      const touched: string[] = [];
      mockApp.fileManager.processFrontMatter = vi.fn(async (file: TFile) => {
        touched.push(file.path);
      });

      const modal = new DisableEnableModal(
        mockApp,
        mockPlugin,
        files,
        'disable'
      );

      await modal['processFiles']();

      expect(touched.sort()).toEqual(files.map((f) => f.path).sort());
      expect(lastNoticeMessage()).toBe('Disabled renaming for 20 notes');
    });

    it('keeps going after a failure mid-chunk', async () => {
      const { DisableEnableModal } = await import('../src/modals');

      const files = Array.from(
        { length: 12 },
        (_, index) => new TFile(`note${index}.md`)
      );
      mockApp.fileManager.processFrontMatter = vi.fn(async (file: TFile) => {
        if (file.path === 'note3.md') throw new Error('Test error');
      });

      const modal = new DisableEnableModal(
        mockApp,
        mockPlugin,
        files,
        'disable'
      );

      await modal['processFiles']();

      expect(lastNoticeMessage()).toBe('Processed 11/12 notes (1 errors)');
    });

    it('should show notice when propertyManager is null for disable action', async () => {
      const { DisableEnableModal } = await import('../src/modals');

      mockPlugin.propertyManager = null;
      const files = [new TFile('test1.md')];

      const modal = new DisableEnableModal(
        mockApp,
        mockPlugin,
        files,
        'disable'
      );

      await modal['processFiles']();

      // Should show "not initialized" notice
      const initNotices = noticeInstances.filter((n) =>
        n.message.includes('not initialized')
      );
      expect(initNotices.length).toBe(1);
    });
  });

  describe('RenameAllFilesModal notification behavior', () => {
    it('should show notice when renameEngine is null', async () => {
      const { RenameAllFilesModal } = await import('../src/modals');

      mockPlugin.renameEngine = null;
      mockApp.vault.getMarkdownFiles = vi
        .fn()
        .mockReturnValue([new TFile('test.md')]);

      const modal = new RenameAllFilesModal(mockApp, mockPlugin);

      await modal['renameFilesToProcess']();

      const initNotices = noticeInstances.filter((n) =>
        n.message.includes('not initialized')
      );
      expect(initNotices.length).toBe(1);
    });

    it('should show success notice only when no errors', async () => {
      const { RenameAllFilesModal } = await import('../src/modals');

      const files = [new TFile('test1.md'), new TFile('test2.md')];
      mockApp.vault.getMarkdownFiles = vi.fn().mockReturnValue(files);
      mockPlugin.renameEngine.processFile = vi
        .fn()
        .mockResolvedValue({ success: true });

      const modal = new RenameAllFilesModal(mockApp, mockPlugin);
      await modal['renameFilesToProcess']();

      const successNotices = noticeInstances.filter(
        (n) => n.message.includes('Renamed') && !n.message.includes('errors')
      );
      expect(successNotices.length).toBe(1);

      const errorNotices = noticeInstances.filter((n) =>
        n.message.includes('errors')
      );
      expect(errorNotices.length).toBe(0);
    });

    it('should rename in concurrent chunks without losing count', async () => {
      const { RenameAllFilesModal } = await import('../src/modals');

      const files = Array.from(
        { length: 10 },
        (_, index) => new TFile(`test${index}.md`)
      );
      mockApp.vault.getMarkdownFiles = vi.fn().mockReturnValue(files);

      let inFlight = 0;
      let peakInFlight = 0;
      mockPlugin.renameEngine.processFile = vi.fn(async () => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
        return { success: true };
      });

      const modal = new RenameAllFilesModal(mockApp, mockPlugin);
      await modal['renameFilesToProcess']();

      // One full chunk runs at once, and every note still lands in the total
      expect(peakInFlight).toBe(8);
      expect(lastNoticeMessage()).toBe('Renamed 10/10 notes');
    });

    it('should show error notice when errors occur', async () => {
      const { RenameAllFilesModal } = await import('../src/modals');

      const files = [new TFile('test1.md')];
      mockApp.vault.getMarkdownFiles = vi.fn().mockReturnValue(files);
      mockPlugin.renameEngine.processFile = vi
        .fn()
        .mockRejectedValue(new Error('Rename failed'));

      const modal = new RenameAllFilesModal(mockApp, mockPlugin);
      await modal['renameFilesToProcess']();

      const errorNotices = noticeInstances.filter((n) =>
        n.message.includes('errors')
      );
      expect(errorNotices.length).toBe(1);

      // Success notice should NOT be shown when errors occur
      const successNotices = noticeInstances.filter(
        (n) => n.message.includes('Renamed') && !n.message.includes('errors')
      );
      expect(successNotices.length).toBe(0);
    });
  });

  describe('RenameModal notification behavior', () => {
    it('should show notice when renameEngine is null', async () => {
      const { RenameModal } = await import('../src/modals');

      mockPlugin.renameEngine = null;
      const files = [new TFile('test.md')];

      const modal = new RenameModal(mockApp, mockPlugin, files);

      await modal['renameFilesToProcess']();

      const initNotices = noticeInstances.filter((n) =>
        n.message.includes('not initialized')
      );
      expect(initNotices.length).toBe(1);
    });

    it('should show success notice only when no errors', async () => {
      const { RenameModal } = await import('../src/modals');

      const files = [new TFile('test1.md')];
      mockPlugin.renameEngine.processFile = vi
        .fn()
        .mockResolvedValue({ success: true });

      const modal = new RenameModal(mockApp, mockPlugin, files);
      await modal['renameFilesToProcess']();

      const successNotices = noticeInstances.filter(
        (n) => n.message.includes('Renamed') && !n.message.includes('errors')
      );
      expect(successNotices.length).toBe(1);
    });

    it('should show error notice when errors occur', async () => {
      const { RenameModal } = await import('../src/modals');

      const files = [new TFile('test1.md')];
      mockPlugin.renameEngine.processFile = vi
        .fn()
        .mockRejectedValue(new Error('Failed'));

      const modal = new RenameModal(mockApp, mockPlugin, files);
      await modal['renameFilesToProcess']();

      const errorNotices = noticeInstances.filter((n) =>
        n.message.includes('errors')
      );
      expect(errorNotices.length).toBe(1);
    });
  });

  describe('bulk rename scope', () => {
    /** Builds `path` as a Markdown file parented to the folder that owns it. */
    function fileIn(folder: any, name: string): TFile {
      const file = new TFile(`${folder.path}/${name}`);
      (file as any).parent = folder;
      return file;
    }

    /** Paths handed to processFile, in call order. */
    function processedPaths(): string[] {
      return mockPlugin.renameEngine.processFile.mock.calls.map(
        (call: unknown[]) => (call[0] as TFile).path
      );
    }

    it('processes a nested-folder note once when both folders are selected', async () => {
      const { RenameMultipleFoldersModal } = await import('../src/modals');

      const parent = new TFolder('A');
      const child = new TFolder('A/B');
      mockApp.vault.getMarkdownFiles = vi
        .fn()
        .mockReturnValue([fileIn(parent, 'note.md'), fileIn(child, 'deep.md')]);

      const modal = new RenameMultipleFoldersModal(mockApp, mockPlugin, [
        parent,
        child,
      ]);
      await modal['renameFilesToProcess']();

      expect(processedPaths().sort()).toEqual(['A/B/deep.md', 'A/note.md']);
      expect(lastNoticeMessage()).toBe('Renamed 2/2 notes');
    });

    it('always includes notes in subfolders', async () => {
      const { RenameFolderModal } = await import('../src/modals');

      const parent = new TFolder('A');
      const child = new TFolder('A/B');
      const sibling = new TFolder('AB');
      mockApp.vault.getMarkdownFiles = vi
        .fn()
        .mockReturnValue([
          fileIn(parent, 'note.md'),
          fileIn(child, 'deep.md'),
          fileIn(sibling, 'other.md'),
        ]);

      const modal = new RenameFolderModal(mockApp, mockPlugin, parent);
      await modal['renameFilesToProcess']();

      expect(processedPaths().sort()).toEqual(['A/B/deep.md', 'A/note.md']);
    });

    it('covers the whole vault from the root folder', async () => {
      const { RenameFolderModal } = await import('../src/modals');

      const root = new TFolder('/');
      const nested = new TFolder('A');
      const files = [new TFile('top.md'), fileIn(nested, 'deep.md')];
      mockApp.vault.getMarkdownFiles = vi.fn().mockReturnValue(files);

      const modal = new RenameFolderModal(mockApp, mockPlugin, root);

      expect(modal['getFilesToProcess']()).toEqual(files);
    });

    it('always includes notes with subtags', async () => {
      const { ProcessTagModal } = await import('../src/modals');

      mockApp.vault.getMarkdownFiles = vi
        .fn()
        .mockReturnValue([
          new TFile('exact.md'),
          new TFile('subtag.md'),
          new TFile('prefix.md'),
        ]);
      const tagsByPath: Record<string, string> = {
        'exact.md': 'project',
        'subtag.md': 'project/alpha',
        'prefix.md': 'projects',
      };
      mockApp.metadataCache.getFileCache = vi.fn((file: TFile) => ({
        frontmatter: { tags: [tagsByPath[file.path]] },
        tags: [],
      }));

      const modal = new ProcessTagModal(mockApp, mockPlugin, 'project');
      await modal['renameFilesToProcess']();

      expect(processedPaths().sort()).toEqual(['exact.md', 'subtag.md']);
    });

    it('leaves out notes the exclusions or the rename-blocking property skip', async () => {
      const { RenameAllFilesModal } = await import('../src/modals');

      const files = [
        new TFile('kept.md'),
        new TFile('excluded.md'),
        new TFile('blocked.md'),
      ];
      mockApp.vault.getMarkdownFiles = vi.fn().mockReturnValue(files);
      vi.mocked(shouldProcessFile).mockImplementation(
        (file) => file.path !== 'excluded.md'
      );
      vi.mocked(canModifyFile).mockImplementation((file) => ({
        canModify: file.path !== 'blocked.md',
      }));
      const modal = new RenameAllFilesModal(mockApp, mockPlugin);
      const previewCount = modal['getFilesToProcess']().length;
      await modal['renameFilesToProcess']();

      expect(previewCount).toBe(1);
      expect(processedPaths()).toEqual(['kept.md']);
      expect(lastNoticeMessage()).toBe('Renamed 1/1 notes');
    });

    it('lets processFile re-apply the exclusions to live content', async () => {
      const { RenameModal } = await import('../src/modals');

      const modal = new RenameModal(mockApp, mockPlugin, [
        new TFile('note.md'),
      ]);
      await modal['renameFilesToProcess']();

      expect(mockPlugin.renameEngine.processFile).toHaveBeenCalledTimes(1);
      expect(mockPlugin.renameEngine.processFile.mock.calls[0][5]).toBe(
        undefined
      );
    });

    it('scans the vault once for both the preview and the run', async () => {
      const { ProcessTagModal } = await import('../src/modals');

      mockApp.vault.getMarkdownFiles = vi
        .fn()
        .mockReturnValue([new TFile('tagged.md'), new TFile('plain.md')]);
      mockApp.metadataCache.getFileCache = vi.fn((file: TFile) =>
        file.path === 'tagged.md'
          ? { frontmatter: { tags: ['project/alpha'] }, tags: [] }
          : { frontmatter: {}, tags: [] }
      );

      const modal = new ProcessTagModal(mockApp, mockPlugin, 'project');
      const previewCount = modal['getFilesToProcess']().length;
      await modal['renameFilesToProcess']();

      expect(previewCount).toBe(1);
      expect(mockApp.vault.getMarkdownFiles).toHaveBeenCalledTimes(1);
      expect(lastNoticeMessage()).toBe('Renamed 1/1 notes');
    });

    it('sorts its own copy rather than the cached list', async () => {
      const { ProcessTagModal } = await import('../src/modals');

      // Vault order is the reverse of creation order, so an in-place sort of
      // the cached list would be visible here.
      const newest = new TFile('newest.md');
      const oldest = new TFile('oldest.md');
      newest.stat.ctime = 2000;
      oldest.stat.ctime = 1000;
      mockApp.vault.getMarkdownFiles = vi
        .fn()
        .mockReturnValue([newest, oldest]);
      mockApp.metadataCache.getFileCache = vi.fn(() => ({
        frontmatter: { tags: ['project/alpha'] },
        tags: [],
      }));

      const modal = new ProcessTagModal(mockApp, mockPlugin, 'project');
      const cached = modal['getFilesToProcess']();

      await modal['renameFilesToProcess']();

      expect(cached.map((f) => f.path)).toEqual(['newest.md', 'oldest.md']);
      expect(processedPaths()).toEqual(['oldest.md', 'newest.md']);
    });
  });

  describe('bulk rename with nothing to process', () => {
    // The mock Modal declares open as an instance field, which shadows the subclass's prototype method.
    const callOpen = (modal: object, prototype: { open(): void }) =>
      prototype.open.call(modal);

    afterEach(() => {
      delete (mockObsidian.Modal.prototype as any).open;
    });

    it('shows a notice instead of the dialog when exclusions cover the folder', async () => {
      const { RenameFolderModal } = await import('../src/modals');

      const folder = new TFolder('Excluded');
      const file = new TFile('Excluded/note.md');
      mockApp.vault.getMarkdownFiles = vi.fn().mockReturnValue([file]);
      vi.mocked(shouldProcessFile).mockImplementation(() => false);
      const baseOpen = vi.fn();
      (mockObsidian.Modal.prototype as any).open = baseOpen;

      const modal = new RenameFolderModal(mockApp, mockPlugin, folder);
      callOpen(modal, RenameFolderModal.prototype);

      expect(baseOpen).not.toHaveBeenCalled();
      expect(noticeInstances.map((n) => n.message)).toEqual([
        'notifications.noNotesFoundInFolder',
      ]);
    });

    it('opens the dialog when at least one note is left', async () => {
      const { RenameAllFilesModal } = await import('../src/modals');

      mockApp.vault.getMarkdownFiles = vi
        .fn()
        .mockReturnValue([new TFile('note.md')]);
      const baseOpen = vi.fn();
      (mockObsidian.Modal.prototype as any).open = baseOpen;

      const modal = new RenameAllFilesModal(mockApp, mockPlugin);
      callOpen(modal, RenameAllFilesModal.prototype);

      expect(baseOpen).toHaveBeenCalledTimes(1);
      expect(noticeInstances).toHaveLength(0);
    });

    it('names the tag when no tagged note is left', async () => {
      const { ProcessTagModal } = await import('../src/modals');

      const modal = new ProcessTagModal(mockApp, mockPlugin, 'project');
      callOpen(modal, ProcessTagModal.prototype);

      expect(noticeInstances.map((n) => n.message)).toEqual([
        'notifications.noNotesFoundWithTag',
      ]);
    });
  });

  describe('confirmation dialogs', () => {
    type ConfirmationMock = InstanceType<typeof mockObsidian.ConfirmationModal>;

    /** Lets a confirmation button's async click finish. */
    const flushClicks = () => new Promise((resolve) => setTimeout(resolve, 0));

    const buttonEls = (modal: object): HTMLButtonElement[] =>
      Array.from(
        (modal as ConfirmationMock).modalEl.querySelectorAll<HTMLButtonElement>(
          '.modal-button-container button'
        )
      );

    afterEach(() => {
      delete (mockObsidian.Modal.prototype as any).open;
    });

    describe('bulk rename', () => {
      /** Every bulk dialog, each built with one note in scope. */
      async function buildEachBulkDialog() {
        const {
          RenameAllFilesModal,
          RenameFolderModal,
          RenameMultipleFoldersModal,
          ProcessTagModal,
          RenameModal,
        } = await import('../src/modals');
        const folder = new TFolder('A');
        const file = new TFile('A/note.md');
        (file as any).parent = folder;
        mockApp.vault.getMarkdownFiles = vi.fn().mockReturnValue([file]);
        mockApp.metadataCache.getFileCache = vi.fn(() => ({
          frontmatter: { tags: ['project'] },
          tags: [],
        }));
        return [
          {
            name: 'RenameAllFilesModal',
            focusesCancel: true,
            modal: new RenameAllFilesModal(mockApp, mockPlugin),
            prototype: RenameAllFilesModal.prototype,
          },
          {
            name: 'RenameFolderModal',
            focusesCancel: false,
            modal: new RenameFolderModal(mockApp, mockPlugin, folder),
            prototype: RenameFolderModal.prototype,
          },
          {
            name: 'RenameMultipleFoldersModal',
            focusesCancel: false,
            modal: new RenameMultipleFoldersModal(mockApp, mockPlugin, [
              folder,
            ]),
            prototype: RenameMultipleFoldersModal.prototype,
          },
          {
            name: 'ProcessTagModal',
            focusesCancel: false,
            modal: new ProcessTagModal(mockApp, mockPlugin, 'project'),
            prototype: ProcessTagModal.prototype,
          },
          {
            name: 'RenameModal',
            focusesCancel: false,
            modal: new RenameModal(mockApp, mockPlugin, [file]),
            prototype: RenameModal.prototype,
          },
        ];
      }

      // The mock Modal declares open as an instance field, which shadows the subclass's prototype method.
      function openBulk(
        modal: object,
        prototype: { open(): void },
        baseOpen = vi.fn()
      ): void {
        (mockObsidian.Modal.prototype as any).open = baseOpen;
        prototype.open.call(modal);
      }

      it('is a confirmation dialog in every variant', async () => {
        for (const { modal } of await buildEachBulkDialog()) {
          expect(modal).toBeInstanceOf(mockObsidian.ConfirmationModal);
        }
      });

      it("carries FLIT's dialog class in every variant", async () => {
        for (const { name, modal } of await buildEachBulkDialog()) {
          expect({
            name,
            hasClass: modal.containerEl.classList.contains('flit-modal'),
          }).toEqual({ name, hasClass: true });
        }
      });

      it('adds Rename then Cancel before the dialog opens, so its initial focus is read', async () => {
        for (const { modal, prototype } of await buildEachBulkDialog()) {
          let buttonCountAtOpen = -1;
          openBulk(
            modal,
            prototype,
            vi.fn(() => {
              buttonCountAtOpen = buttonEls(modal).length;
            })
          );

          expect(buttonCountAtOpen).toBe(2);
          const [renameButton, cancelButton] = buttonEls(modal);
          expect(renameButton.textContent).toBe('modals.buttons.rename');
          expect(renameButton.classList.contains('mod-cta')).toBe(true);
          expect(cancelButton.textContent).toBe('modals.buttons.cancel');
          expect(cancelButton.classList.contains('mod-cancel')).toBe(true);
        }
      });

      it('focuses Cancel on open only in "Rename all notes"', async () => {
        for (const {
          name,
          focusesCancel,
          modal,
          prototype,
        } of await buildEachBulkDialog()) {
          openBulk(modal, prototype);

          const focusFlags = (modal as unknown as ConfirmationMock).buttons.map(
            (button) => button.hasInitialFocus
          );
          expect({ name, focusFlags }).toEqual({
            name,
            focusFlags: [false, focusesCancel],
          });
        }
      });

      it('runs the rename and closes on Rename', async () => {
        const [{ modal, prototype }] = await buildEachBulkDialog();
        const rename = vi
          .spyOn(modal as any, 'renameFilesToProcess')
          .mockResolvedValue(undefined);
        openBulk(modal, prototype);

        buttonEls(modal)[0].click();
        await flushClicks();

        expect(rename).toHaveBeenCalledTimes(1);
        expect(modal.close).toHaveBeenCalledTimes(1);
      });

      it('closes without renaming on Cancel', async () => {
        const [{ modal, prototype }] = await buildEachBulkDialog();
        const rename = vi
          .spyOn(modal as any, 'renameFilesToProcess')
          .mockResolvedValue(undefined);
        openBulk(modal, prototype);

        buttonEls(modal)[1].click();
        await flushClicks();

        expect(rename).not.toHaveBeenCalled();
        expect(modal.close).toHaveBeenCalledTimes(1);
      });
    });

    describe('DisableEnableModal', () => {
      async function openDisableEnable(action: 'disable' | 'enable') {
        const { DisableEnableModal } = await import('../src/modals');
        const modal = new DisableEnableModal(
          mockApp,
          mockPlugin,
          [new TFile('note.md')],
          action
        );
        const processFiles = vi
          .spyOn(modal as any, 'processFiles')
          .mockResolvedValue(undefined);
        DisableEnableModal.prototype.onOpen.call(modal);
        return { modal, processFiles, buttons: buttonEls(modal) };
      }

      it('is a confirmation dialog with the action as its primary button', async () => {
        const disable = await openDisableEnable('disable');
        const enable = await openDisableEnable('enable');

        expect(disable.modal).toBeInstanceOf(mockObsidian.ConfirmationModal);
        expect(disable.buttons.map((b) => b.textContent)).toEqual([
          'modals.buttons.disable',
          'modals.buttons.cancel',
        ]);
        expect(disable.buttons[0].classList.contains('mod-cta')).toBe(true);
        expect(disable.buttons[1].classList.contains('mod-cancel')).toBe(true);
        expect(enable.buttons[0].textContent).toBe('modals.buttons.enable');
      });

      it("carries FLIT's dialog class", async () => {
        const { modal } = await openDisableEnable('disable');

        expect(modal.containerEl.classList.contains('flit-modal')).toBe(true);
      });

      it('processes the notes and closes on the action button', async () => {
        const { modal, processFiles, buttons } =
          await openDisableEnable('disable');

        buttons[0].click();
        await flushClicks();

        expect(processFiles).toHaveBeenCalledTimes(1);
        expect(modal.close).toHaveBeenCalledTimes(1);
      });

      it('closes without processing on Cancel', async () => {
        const { modal, processFiles, buttons } =
          await openDisableEnable('enable');

        buttons[1].click();
        await flushClicks();

        expect(processFiles).not.toHaveBeenCalled();
        expect(modal.close).toHaveBeenCalledTimes(1);
      });
    });

    describe('InternalLinkModal', () => {
      async function openInternalLink(withDisplayText = false) {
        const { InternalLinkModal } = await import('../src/modals');
        const onSubmit = vi.fn();
        const modal = new InternalLinkModal(
          mockApp,
          mockPlugin,
          onSubmit,
          withDisplayText
        );
        // The mock leaves the title detached, while Obsidian nests it in the header that phones add their buttons to
        modal.modalEl.createDiv('modal-header').appendChild(modal.titleEl);
        InternalLinkModal.prototype.onOpen.call(modal);
        return {
          modal,
          onSubmit,
          input: modal.contentEl.querySelector('input') as HTMLInputElement,
          buttons: buttonEls(modal),
          headerButtons: Array.from(
            modal.modalEl.querySelectorAll<HTMLElement>(
              '.modal-header .modal-header-button'
            )
          ),
        };
      }

      const pressEnter = (input: HTMLInputElement) =>
        input.dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Enter' })
        );

      it('uses the native title and keeps the full-width input', async () => {
        const { modal, input } = await openInternalLink();

        expect(modal).toBeInstanceOf(mockObsidian.ConfirmationModal);
        expect(modal.setTitle).toHaveBeenCalledWith('modals.internalLink');
        expect(modal.contentEl.querySelector('h3')).toBeNull();
        expect(input.classList.contains('flit-link-input-full')).toBe(true);
        expect(
          input.parentElement?.classList.contains('flit-input-container')
        ).toBe(true);
      });

      it("carries FLIT's dialog class", async () => {
        const { modal } = await openInternalLink();

        expect(modal.containerEl.classList.contains('flit-modal')).toBe(true);
      });

      it('adds the link and closes on Add', async () => {
        const { modal, onSubmit, input, buttons } =
          await openInternalLink(true);

        expect(buttons[0].textContent).toBe('modals.buttons.add');
        expect(buttons[0].classList.contains('mod-cta')).toBe(true);
        input.value = ' Target ';
        buttons[0].click();

        expect(onSubmit).toHaveBeenCalledWith('Target', 'Target');
        // Add closes the dialog itself; the async click's second close is a no-op in Obsidian
        expect(modal.close).toHaveBeenCalledTimes(1);
      });

      it('stays open with nothing typed', async () => {
        const { modal, onSubmit, buttons } = await openInternalLink();

        buttons[0].click();
        await flushClicks();

        expect(onSubmit).not.toHaveBeenCalled();
        expect(modal.close).not.toHaveBeenCalled();
      });

      it('adds the link on Enter', async () => {
        const { modal, onSubmit, input } = await openInternalLink();

        input.value = 'Target';
        pressEnter(input);

        expect(onSubmit).toHaveBeenCalledWith('Target', undefined);
        expect(modal.close).toHaveBeenCalledTimes(1);
      });

      it('closes without adding on Cancel', async () => {
        const { modal, onSubmit, input, buttons } = await openInternalLink();

        input.value = 'Target';
        buttons[1].click();
        await flushClicks();

        expect(buttons[1].classList.contains('mod-cancel')).toBe(true);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(modal.close).toHaveBeenCalledTimes(1);
      });

      it('keeps Add and Cancel at the bottom on desktop, with nothing in the header', async () => {
        const { modal, buttons, headerButtons } = await openInternalLink();

        expect(buttons.map((button) => button.textContent)).toEqual([
          'modals.buttons.add',
          'modals.buttons.cancel',
        ]);
        expect(headerButtons).toEqual([]);
        expect(modal.modalEl.classList.contains('flit-header-actions')).toBe(
          false
        );
      });

      describe('on tablets', () => {
        beforeEach(() => {
          mockObsidian.Platform.isMobile = true;
          mockObsidian.Platform.isTablet = true;
        });

        afterEach(() => {
          mockObsidian.Platform.isMobile = false;
          mockObsidian.Platform.isTablet = false;
        });

        it('keeps Add and Cancel at the bottom, with nothing in the header', async () => {
          const { buttons, headerButtons } = await openInternalLink();

          expect(buttons.map((button) => button.textContent)).toEqual([
            'modals.buttons.add',
            'modals.buttons.cancel',
          ]);
          expect(headerButtons).toEqual([]);
        });
      });

      describe('on phones', () => {
        beforeEach(() => {
          mockObsidian.Platform.isPhone = true;
        });

        afterEach(() => {
          mockObsidian.Platform.isPhone = false;
        });

        it('replaces the button row with a close button and a submit button in the header', async () => {
          const { modal, headerButtons } = await openInternalLink();

          expect(
            modal.modalEl.querySelector('.modal-button-container')
          ).toBeNull();
          expect(modal.modalEl.querySelector('button')).toBeNull();
          expect(modal.modalEl.classList.contains('flit-header-actions')).toBe(
            true
          );
          expect(
            Array.from(modal.titleEl.parentElement?.children ?? [])
          ).toEqual([modal.titleEl, ...headerButtons]);
          expect(
            headerButtons.map((button) => [
              button.className,
              button.getAttribute('data-icon'),
            ])
          ).toEqual([
            ['modal-header-button mod-raised clickable-icon mod-start', 'x'],
            [
              'modal-header-button mod-raised clickable-icon mod-cta',
              'lucide-check',
            ],
          ]);
        });

        it('adds the link and closes on the submit button', async () => {
          const { modal, onSubmit, input, headerButtons } =
            await openInternalLink(true);

          input.value = ' Target ';
          headerButtons[1].click();

          expect(onSubmit).toHaveBeenCalledWith('Target', 'Target');
          expect(modal.close).toHaveBeenCalledTimes(1);
        });

        it('stays open when the submit button meets an empty input', async () => {
          const { modal, onSubmit, headerButtons } = await openInternalLink();

          headerButtons[1].click();
          await flushClicks();

          expect(onSubmit).not.toHaveBeenCalled();
          expect(modal.close).not.toHaveBeenCalled();
        });

        it('closes on the close button without adding', async () => {
          const { modal, onSubmit, input, headerButtons } =
            await openInternalLink();

          input.value = 'Target';
          headerButtons[0].click();
          await flushClicks();

          expect(onSubmit).not.toHaveBeenCalled();
          expect(modal.close).toHaveBeenCalledTimes(1);
        });

        it('still adds the link on Enter', async () => {
          const { modal, onSubmit, input } = await openInternalLink();

          input.value = 'Target';
          pressEnter(input);

          expect(onSubmit).toHaveBeenCalledWith('Target', undefined);
          expect(modal.close).toHaveBeenCalledTimes(1);
        });
      });
    });
  });
});
