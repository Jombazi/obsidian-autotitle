import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from '../mockObsidian';
import { createTestSettings } from '../testUtils';

// Mock the i18n module
vi.mock('../../src/i18n', () => ({
  t: vi.fn((key: string) => key),
}));

// Mock the utils module
vi.mock('../../src/utils', () => ({
  verboseLog: vi.fn(),
}));

// Mock the modals module.
// In vitest v4, mockImplementation for a class mock must use a regular function
// (not an arrow function) so the mock is constructable with `new`.
vi.mock('../../src/modals', () => ({
  RenameAllFilesModal: vi.fn().mockImplementation(function () {
    return { open: vi.fn() };
  }),
}));

// Mock monkey-around
vi.mock('monkey-around', () => ({
  around: vi.fn((obj, patches) => {
    // Apply patches and return cleanup function
    return vi.fn();
  }),
}));

// Mock file-creation-coordinator.
// In vitest v4, mockImplementation for a class mock must use a regular function
// (not an arrow function) so the mock is constructable with `new`.
vi.mock('../../src/core/file-creation-coordinator', () => ({
  FileCreationCoordinator: vi.fn().mockImplementation(function () {
    return {
      determineActions: vi.fn().mockResolvedValue({
        shouldInsertTitle: false,
        shouldMoveCursor: false,
        placeCursorAtEnd: false,
        viewLagsFile: false,
      }),
    };
  }),
}));

