import { describe, it, expect } from 'vitest';
import { createTestSettings } from './testUtils';
import { DEFAULT_SETTINGS } from '../src/constants';

describe('createTestSettings', () => {
  it('should isolate nested state from DEFAULT_SETTINGS and from other instances', () => {
    // Captured before any mutation so the assertions compare against the pristine
    // defaults rather than whatever the mutation may have leaked into them.
    const pristineExcludedFiles = [
      ...DEFAULT_SETTINGS.exclusions.excludedFiles,
    ];
    const pristineExcludedTagCount =
      DEFAULT_SETTINGS.exclusions.excludedTags.length;

    const first = createTestSettings();
    const second = createTestSettings();

    expect(first.exclusions).not.toBe(DEFAULT_SETTINGS.exclusions);
    expect(first.exclusions).not.toBe(second.exclusions);
    expect(first.core).not.toBe(DEFAULT_SETTINGS.core);
    expect(first.core).not.toBe(second.core);

    first.exclusions.excludedFiles = ['Notes/'];
    first.exclusions.excludedTags.push('#draft');

    expect(DEFAULT_SETTINGS.exclusions.excludedFiles).toEqual(
      pristineExcludedFiles
    );
    expect(DEFAULT_SETTINGS.exclusions.excludedTags).toHaveLength(
      pristineExcludedTagCount
    );
    expect(second.exclusions.excludedFiles).toEqual(pristineExcludedFiles);
    expect(second.exclusions.excludedTags).toHaveLength(
      pristineExcludedTagCount
    );
  });

  it('should merge overrides per leaf, keeping untouched siblings at their defaults', () => {
    const settings = createTestSettings({
      core: {
        insertTitle: true,
      },
    });

    expect(settings.core.insertTitle).toBe(true);
    expect(settings.core.renameAutomatically).toBe(
      DEFAULT_SETTINGS.core.renameAutomatically
    );
    expect(settings.core.charCount).toBe(DEFAULT_SETTINGS.core.charCount);
    expect(settings.exclusions).not.toBe(DEFAULT_SETTINGS.exclusions);
  });

  it('should replace arrays wholesale rather than merging them item by item', () => {
    const settings = createTestSettings({
      exclusions: {
        excludedFiles: ['Notes/', 'Archive/'],
      },
    });

    expect(settings.exclusions.excludedFiles).toEqual(['Notes/', 'Archive/']);
    expect(settings.exclusions.fileScopeStrategy).toBe(
      DEFAULT_SETTINGS.exclusions.fileScopeStrategy
    );
  });
});
