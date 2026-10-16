import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getFrontMatterInfo, parseYaml } from 'obsidian';
import { verboseLog } from '../src/utils';
import {
  canModifyFile,
  hasDisablePropertyInFile,
  frontmatterHasDisableProperty,
  disablePropertyIsOff,
} from '../src/utils/disable-property';
import {
  isValidHeading,
  extractTitle,
  isUntitledName,
} from '../src/utils/title-extraction';
import { normalizeExclusionLists } from '../src/utils/exclusion-lists';
import {
  processForbiddenChars,
  reverseCharacterReplacements,
} from '../src/utils/string-processing';
import { isOnlyFrontmatterChanged } from '../src/utils/editor-checks';
import {
  createTestSettings,
  createMockFile,
  createMockApp,
  splitFrontMatter,
} from './testUtils';
import { PluginSettings } from '../src/types';
import { CharKey, CharReplacementConfig } from '../src/types/char-replacement';
import { TFile, App } from './mockObsidian';

describe('utils', () => {
  let settings: PluginSettings;
  let app: App;

  beforeEach(() => {
    settings = createTestSettings();
    app = createMockApp();
  });

  describe('verboseLog', () => {
    let consoleSpy: any;

    beforeEach(() => {
      // In vitest v4, spyOn on a pre-mocked vi.fn() shares call history with the
      // global mock from setup.ts. mockClear() resets the count for this test.
      consoleSpy = vi.spyOn(console, 'debug');
      consoleSpy.mockClear();
    });

    it('should log when verbose logging is enabled', () => {
      settings.core.debug = true;
      const plugin = { settings };

      verboseLog(plugin, 'Test message');

      expect(consoleSpy).toHaveBeenCalledWith('Test message');
    });

    it('should log with data when provided', () => {
      settings.core.debug = true;
      const plugin = { settings };
      const data = { foo: 'bar' };

      verboseLog(plugin, 'Test message', data);

      expect(consoleSpy).toHaveBeenCalledWith('Test message', data);
    });

    it('should not log when verbose logging is disabled', () => {
      settings.core.debug = false;
      const plugin = { settings };

      verboseLog(plugin, 'Test message');

      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe('isValidHeading', () => {
    it('should return true for h1 heading', () => {
      expect(isValidHeading('# Heading')).toBe(true);
    });

    it('should return true for h2 heading', () => {
      expect(isValidHeading('## Heading')).toBe(true);
    });

    it('should return true for h3-h6 headings', () => {
      expect(isValidHeading('### Heading')).toBe(true);
      expect(isValidHeading('#### Heading')).toBe(true);
      expect(isValidHeading('##### Heading')).toBe(true);
      expect(isValidHeading('###### Heading')).toBe(true);
    });

    it('should return false for more than 6 hashes', () => {
      expect(isValidHeading('####### Heading')).toBe(false);
    });

    it('should return false when no space after hashes', () => {
      expect(isValidHeading('#Heading')).toBe(false);
    });

    it('should return false for plain text', () => {
      expect(isValidHeading('Plain text')).toBe(false);
    });

    it('should return false for hash in middle of line', () => {
      expect(isValidHeading('Text # Heading')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidHeading('')).toBe(false);
    });

    it('should handle headings with special characters', () => {
      expect(isValidHeading('# Heading with **bold** and _italic_')).toBe(true);
    });

    it('should handle headings with numbers', () => {
      expect(isValidHeading('# 123 Numbers')).toBe(true);
    });

    // Reading view renders `#` alone as an empty heading, and skips any spaces and tabs before the marker.
    it.each(['#', ' # x', '   # Title', ' \t# x', '#\tx'])(
      'should return true for %j, which Reading view renders as a heading',
      (line) => {
        expect(isValidHeading(line)).toBe(true);
      }
    );

    it.each(['    # x', '\t# x'])(
      'should return false for %j, which is indented code',
      (line) => {
        expect(isValidHeading(line)).toBe(false);
      }
    );
  });

  describe('isOnlyFrontmatterChanged', () => {
    beforeEach(() => {
      vi.mocked(getFrontMatterInfo).mockImplementation(
        splitFrontMatter as unknown as typeof getFrontMatterInfo
      );
    });

    afterEach(() => {
      vi.mocked(getFrontMatterInfo).mockReset();
    });

    it('should report a change confined to the properties block', () => {
      expect(
        isOnlyFrontmatterChanged(
          '---\nstatus: done\n---\nTitle\nBody',
          '---\nstatus: draft\n---\nTitle\nBody'
        )
      ).toBe(true);
    });

    it('should report a body change as more than the properties', () => {
      expect(
        isOnlyFrontmatterChanged(
          '---\nstatus: draft\n---\nNew title\nBody',
          '---\nstatus: draft\n---\nTitle\nBody'
        )
      ).toBe(false);
    });

    it('should report a properties block added above an unchanged body', () => {
      expect(
        isOnlyFrontmatterChanged('---\nstatus: draft\n---\nTitle', 'Title')
      ).toBe(true);
    });

    it('should compare whole notes without a properties block', () => {
      expect(isOnlyFrontmatterChanged('Title', 'Title')).toBe(true);
      expect(isOnlyFrontmatterChanged('Title 2', 'Title')).toBe(false);
    });
  });

  describe('isUntitledName', () => {
    it.each(['Untitled', 'Untitled 2', 'Untitled 10', 'Untitled  2'])(
      'should count %j as untitled',
      (name) => {
        expect(isUntitledName(name)).toBe(true);
      }
    );

    it.each([
      'Untitled 0',
      'Untitled 01',
      'Untitled2',
      'Untitled note',
      'My note',
    ])('should not count %j as untitled', (name) => {
      expect(isUntitledName(name)).toBe(false);
    });
  });

  describe('hasDisablePropertyInFile', () => {
    const disableSettings = (key: string, value: string): PluginSettings => {
      const keyedSettings = createTestSettings();
      keyedSettings.exclusions.disableRenamingKey = key;
      keyedSettings.exclusions.disableRenamingValue = value;
      return keyedSettings;
    };

    it('should return true when file has matching disable property', async () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { 'no rename': 'true' },
      });

      const result = await hasDisablePropertyInFile(
        file,
        app,
        disableSettings('no rename', 'true')
      );
      expect(result).toBe(true);
    });

    it('should return false when file has no frontmatter', async () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: null,
      });

      const result = await hasDisablePropertyInFile(
        file,
        app,
        disableSettings('no rename', 'true')
      );
      expect(result).toBe(false);
    });

    it('should return false when file has no cache', async () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue(null);

      const result = await hasDisablePropertyInFile(
        file,
        app,
        disableSettings('no rename', 'true')
      );
      expect(result).toBe(false);
    });

    it('should return false when property does not exist', async () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { other: 'value' },
      });

      const result = await hasDisablePropertyInFile(
        file,
        app,
        disableSettings('no rename', 'true')
      );
      expect(result).toBe(false);
    });

    it('should handle array property values', async () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: ['important', 'draft'] },
      });

      const result = await hasDisablePropertyInFile(
        file,
        app,
        disableSettings('tags', 'draft')
      );
      expect(result).toBe(true);
    });

    it('should handle case-insensitive string comparison', async () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { status: 'DISABLED' },
      });

      const result = await hasDisablePropertyInFile(
        file,
        app,
        disableSettings('status', 'disabled')
      );
      expect(result).toBe(true);
    });

    it('should handle boolean property values', async () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { disabled: true },
      });

      const result = await hasDisablePropertyInFile(
        file,
        app,
        disableSettings('disabled', 'true')
      );
      expect(result).toBe(true);
    });

    it('should handle numeric property values', async () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { count: 5 },
      });

      const result = await hasDisablePropertyInFile(
        file,
        app,
        disableSettings('count', '5')
      );
      expect(result).toBe(true);
    });

    it('should return false when property value does not match', async () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { status: 'draft' },
      });

      const result = await hasDisablePropertyInFile(
        file,
        app,
        disableSettings('status', 'published')
      );
      expect(result).toBe(false);
    });

    it('should handle errors gracefully', async () => {
      const file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockImplementation(() => {
        throw new Error('Cache error');
      });

      const result = await hasDisablePropertyInFile(
        file,
        app,
        disableSettings('no rename', 'true')
      );
      expect(result).toBe(false);
    });
  });

  describe('frontmatterHasDisableProperty', () => {
    const DISABLE_KEY = 'no rename';

    it('should match a boolean true', () => {
      expect(
        frontmatterHasDisableProperty(
          { 'no rename': true },
          DISABLE_KEY,
          'true'
        )
      ).toBe(true);
    });

    it('should match the string "True" ignoring case', () => {
      expect(
        frontmatterHasDisableProperty(
          { 'no rename': 'True' },
          DISABLE_KEY,
          'true'
        )
      ).toBe(true);
    });

    it('should match the string "TRUE" ignoring case', () => {
      expect(
        frontmatterHasDisableProperty(
          { 'no rename': 'TRUE' },
          DISABLE_KEY,
          'true'
        )
      ).toBe(true);
    });

    it('should match "01" against a configured "1" as the same number', () => {
      expect(
        frontmatterHasDisableProperty({ 'no rename': '01' }, DISABLE_KEY, '1')
      ).toBe(true);
    });

    it('should match a list when any item matches', () => {
      expect(
        frontmatterHasDisableProperty(
          { 'no rename': ['draft', true] },
          DISABLE_KEY,
          'true'
        )
      ).toBe(true);
    });

    it('should not match a list without the configured value', () => {
      expect(
        frontmatterHasDisableProperty(
          { 'no rename': ['draft'] },
          DISABLE_KEY,
          'true'
        )
      ).toBe(false);
    });

    it('should match the key in another case', () => {
      expect(
        frontmatterHasDisableProperty(
          { 'No Rename': true },
          DISABLE_KEY,
          'true'
        )
      ).toBe(true);
    });

    it('should match when any case variant of the key matches', () => {
      expect(
        frontmatterHasDisableProperty(
          { 'no rename': false, 'No Rename': true },
          DISABLE_KEY,
          'true'
        )
      ).toBe(true);
    });

    it('should not match an empty property', () => {
      expect(
        frontmatterHasDisableProperty(
          { 'no rename': null },
          DISABLE_KEY,
          'true'
        )
      ).toBe(false);
    });

    it('should not match when the key is absent', () => {
      expect(
        frontmatterHasDisableProperty({ other: true }, DISABLE_KEY, 'true')
      ).toBe(false);
    });

    it('should match "yes" against a configured "Yes" ignoring case', () => {
      expect(
        frontmatterHasDisableProperty(
          { 'no rename': 'yes' },
          DISABLE_KEY,
          'Yes'
        )
      ).toBe(true);
    });
  });

  describe('disablePropertyIsOff', () => {
    const DISABLE_KEY = 'no rename';

    it('should be true when there is no frontmatter', () => {
      expect(disablePropertyIsOff(undefined, DISABLE_KEY)).toBe(true);
    });

    it('should be true for empty frontmatter', () => {
      expect(disablePropertyIsOff({}, DISABLE_KEY)).toBe(true);
    });

    it('should be true when the property is false', () => {
      expect(disablePropertyIsOff({ 'no rename': false }, DISABLE_KEY)).toBe(
        true
      );
    });

    it('should be true when the property in another case is false', () => {
      expect(disablePropertyIsOff({ 'No Rename': false }, DISABLE_KEY)).toBe(
        true
      );
    });

    it('should be false when the property is true', () => {
      expect(disablePropertyIsOff({ 'no rename': true }, DISABLE_KEY)).toBe(
        false
      );
    });

    it('should be false when the value is half-typed', () => {
      expect(disablePropertyIsOff({ 'no rename': 'tru' }, DISABLE_KEY)).toBe(
        false
      );
    });

    it('should be false when the property is empty', () => {
      expect(disablePropertyIsOff({ 'no rename': null }, DISABLE_KEY)).toBe(
        false
      );
    });

    it('should be false when any case variant of the key is not false', () => {
      expect(
        disablePropertyIsOff(
          { 'no rename': false, 'No Rename': 'x' },
          DISABLE_KEY
        )
      ).toBe(false);
    });
  });

  describe('canModifyFile', () => {
    let file: TFile;

    beforeEach(() => {
      file = createMockFile('test.md');
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: null,
      });
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);
    });

    it('should allow modification for valid file with manual command', async () => {
      const result = await canModifyFile(file, app, settings, {
        isManualCommand: true,
      });

      expect(result).toEqual({ canModify: true });
    });

    it('should block modification when disable property is present', async () => {
      app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { 'no rename': 'true' },
      });

      const result = await canModifyFile(file, app, settings, {
        isManualCommand: true,
      });

      expect(result.canModify).toBe(false);
      expect(result).toEqual({ canModify: false, reason: 'disable-property' });
    });

    it('should block automatic modification when file not open in editor', async () => {
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);

      const result = await canModifyFile(file, app, settings, {
        isManualCommand: false,
      });

      expect(result.canModify).toBe(false);
      expect(result).toEqual({
        canModify: false,
        reason: 'not-open-in-editor',
      });
    });

    it('should allow automatic modification when file is open in editor', async () => {
      const mockLeaf = {
        view: {
          file: file,
        },
      };
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([mockLeaf]);

      const result = await canModifyFile(file, app, settings, {
        isManualCommand: false,
      });

      expect(result.canModify).toBe(true);
    });

    it('should respect hasActiveEditor parameter when provided', async () => {
      const result = await canModifyFile(file, app, settings, {
        isManualCommand: false,
        hasActiveEditor: true,
      });

      expect(result.canModify).toBe(true);
    });

    it('should block when hasActiveEditor is false', async () => {
      const result = await canModifyFile(file, app, settings, {
        isManualCommand: false,
        hasActiveEditor: false,
      });

      expect(result.canModify).toBe(false);
      expect(result).toEqual({
        canModify: false,
        reason: 'not-open-in-editor',
      });
    });

    it('should allow manual command even when file not open', async () => {
      app.workspace.getLeavesOfType = vi.fn().mockReturnValue([]);

      const result = await canModifyFile(file, app, settings, {
        isManualCommand: true,
      });

      expect(result.canModify).toBe(true);
    });

    // The editor runs ahead of the metadata cache by up to Obsidian's autosave delay.
    describe('with the content being processed', () => {
      // Raw YAML block -> parsed object. Blocks with no entry throw, modelling malformed YAML.
      let yamlFixtures: Map<string, unknown>;

      const checkWithContent = (content?: string) =>
        canModifyFile(file, app, settings, { isManualCommand: true, content });

      const mockCachedDisableValue = (value: boolean) => {
        app.metadataCache.getFileCache = vi.fn().mockReturnValue({
          frontmatter: { 'no rename': value },
        });
      };

      beforeEach(() => {
        yamlFixtures = new Map<string, unknown>([
          ['no rename: true\n', { 'no rename': true }],
          ['no rename: false\n', { 'no rename': false }],
        ]);
        vi.mocked(getFrontMatterInfo).mockImplementation(
          splitFrontMatter as unknown as typeof getFrontMatterInfo
        );
        vi.mocked(parseYaml).mockImplementation(((yaml: string) => {
          if (!yamlFixtures.has(yaml)) {
            throw new Error(`malformed YAML: ${yaml}`);
          }
          return yamlFixtures.get(yaml);
        }) as typeof parseYaml);
      });

      afterEach(() => {
        vi.mocked(getFrontMatterInfo).mockReset();
        vi.mocked(parseYaml).mockReset();
      });

      it('should block when the content turns the property on before the cache does', () => {
        mockCachedDisableValue(false);

        const result = checkWithContent('---\nno rename: true\n---\nTitle');

        expect(result.canModify).toBe(false);
        expect(result).toEqual({
          canModify: false,
          reason: 'disable-property',
        });
      });

      it('should allow when the content turns the property off before the cache does', () => {
        mockCachedDisableValue(true);

        const result = checkWithContent('---\nno rename: false\n---\nTitle');

        expect(result.canModify).toBe(true);
      });

      it('should fall back to the cache when the content has no frontmatter', () => {
        // Text with no properties block says nothing about the property, so the cache decides
        mockCachedDisableValue(true);

        const result = checkWithContent('[^1]: A footnote definition');

        expect(result.canModify).toBe(false);
        expect(result).toEqual({
          canModify: false,
          reason: 'disable-property',
        });
      });

      it('should fall back to the cache when the content frontmatter is malformed', () => {
        mockCachedDisableValue(true);

        const result = checkWithContent('---\nno rename: [tru\n---\nTitle');

        expect(result.canModify).toBe(false);
        expect(result).toEqual({
          canModify: false,
          reason: 'disable-property',
        });
      });

      it('should let the cache decide when no content is passed', () => {
        mockCachedDisableValue(true);
        expect(checkWithContent().canModify).toBe(false);

        mockCachedDisableValue(false);
        expect(checkWithContent().canModify).toBe(true);
      });
    });
  });

  describe('extractTitle', () => {
    beforeEach(() => {
      // Enable all markup stripping by default for tests
      settings.markupStripping.stripMarkupSettings.callouts = true;
      settings.markupStripping.stripMarkupSettings.quote = true;
      settings.markupStripping.stripMarkupSettings.taskLists = true;
      settings.markupStripping.stripMarkupSettings.unorderedLists = true;
      settings.markupStripping.stripMarkupSettings.orderedLists = true;
    });

    describe('callout markup stripping', () => {
      it('should strip callout and return title', () => {
        expect(extractTitle('> [!note] My Title', settings)).toBe('My Title');
      });

      // A callout with no title shows Obsidian's default title, made from its type (app.js 1.14.4, measured); fold markers do not change it.
      it('should give a folded callout with no title its default title', () => {
        expect(extractTitle('> [!note]-', settings)).toBe('Note');
      });

      it('should give an expanded callout with no title its default title', () => {
        expect(extractTitle('> [!note]+', settings)).toBe('Note');
      });

      it('should give a callout with trailing space only its default title', () => {
        expect(extractTitle('> [!note]+ ', settings)).toBe('Note');
      });

      it('should handle folded callout with title', () => {
        expect(extractTitle('> [!note]- My Title', settings)).toBe('My Title');
      });

      it('should handle expanded callout with title', () => {
        expect(extractTitle('> [!note]+ My Title', settings)).toBe('My Title');
      });

      // Reading view parses a callout title as blocks, so a leading `- ` or `+ ` makes it a list item.
      it('should strip a dash list marker from callout title content', () => {
        expect(extractTitle('> [!note] - hello', settings)).toBe('hello');
      });

      it('should strip a plus list marker from callout title content', () => {
        expect(extractTitle('> [!note] + hello', settings)).toBe('hello');
      });

      it('should give a callout with no fold indicator and no title its default title', () => {
        expect(extractTitle('> [!warning]', settings)).toBe('Warning');
      });

      it.each([
        { line: '> [!NOTE]', title: 'Note' },
        { line: '> [!my-type]', title: 'My type' },
        { line: '> [!my_type]', title: 'My_type' },
        { line: '> [!note|meta]', title: 'Note' },
        { line: '> [!my  type]', title: 'My type' },
        { line: '>[!note]', title: 'Note' },
      ])('should title $line after its type: $title', ({ line, title }) => {
        expect(extractTitle(line, settings)).toBe(title);
      });

      it('should keep the default title as typed, reading no markup in it', () => {
        expect(extractTitle('> [!a*b*]', settings)).toBe('A*b*');
      });

      it('should apply title case to the default title', () => {
        settings.core.titleCase = 'uppercase';
        expect(extractTitle('> [!note]', settings)).toBe('NOTE');
      });

      it('should read a marker two spaces after > as a plain quote', () => {
        expect(extractTitle('>  [!note] t', settings)).toBe('[!note] t');
      });

      it('should read an empty type as a plain quote', () => {
        expect(extractTitle('> [!]', settings)).toBe('[!]');
      });
    });

    describe('task list context awareness', () => {
      it('should strip task list when enabled', () => {
        expect(extractTitle('- [x] My Task', settings)).toBe('My Task');
      });

      it('should NOT strip task list marker when only unordered list stripping enabled', () => {
        settings.markupStripping.stripMarkupSettings.taskLists = false;
        settings.markupStripping.stripMarkupSettings.unorderedLists = true;

        // Task list should NOT have its marker stripped as unordered list
        expect(extractTitle('- [x] My Task', settings)).toBe('- [x] My Task');
      });

      it('should NOT strip ordered task list marker when only ordered list stripping enabled', () => {
        settings.markupStripping.stripMarkupSettings.taskLists = false;
        settings.markupStripping.stripMarkupSettings.orderedLists = true;

        // Task list should NOT have its marker stripped as ordered list
        expect(extractTitle('1. [x] My Task', settings)).toBe('1. [x] My Task');
      });

      it('should strip task list checkbox for ordered task list', () => {
        expect(extractTitle('1. [x] My Task', settings)).toBe('My Task');
      });

      it('should keep a star task marker literal when task list stripping is off', () => {
        settings.markupStripping.stripMarkupSettings.taskLists = false;
        expect(extractTitle('* [ ] *a*', settings)).toBe('* [ ] a');
      });

      it('should handle empty task list marker', () => {
        expect(extractTitle('- [ ] ', settings)).toBe('Untitled');
      });

      it('should handle indented empty task list marker', () => {
        expect(extractTitle('  - [x] ', settings)).toBe('Untitled');
      });
    });

    describe('unordered list context awareness', () => {
      it('should strip unordered list marker', () => {
        expect(extractTitle('- My Item', settings)).toBe('My Item');
      });

      it('should keep a star bullet literal when unordered list stripping is off', () => {
        settings.markupStripping.stripMarkupSettings.unorderedLists = false;
        expect(extractTitle('* a *b*', settings)).toBe('* a b');
      });

      it('should handle indented empty unordered list marker (0-3 spaces)', () => {
        expect(extractTitle('  - ', settings)).toBe('Untitled');
      });

      it('should handle 3-space indented empty list marker', () => {
        expect(extractTitle('   - ', settings)).toBe('Untitled');
      });

      it('should NOT strip list marker with 4+ spaces (code block)', () => {
        // 4 spaces = code block per CommonMark spec
        expect(extractTitle('    - item', settings)).toBe('- item');
      });

      it('should strip a list nested in a callout title', () => {
        expect(extractTitle('> [!info] - hello there', settings)).toBe(
          'hello there'
        );
      });

      it('should strip a list nested in a quote', () => {
        settings.markupStripping.stripMarkupSettings.callouts = false;
        expect(extractTitle('> - hello there', settings)).toBe('hello there');
      });

      it('should keep a list marker nested in a quote when unordered list stripping is off', () => {
        settings.markupStripping.stripMarkupSettings.unorderedLists = false;
        expect(extractTitle('> * a *b*', settings)).toBe('* a b');
      });
    });

    describe('ordered list context awareness', () => {
      it('should strip ordered list marker', () => {
        expect(extractTitle('1. My Item', settings)).toBe('My Item');
      });

      it('should handle indented empty ordered list marker', () => {
        expect(extractTitle('  1. ', settings)).toBe('Untitled');
      });

      it('should NOT strip ordered list marker with 4+ spaces (code block)', () => {
        expect(extractTitle('    1. item', settings)).toBe('1. item');
      });

      it('should strip an ordered list nested in a callout title', () => {
        expect(extractTitle('> [!info] 1. hello', settings)).toBe('hello');
      });
    });

    describe('quote markup stripping', () => {
      it('should strip quote markup', () => {
        settings.markupStripping.stripMarkupSettings.callouts = false;
        expect(extractTitle('> My Quote', settings)).toBe('My Quote');
      });

      it('should handle empty quote', () => {
        settings.markupStripping.stripMarkupSettings.callouts = false;
        expect(extractTitle('> ', settings)).toBe('Untitled');
      });
    });

    describe('indentation and code block detection', () => {
      it('should treat 0-space indent as valid list', () => {
        expect(extractTitle('- item', settings)).toBe('item');
      });

      it('should treat 1-space indent as valid list', () => {
        expect(extractTitle(' - item', settings)).toBe('item');
      });

      it('should treat 2-space indent as valid list', () => {
        expect(extractTitle('  - item', settings)).toBe('item');
      });

      it('should treat 3-space indent as valid list', () => {
        expect(extractTitle('   - item', settings)).toBe('item');
      });

      it('should treat 4-space indent as code block (no strip)', () => {
        expect(extractTitle('    - item', settings)).toBe('- item');
      });

      it('should treat 5+ space indent as code block (no strip)', () => {
        expect(extractTitle('     - item', settings)).toBe('- item');
      });

      it('should treat tab indent as code block (no strip)', () => {
        // Tab expands to column 4 per CommonMark, so it's a code block
        expect(extractTitle('\t- item', settings)).toBe('- item');
      });

      // Remark's indented code counts only an exact leading tab or four spaces, not tab stops, and the list tokenizer skips any spaces and tabs before its marker.
      it('should treat space+tab indent as a list item', () => {
        expect(extractTitle(' \t- item', settings)).toBe('item');
      });

      it('should treat tab-indented task list as code block (no strip)', () => {
        expect(extractTitle('\t- [x] task', settings)).toBe('- [x] task');
      });

      it('should treat tab-indented ordered list as code block (no strip)', () => {
        expect(extractTitle('\t1. item', settings)).toBe('1. item');
      });

      it('should treat tab-indented empty unordered marker as code block (no Untitled)', () => {
        // Tab = code block, so "\t- " should become "-" not "Untitled"
        expect(extractTitle('\t- ', settings)).toBe('-');
      });

      it('should treat tab-indented empty task marker as code block (no Untitled)', () => {
        expect(extractTitle('\t- [ ] ', settings)).toBe('- [ ]');
      });

      it('should treat tab-indented empty ordered marker as code block (no Untitled)', () => {
        expect(extractTitle('\t1. ', settings)).toBe('1.');
      });
    });

    describe('HTML and Obsidian comment stripping', () => {
      it('should strip an HTML comment when htmlTags is enabled', () => {
        expect(extractTitle('Before <!-- draft --> After', settings)).toBe(
          'Before  After'
        );
      });

      it('should return Untitled when the entire line is an HTML comment', () => {
        expect(extractTitle('<!-- draft, do not publish -->', settings)).toBe(
          'Untitled'
        );
      });

      it('should leave an HTML comment untouched when htmlTags is disabled', () => {
        settings.markupStripping.stripMarkupSettings.htmlTags = false;

        expect(extractTitle('<!-- draft -->', settings)).toBe('<!-- draft -->');
      });

      it('should strip an HTML comment even when both %% comment toggles are off', () => {
        settings.markupStripping.stripCommentsEntirely = false;
        settings.markupStripping.stripMarkupSettings.comments = false;

        expect(extractTitle('Before <!-- draft --> After', settings)).toBe(
          'Before  After'
        );
      });

      it('should leave an HTML comment untouched when htmlTags is off even if %% comment toggles are on', () => {
        settings.markupStripping.stripMarkupSettings.htmlTags = false;
        settings.markupStripping.stripCommentsEntirely = true;

        expect(extractTitle('<!-- draft -->', settings)).toBe('<!-- draft -->');
      });

      it('should still strip %%…%% entirely regardless of the htmlTags toggle', () => {
        settings.markupStripping.stripMarkupSettings.htmlTags = false;
        settings.markupStripping.stripCommentsEntirely = true;

        expect(extractTitle('Hello %%secret%% World', settings)).toBe(
          'Hello  World'
        );
      });

      it('should drop an empty %%…%% comment when the markers-only toggle is on', () => {
        settings.markupStripping.stripCommentsEntirely = false;
        settings.markupStripping.stripMarkupSettings.comments = true;

        expect(extractTitle('%%%%', settings)).toBe('Untitled');
      });

      it('should still keep %%…%% content when the markers-only toggle is on', () => {
        settings.markupStripping.stripCommentsEntirely = false;
        settings.markupStripping.stripMarkupSettings.comments = true;

        expect(extractTitle('Hello %%secret%% World', settings)).toBe(
          'Hello secret World'
        );
      });
    });

    describe('highlight markup stripping', () => {
      // Obsidian 1.14's color markers: a circle and a square form for each of six colors.
      const colorMarkers: Array<{ name: string; marker: string }> = [
        { name: 'red circle', marker: '\u{1F534}' },
        { name: 'red square', marker: '\u{1F7E5}' },
        { name: 'orange circle', marker: '\u{1F7E0}' },
        { name: 'orange square', marker: '\u{1F7E7}' },
        { name: 'yellow circle', marker: '\u{1F7E1}' },
        { name: 'yellow square', marker: '\u{1F7E8}' },
        { name: 'green circle', marker: '\u{1F7E2}' },
        { name: 'green square', marker: '\u{1F7E9}' },
        { name: 'blue circle', marker: '\u{1F535}' },
        { name: 'blue square', marker: '\u{1F7E6}' },
        { name: 'purple circle', marker: '\u{1F7E3}' },
        { name: 'purple square', marker: '\u{1F7EA}' },
      ];

      it('should strip highlight markup and keep the content', () => {
        expect(extractTitle('==My Title==', settings)).toBe('My Title');
      });

      it.each(colorMarkers)(
        'should strip the $name color marker',
        ({ marker }) => {
          expect(extractTitle(`==${marker}Title==`, settings)).toBe('Title');
        }
      );

      it('should keep a color marker that is not the first character', () => {
        expect(extractTitle('==a🔴b==', settings)).toBe('a🔴b');
      });

      it('should keep a leading emoji that is not a color marker', () => {
        expect(extractTitle('==⭐x==', settings)).toBe('⭐x');
      });

      it('should keep a brown circle whole even though it shares a high surrogate with the markers', () => {
        expect(extractTitle('==\u{1F7E4}x==', settings)).toBe('\u{1F7E4}x');
      });

      it('should strip a color marker followed by a space', () => {
        expect(extractTitle('==🔴 x==', settings)).toBe('x');
      });

      it('should drop a marker-only highlight inside a longer line', () => {
        expect(extractTitle('Before ==🔴== After', settings)).toBe(
          'Before  After'
        );
      });

      it('should return Untitled when the line is only a marker-only highlight', () => {
        expect(extractTitle('==🔴==', settings)).toBe('Untitled');
      });

      it('should leave a color-marked highlight untouched when highlight stripping is disabled', () => {
        settings.markupStripping.stripMarkupSettings.highlight = false;

        expect(extractTitle('==🔴Title==', settings)).toBe('==🔴Title==');
      });

      it('should leave an escaped highlight untouched', () => {
        expect(extractTitle('\\==🔴Title==', settings)).toBe('==🔴Title==');
      });

      it('should strip a color-marked highlight that contains an escape', () => {
        expect(extractTitle('==🔴Ti\\*tle==', settings)).toBe('Ti*tle');
      });

      it('should leave a highlight opened by a space as literal text', () => {
        expect(extractTitle('== x==', settings)).toBe('== x==');
      });

      it('should leave four equals signs as literal text', () => {
        expect(extractTitle('====', settings)).toBe('====');
      });

      it('should leave a highlight whose closing marker follows a space as literal text', () => {
        expect(extractTitle('==x ==', settings)).toBe('==x ==');
      });

      it('should leave a color-marked highlight whose closing marker follows a space as literal text', () => {
        expect(extractTitle('==🔴x ==', settings)).toBe('==🔴x ==');
      });

      it('should keep a color marker that only bold stripping exposes', () => {
        expect(extractTitle('==**🔴**Title==', settings)).toBe('🔴Title');
      });

      it('should keep a color marker that only comment stripping exposes', () => {
        expect(settings.markupStripping.stripCommentsEntirely).toBe(true);

        expect(extractTitle('==%%c%%🔴Title==', settings)).toBe('🔴Title');
      });

      it('should strip the color marker of a highlight wrapped in bold', () => {
        expect(extractTitle('**==🔴Title==**', settings)).toBe('Title');
      });
    });

    describe('backslashes as Reading view shows them', () => {
      // Expected values are the text Obsidian 1.14's Reading view renders for each line, with every markup-stripping toggle on.
      it.each([
        { line: 'a\\b', expected: 'a\\b' },
        { line: 'a\\*b*', expected: 'a*b*' },
        { line: 'a\\\\b', expected: 'a\\b' },
        { line: 'a\\ b', expected: 'a\\ b' },
        { line: 'trail\\', expected: 'trail\\' },
        { line: '\\# x', expected: '# x' },
        { line: '# Head \\', expected: 'Head \\' },
        { line: 'a\\é', expected: 'a\\é' },
        { line: 'a\\“b”', expected: 'a\\“b”' },
        { line: 'a\\\\\\*b', expected: 'a\\*b' },
        { line: '`a\\*b`', expected: 'a\\*b' },
        { line: 'x \\`a\\` y', expected: 'x `a` y' },
        { line: 'a\\😀b', expected: 'a\\😀b' },
        { line: 'a\\\\', expected: 'a\\' },
      ])('$line gives $expected', ({ line, expected }) => {
        expect(extractTitle(line, settings)).toBe(expected);
      });

      it('reads escapes the same whatever the backslash toggle says', () => {
        settings.characterReplacements.enableForbiddenCharReplacements = true;
        for (const enabled of [true, false]) {
          settings.characterReplacements.charReplacements.backslash.enabled =
            enabled;
          expect(extractTitle('a\\*b* c\\d', settings)).toBe('a*b* c\\d');
        }
      });

      // Code stripping off, so the code span keeps its backticks and only escape handling decides what happens to each backslash.
      it('keeps backslashes literal inside a code span closed by a run of the same length', () => {
        settings.markupStripping.stripMarkupSettings.code = false;
        expect(extractTitle('`` a`b\\* `` \\*', settings)).toBe(
          '`` a`b\\* `` *'
        );
      });

      it('keeps backslashes literal inside a wikilink when wikilink stripping is off', () => {
        settings.markupStripping.stripMarkupSettings.wikilinks = false;
        expect(extractTitle('[[a\\*b]] \\*', settings)).toBe('[[a\\*b]] *');
      });

      it('lets an unclosed backtick run open no code span', () => {
        settings.markupStripping.stripMarkupSettings.code = false;
        expect(extractTitle('``a` \\*', settings)).toBe('``a` *');
      });

      describe('through processForbiddenChars', () => {
        const toFileName = (line: string): string =>
          processForbiddenChars(extractTitle(line, settings), settings);

        beforeEach(() => {
          settings.characterReplacements.enableForbiddenCharReplacements = true;
        });

        it('replaces a visible backslash when backslash replacement is on', () => {
          settings.characterReplacements.charReplacements.backslash.enabled = true;
          expect(toFileName('a\\b')).toBe('a⧵b');
        });

        it('drops a visible backslash when backslash replacement is off', () => {
          settings.characterReplacements.charReplacements.backslash.enabled = false;
          expect(toFileName('a\\b')).toBe('ab');
        });

        it('replaces an escaped asterisk when asterisk replacement is on', () => {
          settings.characterReplacements.charReplacements.asterisk.enabled = true;
          expect(toFileName('a\\*b')).toBe('a∗b');
        });

        it('drops an escaped asterisk when asterisk replacement is off', () => {
          settings.characterReplacements.charReplacements.asterisk.enabled = false;
          expect(toFileName('a\\*b')).toBe('ab');
        });
      });
    });

    describe('math, from the tokenizer', () => {
      // MathJax replaces the rendered math, so these follow the math tokenizer in Obsidian 1.14.4's app.js instead of a Reading view measurement: content stays raw, escapes included.
      it.each([
        { line: '$a\\*b$', expected: 'a\\*b' },
        { line: '$a\\$b$', expected: 'a\\$b' },
        { line: '$$a$$', expected: 'a' },
        { line: 'x $$a\\*b$$ y', expected: 'x a\\*b y' },
        { line: '$*a*$ *b*', expected: '*a* b' },
      ])('$line gives $expected', ({ line, expected }) => {
        expect(extractTitle(line, settings)).toBe(expected);
      });

      it('keeps the delimiters and raw content when inline math stripping is off', () => {
        settings.markupStripping.stripInlineMathMarkup = false;
        expect(extractTitle('$a\\*b$ *c*', settings)).toBe('$a\\*b$ c');
      });
    });

    describe('Reading view parity', () => {
      // Each readingView is the textContent Obsidian 1.14.4's Reading view renders for the line as its own block; an empty rendering falls back to Untitled.
      const defaults = createTestSettings();
      const expectReadingView = ({
        line,
        readingView,
      }: {
        line: string;
        readingView: string;
      }): void => {
        expect(extractTitle(line, defaults).trim()).toBe(
          readingView.trim() || 'Untitled'
        );
      };

      it.each([
        { line: '``a`b``', readingView: 'a`b' },
        { line: '`` `a` ``', readingView: '`a`' },
        { line: '` a `', readingView: 'a' },
        { line: '`  a  `', readingView: ' a ' },
        { line: '```x```', readingView: 'x' },
        { line: '`a``b`', readingView: 'a``b' },
        { line: '``a`', readingView: '`a' },
        { line: 'x `a', readingView: 'x `a' },
        { line: '`a`b`', readingView: 'ab`' },
        { line: '`a\\`b`', readingView: 'a\\b`' },
        { line: '`` a ``b', readingView: 'ab' },
        { line: 'x ``a`` y `b`', readingView: 'x a y b' },
      ])('code spans: $line renders $readingView', expectReadingView);

      it.each([
        { line: '==a\\==b==', readingView: 'a\\b==' },
        { line: '==a\\*b==', readingView: 'a*b' },
        { line: '==a\\=b==', readingView: 'a=b' },
        { line: '\\==a==', readingView: '==a==' },
        { line: '==a==\\=', readingView: 'a=' },
        { line: '==a=b==', readingView: 'a=b' },
        { line: 'a\\===b==', readingView: 'a=b' },
        { line: '==a\\\\==', readingView: 'a\\' },
        { line: '==\\=a==', readingView: '=a' },
        { line: '==a \\== b==', readingView: 'a \\ b==' },
        { line: '~~a\\~b~~', readingView: 'a~b' },
        { line: '~~a\\*b~~', readingView: 'a*b' },
        { line: '~~a\\~~b~~', readingView: 'a\\b~~' },
        { line: '==**a\\*b**==', readingView: 'a*b' },
      ])(
        'highlights and strikethrough: $line renders $readingView',
        expectReadingView
      );

      it.each([
        { line: '**a\\*b**', readingView: 'a*b' },
        { line: '*a\\*b*', readingView: 'a*b' },
        { line: '_a\\_b_', readingView: 'a_b' },
        { line: '__a\\_b__', readingView: 'a_b' },
        { line: '**a\\\\**', readingView: 'a\\' },
        { line: '*a\\\\*', readingView: 'a\\' },
        { line: '**a\\**b**', readingView: 'a**b' },
        { line: '\\**a**', readingView: '**a**' },
        { line: '**a**\\*', readingView: 'a*' },
        { line: '*a\\**', readingView: '*a**' },
        { line: '***a\\*b***', readingView: 'a*b' },
        { line: '**a\\`b**', readingView: 'a`b' },
      ])('bold and italic: $line renders $readingView', expectReadingView);

      it.each([
        { line: '[[x\\|y]]', readingView: 'y' },
        { line: '[[x\\|y\\|z]]', readingView: 'y\\|z' },
        { line: '[[x|y\\|z]]', readingView: 'y\\|z' },
        { line: '[[x\\\\|y]]', readingView: 'y' },
        { line: '[[x\\#h|y]]', readingView: 'y' },
        { line: '[[x\\|]]', readingView: '' },
        { line: 'p [[x\\|y]] q', readingView: 'p y q' },
        { line: '[[x\\]]', readingView: 'x\\' },
        { line: '[[x|a\\*b]]', readingView: 'a\\*b' },
        { line: '[a\\|b](c)', readingView: 'a|b' },
        { line: '[a\\*b](c)', readingView: 'a*b' },
        { line: '%%a\\*b%%', readingView: '' },
        { line: '<b>a\\*b</b>', readingView: 'a*b' },
        { line: '# a\\*b', readingView: 'a*b' },
        { line: '#tag\\*x', readingView: '#tag*x' },
      ])('links and other: $line renders $readingView', expectReadingView);

      it.each([
        { line: 'snake_case_name', readingView: 'snake_case_name' },
        { line: '`[[x]]`', readingView: '[[x]]' },
        { line: '`<b>x</b>`', readingView: '<b>x</b>' },
        { line: '`$x$`', readingView: '$x$' },
        { line: '~~ a~~', readingView: '~~ a~~' },
        { line: '~~a ~~', readingView: '~~a ~~' },
        { line: '%%%%', readingView: '' },
        { line: '[[x|]] y', readingView: ' y' },
      ])(
        'delimiters and code span content: $line renders $readingView',
        expectReadingView
      );

      it.each([
        { line: '[[x#h]]', readingView: 'x > h' },
        { line: '[[x#h#k]]', readingView: 'x > h > k' },
        { line: '[[#h]]', readingView: 'h' },
        { line: '[[x#^block]]', readingView: 'x > ^block' },
        { line: '[[x#h|y]]', readingView: 'y' },
        { line: '[[x#]]', readingView: 'x' },
        { line: '[[#]]', readingView: '' },
        { line: '[[x #h]]', readingView: 'x  > h' },
        { line: '[[x# h]]', readingView: 'x >  h' },
        { line: '[[x##h]]', readingView: 'x > h' },
        { line: '[[|y]]', readingView: '|y' },
        { line: '[[a &amp; b]]', readingView: 'a &amp; b' },
        { line: 'p [[x#h]] q', readingView: 'p x > h q' },
        { line: '[[x\\#h]]', readingView: 'x\\ > h' },
        { line: '# [[x#h]]', readingView: 'x > h' },
      ])('heading links: $line renders $readingView', expectReadingView);

      it.each([
        {
          line: 'https://x.com/__init__',
          readingView: 'https://x.com/__init__',
        },
        { line: 'https://x.com/*a*', readingView: 'https://x.com/*a*' },
        { line: 'https://x.com/~~a~~', readingView: 'https://x.com/~~a~~' },
        { line: 'see https://x.com/a.', readingView: 'see https://x.com/a.' },
        { line: '(https://x.com/a)', readingView: '(https://x.com/a)' },
        { line: 'www.x.com/_a_', readingView: 'www.x.com/_a_' },
        { line: 'http://x.com/**a** b', readingView: 'http://x.com/**a** b' },
        { line: 'https://x.com/a_ b_', readingView: 'https://x.com/a b' },
        { line: 'HTTPS://x.com/__a__', readingView: 'HTTPS://x.com/__a__' },
        { line: 'x HTTPS://x.com/__a__', readingView: 'x HTTPS://x.com/a' },
        { line: 'https://x_y.com/__a__', readingView: 'https://x_y.com/a' },
        { line: 'https://x.com/a.)', readingView: 'https://x.com/a.)' },
        {
          line: 'https://x.com/?a=1&amp;b=2',
          readingView: 'https://x.com/?a=1&b=2',
        },
        { line: 'https://x.com/a&amp;', readingView: 'https://x.com/a&' },
        { line: 'https://x.com/[[a]]', readingView: 'https://x.com/[[a]]' },
        { line: 'https://x.com/a$b$', readingView: 'https://x.com/a$b$' },
        { line: '**https://x.com/a**', readingView: 'https://x.com/a' },
        { line: 'https://x.com/a*b*', readingView: 'https://x.com/a*b*' },
        { line: '*https://x.com/a_b_*', readingView: 'https://x.com/a_b_' },
        { line: 'www.x.com', readingView: 'www.x.com' },
        { line: 'https://x.com/a_b_c_', readingView: 'https://x.com/a_b_c_' },
        { line: 'https://x.com/a(b)_c_', readingView: 'https://x.com/a(b)_c_' },
        { line: 'https://x.com/a;b_c_', readingView: 'https://x.com/a;b_c_' },
        { line: 'www.x..com/_a_', readingView: 'www.x..com/a' },
        { line: 'https://.x.com/_a_', readingView: 'https://.x.com/a' },
        { line: 'x.com/_a_', readingView: 'x.com/a' },
        { line: 'a\\_b_ https://x.com/_', readingView: 'a_b https://x.com/' },
        { line: 'a_b@x.com', readingView: 'a_b@x.com' },
        { line: '_a_b@x.com', readingView: '_a_b@x.com' },
        { line: 'mail a_b_@x.co_m', readingView: 'mail a_b_@x.co_m' },
        { line: 'x@y', readingView: 'x@y' },
        { line: 'a.b@x.y.', readingView: 'a.b@x.y.' },
        { line: 'a@x-.com', readingView: 'a@x-.com' },
      ])('bare URLs and emails: $line renders $readingView', expectReadingView);

      it.each([
        { line: '[https://x.com/__a__](u)', readingView: 'https://x.com/a' },
        { line: '[https://x.com/__a__]', readingView: '[https://x.com/a]' },
        { line: '[a](https://x.com/__a__)', readingView: 'a' },
        { line: '[](https://x.com/__a__)', readingView: '' },
        {
          line: '[x](y) https://x.com/_a_',
          readingView: 'x https://x.com/_a_',
        },
        { line: '[x *a*]', readingView: '[x a]' },
        { line: '[a *b] c*', readingView: '[a *b] c*' },
        { line: '[a [b] *c*]', readingView: '[a [b] c]' },
        { line: '<https://x.com/__a__>', readingView: 'https://x.com/__a__' },
        { line: '<https://x.com/&amp;>', readingView: 'https://x.com/&' },
        { line: '<a_b_@x.co>', readingView: 'a_b_@x.co' },
        { line: '<mailto:a@b.c>', readingView: 'a@b.c' },
        { line: '<https://>', readingView: 'https://' },
        { line: '<a:/b>', readingView: '<a:/b>' },
        {
          line: '[<https://x.com/__a__>](u)',
          readingView: '<https://x.com/a>',
        },
        { line: '*a <https://x*y> b*', readingView: 'a <https://xy> b*' },
      ])(
        'link text and autolinks: $line renders $readingView',
        expectReadingView
      );

      it.each([
        { line: '* a *b*', readingView: 'a b' },
        { line: '- a *b*', readingView: 'a b' },
        { line: '+ _a_', readingView: 'a' },
        { line: '* *a*', readingView: 'a' },
        { line: '1. *a*', readingView: 'a' },
        { line: '1) *a*', readingView: 'a' },
        { line: '- [ ] *a*', readingView: 'a' },
        { line: '* [ ] *a*', readingView: 'a' },
        { line: '- [x] *a* b*', readingView: 'a b*' },
        { line: '- [ ] ', readingView: '' },
        { line: '> *a*', readingView: 'a' },
        { line: '> a &amp; b', readingView: 'a & b' },
        { line: '> [!note] *a*', readingView: 'a' },
        { line: '> [!note] *a* #', readingView: 'a #' },
        { line: '- https://x.com/__a__', readingView: 'https://x.com/__a__' },
        { line: '> - a', readingView: 'a' },
        { line: '> - hello there', readingView: 'hello there' },
        { line: '> 1. a', readingView: 'a' },
        { line: '> - [ ] a', readingView: 'a' },
        { line: '> > a', readingView: 'a' },
        { line: '> # a', readingView: 'a' },
        { line: '- # a', readingView: 'a' },
        { line: '- > a', readingView: 'a' },
        { line: '- - a', readingView: 'a' },
        { line: '1. - a', readingView: 'a' },
        { line: '- [ ] - a', readingView: 'a' },
        { line: '> [!info] - hello there', readingView: 'hello there' },
        { line: '> [!info] 1. hello', readingView: 'hello' },
        { line: '> [!note] + hello', readingView: 'hello' },
        { line: '> [!note] # a #', readingView: 'a' },
      ])('block prefixes: $line renders $readingView', expectReadingView);

      it.each([
        { line: '# *a*', readingView: 'a' },
        { line: '# a #', readingView: 'a' },
        { line: '## *a* ##', readingView: 'a' },
        { line: '# a#', readingView: 'a#' },
        { line: '# a \\#', readingView: 'a #' },
        { line: '# #a', readingView: '#a' },
        { line: '# a # b', readingView: 'a # b' },
        { line: '# a ##  ', readingView: 'a' },
        { line: '#\ta #', readingView: 'a' },
        { line: '# https://x.com/__a__', readingView: 'https://x.com/__a__' },
      ])('headings: $line renders $readingView', expectReadingView);

      it.each([
        { line: 'a &amp; b', readingView: 'a & b' },
        { line: '&lt;x&gt;', readingView: '<x>' },
        { line: '&#35;tag', readingView: '#tag' },
        { line: '&copy;', readingView: '©' },
        { line: 'a&nbsp;b', readingView: 'a\u00A0b' },
        { line: '&nbsp;', readingView: '\u00A0' },
        { line: '&foo;', readingView: '&foo;' },
        { line: '`&amp;`', readingView: '&amp;' },
        { line: '&amp', readingView: '&' },
        { line: '&copyx', readingView: '©x' },
        { line: '&notit;', readingView: '¬it;' },
        { line: '&hearts;', readingView: '♥' },
        { line: '&#x1F534;', readingView: '🔴' },
        { line: '&#0;', readingView: '\uFFFD' },
        { line: '&#128;', readingView: '€' },
        { line: 'a&#32;b', readingView: 'a b' },
        { line: '\\&amp;', readingView: '&amp;' },
        { line: '*&amp;*', readingView: '&' },
        { line: '~~&amp;~~', readingView: '&' },
        { line: '==&#x1F534;x==', readingView: '🔴x' },
        { line: '%%&amp;%%x', readingView: 'x' },
        { line: '&lt;b&gt;x&lt;/b&gt;', readingView: '<b>x</b>' },
      ])('character references: $line renders $readingView', expectReadingView);

      it.each([
        { line: '$5 and $6', readingView: '$5 and $6' },
        { line: '\\$a$', readingView: '$a$' },
        { line: 'a $ b$', readingView: 'a $ b$' },
        { line: '$a$1', readingView: '$a$1' },
        { line: '`$a$` $b', readingView: '$a$ $b' },
      ])(
        'dollar signs that open no math: $line renders $readingView',
        expectReadingView
      );

      it.each([
        { line: '<a href="https://x.com/__a__">t</a>', readingView: 't' },
        {
          line: '<a href="x">https://x.com/__a__</a>',
          readingView: 'https://x.com/a',
        },
        {
          line: '<A HREF="x">https://x.com/__a__</A>',
          readingView: 'https://x.com/a',
        },
        {
          line: '<a href="x">t</a> https://x.com/__a__',
          readingView: 't https://x.com/__a__',
        },
        {
          line: '<b>https://x.com/__a__</b>',
          readingView: 'https://x.com/__a__',
        },
        { line: '<span title="*a*">b</span>', readingView: 'b' },
        { line: '<!-- *a* --> b', readingView: 'b' },
        { line: '<b>*a*</b>', readingView: 'a' },
        { line: 'x <b>a &amp; b</b>', readingView: 'x a & b' },
      ])('inline HTML: $line renders $readingView', expectReadingView);

      it.each([
        { line: '[a](x*y) *z*', readingView: 'a z' },
        {
          line: '[Foo (bar)](Foo%20(bar).md) tail',
          readingView: 'Foo (bar) tail',
        },
        { line: '[a](<Foo (bar).md>) tail', readingView: 'a tail' },
        { line: '[a [b] c](x) tail', readingView: 'a [b] c tail' },
        { line: '[a]() tail', readingView: 'a tail' },
        { line: '[](x) tail', readingView: 'tail' },
        { line: '[a](<b>)', readingView: 'a' },
        { line: '[a](b "t")', readingView: 'a' },
        { line: '[a](b\\ c) tail', readingView: 'a tail' },
        { line: '[a](<b\\>c>) tail', readingView: '[a](<b>c>) tail' },
        { line: '[a] (x) tail', readingView: '[a] (x) tail' },
        {
          line: '[a [b] https://x.com/__a__]',
          readingView: '[a [b] https://x.com/__a__]',
        },
      ])('links: $line renders $readingView', expectReadingView);

      it.each([
        { line: '<foo bar>', readingView: '' },
        { line: '<foo bar> text', readingView: 'text' },
        { line: 'a<br>b', readingView: 'ab' },
        { line: '<B>x</b>', readingView: 'x' },
        { line: 'a <script>x</script> y', readingView: 'a  y' },
        { line: '<script>x</script> y', readingView: 'y' },
        { line: 'a <style>x</style> y', readingView: 'a  y' },
        { line: 'a <template>x</template> y', readingView: 'a  y' },
        { line: '<kbd>x</kbd> y', readingView: 'x y' },
      ])(
        'unpaired and hiding HTML: $line renders $readingView',
        expectReadingView
      );

      // A line that opens an HTML block reaches the browser as typed, so no Markdown is parsed on it and only its HTML and character references are read
      it.each([
        { line: '<div>**a** `b` [c](d) e', readingView: '**a** `b` [c](d) e' },
        {
          line: '<div>[[Note A]] #tag ==hi== ~~s~~ *i* e',
          readingView: '[[Note A]] #tag ==hi== ~~s~~ *i* e',
        },
        {
          line: '<div>\\*x\\* &amp; &lt;y&gt; z',
          readingView: '\\*x\\* & <y> z',
        },
        { line: '<div>a %%c%% b', readingView: 'a %%c%% b' },
        { line: '<div>$x^2$ after', readingView: '$x^2$ after' },
        { line: '<div>a ^[fn] b [^1] c', readingView: 'a ^[fn] b [^1] c' },
        { line: '<div>![[pic.png]] after', readingView: '![[pic.png]] after' },
        { line: '<div>text ^abc', readingView: 'text ^abc' },
        { line: '<div><b>bold</b> <span>s</span> t', readingView: 'bold s t' },
        { line: '<div>a &#42;b&#42; c', readingView: 'a *b* c' },
        { line: '<div>a &ampx@y.com', readingView: 'a &x@y.com' },
        { line: '<div>a<script>h</script> b', readingView: 'a b' },
        { line: '<DIV>**a** b', readingView: '**a** b' },
        { line: '</div>**a** b', readingView: '**a** b' },
        { line: '<!-- c -->**a** b', readingView: '**a** b' },
        { line: '- <div>**a** b ^id', readingView: '**a** b ^id' },
        { line: '> <div>**a** b', readingView: '**a** b' },
        { line: '1. <div>**a** b', readingView: '**a** b' },
        { line: '> [!note] <div>**a** b', readingView: '**a** b' },
        { line: '# <div>**a** b', readingView: 'a b' },
        { line: '<span>**a** b', readingView: 'a b' },
        { line: '<b>**a**</b> c', readingView: 'a c' },
      ])('HTML blocks: $line renders $readingView', expectReadingView);

      // A line that opens an HTML block reaches the browser as typed, so a hidden element ends at its first close tag; in a paragraph or heading Reading view renders the Markdown first and the browser then hides from the open tag to the first close tag in the HTML that reached it, so one inside a code span, which remark escapes, ends nothing and the element runs on to the next one
      it.each([
        { line: '<script>a `</script>` b</script> c', readingView: '` b c' },
        { line: '<SCRIPT>a `</SCRIPT>` b</SCRIPT> c', readingView: '` b c' },
        { line: '- <script>a `</script>` b</script> c', readingView: '` b c' },
        { line: '1. <script>a `</script>` b</script> c', readingView: '` b c' },
        {
          line: '- [ ] <script>a `</script>` b</script> c',
          readingView: '` b c',
        },
        { line: '> <script>a `</script>` b</script> c', readingView: '` b c' },
        {
          line: '> - <script>a `</script>` b</script> c',
          readingView: '` b c',
        },
        {
          line: '> [!note] <script>a `</script>` b</script> c',
          readingView: '` b c',
        },
        {
          line: '<div><template>a `</template>` b</template> c',
          readingView: '` b c',
        },
        { line: '<p><script>a `</script>` b</script> c', readingView: '` b c' },
        { line: '# <script>a `</script>` b</script> c', readingView: 'c' },
        { line: '- # <script>a `</script>` b</script> c', readingView: 'c' },
        { line: 'x <script>a `</script>` b</script> c', readingView: 'x c' },
        {
          line: '> [!note] x <script>a `</script>` b</script> c',
          readingView: 'x c',
        },
        { line: '<span><script>a `</script>` b</script> c', readingView: 'c' },
        { line: '<template>a `</template>` b</template> c', readingView: 'c' },
        { line: '<xmp>a `</xmp>` b</xmp> c', readingView: 'c' },
        { line: '<noscript>a `</noscript>` b</noscript> c', readingView: 'c' },
        { line: 'x <script>a \\</script> b</script> c', readingView: 'x c' },
        { line: 'x <script>a $</script>$ b</script> c', readingView: 'x c' },
        {
          line: 'x <script>a **</script>** b</script> c',
          readingView: 'x b c',
        },
        { line: 'x <script>a *</script>* b</script> c', readingView: 'x b c' },
        {
          line: 'x <script>a ==</script>== b</script> c',
          readingView: 'x b c',
        },
        {
          line: 'x <script>a ~~</script>~~ b</script> c',
          readingView: 'x b c',
        },
        {
          line: 'x <script>a [</script>](u) b</script> c',
          readingView: 'x b c',
        },
        { line: 'x <style>a **</style>** b</style> c', readingView: 'x b c' },
        {
          line: 'x <script>a **b</script> c** d</script> e',
          readingView: 'x c d e',
        },
        {
          line: 'x <script>a [</script>] b</script> c',
          readingView: 'x ] b c',
        },
        { line: 'x <script>a [l](</script>) b</script> c', readingView: 'x c' },
        {
          line: 'x <script>a <https://e.com/</script>> b</script> c',
          readingView: 'x c',
        },
        { line: 'x <script>a %%</script>%% b</script> c', readingView: 'x c' },
        {
          line: 'x <script>a <a href="</script>">l</a> b</script> c',
          readingView: 'x ">l b c',
        },
        {
          line: 'x <script>a <!-- </script> --> b</script> c',
          readingView: 'x --> b c',
        },
        {
          line: 'x <script>a ![</script>](p.png) b</script> c',
          readingView: 'x "> b c',
        },
        {
          line: 'x <style>a <!-- </script> </style> --> b</style> c',
          readingView: 'x --> b c',
        },
        {
          line: 'x <style>a ![</script></style>](p.png) b</style> c',
          readingView: 'x "> b c',
        },
        {
          line: 'x <script>a ![&lt;/script>](p.png) b</script> c',
          readingView: 'x "> b c',
        },
        {
          line: 'x <script>a ![</script>a&amp;b](p.png) b</script> c',
          readingView: 'x a&b"> b c',
        },
        { line: 'x <a href="</script>">l</a> y', readingView: 'x l y' },
        { line: 'x <!-- </script> --> y', readingView: 'x y' },
        { line: 'x <iframe>a</iframe> b', readingView: 'x b' },
        { line: 'x <noembed>a</noembed> b', readingView: 'x b' },
        { line: 'x <noframes>a</noframes> b', readingView: 'x b' },
        { line: '<iframe src="x">a</iframe> b', readingView: 'b' },
        { line: 'x <plaintext>a b', readingView: 'x' },
        { line: 'x <plaintext>a</plaintext> b', readingView: 'x' },
        { line: '<plaintext>a b', readingView: 'Untitled' },
        {
          line: 'x <script>a <!-- </script> <style> --> b</script> c',
          readingView: 'x',
        },
        {
          line: 'x <script>a <!-- </script> <span hidden> --> b</span> c',
          readingView: 'x c',
        },
        { line: 'x <video>a</video> b', readingView: 'x b' },
        { line: 'x <span hidden>a</span> b', readingView: 'x b' },
        { line: 'x <details>a</details> b', readingView: 'x b' },
        {
          line: 'x <svg><text><foreignObject>a</foreignObject></text></svg> b',
          readingView: 'x b',
        },
        { line: 'x <svg><desc>a</svg> b', readingView: 'x b' },
        { line: 'x <text>a</text> b', readingView: 'x b' },
        { line: 'x <span style="display:none">a</span> b', readingView: 'x b' },
        { line: 'Plan <span hidden>draft</span> v2', readingView: 'Plan v2' },
        {
          line: 'Plan <details><summary>Summary</summary>body</details> end',
          readingView: 'Plan Summary end',
        },
        { line: 'x **a <video>b** c</video> d', readingView: 'x a c d' },
        {
          line: '# x ~~a <span hidden>b <div>c~~ d</div> e</span> f',
          readingView: 'x a f',
        },
        {
          line: '# x ==a <span hidden>b <div>c== d</div> e</span> f',
          readingView: 'x a f',
        },
        { line: '# x <video>a</video> b', readingView: 'x b' },
        { line: '- x <span hidden>a</span> b', readingView: 'x b' },
        { line: '> [!note] t <video>a</video> b', readingView: 't b' },
        { line: '<video>a</video> b', readingView: 'b' },
        { line: '<details>a</details> b', readingView: 'b' },
        { line: '<div hidden>a</div> b', readingView: 'b' },
        { line: '<span hidden>a</span> b', readingView: 'b' },
        { line: '<details open>a</details> b', readingView: 'a b' },
      ])(
        'hidden HTML elements: $line renders $readingView',
        ({ line, readingView }) => {
          expect(extractTitle(line, defaults).replace(/\s+/g, ' ').trim()).toBe(
            readingView
          );
        }
      );

      it.each([
        { line: 'text[^1]', readingView: 'text' },
        { line: 'a [^1]: b', readingView: 'a : b' },
        { line: '^[note] text', readingView: ' text' },
        { line: '[^a b] text', readingView: '[^a b] text' },
      ])('footnotes: $line renders $readingView', expectReadingView);

      it.each([
        { line: '#tag', readingView: '#tag' },
        { line: '#123', readingView: '#123' },
        { line: '#a_b_ text', readingView: '#a_b_ text' },
        { line: 'x #a_b_', readingView: 'x #a_b_' },
        { line: 'a#b_c_', readingView: 'a#bc' },
        { line: '*a*#b_c_', readingView: 'a#b_c_' },
        { line: '#тег_a_', readingView: '#тег_a_' },
        { line: '#a-b_c_', readingView: '#a-b_c_' },
        { line: '#a*b*c', readingView: '#abc' },
        { line: '#a.b_c_', readingView: '#a.bc' },
        { line: '(#b_c_)', readingView: '(#bc)' },
        { line: 'x #123_a_', readingView: 'x #123_a_' },
        { line: '`x` #a_b_', readingView: 'x #a_b_' },
      ])('tags: $line renders $readingView', expectReadingView);

      // Reading view shows a missing embed's error text and a present one's picture, so an embed is titled after its alt text or target, as FLIT titles every embed; Obsidian itself reads a size alias as no alt text.
      it.each([
        { line: '![alt](img.png) tail', title: 'alt tail' },
        { line: '![[photo.jpg|400]]', title: 'photo.jpg' },
        { line: '![[note|300x200]]', title: 'note' },
        { line: '[[note|400]]', title: '400' },
      ])('embeds: $line is titled $title', ({ line, title }) => {
        expect(extractTitle(line, defaults)).toBe(title);
      });

      describe('with Markdown link stripping off', () => {
        const linksKept = createTestSettings();
        linksKept.markupStripping.stripMarkupSettings.markdownLinks = false;

        it.each([
          { line: '[a](x*y*z)', title: '[a](x*y*z)' },
          { line: '[*a*](x)', title: '[*a*](x)' },
          { line: '[](x) tail', title: '[](x) tail' },
          { line: '[](x)', title: '[](x)' },
        ])('$line keeps the link as typed', ({ line, title }) => {
          expect(extractTitle(line, linksKept)).toBe(title);
        });
      });
    });
  });

  describe('normalizeExclusionLists', () => {
    beforeEach(() => {
      settings.exclusions.excludedFiles = [];
      settings.exclusions.excludedTags = [];
      settings.exclusions.excludedProperties = [];
    });

    describe('blank entry removal', () => {
      it('should remove blank excluded-file entries', () => {
        settings.exclusions.excludedFiles = ['', 'Notes/', ''];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedFiles).toEqual(['Notes/']);
      });

      it('should remove whitespace-only excluded-file entries', () => {
        settings.exclusions.excludedFiles = ['Notes/', '   '];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedFiles).toEqual(['Notes/']);
      });

      it('should trim excluded-file entries, preserving case', () => {
        settings.exclusions.excludedFiles = ['  Notes/  ', ' /Draft-/ '];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedFiles).toEqual([
          'Notes/',
          '/Draft-/',
        ]);
      });

      it('should remove blank tag entries', () => {
        settings.exclusions.excludedTags = ['', 'project', ''];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedTags).toEqual(['project']);
      });

      it('should remove property entries with blank key and value', () => {
        settings.exclusions.excludedProperties = [
          { key: '', value: '' },
          { key: 'status', value: 'draft' },
        ];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedProperties).toEqual([
          { key: 'status', value: 'draft' },
        ]);
      });

      it('should remove property entries with a blank key but a value', () => {
        // A blank key can never match a property, so the row would read as live but
        // never fire
        settings.exclusions.excludedProperties = [
          { key: '', value: 'draft' },
          { key: 'status', value: 'draft' },
        ];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedProperties).toEqual([
          { key: 'status', value: 'draft' },
        ]);
      });

      it('should keep a property entry that has a key but a blank value', () => {
        settings.exclusions.excludedProperties = [{ key: 'status', value: '' }];

        expect(normalizeExclusionLists(settings)).toBe(false);
        expect(settings.exclusions.excludedProperties).toEqual([
          { key: 'status', value: '' },
        ]);
      });

      it('should collapse an all-blank list to an empty array', () => {
        settings.exclusions.excludedFiles = ['', '  ', ''];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedFiles).toEqual([]);
      });
    });

    describe('deduplication', () => {
      it('should keep the last occurrence of a case-insensitive duplicate path entry', () => {
        settings.exclusions.excludedFiles = ['Notes/', 'Archive/', 'notes/'];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedFiles).toEqual([
          'Archive/',
          'notes/',
        ]);
      });

      it('should treat entries that differ only by surrounding whitespace as duplicates', () => {
        settings.exclusions.excludedFiles = ['Notes/', ' Notes/ '];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedFiles).toEqual(['Notes/']);
      });

      it('should keep entries that differ by a trailing slash, since they match different paths', () => {
        settings.exclusions.excludedFiles = ['Notes', 'Notes/'];

        expect(normalizeExclusionLists(settings)).toBe(false);
        expect(settings.exclusions.excludedFiles).toEqual(['Notes', 'Notes/']);
      });

      it('should keep regular expressions that differ only by case, since case changes their meaning', () => {
        settings.exclusions.excludedFiles = ['/\\d/', '/\\D/', '/\\d/'];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedFiles).toEqual(['/\\D/', '/\\d/']);
      });

      it('should keep the last occurrence of a duplicate tag', () => {
        settings.exclusions.excludedTags = ['Project', 'work', 'project'];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedTags).toEqual(['work', 'project']);
      });

      it('should treat a tag written with and without its "#" as one entry', () => {
        settings.exclusions.excludedTags = ['#project', 'work', 'Project'];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedTags).toEqual(['work', 'Project']);
      });

      it('should drop a bare "#" tag entry, which matches no tag', () => {
        settings.exclusions.excludedTags = ['#', 'work'];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedTags).toEqual(['work']);
      });

      it('should keep tag patterns that differ only by case, since case changes their meaning', () => {
        settings.exclusions.excludedTags = ['/\\d/', '/\\D/', '/\\d/'];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedTags).toEqual(['/\\D/', '/\\d/']);
      });

      // Obsidian accepts a tag written `#/x/`, which the tag menu can add beside the pattern `/x/`
      it('should keep a tag pattern beside a tag written like it', () => {
        settings.exclusions.excludedTags = ['/x/', '#/x/'];

        expect(normalizeExclusionLists(settings)).toBe(false);
        expect(settings.exclusions.excludedTags).toEqual(['/x/', '#/x/']);
      });

      it('should fold case on a plain property side but not on a pattern side', () => {
        settings.exclusions.excludedProperties = [
          { key: '/A/', value: 'x' },
          { key: '/a/', value: 'x' },
          { key: 'status', value: '/Draft/' },
          { key: 'Status', value: '/Draft/' },
        ];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedProperties).toEqual([
          { key: '/A/', value: 'x' },
          { key: '/a/', value: 'x' },
          { key: 'Status', value: '/Draft/' },
        ]);
      });

      it('should deduplicate properties only when key and value both match', () => {
        settings.exclusions.excludedProperties = [
          { key: 'status', value: 'draft' },
          { key: 'status', value: 'final' },
          { key: 'Status', value: 'Draft' },
        ];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedProperties).toEqual([
          { key: 'status', value: 'final' },
          { key: 'Status', value: 'Draft' },
        ]);
      });
    });

    describe('return value', () => {
      it('should return false when every list is already clean', () => {
        settings.exclusions.excludedFiles = ['Notes/', '/draft-/'];
        settings.exclusions.excludedTags = ['project'];
        settings.exclusions.excludedProperties = [
          { key: 'status', value: 'draft' },
        ];

        expect(normalizeExclusionLists(settings)).toBe(false);
      });

      it('should return true when an entry only needed trimming', () => {
        settings.exclusions.excludedTags = ['  project  '];

        expect(normalizeExclusionLists(settings)).toBe(true);
        expect(settings.exclusions.excludedTags).toEqual(['project']);
      });
    });
  });

  describe('reverseCharacterReplacements', () => {
    beforeEach(() => {
      settings.characterReplacements.enableForbiddenCharReplacements = true;
    });

    const enableChar = (
      key: CharKey,
      overrides: Partial<CharReplacementConfig> = {}
    ) => {
      const config = settings.characterReplacements.charReplacements[key];
      config.enabled = true;
      Object.assign(config, overrides);
      return config;
    };

    // Every shipped default replacement, reversed with plain substitution.
    // `slash` and `quote` are multi-character, so a per-character advance corrupts them.
    const shippedDefaults: Array<{
      key: CharKey;
      input: string;
      expected: string;
    }> = [
      { key: 'slash', input: 'a ∕ b', expected: 'a/b' },
      { key: 'colon', input: 'a։b', expected: 'a:b' },
      { key: 'asterisk', input: 'a∗b', expected: 'a*b' },
      { key: 'question', input: 'a？b', expected: 'a?b' },
      { key: 'lessThan', input: 'a‹b', expected: 'a<b' },
      { key: 'greaterThan', input: 'a›b', expected: 'a>b' },
      { key: 'quote', input: "say ''hi''", expected: 'say "hi"' },
      { key: 'pipe', input: 'a❘b', expected: 'a|b' },
      { key: 'hash', input: 'a＃b', expected: 'a#b' },
      { key: 'leftBracket', input: 'a［b', expected: 'a[b' },
      { key: 'rightBracket', input: 'a］b', expected: 'a]b' },
      { key: 'caret', input: 'aˆb', expected: 'a^b' },
      { key: 'backslash', input: 'a⧵b', expected: 'a\\b' },
      { key: 'dot', input: 'a․b', expected: 'a.b' },
    ];

    describe('shipped defaults without re-spacing', () => {
      it.each(shippedDefaults)(
        'reverses the default $key replacement',
        ({ key, input, expected }) => {
          enableChar(key);

          expect(reverseCharacterReplacements(input, settings)).toBe(expected);
        }
      );

      it('reverses repeated multi-character replacements in one string', () => {
        enableChar('slash');

        expect(reverseCharacterReplacements('a ∕ b ∕ c', settings)).toBe(
          'a/b/c'
        );
      });

      it('reverses several enabled characters in one string', () => {
        enableChar('slash');
        enableChar('quote');
        enableChar('question');

        expect(reverseCharacterReplacements("a ∕ b ''c'' d？", settings)).toBe(
          'a/b "c" d?'
        );
      });

      // Nothing tells which character a shared string stood for
      it('leaves a replacement shared by two characters as it is', () => {
        enableChar('slash', { replacement: '-' });
        enableChar('colon', { replacement: '-' });

        expect(reverseCharacterReplacements('a-b', settings)).toBe('a-b');
      });

      // Title conversion governs title insertion only, and that caller checks it itself
      it('reverses while Character replacements is on, even with title conversion off', () => {
        settings.core.convertReplacementChars = false;

        expect(reverseCharacterReplacements('a⧵b․c', settings)).toBe('a\\b.c');
      });

      // With Character replacements off FLIT made no replacements, so there is nothing to reverse
      it('leaves text untouched while Character replacements is off, even with title conversion on', () => {
        settings.characterReplacements.enableForbiddenCharReplacements = false;
        settings.core.convertReplacementChars = true;

        expect(reverseCharacterReplacements('a⧵b․c', settings)).toBe('a⧵b․c');
      });

      // Guards the insert-filename command, which echoes a filename verbatim
      it('ignores trim flags unless re-spacing is requested', () => {
        enableChar('question');
        enableChar('leftBracket');
        enableChar('rightBracket');

        expect(reverseCharacterReplacements('What？Now', settings)).toBe(
          'What?Now'
        );
        expect(reverseCharacterReplacements('a［b］c', settings)).toBe('a[b]c');
      });
    });

    describe('with re-spacing opted in', () => {
      const respace = (text: string) =>
        reverseCharacterReplacements(text, settings, undefined, {
          restoreTrimmedSpacing: true,
        });

      it('reverses multi-character replacements that carry no trim flags', () => {
        enableChar('slash');
        enableChar('quote');

        expect(respace('a ∕ b')).toBe('a/b');
        expect(respace("say ''hi''")).toBe('say "hi"');
      });

      it('restores the space trimmed to the right of a question mark', () => {
        enableChar('question');

        expect(respace('What？Now')).toBe('What? Now');
      });

      it('adds no trailing space when a question mark ends the title', () => {
        enableChar('question');

        expect(respace('Really？')).toBe('Really?');
      });

      it('adds no trailing space before punctuation', () => {
        enableChar('question');

        expect(respace('Really？! Yes')).toBe('Really?! Yes');
      });

      // An opening bracket binds to the text after it and a closing one to the text before it, so each gets back only its outer space.
      it('restores spaces only on the outer side of bracket replacements', () => {
        enableChar('leftBracket');
        enableChar('rightBracket');

        expect(respace('a［b］c')).toBe('a [b] c');
      });

      it('restores a bracket pair with its default trims', () => {
        enableChar('leftBracket');
        enableChar('rightBracket');

        // Under the default trims no first line written with ASCII brackets maps back to `［Draft］ Plan`: the forward pass drops the space after `］`, so the note takes the name `［Draft］Plan` on its next pass.
        expect(respace('［Draft］ Plan')).toBe('[Draft] Plan');
      });

      it('restores the space between adjacent bracket pairs once', () => {
        enableChar('leftBracket');
        enableChar('rightBracket');

        expect(respace('［a］［b］')).toBe('[a] [b]');
      });

      it('restores spaces around a bracket pair inside a word', () => {
        enableChar('leftBracket');
        enableChar('rightBracket');

        expect(respace('foo［bar］baz')).toBe('foo [bar] baz');
      });

      it('restores the space after a mid-word question mark with its default trims', () => {
        enableChar('question');

        expect(respace('a？b')).toBe('a? b');
      });

      it('adds no space between a closing bracket and punctuation', () => {
        enableChar('leftBracket');
        enableChar('rightBracket');

        expect(respace('［Draft］: x')).toBe('[Draft]: x');
      });

      it('adds no space at the start of the text or next to whitespace', () => {
        enableChar('question', { trimLeft: true });

        expect(respace('？ a ？')).toBe('? a ?');
      });

      it('inspects the character past a multi-character replacement', () => {
        // Reading one char past the start would land inside "''" and see punctuation
        enableChar('quote', { trimRight: true });

        expect(respace("say ''hi")).toBe('say " hi');
      });
    });
  });
});