describe('WorkspaceIntegration', () => {
  let mockPlugin: any;
  let mockApp: App;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockApp = new App();
    mockPlugin = {
      app: mockApp,
      settings: createTestSettings(),
      addRibbonIcon: vi.fn(),
      registerEvent: vi.fn(),
      commandRegistrar: {
        executeRenameCurrentFile: vi.fn().mockResolvedValue(undefined),
        executeToggleAutomaticRenaming: vi.fn().mockResolvedValue(undefined),
        executeRenameUnlessExcluded: vi.fn().mockResolvedValue(undefined),
      },
      renameEngine: {
        processFile: vi.fn().mockResolvedValue(undefined),
      },
      fileOperations: {
        insertTitle: vi.fn().mockResolvedValue(undefined),
        handleCursorPositioning: vi.fn().mockResolvedValue(undefined),
      },
      editorLifecycle: {
        clearCreationDelayTimer: vi.fn(),
        setCreationDelayTimer: vi.fn(),
        clearAllCreationDelayTimers: vi.fn(),
      },
      isFullyLoaded: true,
      pluginLoadTime: Date.now() - 10000,
      fileStateManager: {
        wasRecentlyRenamedInto: vi.fn().mockReturnValue(false),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('registerRibbonIcons', () => {
    it('should register both ribbon icons', async () => {
      const { WorkspaceIntegration } =
        await import('../../src/core/workspace-integration');
      const integration = new WorkspaceIntegration(mockPlugin);

      integration.registerRibbonIcons();

      expect(mockPlugin.addRibbonIcon).toHaveBeenCalledTimes(2);
    });

    it('should register file-type-corner icon for rename', async () => {
      const { WorkspaceIntegration } =
        await import('../../src/core/workspace-integration');
      const integration = new WorkspaceIntegration(mockPlugin);

      integration.registerRibbonIcons();

      expect(mockPlugin.addRibbonIcon).toHaveBeenCalledWith(
        'file-type-corner',
        'commands.putFirstLineInTitle',
        expect.any(Function)
      );
    });

    it('no longer registers a bulk-rename icon, which moved to the command palette only', async () => {
      const { WorkspaceIntegration } =
        await import('../../src/core/workspace-integration');
      const integration = new WorkspaceIntegration(mockPlugin);

      integration.registerRibbonIcons();

      expect(mockPlugin.addRibbonIcon).not.toHaveBeenCalledWith(
        'file-stack',
        expect.anything(),
        expect.anything()
      );
    });

    it('should register file-cog icon for toggle', async () => {
      const { WorkspaceIntegration } =
        await import('../../src/core/workspace-integration');
      const integration = new WorkspaceIntegration(mockPlugin);

      integration.registerRibbonIcons();

      expect(mockPlugin.addRibbonIcon).toHaveBeenCalledWith(
        'file-cog',
        'commands.toggleAutomaticRenaming',
        expect.any(Function)
      );
    });

    it('should call executeRenameCurrentFile when file-type-corner ribbon is clicked', async () => {
      const { WorkspaceIntegration } =
        await import('../../src/core/workspace-integration');
      const integration = new WorkspaceIntegration(mockPlugin);

      integration.registerRibbonIcons();

      // Get the callback for file-type-corner icon
      const filePenCall = mockPlugin.addRibbonIcon.mock.calls.find(
        (call: any[]) => call[0] === 'file-type-corner'
      );
      const callback = filePenCall[2];

      // Execute callback
      callback();

      expect(
        mockPlugin.commandRegistrar.executeRenameCurrentFile
      ).toHaveBeenCalled();
    });

    it('should call executeToggleAutomaticRenaming when file-cog ribbon is clicked', async () => {
      const { WorkspaceIntegration } =
        await import('../../src/core/workspace-integration');
      const integration = new WorkspaceIntegration(mockPlugin);

      integration.registerRibbonIcons();

      // Get the callback for file-cog icon
      const fileCogCall = mockPlugin.addRibbonIcon.mock.calls.find(
        (call: any[]) => call[0] === 'file-cog'
      );
      const callback = fileCogCall[2];

      // Execute callback
      callback();

      expect(
        mockPlugin.commandRegistrar.executeToggleAutomaticRenaming
      ).toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('should clear all creation delay timers on cleanup', async () => {
      const { WorkspaceIntegration } =
        await import('../../src/core/workspace-integration');
      const integration = new WorkspaceIntegration(mockPlugin);

      integration.cleanup();

      expect(
        mockPlugin.editorLifecycle.clearAllCreationDelayTimers
      ).toHaveBeenCalled();
    });
  });

  describe('setupSaveEventHook', () => {
    it('should setup save event hook when command exists', async () => {
      const { WorkspaceIntegration } =
        await import('../../src/core/workspace-integration');
      const integration = new WorkspaceIntegration(mockPlugin);

      // Add save command to existing commands object
      mockApp.commands.commands['editor:save-file'] = {
        id: 'editor:save-file',
        name: 'Save current file',
        checkCallback: vi.fn(),
      };

      integration.setupSaveEventHook();

      // The around function should have been called
      const { around } = await import('monkey-around');
      expect(around).toHaveBeenCalled();
    });

    it('should not setup hook when command does not exist', async () => {
      const { WorkspaceIntegration } =
        await import('../../src/core/workspace-integration');
      const integration = new WorkspaceIntegration(mockPlugin);

      // commands.commands is empty by default from mock

      integration.setupSaveEventHook();

      // Should not crash
      const { around } = await import('monkey-around');
      expect(around).not.toHaveBeenCalled();
    });
  });

  describe('setupNewNotePipeline', () => {
    it('should wait for layout ready before setting up', async () => {
      const { WorkspaceIntegration } =
        await import('../../src/core/workspace-integration');
      const integration = new WorkspaceIntegration(mockPlugin);

      // onLayoutReady is now built into the mock Workspace

      integration.setupNewNotePipeline();

      expect(mockApp.workspace.onLayoutReady).toHaveBeenCalled();
    });

    it('should register vault create event', async () => {
      const { WorkspaceIntegration } =
        await import('../../src/core/workspace-integration');
      const integration = new WorkspaceIntegration(mockPlugin);

      // onLayoutReady calls callback immediately (built into mock)

      integration.setupNewNotePipeline();

      expect(mockPlugin.registerEvent).toHaveBeenCalled();
    });
  });
});
