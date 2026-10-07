import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { App as ObsidianApp } from 'obsidian';
import { App, TFolder } from '../mockObsidian';
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
      new App() as unknown as ObsidianApp,
      settings,
      saveSettings,
      vi.fn(),
      vi.fn().mockResolvedValue(undefined)
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

    it('treats a slash-less prefix entry as a different entry', async () => {
      settings.exclusions.excludedFiles = ['Notes'];

      await folderOperations.toggleFolderExclusion('Notes', true);

      expect(settings.exclusions.excludedFiles).toEqual(['Notes', 'Notes/']);
    });
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
