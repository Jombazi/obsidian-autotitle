import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  compileExcludedFileFilters,
  fileHasExcludedProperties,
  isPathExcludedByFileRules,
  shouldProcessFile,
  isFolderFullyExcludedByFileRules,
  isTagFullyExcludedByTagRules,
} from '../../src/utils/file-exclusions';
import {
  createTestSettings,
  createMockFile,
  createMockApp,
} from '../testUtils';
import { EXCLUSION_STRATEGY, PluginSettings } from '../../src/types';
import { App, TFolder } from '../mockObsidian';

describe('file-exclusions', () => {
  let settings: PluginSettings;
  let app: App;

  beforeEach(() => {
    settings = createTestSettings();
    app = createMockApp();
  });

  // Each case pins Obsidian 1.14.4's own Excluded files behavior (MetadataCache.updateUserIgnoreFilters)
  describe('compileExcludedFileFilters', () => {
    const matches = (entries: string[], path: string): boolean =>
      compileExcludedFileFilters(entries).some((filter) => filter.test(path));

    describe('path prefixes', () => {
      it('should cover every note under a folder entry', () => {
        expect(matches(['Notes/'], 'Notes/a.md')).toBe(true);
        expect(matches(['Notes/'], 'Notes/a/b.md')).toBe(true);
        expect(matches(['Notes/'], 'Other/Notes/a.md')).toBe(false);
      });

      it('should match a prefix without a slash beyond the folder, as Obsidian does', () => {
        expect(matches(['Notes'], 'Notes/a.md')).toBe(true);
        expect(matches(['Notes'], 'Notes 2/x.md')).toBe(true);
        expect(matches(['Notes'], 'Notes.md')).toBe(true);
      });

      it('should ignore case', () => {
        expect(matches(['notes/'], 'Notes/a.md')).toBe(true);
        expect(matches(['NOTES/'], 'notes/a.md')).toBe(true);
      });

      it('should treat regex metacharacters in a path literally', () => {
        expect(matches(['Notes (old)/'], 'Notes (old)/a.md')).toBe(true);
        expect(matches(['a.b/'], 'aXb/c.md')).toBe(false);
        expect(matches(['[draft]'], '[draft] a.md')).toBe(true);
      });

      it('should match a full note path entry', () => {
        expect(matches(['Notes/a.md'], 'Notes/a.md')).toBe(true);
        expect(matches(['Notes/a.md'], 'Notes/b.md')).toBe(false);
      });

      it('should trim entries and skip blank ones', () => {
        expect(compileExcludedFileFilters(['', '   '])).toHaveLength(0);
        expect(matches(['  Notes/  '], 'Notes/a.md')).toBe(true);
      });
    });

    describe('regular expressions', () => {
      it('should match a slash-wrapped entry anywhere in the path, ignoring case', () => {
        expect(matches(['/draft-/'], 'Notes/draft-a.md')).toBe(true);
        expect(matches(['/draft-/'], 'DRAFT-b.md')).toBe(true);
        expect(matches(['/draft-/'], 'Notes/final.md')).toBe(false);
      });

      it('should honor regex syntax inside the slashes', () => {
        expect(matches(['/^daily-\\d+/'], 'daily-12.md')).toBe(true);
        expect(matches(['/^daily-\\d+/'], 'Notes/daily-12.md')).toBe(false);
      });

      it('should read a three-character entry as a regex and `//` as a plain prefix', () => {
        expect(matches(['/a/'], 'Notes/a.md')).toBe(true);
        expect(matches(['/a/'], 'b.md')).toBe(false);
        // `//` is a literal prefix no vault path starts with
        expect(matches(['//'], 'Notes/a.md')).toBe(false);
        expect(matches(['//'], '//a.md')).toBe(true);
      });

      it('should skip an entry whose regex does not compile', () => {
        expect(
          compileExcludedFileFilters(['/[unclosed/', 'Notes/'])
        ).toHaveLength(1);
        expect(matches(['/[unclosed/'], '[unclosed.md')).toBe(false);
      });
    });
  });

  describe('isPathExcludedByFileRules', () => {
    describe('"Only exclude..." strategy', () => {
      beforeEach(() => {
        settings.exclusions.fileScopeStrategy = EXCLUSION_STRATEGY.ONLY_EXCLUDE;
      });

      it('should exclude nothing when the list is empty', () => {
        settings.exclusions.excludedFiles = [];
        expect(isPathExcludedByFileRules('Notes/a.md', settings)).toBe(false);
      });

      it('should exclude matching paths only', () => {
        settings.exclusions.excludedFiles = ['Archive/', '/draft-/'];
        expect(isPathExcludedByFileRules('Archive/a.md', settings)).toBe(true);
        expect(isPathExcludedByFileRules('Notes/draft-a.md', settings)).toBe(
          true
        );
        expect(isPathExcludedByFileRules('Notes/a.md', settings)).toBe(false);
      });

      it('should exclude nothing when every entry is an invalid regex', () => {
        settings.exclusions.excludedFiles = ['/[unclosed/'];
        expect(isPathExcludedByFileRules('Notes/a.md', settings)).toBe(false);
      });
    });

    describe('"Exclude all except..." strategy', () => {
      beforeEach(() => {
        settings.exclusions.fileScopeStrategy =
          EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT;
      });

      it('should spare notes that match', () => {
        settings.exclusions.excludedFiles = ['Notes/inc/'];
        expect(isPathExcludedByFileRules('Notes/inc/a.md', settings)).toBe(
          false
        );
        expect(isPathExcludedByFileRules('notes/INC/b/c.md', settings)).toBe(
          false
        );
      });

      it('should exclude notes that do not match', () => {
        settings.exclusions.excludedFiles = ['Notes/inc/'];
        expect(isPathExcludedByFileRules('Notes/a.md', settings)).toBe(true);
        expect(isPathExcludedByFileRules('top.md', settings)).toBe(true);
      });

      it('should exclude everything when the list is empty', () => {
        settings.exclusions.excludedFiles = [];
        expect(isPathExcludedByFileRules('Notes/a.md', settings)).toBe(true);
      });

      it('should exclude everything when only blank or invalid entries remain', () => {
        settings.exclusions.excludedFiles = ['  ', '/[unclosed/'];
        expect(isPathExcludedByFileRules('Notes/a.md', settings)).toBe(true);
      });
    });
  });

  describe('fileHasExcludedProperties', () => {
    beforeEach(() => {
      settings.exclusions.excludedProperties = [
        { key: 'status', value: 'draft' },
        { key: 'archived', value: '' },
      ];
    });

    it('should return true if file has excluded property with matching value', () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { status: 'draft' },
      });

      const result = fileHasExcludedProperties(file, settings, app);
      expect(result).toBe(true);
    });

    it('should return true if file has excluded property with empty value (any value matches)', () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { archived: true },
      });

      const result = fileHasExcludedProperties(file, settings, app);
      expect(result).toBe(true);
    });

    it('should return false if file does not have excluded property', () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { status: 'published' },
      });

      const result = fileHasExcludedProperties(file, settings, app);
      expect(result).toBe(false);
    });

    it('should return false if file has no frontmatter', () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: null,
      });

      const result = fileHasExcludedProperties(file, settings, app);
      expect(result).toBe(false);
    });

    it('should return false if file has no cache', () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue(null);

      const result = fileHasExcludedProperties(file, settings, app);
      expect(result).toBe(false);
    });

    it('should handle array property values', () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { status: ['draft', 'pending'] },
      });

      const result = fileHasExcludedProperties(file, settings, app);
      expect(result).toBe(true);
    });

    it('should handle non-string property values', () => {
      settings.exclusions.excludedProperties = [
        { key: 'priority', value: '1' },
      ];
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { priority: 1 },
      });

      const result = fileHasExcludedProperties(file, settings, app);
      expect(result).toBe(true);
    });

    it('should filter out empty property keys', () => {
      settings.exclusions.excludedProperties = [
        { key: '', value: 'test' },
        { key: '  ', value: 'test' },
      ];
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { anything: 'value' },
      });

      const result = fileHasExcludedProperties(file, settings, app);
      expect(result).toBe(false);
    });

    it('should trim property keys and values', () => {
      settings.exclusions.excludedProperties = [
        { key: '  status  ', value: '  draft  ' },
      ];
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { status: 'draft' },
      });

      const result = fileHasExcludedProperties(file, settings, app);
      expect(result).toBe(true);
    });

    // Regression: the content path used to strip "#" for a `tags` rule while the cache
    // path did not, so the same rule excluded a file in one path and not the other.
    it('should match a bare tags rule against a frontmatter tag written with #', () => {
      settings.exclusions.excludedProperties = [{ key: 'tags', value: 'foo' }];
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: ['#foo'] },
      });

      const result = fileHasExcludedProperties(file, settings, app);
      expect(result).toBe(true);
    });

    it('should match a tags rule written with # against a bare frontmatter tag', () => {
      settings.exclusions.excludedProperties = [{ key: 'tags', value: '#foo' }];
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: 'foo' },
      });

      const result = fileHasExcludedProperties(file, settings, app);
      expect(result).toBe(true);
    });

    it('should not strip # for a property other than tags', () => {
      settings.exclusions.excludedProperties = [
        { key: 'status', value: 'draft' },
      ];
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { status: '#draft' },
      });

      const result = fileHasExcludedProperties(file, settings, app);
      expect(result).toBe(false);
    });
  });

  describe('shouldProcessFile', () => {
    beforeEach(() => {
      settings.exclusions.fileScopeStrategy = 'Only exclude...';
      settings.exclusions.tagScopeStrategy = 'Only exclude...';
      settings.exclusions.propertyScopeStrategy = 'Only exclude...';
      settings.exclusions.excludedFiles = [];
      settings.exclusions.excludedTags = [];
      settings.exclusions.excludedProperties = [];
    });

    describe('"Only exclude..." strategy', () => {
      it('should process all files when no exclusions configured', () => {
        const file = createMockFile('test.md');
        file.parent = new TFolder('Notes');

        const result = shouldProcessFile(file, settings, app);
        expect(result).toBe(true);
      });

      it('should not process file in excluded folder', () => {
        settings.exclusions.excludedFiles = ['Archive/'];
        const file = createMockFile('Archive/test.md');
        file.parent = new TFolder('Archive');

        const result = shouldProcessFile(file, settings, app);
        expect(result).toBe(false);
      });

      it('should process file not in excluded folder', () => {
        settings.exclusions.excludedFiles = ['Archive/'];
        const file = createMockFile('Notes/test.md');
        file.parent = new TFolder('Notes');

        const result = shouldProcessFile(file, settings, app);
        expect(result).toBe(true);
      });

      it("should test the note's full path, so an entry can match its name", () => {
        settings.exclusions.excludedFiles = ['/draft-/'];
        const file = createMockFile('Notes/draft-a.md');
        file.parent = new TFolder('Notes');

        expect(shouldProcessFile(file, settings, app)).toBe(false);
      });
    });

    describe('"Exclude all except..." strategy', () => {
      beforeEach(() => {
        settings.exclusions.fileScopeStrategy = 'Exclude all except...';
      });

      it('should not process any files when no entries are configured', () => {
        settings.exclusions.excludedFiles = [];
        const file = createMockFile('Notes/test.md');
        file.parent = new TFolder('Notes');

        const result = shouldProcessFile(file, settings, app);
        expect(result).toBe(false);
      });

      it('should process file in included folder', () => {
        settings.exclusions.excludedFiles = ['Notes/'];
        const file = createMockFile('Notes/test.md');
        file.parent = new TFolder('Notes');

        const result = shouldProcessFile(file, settings, app);
        expect(result).toBe(true);
      });

      it('should not process file not in included folder', () => {
        settings.exclusions.excludedFiles = ['Notes/'];
        const file = createMockFile('Archive/test.md');
        file.parent = new TFolder('Archive');

        const result = shouldProcessFile(file, settings, app);
        expect(result).toBe(false);
      });
    });

    describe('exclusion overrides', () => {
      beforeEach(() => {
        settings.exclusions.excludedFiles = ['Archive/'];
        settings.exclusions.excludedTags = ['archived'];
        settings.exclusions.excludedProperties = [
          { key: 'status', value: 'draft' },
        ];
      });

      it('should ignore path exclusions when ignoreFiles is true', () => {
        const file = createMockFile('Archive/test.md');
        file.parent = new TFolder('Archive');

        const result = shouldProcessFile(file, settings, app, undefined, {
          ignoreFiles: true,
        });
        expect(result).toBe(true);
      });

      it('should ignore tag exclusions when ignoreTag is true', () => {
        const file = createMockFile('test.md');
        file.parent = new TFolder('Notes');
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: { tags: ['archived'] },
        });

        const result = shouldProcessFile(file, settings, app, undefined, {
          ignoreTag: true,
        });
        expect(result).toBe(true);
      });

      it('should ignore property exclusions when ignoreProperty is true', () => {
        const file = createMockFile('test.md');
        file.parent = new TFolder('Notes');
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: { status: 'draft' },
        });

        const result = shouldProcessFile(file, settings, app, undefined, {
          ignoreProperty: true,
        });
        expect(result).toBe(true);
      });

      it('should respect all overrides together', () => {
        const file = createMockFile('Archive/test.md');
        file.parent = new TFolder('Archive');
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: { status: 'draft', tags: ['archived'] },
        });

        const result = shouldProcessFile(file, settings, app, undefined, {
          ignoreFiles: true,
          ignoreTag: true,
          ignoreProperty: true,
        });
        expect(result).toBe(true);
      });
    });

    describe('combined exclusions', () => {
      it('should exclude if ANY exclusion type matches ("Only exclude..." mode)', () => {
        settings.exclusions.fileScopeStrategy = 'Only exclude...';
        settings.exclusions.tagScopeStrategy = 'Only exclude...';
        settings.exclusions.excludedFiles = ['Archive/'];
        settings.exclusions.excludedTags = ['archived'];

        const file = createMockFile('Archive/test.md');
        file.parent = new TFolder('Archive');
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: { tags: ['archived'] },
        });

        // File is in excluded folder AND has excluded tag
        const result = shouldProcessFile(file, settings, app);
        expect(result).toBe(false);
      });

      it('should exclude if only the path matches', () => {
        settings.exclusions.fileScopeStrategy = 'Only exclude...';
        settings.exclusions.excludedFiles = ['Archive/'];

        const file = createMockFile('Archive/test.md');
        file.parent = new TFolder('Archive');

        const result = shouldProcessFile(file, settings, app);
        expect(result).toBe(false);
      });

      it('should exclude if only tag matches', () => {
        settings.exclusions.tagScopeStrategy = 'Only exclude...';
        settings.exclusions.excludedTags = ['archived'];

        const file = createMockFile('Notes/test.md');
        file.parent = new TFolder('Notes');
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: { tags: ['archived'] },
        });

        // Mock fileHasTargetTags to return true
        vi.doMock('./tag-utils', () => ({
          fileHasTargetTags: vi.fn().mockReturnValue(true),
          normalizeTag: vi.fn((tag) => tag.replace(/^#/, '')),
          stripFrontmatter: vi.fn((content) => content),
        }));

        const result = shouldProcessFile(file, settings, app);
        expect(result).toBe(false);
      });
    });
  });

  describe('isFolderFullyExcludedByFileRules', () => {
    const notes = () => new TFolder('Notes');
    const work = () => new TFolder('Notes/Work');
    const vaultRoot = () => new TFolder('/');

    beforeEach(() => {
      settings.exclusions.excludedFiles = [];
    });

    describe('"Only exclude..." strategy', () => {
      beforeEach(() => {
        settings.exclusions.fileScopeStrategy = EXCLUSION_STRATEGY.ONLY_EXCLUDE;
      });

      it('should not report a folder as fully excluded when the list is empty', () => {
        expect(isFolderFullyExcludedByFileRules(notes(), settings)).toBe(false);
      });

      it('should report a folder whose own entry is listed, ignoring case', () => {
        settings.exclusions.excludedFiles = ['notes/'];
        expect(isFolderFullyExcludedByFileRules(notes(), settings)).toBe(true);
      });

      it('should report a subfolder covered by a parent entry', () => {
        settings.exclusions.excludedFiles = ['Notes/'];
        expect(isFolderFullyExcludedByFileRules(work(), settings)).toBe(true);
      });

      it('should report a folder covered by a slash-less prefix entry', () => {
        settings.exclusions.excludedFiles = ['Note'];
        expect(isFolderFullyExcludedByFileRules(notes(), settings)).toBe(true);
      });

      it('should not report a parent when only a subfolder is listed', () => {
        settings.exclusions.excludedFiles = ['Notes/Work/'];
        expect(isFolderFullyExcludedByFileRules(notes(), settings)).toBe(false);
      });

      it('should not report a folder a regex might only partly cover', () => {
        settings.exclusions.excludedFiles = ['/^Notes\\//'];
        expect(isFolderFullyExcludedByFileRules(notes(), settings)).toBe(false);
      });

      it('should never report the vault root', () => {
        settings.exclusions.excludedFiles = ['Notes/'];
        expect(isFolderFullyExcludedByFileRules(vaultRoot(), settings)).toBe(
          false
        );
      });
    });

    describe('"Exclude all except..." strategy', () => {
      beforeEach(() => {
        settings.exclusions.fileScopeStrategy =
          EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT;
      });

      it('should report every folder, the root included, when the list is empty', () => {
        expect(isFolderFullyExcludedByFileRules(notes(), settings)).toBe(true);
        expect(isFolderFullyExcludedByFileRules(vaultRoot(), settings)).toBe(
          true
        );
      });

      it('should report every folder when only invalid regexes are listed', () => {
        settings.exclusions.excludedFiles = ['/[unclosed/'];
        expect(isFolderFullyExcludedByFileRules(notes(), settings)).toBe(true);
      });

      it('should report a folder no entry touches', () => {
        settings.exclusions.excludedFiles = ['Archive/'];
        expect(isFolderFullyExcludedByFileRules(notes(), settings)).toBe(true);
      });

      it('should not report a folder whose own entry spares it', () => {
        settings.exclusions.excludedFiles = ['NOTES/'];
        expect(isFolderFullyExcludedByFileRules(notes(), settings)).toBe(false);
      });

      it('should not report a subfolder a covering parent entry spares', () => {
        settings.exclusions.excludedFiles = ['Notes/'];
        expect(isFolderFullyExcludedByFileRules(work(), settings)).toBe(false);
      });

      it('should not report a folder holding a spared subfolder or note', () => {
        settings.exclusions.excludedFiles = ['Notes/Work/'];
        expect(isFolderFullyExcludedByFileRules(notes(), settings)).toBe(false);
        settings.exclusions.excludedFiles = ['Notes/a.md'];
        expect(isFolderFullyExcludedByFileRules(notes(), settings)).toBe(false);
      });

      it('should not report any folder while a regex is listed', () => {
        settings.exclusions.excludedFiles = ['Archive/', '/draft-/'];
        expect(isFolderFullyExcludedByFileRules(notes(), settings)).toBe(false);
      });

      it('should not report the vault root while any entry is listed', () => {
        settings.exclusions.excludedFiles = ['Archive/'];
        expect(isFolderFullyExcludedByFileRules(vaultRoot(), settings)).toBe(
          false
        );
      });
    });
  });

  describe('isTagFullyExcludedByTagRules', () => {
    let getTags: Mock<() => Record<string, number>>;

    beforeEach(() => {
      settings.exclusions.tagScopeStrategy = EXCLUSION_STRATEGY.ONLY_EXCLUDE;
      settings.exclusions.tagMatchingMode = 'In Properties and note body';
      settings.exclusions.matchSubtags = true;
      settings.exclusions.excludedTags = [];
      // Obsidian's tag tree: keys carry the "#" and list a parent for every subtag.
      getTags = vi.fn(() => ({ '#project': 3, '#project/alpha': 1 }));
      app.metadataCache.getTags = getTags;
    });

    describe('"Only exclude..." strategy', () => {
      it('should not report a tag as fully excluded when the list is empty', () => {
        expect(isTagFullyExcludedByTagRules('project', settings, app)).toBe(
          false
        );
      });

      it('should report a listed tag as fully excluded, with or without its "#"', () => {
        settings.exclusions.excludedTags = ['#project'];

        expect(isTagFullyExcludedByTagRules('project', settings, app)).toBe(
          true
        );
        expect(isTagFullyExcludedByTagRules('#project', settings, app)).toBe(
          true
        );
      });

      it('should not report an unlisted tag as fully excluded', () => {
        settings.exclusions.excludedTags = ['#archive'];

        expect(isTagFullyExcludedByTagRules('project', settings, app)).toBe(
          false
        );
      });

      it('should fold case when matching tags', () => {
        settings.exclusions.excludedTags = ['#Project'];

        expect(isTagFullyExcludedByTagRules('PROJECT', settings, app)).toBe(
          true
        );
      });

      it('should report a subtag as fully excluded when its parent tag is listed under subtag matching', () => {
        settings.exclusions.excludedTags = ['#project'];

        expect(
          isTagFullyExcludedByTagRules('project/alpha', settings, app)
        ).toBe(true);
      });

      it('should not report a subtag as fully excluded through its listed parent when subtag matching is off', () => {
        settings.exclusions.excludedTags = ['#project'];
        settings.exclusions.matchSubtags = false;

        expect(
          isTagFullyExcludedByTagRules('project/alpha', settings, app)
        ).toBe(false);
      });

      it('should not read the tag tree when subtag matching settles the answer', () => {
        settings.exclusions.excludedTags = ['#project'];

        isTagFullyExcludedByTagRules('project', settings, app);

        expect(getTags).not.toHaveBeenCalled();
      });

      it('should not report a listed tag as fully excluded when subtag matching is off and the tree holds an unlisted subtag', () => {
        settings.exclusions.excludedTags = ['#project'];
        settings.exclusions.matchSubtags = false;

        expect(isTagFullyExcludedByTagRules('project', settings, app)).toBe(
          false
        );
      });

      it('should report a listed tag as fully excluded when subtag matching is off and every subtag in the tree is listed', () => {
        settings.exclusions.excludedTags = ['#project', '#Project/Alpha'];
        settings.exclusions.matchSubtags = false;

        expect(isTagFullyExcludedByTagRules('project', settings, app)).toBe(
          true
        );
      });

      it.each(['In Properties only', 'In note body only'] as const)(
        'should not report a listed tag as fully excluded when tag matching reads one source only: %s',
        (mode) => {
          settings.exclusions.excludedTags = ['#project'];
          settings.exclusions.tagMatchingMode = mode;

          expect(isTagFullyExcludedByTagRules('project', settings, app)).toBe(
            false
          );
        }
      );
    });

    describe('"Exclude all except..." strategy', () => {
      beforeEach(() => {
        settings.exclusions.tagScopeStrategy =
          EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT;
      });

      it('should report every tag as fully excluded when the list is empty', () => {
        expect(isTagFullyExcludedByTagRules('project', settings, app)).toBe(
          true
        );
      });

      it('should not report a listed tag as fully excluded', () => {
        settings.exclusions.excludedTags = ['#project'];

        expect(isTagFullyExcludedByTagRules('project', settings, app)).toBe(
          false
        );
      });

      // A note carrying the unlisted tag can also carry a listed one, which only the note can tell.
      it('should not report an unlisted tag as fully excluded', () => {
        settings.exclusions.excludedTags = ['#archive'];

        expect(isTagFullyExcludedByTagRules('project', settings, app)).toBe(
          false
        );
      });
    });
  });
});
