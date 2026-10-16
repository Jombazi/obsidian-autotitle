import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';
import * as mockObsidian from '../mockObsidian';
import { TFolder } from '../mockObsidian';
import { FolderOperations } from '../../src/operations/folder-operations';
import { EXCLUSION_STRATEGY, PluginSettings } from '../../src/types';
import { createTestSettings } from '../testUtils';

describe('FolderOperations', () => {
  let settings: PluginSettings;
  let saveSettings: Mock<() => Promise<void>>;
  let folderOperations: FolderOperations;

  beforeEach(() => {
    settings = createTestSettings();
    saveSettings = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    folderOperations = new FolderOperations(
      () => settings,
      saveSettings,
      vi.fn()
    );
  });

  describe('toggleFolderExclusion', () => {
    it("adds the folder's entry in the form Obsidian's own dialog writes", async () => {
      await folderOperations.toggleFolderExclusion('Notes/Work', true);

      expect(settings.exclusions.excludedFiles).toEqual(['Notes/Work/']);
      expect(saveSettings).toHaveBeenCalledTimes(1);
    });

    it('adds to an empty list without a placeholder row', async () => {
      settings.exclusions.excludedFiles = [];

      await folderOperations.toggleFolderExclusion('Notes', true);

      expect(settings.exclusions.excludedFiles).toEqual(['Notes/']);
    });

    it('removes the entry, matching it regardless of case', async () => {
      settings.exclusions.excludedFiles = ['/draft-/', 'notes/', 'Archive/'];

      await folderOperations.toggleFolderExclusion('Notes', true);

      expect(settings.exclusions.excludedFiles).toEqual([
        '/draft-/',
        'Archive/',
      ]);
    });

    it('leaves an empty list empty after removing the last entry', async () => {
      settings.exclusions.excludedFiles = ['Notes/'];

      await folderOperations.toggleFolderExclusion('Notes', true);

      expect(settings.exclusions.excludedFiles).toEqual([]);
    });

    it('writes to the settings object the plugin holds now, not the one it held when the operations were built', async () => {
      // Clear settings and Import replace the plugin's settings object wholesale
      const discardedSettings = settings;
      settings = createTestSettings();

      await folderOperations.toggleFolderExclusion('Notes', true);

      expect(settings.exclusions.excludedFiles).toEqual(['Notes/']);
      expect(discardedSettings.exclusions.excludedFiles).toEqual([]);
    });

    it('treats a slash-less prefix entry as a different entry', async () => {
      settings.exclusions.excludedFiles = ['Notes'];

      await folderOperations.toggleFolderExclusion('Notes', true);

      expect(settings.exclusions.excludedFiles).toEqual(['Notes', 'Notes/']);
    });
  });

  describe('toggle notice', () => {
    let noticeMessages: string[];

    beforeEach(() => {
      noticeMessages = [];
      // A regular function, not an arrow: the operations call `new Notice(...)`
      vi.spyOn(mockObsidian, 'Notice').mockImplementation(function (
        message: string
      ) {
        noticeMessages.push(message);
        return { containerEl: document.createElement('div') } as never;
      } as never);
    });

    afterEach(() => {
      vi.mocked(mockObsidian.Notice).mockRestore();
    });

    // Under "Exclude all except..." the list names the folders renaming runs in, so listing a folder enables it there
    it.each([
      [EXCLUSION_STRATEGY.ONLY_EXCLUDE, [], 'Disabled renaming in “Notes”'],
      [
        EXCLUSION_STRATEGY.ONLY_EXCLUDE,
        ['Notes/'],
        'Enabled renaming in “Notes”',
      ],
      [
        EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT,
        [],
        'Enabled renaming in “Notes”',
      ],
      [
        EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT,
        ['Notes/'],
        'Disabled renaming in “Notes”',
      ],
    ])(
      'under %s, starting from %j, says %j',
      async (strategy, excludedFiles, expected) => {
        settings.exclusions.fileScopeStrategy = strategy;
        settings.exclusions.excludedFiles = [...excludedFiles];

        await folderOperations.toggleFolderExclusion('Notes');

        expect(noticeMessages).toEqual([expected]);
      }
    );
  });

  describe('processMultipleFolders', () => {
    const notes = new TFolder('Notes');
    const archive = new TFolder('Archive');
    const vaultRoot = new TFolder('/');

    it('disables renaming by adding each unlisted folder under "Only exclude..."', async () => {
      settings.exclusions.fileScopeStrategy = EXCLUSION_STRATEGY.ONLY_EXCLUDE;
      settings.exclusions.excludedFiles = ['notes/'];

      await folderOperations.processMultipleFolders(
        [notes, archive],
        'disable'
      );

      expect(settings.exclusions.excludedFiles).toEqual(['notes/', 'Archive/']);
    });

    it.each(['disable', 'enable'] as const)(
      'saves once for several folders on %s',
      async (action) => {
        settings.exclusions.fileScopeStrategy = EXCLUSION_STRATEGY.ONLY_EXCLUDE;
        settings.exclusions.excludedFiles =
          action === 'enable' ? ['Notes/', 'Archive/', 'Other/'] : [];
        const other = new TFolder('Other');

        await folderOperations.processMultipleFolders(
          [notes, archive, other],
          action
        );

        expect(settings.exclusions.excludedFiles).toEqual(
          action === 'enable' ? [] : ['Notes/', 'Archive/', 'Other/']
        );
        expect(saveSettings).toHaveBeenCalledTimes(1);
      }
    );

    it('does not save when every folder is already as asked', async () => {
      settings.exclusions.fileScopeStrategy = EXCLUSION_STRATEGY.ONLY_EXCLUDE;
      settings.exclusions.excludedFiles = ['Notes/', 'Archive/'];

      await folderOperations.processMultipleFolders(
        [notes, archive],
        'disable'
      );

      expect(saveSettings).not.toHaveBeenCalled();
    });

    it('enables renaming by removing each listed folder under "Only exclude..."', async () => {
      settings.exclusions.fileScopeStrategy = EXCLUSION_STRATEGY.ONLY_EXCLUDE;
      settings.exclusions.excludedFiles = ['Notes/', '/draft-/'];

      await folderOperations.processMultipleFolders([notes, archive], 'enable');

      expect(settings.exclusions.excludedFiles).toEqual(['/draft-/']);
    });

    it('enables renaming by adding each folder under "Exclude all except..."', async () => {
      settings.exclusions.fileScopeStrategy =
        EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT;
      settings.exclusions.excludedFiles = ['Notes/'];

      await folderOperations.processMultipleFolders([notes, archive], 'enable');

      expect(settings.exclusions.excludedFiles).toEqual(['Notes/', 'Archive/']);
    });

    it('disables renaming by removing each folder under "Exclude all except..."', async () => {
      settings.exclusions.fileScopeStrategy =
        EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT;
      settings.exclusions.excludedFiles = ['Notes/', 'Other/'];

      await folderOperations.processMultipleFolders(
        [notes, archive],
        'disable'
      );

      expect(settings.exclusions.excludedFiles).toEqual(['Other/']);
    });

    describe('summary notice', () => {
      let noticeMessages: string[];

      beforeEach(() => {
        noticeMessages = [];
        // A regular function, not an arrow: the operations call `new Notice(...)`
        vi.spyOn(mockObsidian, 'Notice').mockImplementation(function (
          message: string
        ) {
          noticeMessages.push(message);
          return { containerEl: document.createElement('div') } as never;
        } as never);
        settings.exclusions.fileScopeStrategy = EXCLUSION_STRATEGY.ONLY_EXCLUDE;
        settings.exclusions.excludedFiles = [];
      });

      afterEach(() => {
        vi.mocked(mockObsidian.Notice).mockRestore();
      });

      it.each([
        ['disable', [notes], 'Disabled renaming in 1 folder'],
        ['disable', [notes, archive], 'Disabled renaming in 2 folders'],
        ['enable', [notes], 'Enabled renaming in 1 folder'],
        ['enable', [notes, archive], 'Enabled renaming in 2 folders'],
      ] as const)(
        'counts the folders in the noun on %s: %#',
        async (action, folders, expected) => {
          await folderOperations.processMultipleFolders([...folders], action);

          expect(noticeMessages).toEqual([expected]);
        }
      );
    });

    it.each(['disable', 'enable'] as const)(
      'never writes an entry for the vault root on %s',
      async (action) => {
        settings.exclusions.excludedFiles = [];

        await folderOperations.processMultipleFolders([vaultRoot], action);

        expect(settings.exclusions.excludedFiles).toEqual([]);
      }
    );
  });
});
