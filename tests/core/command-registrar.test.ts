import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App, TFile, Editor } from '../mockObsidian';
import { DEFAULT_SETTINGS } from '../../src/constants';
import { createTestSettings } from '../testUtils';
import { reverseCharacterReplacements } from '../../src/utils/string-processing';

// Mock the i18n module
vi.mock('../../src/i18n', () => ({
  t: vi.fn((key: string) => key),
}));

// Mock the debug log and the filename reversal; the disable-property matcher stays real so the palette cases run the canonical rule against their mocked metadata cache.
vi.mock('../../src/utils', () => ({
  verboseLog: vi.fn(),
}));
vi.mock('../../src/utils/string-processing', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/utils/string-processing')
  >()),
  reverseCharacterReplacements: vi.fn((str: string) => str),
}));

// Mock the modals module.
// In vitest v4, mockImplementation for a class mock must use a regular function
// (not an arrow function) so the mock is constructable with `new`.
const mockModalOpen = vi.fn();
vi.mock('../../src/modals', () => ({
  RenameAllFilesModal: vi.fn().mockImplementation(function () {
    return { open: mockModalOpen };
  }),
}));

describe('CommandRegistrar', () => {
  let mockPlugin: any;
  let mockApp: App;

  beforeEach(() => {
    vi.clearAllMocks();

    mockApp = new App();
    mockPlugin = {
      app: mockApp,
      settings: createTestSettings(),
      addCommand: vi.fn(),
      renameEngine: {
        processFile: vi.fn().mockResolvedValue(undefined),
      },
      linkManager: {
        addSafeInternalLink: vi.fn(),
        addSafeInternalLinkWithDisplayText: vi.fn(),
        addInternalLinkWithDisplayTextAndCustomTarget: vi.fn(),
      },
      saveSettings: vi.fn().mockResolvedValue(undefined),
      refreshSettingsTab: vi.fn(),
      setRenamingDisabledForNote: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('registerCommands', () => {
    it('should register all 10 commands', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      registrar.registerCommands();

      expect(mockPlugin.addCommand).toHaveBeenCalledTimes(10);
    });

    it('should register rename-current-file command with correct icon', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'rename-current-file'
      );
      expect(command).toBeDefined();
      expect(command[0].icon).toBe('file-type-corner');
    });

    it('should register rename-current-file-unless-excluded command', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'rename-current-file-unless-excluded'
      );
      expect(command).toBeDefined();
      expect(command[0].icon).toBe('file-type-corner');
    });

    it('should register rename-all-files command with file-stack icon', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'rename-all-files'
      );
      expect(command).toBeDefined();
      expect(command[0].icon).toBe('file-stack');
    });

    it('should register toggle-automatic-renaming command with file-cog icon', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'toggle-automatic-renaming'
      );
      expect(command).toBeDefined();
      expect(command[0].icon).toBe('file-cog');
    });
  });

  describe('link commands registration', () => {
    it('should register add-safe-internal-link command', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'add-safe-internal-link'
      );
      expect(command).toBeDefined();
      expect(command[0].icon).toBe('link');
    });

    it('should register add-safe-internal-link-with-display-text command', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) =>
          call[0].id === 'add-safe-internal-link-with-display-text'
      );
      expect(command).toBeDefined();
      expect(command[0].icon).toBe('link');
    });

    it('should register add-internal-link-with-display-text-and-custom-target command', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) =>
          call[0].id === 'add-internal-link-with-display-text-and-custom-target'
      );
      expect(command).toBeDefined();
      expect(command[0].icon).toBe('link');
    });

    it('should hand the command editor to addSafeInternalLink', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'add-safe-internal-link'
      );

      const editor = new Editor();
      command[0].editorCallback(editor, {});

      expect(mockPlugin.linkManager.addSafeInternalLink).toHaveBeenCalledWith(
        editor
      );
    });

    it('should hand the command editor to addSafeInternalLinkWithDisplayText', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) =>
          call[0].id === 'add-safe-internal-link-with-display-text'
      );

      const editor = new Editor();
      command[0].editorCallback(editor, {});

      expect(
        mockPlugin.linkManager.addSafeInternalLinkWithDisplayText
      ).toHaveBeenCalledWith(editor);
    });

    it('should hand the command editor to addInternalLinkWithDisplayTextAndCustomTarget', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) =>
          call[0].id === 'add-internal-link-with-display-text-and-custom-target'
      );

      const editor = new Editor();
      command[0].editorCallback(editor, {});

      expect(
        mockPlugin.linkManager.addInternalLinkWithDisplayTextAndCustomTarget
      ).toHaveBeenCalledWith(editor);
    });
  });

  describe('rename-all-files command', () => {
    it('should open RenameAllFilesModal when executed', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'rename-all-files'
      );

      // Execute the callback
      command[0].callback();

      expect(mockModalOpen).toHaveBeenCalled();
    });
  });

  describe('executeRenameCurrentFile', () => {
    it('should not call processFile when no active file', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      (mockApp.workspace as any).activeEditor = null;

      await registrar.executeRenameCurrentFile();

      expect(mockPlugin.renameEngine.processFile).not.toHaveBeenCalled();
    });

    it('should call processFile with exclusion overrides for Markdown files', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test.md');
      const mockEditor = new Editor();
      (mockApp.workspace as any).activeEditor = {
        file: mockFile,
        editor: mockEditor,
      };

      await registrar.executeRenameCurrentFile();

      expect(mockPlugin.renameEngine.processFile).toHaveBeenCalledWith(
        mockFile,
        {
          isManualCommand: true,
          exclusionOverrides: {
            ignoreExcludedFiles: true,
            ignoreExcludedTags: true,
            ignoreExcludedProperties: true,
          },
          hasActiveEditor: true,
          editor: mockEditor,
        }
      );
    });

    // A focused footnote preview is a section embed whose editor holds the footnote alone, which would rename the note after it.
    it('should pass no editor when the active editor shows one section of the note', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test.md');
      (mockApp.workspace as any).activeEditor = {
        file: mockFile,
        editor: new Editor(),
        subpath: '#[^1]',
      };

      await registrar.executeRenameCurrentFile();

      expect(mockPlugin.renameEngine.processFile).toHaveBeenCalledWith(
        mockFile,
        {
          isManualCommand: true,
          exclusionOverrides: {
            ignoreExcludedFiles: true,
            ignoreExcludedTags: true,
            ignoreExcludedProperties: true,
          },
          hasActiveEditor: true,
          editor: undefined,
        }
      );
    });

    it('should pass the editor of an embed showing the whole note', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test.md');
      const mockEditor = new Editor();
      (mockApp.workspace as any).activeEditor = {
        file: mockFile,
        editor: mockEditor,
        subpath: '',
      };

      await registrar.executeRenameCurrentFile();

      expect(mockPlugin.renameEngine.processFile.mock.calls[0][1].editor).toBe(
        mockEditor
      );
    });

    it('should ignore non-Markdown files', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test.txt');
      mockFile.extension = 'txt';
      (mockApp.workspace as any).activeEditor = {
        file: mockFile,
        editor: new Editor(),
      };

      await registrar.executeRenameCurrentFile();

      expect(mockPlugin.renameEngine.processFile).not.toHaveBeenCalled();
    });
  });

  describe('executeRenameUnlessExcluded', () => {
    it('should call processFile without exclusion overrides', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test.md');
      const mockEditor = new Editor();
      (mockApp.workspace as any).activeEditor = {
        file: mockFile,
        editor: mockEditor,
      };

      await registrar.executeRenameUnlessExcluded();

      expect(mockPlugin.renameEngine.processFile).toHaveBeenCalledWith(
        mockFile,
        {
          isManualCommand: true,
          hasActiveEditor: true,
          editor: mockEditor,
        }
      );
    });

    it('should pass no editor when the active editor shows one section of the note', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      (mockApp.workspace as any).activeEditor = {
        file: new TFile('test.md'),
        editor: new Editor(),
        subpath: '#Heading',
      };

      await registrar.executeRenameUnlessExcluded();

      expect(
        mockPlugin.renameEngine.processFile.mock.calls[0][1].editor
      ).toBeUndefined();
    });

    it('should not call processFile when no active file', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      (mockApp.workspace as any).activeEditor = null;

      await registrar.executeRenameUnlessExcluded();

      expect(mockPlugin.renameEngine.processFile).not.toHaveBeenCalled();
    });
  });

  describe('executeToggleAutomaticRenaming', () => {
    it('should toggle from automatic to manual', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      mockPlugin.settings.core.renameAutomatically = true;

      await registrar.executeToggleAutomaticRenaming();

      expect(mockPlugin.settings.core.renameAutomatically).toBe(false);
      expect(mockPlugin.saveSettings).toHaveBeenCalled();
    });

    it('should toggle from manual to automatic', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      mockPlugin.settings.core.renameAutomatically = false;

      await registrar.executeToggleAutomaticRenaming();

      expect(mockPlugin.settings.core.renameAutomatically).toBe(true);
      expect(mockPlugin.saveSettings).toHaveBeenCalled();
    });

    it('should refresh the settings tab after saving', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);
      const order: string[] = [];
      mockPlugin.saveSettings.mockImplementation(() => {
        order.push('save');
        return Promise.resolve();
      });
      mockPlugin.refreshSettingsTab.mockImplementation(() => {
        order.push('refresh');
      });

      await registrar.executeToggleAutomaticRenaming();

      expect(order).toEqual(['save', 'refresh']);
    });

    it('should run the toggle command through executeToggleAutomaticRenaming', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);
      const executeSpy = vi.spyOn(registrar, 'executeToggleAutomaticRenaming');
      mockPlugin.settings.core.renameAutomatically = true;

      registrar.registerCommands();
      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'toggle-automatic-renaming'
      );
      await command[0].callback();

      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(mockPlugin.settings.core.renameAutomatically).toBe(false);
      expect(mockPlugin.saveSettings).toHaveBeenCalled();
      expect(mockPlugin.refreshSettingsTab).toHaveBeenCalled();
    });
  });

  describe('checkCallback commands', () => {
    it('disable-renaming command should show when renaming is not disabled', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test.md');
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(mockFile);
      mockApp.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: {},
      });

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'disable-renaming-for-note'
      );

      const checkResult = command[0].checkCallback(true);
      expect(checkResult).toBe(true);
    });

    it('disable-renaming command should not show when renaming is disabled', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test.md');
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(mockFile);
      mockApp.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: {
          [DEFAULT_SETTINGS.exclusions.disableRenamingKey]: true,
        },
      });

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'disable-renaming-for-note'
      );

      const checkResult = command[0].checkCallback(true);
      expect(checkResult).toBe(false);
    });

    it('enable-renaming command should show when renaming is disabled', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test.md');
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(mockFile);
      mockApp.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: {
          [DEFAULT_SETTINGS.exclusions.disableRenamingKey]: true,
        },
      });

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'enable-renaming-for-note'
      );

      const checkResult = command[0].checkCallback(true);
      expect(checkResult).toBe(true);
    });

    it('enable-renaming command should not show when renaming is not disabled', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test.md');
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(mockFile);
      mockApp.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: {},
      });

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'enable-renaming-for-note'
      );

      const checkResult = command[0].checkCallback(true);
      expect(checkResult).toBe(false);
    });

    it('disable-renaming command should show and enable-renaming should not when the property is false', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test.md');
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(mockFile);
      mockApp.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: {
          [DEFAULT_SETTINGS.exclusions.disableRenamingKey]: false,
        },
      });

      registrar.registerCommands();

      const disableCommand = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'disable-renaming-for-note'
      );
      const enableCommand = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'enable-renaming-for-note'
      );

      expect(disableCommand[0].checkCallback(true)).toBe(true);
      expect(enableCommand[0].checkCallback(true)).toBe(false);
    });

    it('enable-renaming command should show and disable-renaming should not when the key differs in case', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test.md');
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(mockFile);
      mockApp.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: {
          'No Rename': true,
        },
      });

      registrar.registerCommands();

      const disableCommand = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'disable-renaming-for-note'
      );
      const enableCommand = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'enable-renaming-for-note'
      );

      expect(enableCommand[0].checkCallback(true)).toBe(true);
      expect(disableCommand[0].checkCallback(true)).toBe(false);
    });

    it('disable-renaming command should call plugin method when executed', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test.md');
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(mockFile);
      mockApp.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: {},
      });

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'disable-renaming-for-note'
      );

      // Execute (not just check)
      command[0].checkCallback(false);

      expect(mockPlugin.setRenamingDisabledForNote).toHaveBeenCalledWith(
        mockFile,
        true
      );
    });

    it.each(['rename-current-file', 'rename-current-file-unless-excluded'])(
      '%s passes no editor when the active editor shows one section of the note',
      async (commandId) => {
        const { CommandRegistrar } =
          await import('../../src/core/command-registrar');
        const registrar = new CommandRegistrar(mockPlugin);
        (mockApp.workspace as any).activeEditor = {
          file: new TFile('test.md'),
          editor: new Editor(),
          subpath: '#[^1]',
        };

        registrar.registerCommands();
        const command = mockPlugin.addCommand.mock.calls.find(
          (call: any[]) => call[0].id === commandId
        );
        command[0].checkCallback(false);

        expect(
          mockPlugin.renameEngine.processFile.mock.calls[0][1].editor
        ).toBeUndefined();
      }
    );

    it.each(['rename-current-file', 'rename-current-file-unless-excluded'])(
      '%s is hidden from the palette while no Markdown note is active',
      async (commandId) => {
        const { CommandRegistrar } =
          await import('../../src/core/command-registrar');
        const registrar = new CommandRegistrar(mockPlugin);
        (mockApp.workspace as any).activeEditor = {
          file: new TFile('board.canvas'),
          editor: new Editor(),
        };

        registrar.registerCommands();
        const command = mockPlugin.addCommand.mock.calls.find(
          (call: any[]) => call[0].id === commandId
        );

        expect(command[0].checkCallback(true)).toBe(false);
        expect(command[0].checkCallback(false)).toBe(false);
        expect(mockPlugin.renameEngine.processFile).not.toHaveBeenCalled();
      }
    );

    it.each([
      [
        'rename-current-file',
        {
          ignoreExcludedFiles: true,
          ignoreExcludedTags: true,
          ignoreExcludedProperties: true,
        },
      ],
      ['rename-current-file-unless-excluded', undefined],
    ])(
      '%s run from the palette renames the active note with the same exclusions as its ribbon twin',
      async (commandId, exclusionOverrides) => {
        const { CommandRegistrar } =
          await import('../../src/core/command-registrar');
        const registrar = new CommandRegistrar(mockPlugin);
        const file = new TFile('test.md');
        (mockApp.workspace as any).activeEditor = {
          file,
          editor: new Editor(),
        };

        registrar.registerCommands();
        const command = mockPlugin.addCommand.mock.calls.find(
          (call: any[]) => call[0].id === commandId
        );
        command[0].checkCallback(false);

        const [renamedFile, options] =
          mockPlugin.renameEngine.processFile.mock.calls[0];
        expect(renamedFile).toBe(file);
        expect(options.exclusionOverrides).toEqual(exclusionOverrides);
      }
    );

    it('enable-renaming command should call plugin method when executed', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test.md');
      mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(mockFile);
      mockApp.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: {
          [DEFAULT_SETTINGS.exclusions.disableRenamingKey]: true,
        },
      });

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'enable-renaming-for-note'
      );

      command[0].checkCallback(false);

      expect(mockPlugin.setRenamingDisabledForNote).toHaveBeenCalledWith(
        mockFile,
        false
      );
    });
  });

  describe('insert-filename command', () => {
    it('should register with clipboard-type icon', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'insert-filename'
      );
      expect(command).toBeDefined();
      expect(command[0].icon).toBe('clipboard-type');
    });

    it('should return true when checking with Markdown file', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test-file.md');
      const mockEditor = new Editor();
      const mockView = { file: mockFile };

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'insert-filename'
      );

      const checkResult = command[0].editorCheckCallback(
        true,
        mockEditor,
        mockView
      );
      expect(checkResult).toBe(true);
    });

    it('should return false when checking with non-Markdown file', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test-file.txt');
      mockFile.extension = 'txt';
      const mockEditor = new Editor();
      const mockView = { file: mockFile };

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'insert-filename'
      );

      const checkResult = command[0].editorCheckCallback(
        true,
        mockEditor,
        mockView
      );
      expect(checkResult).toBe(false);
    });

    it('should insert filename when executed', async () => {
      const { CommandRegistrar } =
        await import('../../src/core/command-registrar');
      const registrar = new CommandRegistrar(mockPlugin);

      const mockFile = new TFile('test-file.md');
      const mockEditor = new Editor();
      const mockView = { file: mockFile };

      registrar.registerCommands();

      const command = mockPlugin.addCommand.mock.calls.find(
        (call: any[]) => call[0].id === 'insert-filename'
      );

      command[0].editorCheckCallback(false, mockEditor, mockView);
      expect(mockEditor.replaceSelection).toHaveBeenCalled();
    });

    describe('replacement character conversion', () => {
      beforeEach(async () => {
        // The real reversal, so the inserted text shows what a user would get
        const actual = await vi.importActual<
          typeof import('../../src/utils/string-processing')
        >('../../src/utils/string-processing');
        vi.mocked(reverseCharacterReplacements).mockImplementation(
          actual.reverseCharacterReplacements
        );
      });

      afterEach(() => {
        // Back to the pass-through the other cases rely on
        vi.mocked(reverseCharacterReplacements).mockReset();
      });

      const runInsertFilename = async () => {
        const { CommandRegistrar } =
          await import('../../src/core/command-registrar');
        const registrar = new CommandRegistrar(mockPlugin);
        const mockEditor = new Editor();
        const mockView = { file: new TFile('a⧵b․c.md') };

        registrar.registerCommands();
        const command = mockPlugin.addCommand.mock.calls.find(
          (call: any[]) => call[0].id === 'insert-filename'
        );
        command[0].editorCheckCallback(false, mockEditor, mockView);
        return mockEditor.replaceSelection;
      };

      // Title conversion governs title insertion only
      it('converts with Character replacements on, even with title conversion off', async () => {
        mockPlugin.settings.characterReplacements.enableForbiddenCharReplacements = true;
        mockPlugin.settings.core.convertReplacementChars = false;

        expect(await runInsertFilename()).toHaveBeenCalledWith('a\\b.c');
      });

      it('does not convert with Character replacements off', async () => {
        mockPlugin.settings.characterReplacements.enableForbiddenCharReplacements = false;
        mockPlugin.settings.core.convertReplacementChars = true;

        expect(await runInsertFilename()).toHaveBeenCalledWith('a⧵b․c');
      });
    });
  });
});
