import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getFrontMatterInfo, parseYaml } from 'obsidian';
import { FileOperations } from '../../src/operations/file-operations';
import { App, TFile, TFolder } from '../mockObsidian';
import {
  createMockApp,
  createMockFile,
  createTestSettings,
  splitFrontMatter,
} from '../testUtils';
import { PluginSettings } from '../../src/types';
import type FirstLineIsTitle from '../../main';

describe('FileOperations.isFileExcludedForCursorPositioning', () => {
  let settings: PluginSettings;
  let app: App;
  let file: TFile;
  let fileOperations: FileOperations;
  // Raw YAML block -> parsed object. Blocks with no entry throw, modelling malformed YAML.
  let yamlFixtures: Map<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();

    yamlFixtures = new Map<string, unknown>();
    vi.mocked(getFrontMatterInfo).mockImplementation(
      splitFrontMatter as unknown as typeof getFrontMatterInfo
    );
    vi.mocked(parseYaml).mockImplementation(((yaml: string) => {
      if (!yamlFixtures.has(yaml)) {
        throw new Error(`malformed YAML: ${yaml}`);
      }
      return yamlFixtures.get(yaml);
    }) as typeof parseYaml);

    settings = createTestSettings();
    settings.exclusions.excludedFiles = [];
    settings.exclusions.excludedTags = [];
    settings.exclusions.excludedProperties = [];

    app = createMockApp();
    app.metadataCache.getFileCache = vi.fn().mockReturnValue(null);

    file = createMockFile('Notes/test.md');
    file.parent = new TFolder('Notes');

    fileOperations = new FileOperations({
      app,
      settings,
    } as unknown as FirstLineIsTitle);
  });

  describe('property exclusions from real-time content', () => {
    beforeEach(() => {
      settings.exclusions.excludedProperties = [
        { key: 'status', value: 'draft' },
      ];
    });

    it('is not excluded when content has no frontmatter and the cache has none either', () => {
      expect(fileOperations.isFileExcludedForCursorPositioning(file, '')).toBe(
        false
      );
    });

    it('is excluded when content frontmatter carries the listed property', () => {
      const content = '---\nstatus: draft\n---\n';
      yamlFixtures.set('status: draft\n', { status: 'draft' });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(file, content)
      ).toBe(true);
    });

    it('is not excluded when content frontmatter drops a property the cache still holds', () => {
      const content = '---\nstatus: published\n---\n';
      yamlFixtures.set('status: published\n', { status: 'published' });
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { status: 'draft' },
      });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(file, content)
      ).toBe(false);
    });

    it('falls back to the cache when partial content lacks frontmatter the file has', () => {
      // Text without a properties block, as an editor holding less than the whole note would hand over
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { status: 'draft' },
      });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(
          file,
          '[^1]: a footnote definition'
        )
      ).toBe(true);
    });

    it('falls back to the cache when content frontmatter is malformed', () => {
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { status: 'draft' },
      });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(
          file,
          '---\nstatus: [unclosed\n---\n'
        )
      ).toBe(true);
    });

    it('matches property keys and values case-insensitively', () => {
      const content = '---\nStatus: Draft\n---\n';
      yamlFixtures.set('Status: Draft\n', { Status: 'Draft' });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(file, content)
      ).toBe(true);
    });
  });

  describe('property scope strategies', () => {
    beforeEach(() => {
      settings.exclusions.excludedProperties = [
        { key: 'status', value: 'draft' },
      ];
    });

    it('"Only exclude..." excludes only files carrying the listed property', () => {
      settings.exclusions.propertyScopeStrategy = 'Only exclude...';
      yamlFixtures.set('status: draft\n', { status: 'draft' });
      yamlFixtures.set('status: published\n', { status: 'published' });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(
          file,
          '---\nstatus: draft\n---\n'
        )
      ).toBe(true);
      expect(
        fileOperations.isFileExcludedForCursorPositioning(
          file,
          '---\nstatus: published\n---\n'
        )
      ).toBe(false);
    });

    it('"Exclude all except..." excludes every file that lacks the listed property', () => {
      settings.exclusions.propertyScopeStrategy = 'Exclude all except...';
      yamlFixtures.set('status: draft\n', { status: 'draft' });
      yamlFixtures.set('status: published\n', { status: 'published' });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(
          file,
          '---\nstatus: draft\n---\n'
        )
      ).toBe(false);
      expect(
        fileOperations.isFileExcludedForCursorPositioning(
          file,
          '---\nstatus: published\n---\n'
        )
      ).toBe(true);
    });
  });

  describe('caller override shapes', () => {
    beforeEach(() => {
      settings.exclusions.excludedFiles = ['Notes/'];
      settings.exclusions.excludedProperties = [
        { key: 'status', value: 'draft' },
      ];
      yamlFixtures.set('status: draft\n', { status: 'draft' });
    });

    it('applies every exclusion type for the title-insertion caller (no overrides)', () => {
      expect(fileOperations.isFileExcludedForCursorPositioning(file, '')).toBe(
        true
      );
    });

    it('skips the path check but keeps properties for the creation-coordinator overrides', () => {
      expect(
        fileOperations.isFileExcludedForCursorPositioning(file, '', {
          ignoreExcludedFiles: true,
        })
      ).toBe(false);

      expect(
        fileOperations.isFileExcludedForCursorPositioning(
          file,
          '---\nstatus: draft\n---\n',
          { ignoreExcludedFiles: true }
        )
      ).toBe(true);
    });

    it('skips whitelist evaluation when the caller ignores tags and properties', () => {
      settings.exclusions.propertyScopeStrategy = 'Exclude all except...';

      expect(
        fileOperations.isFileExcludedForCursorPositioning(file, '', {
          ignoreExcludedFiles: true,
          ignoreExcludedTags: true,
          ignoreExcludedProperties: true,
        })
      ).toBe(false);
    });
  });

  describe('disable-renaming property', () => {
    it('is excluded when content frontmatter carries the disable property', () => {
      const content = '---\nno rename: true\n---\n';
      yamlFixtures.set('no rename: true\n', { 'no rename': true });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(file, content)
      ).toBe(true);
    });

    it('matches the disable key and value case-insensitively', () => {
      const content = '---\nNo Rename: TRUE\n---\n';
      yamlFixtures.set('No Rename: TRUE\n', { 'No Rename': 'TRUE' });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(file, content)
      ).toBe(true);
    });

    it('matches a disable value inside a list', () => {
      const content = '---\nno rename:\n  - true\n---\n';
      yamlFixtures.set('no rename:\n  - true\n', { 'no rename': ['true'] });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(file, content)
      ).toBe(true);
    });

    it('ignores a matching value stored under a different key', () => {
      const content = '---\nstatus: true\n---\n';
      yamlFixtures.set('status: true\n', { status: true });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(file, content)
      ).toBe(false);
    });

    // The new-note path gains the fallback the rename gate has, so a note whose text the cache already indexes with the property stays excluded.
    it('falls back to the metadata cache when the content has no properties block', () => {
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { 'no rename': true },
      });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(file, 'Title\n')
      ).toBe(true);
    });

    it('falls back to the metadata cache when the content properties are malformed', () => {
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { 'no rename': true },
      });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(
          file,
          '---\nno rename: [unclosed\n---\n'
        )
      ).toBe(true);
    });

    it('lets the content switch the property off ahead of the cache', () => {
      const content = '---\nno rename: false\n---\n';
      yamlFixtures.set('no rename: false\n', { 'no rename': false });
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { 'no rename': true },
      });

      expect(
        fileOperations.isFileExcludedForCursorPositioning(file, content)
      ).toBe(false);
    });

    it('reads the metadata cache when no content is supplied', () => {
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { 'no rename': true },
      });

      expect(fileOperations.isFileExcludedForCursorPositioning(file)).toBe(
        true
      );
    });
  });
});
