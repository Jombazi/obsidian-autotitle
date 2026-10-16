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
import { TagOperations } from '../../src/operations/tag-operations';
import { EXCLUSION_STRATEGY, PluginSettings } from '../../src/types';
import { createTestSettings } from '../testUtils';

describe('TagOperations', () => {
  let settings: PluginSettings;
  let saveSettings: Mock<() => Promise<void>>;
  let tagOperations: TagOperations;

  beforeEach(() => {
    settings = createTestSettings();
    settings.exclusions.tagScopeStrategy = EXCLUSION_STRATEGY.ONLY_EXCLUDE;
    saveSettings = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    tagOperations = new TagOperations(() => settings, saveSettings, vi.fn());
  });

  describe('toggleTagExclusion', () => {
    it('adds the tag with its "#" to an empty list without a placeholder row', async () => {
      settings.exclusions.excludedTags = [];

      await tagOperations.toggleTagExclusion('project');

      expect(settings.exclusions.excludedTags).toEqual(['#project']);
      expect(saveSettings).toHaveBeenCalledTimes(1);
    });

    it('removes an entry written without the "#" rather than adding a duplicate', async () => {
      settings.exclusions.excludedTags = ['project', '#archive'];

      await tagOperations.toggleTagExclusion('#project');

      expect(settings.exclusions.excludedTags).toEqual(['#archive']);
    });

    it('removes every entry with the same tag, so none leaves it listed', async () => {
      settings.exclusions.excludedTags = ['#project', 'Project', '#archive'];

      await tagOperations.toggleTagExclusion('project');

      expect(settings.exclusions.excludedTags).toEqual(['#archive']);
    });

    it('leaves a pattern entry in place when enabling renaming for a tag it covers', async () => {
      settings.exclusions.excludedTags = ['/^draft/', '#draft'];

      await tagOperations.toggleTagExclusion('draft');

      expect(settings.exclusions.excludedTags).toEqual(['/^draft/']);
    });

    // Obsidian accepts a tag written `#/x/`, whose plain entry must not stand for the pattern `/x/`
    it('leaves the pattern /x/ in place when enabling renaming for a tag written #/x/', async () => {
      settings.exclusions.excludedTags = ['/x/', '#/x/'];

      await tagOperations.toggleTagExclusion('#/x/');

      expect(settings.exclusions.excludedTags).toEqual(['/x/']);
    });

    it('leaves an empty list empty after removing the last entry', async () => {
      settings.exclusions.excludedTags = ['#project'];

      await tagOperations.toggleTagExclusion('project');

      expect(settings.exclusions.excludedTags).toEqual([]);
    });

    it('appends after a stray blank entry instead of replacing it', async () => {
      settings.exclusions.excludedTags = [''];

      await tagOperations.toggleTagExclusion('project');

      expect(settings.exclusions.excludedTags).toEqual(['', '#project']);
    });

    it('writes to the settings object the plugin holds now, not the one it held when the operations were built', async () => {
      // Clear settings and Import replace the plugin's settings object wholesale
      const discardedSettings = settings;
      settings = createTestSettings();

      await tagOperations.toggleTagExclusion('project');

      expect(settings.exclusions.excludedTags).toEqual(['#project']);
      expect(discardedSettings.exclusions.excludedTags).toEqual([]);
    });
  });

  describe('notice', () => {
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

    // Under "Exclude all except..." the list names the tags renaming runs in, so listing a tag enables it there
    it.each([
      [EXCLUSION_STRATEGY.ONLY_EXCLUDE, [], 'Disabled renaming for #project'],
      [
        EXCLUSION_STRATEGY.ONLY_EXCLUDE,
        ['#project'],
        'Enabled renaming for #project',
      ],
      [
        EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT,
        [],
        'Enabled renaming for #project',
      ],
      [
        EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT,
        ['#project'],
        'Disabled renaming for #project',
      ],
    ])(
      'under %s, starting from %j, says %j',
      async (strategy, excludedTags, expected) => {
        settings.exclusions.tagScopeStrategy = strategy;
        settings.exclusions.excludedTags = [...excludedTags];

        await tagOperations.toggleTagExclusion('project');

        expect(noticeMessages).toEqual([expected]);
      }
    );
  });
});
