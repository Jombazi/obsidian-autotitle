import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';
import {
  compileExcludedFileFilters,
  fileHasExcludedProperties,
  fileHasTargetTags,
  isPathExcludedByFileRules,
  shouldProcessFile,
  findExcludingList,
  isFolderFullyExcludedByFileRules,
  isTagFullyExcludedByTagRules,
  hasTagTargets,
  hasPropertyTargets,
  isListedPropertyKey,
  stripExcludedFileLeadingSlashes,
} from '../../src/utils/file-exclusions';
import {
  createTestSettings,
  createMockFile,
  createMockApp,
} from '../testUtils';
import { EXCLUSION_STRATEGY, PluginSettings } from '../../src/types';
import {
  App,
  TFile,
  TFolder,
  getFrontMatterInfo,
  parseYaml,
} from '../mockObsidian';

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

    // Every note an exclusion check reads used to recompile one expression per entry.
    describe('memo', () => {
      it('hands back the same compiled filters for the same entries', () => {
        const entries = ['Notes/', '/draft-/'];

        expect(compileExcludedFileFilters(entries)).toBe(
          compileExcludedFileFilters(entries)
        );
        expect(compileExcludedFileFilters([...entries])).toBe(
          compileExcludedFileFilters(entries)
        );
      });

      it('recompiles once a settings list is changed in place', () => {
        const entries = ['Notes/'];
        const before = compileExcludedFileFilters(entries);

        entries.push('Archive/');
        const after = compileExcludedFileFilters(entries);

        expect(after).not.toBe(before);
        expect(after.some((filter) => filter.test('Archive/a.md'))).toBe(true);
      });

      it('applies an entry edited in place to the next path check', () => {
        settings.exclusions.excludedFiles = ['Notes/'];
        expect(isPathExcludedByFileRules('Archive/a.md', settings)).toBe(false);

        settings.exclusions.excludedFiles[0] = 'Archive/';

        expect(isPathExcludedByFileRules('Archive/a.md', settings)).toBe(true);
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

    describe('pattern entries', () => {
      /** Does a note holding `frontmatter` match the rules? */
      function matchesFrontmatter(frontmatter: Record<string, unknown>) {
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter,
        });
        return fileHasExcludedProperties(
          createMockFile('test.md'),
          settings,
          app
        );
      }

      it('should match every property whose name a name pattern matches, ignoring case', () => {
        settings.exclusions.excludedProperties = [
          { key: '/^stat/', value: 'draft' },
        ];

        expect(matchesFrontmatter({ Status: 'draft' })).toBe(true);
        expect(matchesFrontmatter({ stage: 'draft' })).toBe(false);
      });

      it('should match a name pattern alone when the value is blank', () => {
        settings.exclusions.excludedProperties = [
          { key: '/^arch/', value: '' },
        ];

        expect(matchesFrontmatter({ archived: true })).toBe(true);
      });

      it('should match a value pattern anywhere in the value, ignoring case', () => {
        settings.exclusions.excludedProperties = [
          { key: 'status', value: '/draft|wip/' },
        ];

        expect(matchesFrontmatter({ status: 'WIP' })).toBe(true);
        expect(matchesFrontmatter({ status: 'done' })).toBe(false);
      });

      it('should match a name pattern and a value pattern together', () => {
        settings.exclusions.excludedProperties = [
          { key: '/^stat/', value: '/draft|wip/' },
        ];

        expect(matchesFrontmatter({ status: 'wip' })).toBe(true);
        expect(matchesFrontmatter({ status: 'done', other: 'wip' })).toBe(
          false
        );
      });

      it('should test a value pattern against each item of a list', () => {
        settings.exclusions.excludedProperties = [
          { key: 'status', value: '/^wi/' },
        ];

        expect(matchesFrontmatter({ status: ['done', 'wip'] })).toBe(true);
      });

      it('should drop the "#" on both sides when a name pattern reaches tags, with it on the rule', () => {
        settings.exclusions.excludedProperties = [
          { key: '/^tags$/', value: '#draft' },
        ];

        expect(matchesFrontmatter({ tags: ['draft'] })).toBe(true);
      });

      it('should drop the "#" on both sides when a name pattern reaches tags, with it on the note', () => {
        settings.exclusions.excludedProperties = [
          { key: '/^tags$/', value: 'draft' },
        ];

        expect(matchesFrontmatter({ tags: ['#draft'] })).toBe(true);
      });

      it.each([
        ['name', { key: '/[/', value: '' }],
        ['value', { key: 'status', value: '/[/' }],
      ])(
        'should drop a rule whose %s pattern does not compile',
        (_side, rule) => {
          settings.exclusions.excludedProperties = [rule];

          expect(matchesFrontmatter({ status: '[' })).toBe(false);
          expect(hasPropertyTargets(settings)).toBe(false);
        }
      );
    });
  });

  describe('fileHasTargetTags', () => {
    let file: TFile;

    /** Content parsing is stubbed per test; the reset keeps one test's stub out of the next. */
    function resetFrontmatterParsing(): void {
      vi.mocked(getFrontMatterInfo).mockReset();
      vi.mocked(parseYaml).mockReset();
    }

    /** Stubs the content's properties block as parsing to `frontmatter`, once. */
    function stubContentFrontmatter(
      frontmatter: Record<string, unknown>
    ): void {
      vi.mocked(getFrontMatterInfo).mockReturnValueOnce({
        exists: true,
        frontmatter: 'stubbed',
        contentStart: 20,
        from: 4,
        to: 12,
      });
      vi.mocked(parseYaml).mockReturnValueOnce(frontmatter);
    }

    beforeEach(() => {
      resetFrontmatterParsing();
      file = createMockFile('test.md');
      settings.exclusions.excludedTags = ['work', 'important'];
      settings.exclusions.tagMatchingMode = 'In Properties and note body';
      settings.exclusions.matchSubtags = true;
    });

    afterEach(resetFrontmatterParsing);

    it('should return false when no target tags configured', () => {
      settings.exclusions.excludedTags = [];

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(false);
    });

    it('should return false when only empty tags configured', () => {
      settings.exclusions.excludedTags = ['', '  '];

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(false);
    });

    it('should detect tag in frontmatter', () => {
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: ['work', 'project'] },
        tags: [],
      });

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(true);
    });

    it('should detect single tag in frontmatter', () => {
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: 'important' },
        tags: [],
      });

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(true);
    });

    it('should detect inline tag', () => {
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: null,
        tags: [
          {
            tag: '#work',
            position: {
              start: { line: 0, col: 0, offset: 0 },
              end: { line: 0, col: 5, offset: 5 },
            },
          },
        ],
      });

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(true);
    });

    it('should detect subtags when matchSubtags is true', () => {
      settings.exclusions.matchSubtags = true;
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: ['work/project/backend'] },
        tags: [],
      });

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(true);
    });

    it('should not detect subtags when matchSubtags is false', () => {
      settings.exclusions.matchSubtags = false;
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: ['work/project'] },
        tags: [],
      });

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(false);
    });

    it('should normalize tags with # prefix', () => {
      settings.exclusions.excludedTags = ['#work'];
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: ['work'] },
        tags: [],
      });

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(true);
    });

    it('should only check frontmatter when mode is "In Properties only"', () => {
      settings.exclusions.tagMatchingMode = 'In Properties only';
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: null,
        tags: [
          {
            tag: '#work',
            position: {
              start: { line: 0, col: 0, offset: 0 },
              end: { line: 0, col: 5, offset: 5 },
            },
          },
        ],
      });

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(false);
    });

    it('should only check inline tags when mode is "In note body only"', () => {
      settings.exclusions.tagMatchingMode = 'In note body only';
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: ['work'] },
        tags: [],
      });

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(false);
    });

    it('should parse tags from provided content', () => {
      stubContentFrontmatter({ tags: ['work'] });

      const result = fileHasTargetTags(file, settings, app, {
        content: '---\ntags: [work]\n---\nContent',
      });
      expect(result).toBe(true);
    });

    it('should return false when file has no cache', () => {
      app.metadataCache.getFileCache = vi.fn().mockReturnValue(null);

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(false);
    });

    it('should ignore numeric tags in frontmatter, as Obsidian does', () => {
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: [1, 2, 3] },
        tags: [],
      });

      settings.exclusions.excludedTags = ['1'];

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(false);
    });

    it('should detect exact match before subtag check', () => {
      settings.exclusions.excludedTags = ['work'];
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: ['work'] },
        tags: [],
      });

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(true);
    });

    it('should handle tags in both frontmatter and inline', () => {
      settings.exclusions.tagMatchingMode = 'In Properties and note body';
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: ['project'] },
        tags: [
          {
            tag: '#work',
            position: {
              start: { line: 0, col: 0, offset: 0 },
              end: { line: 0, col: 5, offset: 5 },
            },
          },
        ],
      });

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(true);
    });

    it('should match frontmatter tags case-insensitively', () => {
      settings.exclusions.excludedTags = ['Work'];
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: ['WORK'] },
        tags: [],
      });

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(true);
    });

    it('should match inline subtags case-insensitively', () => {
      settings.exclusions.excludedTags = ['WORK'];
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: null,
        tags: [
          {
            tag: '#Work/Project',
            position: {
              start: { line: 0, col: 0, offset: 0 },
              end: { line: 0, col: 13, offset: 13 },
            },
          },
        ],
      });

      const result = fileHasTargetTags(file, settings, app);
      expect(result).toBe(true);
    });

    it.each(['Tags', 'TAGS'])(
      'should read a %s key from the cache, as Obsidian does',
      (key) => {
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: { [key]: ['work'] },
          tags: [],
        });

        expect(fileHasTargetTags(file, settings, app)).toBe(true);
      }
    );

    it('should read a TAGS key from provided content', () => {
      stubContentFrontmatter({ TAGS: 'work' });

      expect(
        fileHasTargetTags(file, settings, app, {
          content: '---\nTAGS: work\n---\n',
        })
      ).toBe(true);
    });

    it("should fall back to the cache when the content's YAML is malformed mid-edit", () => {
      vi.mocked(getFrontMatterInfo).mockReturnValueOnce({
        exists: true,
        frontmatter: 'tags: [work',
        contentStart: 20,
        from: 4,
        to: 15,
      });
      vi.mocked(parseYaml).mockImplementationOnce(() => {
        throw new Error('YAML parse error');
      });
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: ['work'] },
        tags: [],
      });

      expect(
        fileHasTargetTags(file, settings, app, {
          content: '---\ntags: [work\n---\n',
        })
      ).toBe(true);
    });

    it('should fall back to the cache when handed partial content without a properties block', () => {
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: ['work'] },
        tags: [],
      });

      expect(
        fileHasTargetTags(file, settings, app, {
          content: '[^1]: footnote text',
        })
      ).toBe(true);
    });

    it("should read the content's properties ahead of a stale cache", () => {
      stubContentFrontmatter({ tags: ['work'] });
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: ['project'] },
        tags: [],
      });

      expect(
        fileHasTargetTags(file, settings, app, {
          content: '---\ntags: [work]\n---\n',
        })
      ).toBe(true);
    });

    // A text the cache has not indexed yet, such as a template just written, is judged on Obsidian's parse of it
    describe('the provided metadata', () => {
      beforeEach(() => {
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: { tags: ['work'] },
          tags: [{ tag: '#important' }],
        });
      });

      it('reads property tags from the metadata, not the cache', () => {
        settings.exclusions.tagMatchingMode = 'In Properties only';

        expect(fileHasTargetTags(file, settings, app, { metadata: {} })).toBe(
          false
        );
        expect(
          fileHasTargetTags(file, settings, app, {
            metadata: { frontmatter: { tags: 'important' } },
          })
        ).toBe(true);
      });

      it('reads body tags from the metadata, not the cache', () => {
        settings.exclusions.tagMatchingMode = 'In note body only';
        const bodyTag = (tag: string) => ({
          tag,
          position: {
            start: { line: 0, col: 0, offset: 0 },
            end: { line: 0, col: tag.length, offset: tag.length },
          },
        });

        expect(
          fileHasTargetTags(file, settings, app, {
            metadata: { tags: [bodyTag('#other')] },
          })
        ).toBe(false);
        expect(
          fileHasTargetTags(file, settings, app, {
            metadata: { tags: [bodyTag('#work')] },
          })
        ).toBe(true);
        expect(app.metadataCache.getFileCache).not.toHaveBeenCalled();
      });
    });

    // The cache trails typing by a re-index, so the title line's own tags count before it catches up
    describe('the provided title line', () => {
      beforeEach(() => {
        settings.exclusions.excludedTags = ['/^draft/'];
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({});
      });

      it('excludes a note whose excluded tag is only in the title line', () => {
        expect(
          fileHasTargetTags(file, settings, app, {
            titleLine: '#draft-x Title',
          })
        ).toBe(true);
      });

      it.each([
        { titleLine: '`#draft` Title' },
        { titleLine: '[Title](#draft)' },
        { titleLine: '\\#draft Title' },
        { titleLine: '<div>#draft</div>' },
        { titleLine: '- <div>#draft</div>' },
      ])('reads no tag from $titleLine', ({ titleLine }) => {
        expect(fileHasTargetTags(file, settings, app, { titleLine })).toBe(
          false
        );
      });

      it('reads the title line under "In note body only"', () => {
        settings.exclusions.tagMatchingMode = 'In note body only';

        expect(
          fileHasTargetTags(file, settings, app, { titleLine: '#draft' })
        ).toBe(true);
      });

      it('ignores the title line under "In Properties only"', () => {
        settings.exclusions.tagMatchingMode = 'In Properties only';

        expect(
          fileHasTargetTags(file, settings, app, { titleLine: '#draft' })
        ).toBe(false);
      });

      it('passes the title line on from shouldProcessFile', () => {
        settings.exclusions.tagScopeStrategy = 'Only exclude...';

        expect(
          shouldProcessFile(file, settings, app, { titleLine: '#draft-x' })
        ).toBe(false);
        expect(shouldProcessFile(file, settings, app)).toBe(true);
      });
    });

    describe('pattern entries', () => {
      /** Does a note tagged `tags` in its properties match the rules? */
      function matchesPropertyTags(tags: string[]) {
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: { tags },
          tags: [],
        });
        return fileHasTargetTags(file, settings, app);
      }

      it('should match an unanchored pattern anywhere in the tag', () => {
        settings.exclusions.excludedTags = ['/raft/'];

        expect(matchesPropertyTags(['draft'])).toBe(true);
      });

      it('should match an anchored pattern only where anchored', () => {
        settings.exclusions.excludedTags = ['/^draft/'];

        expect(matchesPropertyTags(['draft-2024'])).toBe(true);
        expect(matchesPropertyTags(['redraft'])).toBe(false);
      });

      it('should match a body tag ignoring case', () => {
        settings.exclusions.excludedTags = ['/^draft/'];
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: null,
          tags: [
            {
              tag: '#Draft/2024',
              position: {
                start: { line: 0, col: 0, offset: 0 },
                end: { line: 0, col: 11, offset: 11 },
              },
            },
          ],
        });

        expect(fileHasTargetTags(file, settings, app)).toBe(true);
      });

      it('should match Cyrillic ignoring case', () => {
        settings.exclusions.excludedTags = ['/^черновик/'];

        expect(matchesPropertyTags(['Черновик'])).toBe(true);
      });

      it("should test a pattern against the tag's parents under subtag matching", () => {
        settings.exclusions.excludedTags = ['/^draft$/'];
        settings.exclusions.matchSubtags = true;

        expect(matchesPropertyTags(['draft/2024/x'])).toBe(true);
      });

      it("should not test a pattern against the tag's parents without subtag matching", () => {
        settings.exclusions.excludedTags = ['/^draft$/'];
        settings.exclusions.matchSubtags = false;

        expect(matchesPropertyTags(['draft/2024'])).toBe(false);
      });

      it('should match nothing with a pattern that does not compile', () => {
        settings.exclusions.excludedTags = ['/[/'];

        expect(matchesPropertyTags(['['])).toBe(false);
        expect(hasTagTargets(settings)).toBe(false);
      });

      it('should treat a list holding only a pattern that does not compile as empty under "Exclude all except..."', () => {
        settings.exclusions.tagScopeStrategy =
          EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT;
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: { tags: ['work'] },
          tags: [],
        });

        settings.exclusions.excludedTags = [];
        const withEmptyList = shouldProcessFile(file, settings, app);
        settings.exclusions.excludedTags = ['/[/'];

        expect(shouldProcessFile(file, settings, app)).toBe(withEmptyList);
        expect(withEmptyList).toBe(false);
      });

      it('should not count a bare "#" entry as a target', () => {
        settings.exclusions.excludedTags = ['#', ' # '];

        expect(hasTagTargets(settings)).toBe(false);
        expect(matchesPropertyTags(['work'])).toBe(false);
      });
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

      it('should ignore path exclusions when ignoreExcludedFiles is true', () => {
        const file = createMockFile('Archive/test.md');
        file.parent = new TFolder('Archive');

        const result = shouldProcessFile(file, settings, app, {
          exclusionOverrides: {
            ignoreExcludedFiles: true,
          },
        });
        expect(result).toBe(true);
      });

      it('should ignore tag exclusions when ignoreExcludedTags is true', () => {
        const file = createMockFile('test.md');
        file.parent = new TFolder('Notes');
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: { tags: ['archived'] },
        });

        const result = shouldProcessFile(file, settings, app, {
          exclusionOverrides: {
            ignoreExcludedTags: true,
          },
        });
        expect(result).toBe(true);
      });

      it('should ignore property exclusions when ignoreExcludedProperties is true', () => {
        const file = createMockFile('test.md');
        file.parent = new TFolder('Notes');
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: { status: 'draft' },
        });

        const result = shouldProcessFile(file, settings, app, {
          exclusionOverrides: {
            ignoreExcludedProperties: true,
          },
        });
        expect(result).toBe(true);
      });

      it('should respect all overrides together', () => {
        const file = createMockFile('Archive/test.md');
        file.parent = new TFolder('Archive');
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: { status: 'draft', tags: ['archived'] },
        });

        const result = shouldProcessFile(file, settings, app, {
          exclusionOverrides: {
            ignoreExcludedFiles: true,
            ignoreExcludedTags: true,
            ignoreExcludedProperties: true,
          },
        });
        expect(result).toBe(true);
      });
    });

    // The tag and property detectors share one frontmatter resolution, made only when a live rule needs it.
    describe('frontmatter parsing', () => {
      const CONTENT = '---\ntags: [work]\nstatus: draft\n---\nBody';

      beforeEach(() => {
        vi.mocked(parseYaml).mockReset();
        vi.mocked(parseYaml).mockReturnValue({
          tags: ['work'],
          status: 'draft',
        });
      });

      afterEach(() => {
        vi.mocked(parseYaml).mockReset();
      });

      it('parses nothing when no tag or property rule is live', () => {
        settings.exclusions.excludedTags = ['  '];
        settings.exclusions.excludedProperties = [{ key: '', value: 'x' }];

        expect(
          shouldProcessFile(createMockFile('Notes/a.md'), settings, app, {
            content: CONTENT,
          })
        ).toBe(true);
        expect(parseYaml).not.toHaveBeenCalled();
      });

      it('parses the properties once when both a tag and a property rule are live', () => {
        settings.exclusions.excludedTags = ['other'];
        settings.exclusions.excludedProperties = [
          { key: 'status', value: 'published' },
        ];

        expect(
          shouldProcessFile(createMockFile('Notes/a.md'), settings, app, {
            content: CONTENT,
          })
        ).toBe(true);
        expect(parseYaml).toHaveBeenCalledTimes(1);
      });

      it('still reads a property rule from the shared parse', () => {
        settings.exclusions.excludedTags = ['other'];
        settings.exclusions.excludedProperties = [
          { key: 'status', value: 'draft' },
        ];

        expect(
          shouldProcessFile(createMockFile('Notes/a.md'), settings, app, {
            content: CONTENT,
          })
        ).toBe(false);
        expect(parseYaml).toHaveBeenCalledTimes(1);
      });

      it('applies a property rule edited in place to the next check', () => {
        settings.exclusions.excludedProperties = [
          { key: 'status', value: 'published' },
        ];
        const file = createMockFile('Notes/a.md');
        expect(
          shouldProcessFile(file, settings, app, { content: CONTENT })
        ).toBe(true);

        settings.exclusions.excludedProperties[0].value = 'draft';

        expect(
          shouldProcessFile(file, settings, app, { content: CONTENT })
        ).toBe(false);
      });

      it('applies a tag rule edited in place to the next check', () => {
        settings.exclusions.excludedTags = ['other'];
        const file = createMockFile('Notes/a.md');
        expect(
          shouldProcessFile(file, settings, app, { content: CONTENT })
        ).toBe(true);

        settings.exclusions.excludedTags[0] = '#Work';

        expect(
          shouldProcessFile(file, settings, app, { content: CONTENT })
        ).toBe(false);
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

        const result = shouldProcessFile(file, settings, app);
        expect(result).toBe(false);
      });
    });
  });

  // The manual command's refusal notice names the first list that excludes the note
  describe('stripExcludedFileLeadingSlashes', () => {
    it.each([
      ['/Templates', 'Templates'],
      ['///Templates/Daily', 'Templates/Daily'],
      ['/ Templates', 'Templates'],
      ['/', ''],
      ['//', ''],
      ['Templates/', 'Templates/'],
      ['/Templates/', '/Templates/'],
      ['/^daily-.*/', '/^daily-.*/'],
    ])('turns %j into %j', (entry, expected) => {
      expect(stripExcludedFileLeadingSlashes(entry)).toBe(expected);
    });
  });

  describe('findExcludingList', () => {
    let file: TFile;

    beforeEach(() => {
      settings.exclusions.excludedFiles = ['Archive/'];
      settings.exclusions.excludedTags = ['archived'];
      settings.exclusions.excludedProperties = [
        { key: 'status', value: 'draft' },
      ];
      file = createMockFile('Archive/test.md');
      file.parent = new TFolder('Archive');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { status: 'draft', tags: ['archived'] },
      });
    });

    it('names the path list ahead of the tag and property lists', () => {
      expect(findExcludingList(file, settings, app)).toBe('files');
    });

    it('names the tag list ahead of the property list', () => {
      settings.exclusions.excludedFiles = [];

      expect(findExcludingList(file, settings, app)).toBe('tags');
    });

    it('names the property list once the tag is gone', () => {
      settings.exclusions.excludedFiles = [];
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { status: 'draft' },
      });

      expect(findExcludingList(file, settings, app)).toBe('properties');
    });

    it('names no list when none excludes the note', () => {
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: {},
      });
      file = createMockFile('Notes/test.md');
      file.parent = new TFolder('Notes');

      expect(findExcludingList(file, settings, app)).toBeNull();
    });

    it('names the first list an override leaves in place', () => {
      expect(
        findExcludingList(file, settings, app, {
          exclusionOverrides: { ignoreExcludedFiles: true },
        })
      ).toBe('tags');
      expect(
        findExcludingList(file, settings, app, {
          exclusionOverrides: {
            ignoreExcludedFiles: true,
            ignoreExcludedTags: true,
          },
        })
      ).toBe('properties');
      expect(
        findExcludingList(file, settings, app, {
          exclusionOverrides: {
            ignoreExcludedFiles: true,
            ignoreExcludedTags: true,
            ignoreExcludedProperties: true,
          },
        })
      ).toBeNull();
    });

    it('names a list "Exclude all except..." excludes under', () => {
      settings.exclusions.excludedFiles = [];
      settings.exclusions.excludedTags = ['other'];
      settings.exclusions.tagScopeStrategy = 'Exclude all except...';

      expect(findExcludingList(file, settings, app)).toBe('tags');
    });

    it('agrees with shouldProcessFile', () => {
      expect(shouldProcessFile(file, settings, app)).toBe(false);
      settings.exclusions.excludedFiles = [];
      settings.exclusions.excludedTags = [];
      settings.exclusions.excludedProperties = [];
      expect(findExcludingList(file, settings, app)).toBeNull();
      expect(shouldProcessFile(file, settings, app)).toBe(true);
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

      it('should ignore pattern entries, so a tag only a pattern covers keeps its action', () => {
        settings.exclusions.excludedTags = ['/^project/'];

        expect(isTagFullyExcludedByTagRules('project', settings, app)).toBe(
          false
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

  describe('isListedPropertyKey', () => {
    it('should find a plain name ignoring case, whatever value the rule asks for', () => {
      settings.exclusions.excludedProperties = [
        { key: 'Status', value: 'draft' },
      ];

      expect(isListedPropertyKey('STATUS', settings)).toBe(true);
      expect(isListedPropertyKey('state', settings)).toBe(false);
    });

    it('should find a name a name pattern matches', () => {
      settings.exclusions.excludedProperties = [{ key: '/^stat/', value: '' }];

      expect(isListedPropertyKey('Status', settings)).toBe(true);
      expect(isListedPropertyKey('upstate', settings)).toBe(false);
    });

    it('should ignore a rule with a side that does not compile', () => {
      settings.exclusions.excludedProperties = [
        { key: 'status', value: '/[/' },
      ];

      expect(isListedPropertyKey('status', settings)).toBe(false);
    });
  });
});
