/**
 * Comprehensive test suite for FirstLinePropertyManager
 *
 * Tests cover:
 * - getFirstLinePropertyKeys: parsing, whitespace, blank key
 * - updateFirstLinePropertyIfNeeded: the value pipeline, ZWSP markers, truncation, custom replacements, multi-property, no-op passes, exclusion overrides
 * - removeFirstLinePropertyValuesFromFile: selective removal, keepEmptyProperty, untouched properties
 * - Write target: the editor showing the note, or the file
 * - Edge cases: ENOENT, concurrent calls, special characters
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getFrontMatterInfo, parseYaml, stringifyYaml } from 'obsidian';
import { FirstLinePropertyManager } from '../../src/core/first-line-property-manager';
import { createMockFile, createMockApp, splitFrontMatter } from '../testUtils';
import { TFile, MarkdownView } from '../mockObsidian';
import { DeepPartial, PluginSettings } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/constants';
import { deepMerge } from '../../src/utils/deep-merge';
import { mergeSettingsOverDefaults } from '../../src/settings/transfer';

const ZWSP = '​';

/** A value as the plugin stores it, wrapped in its ZWSP markers */
const marked = (value: string) => `${ZWSP}${value}${ZWSP}`;

// Create mock plugin for FirstLinePropertyManager
function createMockPlugin(settingsOverrides: DeepPartial<PluginSettings> = {}) {
  const app = createMockApp();
  // deepMerge deep-clones its defaults, so untouched branches never alias DEFAULT_SETTINGS
  const settings = deepMerge(DEFAULT_SETTINGS, {
    firstLineProperty: {
      truncate: false,
      addOnlyIfTitleDiffers: false,
      propertyKey: 'aliases',
      hideProperty: 'never',
      hideInSidebar: false,
      keepEmptyProperty: true,
    },
    core: {
      charCount: 100,
    },
    markupStripping: {
      stripMarkupInFirstLineProperty: false,
      applyCustomReplacementsInFirstLineProperty: false,
    },
    customReplacements: {
      rules: [],
    },
    ...settingsOverrides,
  });

  const pendingMetadataPaths = new Set<string>();
  return {
    app,
    settings,
    fileStateManager: {
      markEditorSyncing: vi.fn(),
      clearEditorSyncing: vi.fn(),
      markPendingMetadataUpdate: (path: string) => {
        pendingMetadataPaths.add(path);
      },
      hasPendingMetadataUpdate: (path: string) =>
        pendingMetadataPaths.has(path),
    },
  } as any;
}

/** An editor showing `text`, with a CodeMirror view whose `dispatch` is recorded */
function createEditorTarget(text: string) {
  const editor = {
    getValue: vi.fn(() => text),
    replaceRange: vi.fn(),
    cm: { dispatch: vi.fn() },
  };
  return { editor: editor as any, isDirty: () => false, requestSave: vi.fn() };
}

/**
 * Wire the YAML mocks to read a properties block as JSON, which is valid YAML, so a block round-trips through parse and stringify.
 * @param yamlFixtures - Blocks that are not JSON (a comment, say), mapped to what they parse to
 */
function installJsonYaml(yamlFixtures = new Map<string, unknown>()) {
  vi.mocked(getFrontMatterInfo).mockImplementation(
    splitFrontMatter as unknown as typeof getFrontMatterInfo
  );
  vi.mocked(parseYaml).mockImplementation(((yaml: string) =>
    yamlFixtures.has(yaml)
      ? structuredClone(yamlFixtures.get(yaml))
      : JSON.parse(yaml)) as typeof parseYaml);
  vi.mocked(stringifyYaml).mockImplementation(
    (value: unknown) => `${JSON.stringify(value)}\n`
  );
}

/** Note text with a properties block holding `properties` as JSON, or no block for null */
function noteText(
  properties: Record<string, unknown> | null,
  body = 'First Line\nBody'
): string {
  return properties ? `---\n${JSON.stringify(properties)}\n---\n${body}` : body;
}

/**
 * Put a note on disk: `vault.read` serves its text, and `processFrontMatter` rewrites the whole block the way Obsidian's does. Needs `installJsonYaml`.
 * @returns Reads of the note's current text and parsed properties
 */
function installDiskNote(plugin: any, initialText: string) {
  let text = initialText;
  plugin.app.vault.read = vi.fn(async () => text);
  plugin.app.fileManager.processFrontMatter = vi.fn(
    async (_file: TFile, mutate: (frontmatter: any) => void) => {
      const info = splitFrontMatter(text);
      const properties = info.exists ? parseYaml(info.frontmatter) : {};
      mutate(properties);
      const body = info.exists ? text.slice(info.contentStart) : text;
      text = Object.keys(properties).length
        ? `---\n${JSON.stringify(properties)}\n---\n${body}`
        : body;
    }
  );
  return {
    text: () => text,
    properties: (): Record<string, unknown> => {
      const info = splitFrontMatter(text);
      return info.exists ? parseYaml(info.frontmatter) : {};
    },
  };
}

describe('FirstLinePropertyManager', () => {
  let plugin: ReturnType<typeof createMockPlugin>;
  let firstLinePropertyManager: FirstLinePropertyManager;
  let file: TFile;

  beforeEach(() => {
    plugin = createMockPlugin();
    firstLinePropertyManager = new FirstLinePropertyManager(plugin);
    file = createMockFile('test.md');

    // Reset all mocks
    vi.clearAllMocks();

    // Default mocks
    plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getFrontMatterInfo).mockReset();
    vi.mocked(parseYaml).mockReset();
    vi.mocked(stringifyYaml).mockReset();
  });

  /** Run a pass over the note's current text, as the save and metadata handlers do */
  const updateFromText = (
    text: string,
    target: ReturnType<typeof createEditorTarget> | null = null
  ) =>
    firstLinePropertyManager.updateFirstLinePropertyIfNeeded(
      file,
      text,
      target
    );

  describe('constructor and accessors', () => {
    it('should initialize with plugin reference', () => {
      expect(firstLinePropertyManager).toBeDefined();
      expect(firstLinePropertyManager['plugin']).toBe(plugin);
    });

    it('should have access to app through plugin', () => {
      expect(firstLinePropertyManager.app).toBe(plugin.app);
    });

    it('should have access to settings through plugin', () => {
      expect(firstLinePropertyManager.settings).toBe(plugin.settings);
    });
  });

  describe('getFirstLinePropertyKeys', () => {
    it('should return no keys when the property name is blank', () => {
      plugin.settings.firstLineProperty.propertyKey = '';
      const keys = firstLinePropertyManager['getFirstLinePropertyKeys']();
      expect(keys).toEqual([]);
    });

    it('should return single property key', () => {
      plugin.settings.firstLineProperty.propertyKey = 'aliases';
      const keys = firstLinePropertyManager['getFirstLinePropertyKeys']();
      expect(keys).toEqual(['aliases']);
    });

    it('should return multiple comma-separated keys', () => {
      plugin.settings.firstLineProperty.propertyKey =
        'aliases, aka, also-known-as';
      const keys = firstLinePropertyManager['getFirstLinePropertyKeys']();
      expect(keys).toEqual(['aliases', 'aka', 'also-known-as']);
    });

    it('should trim whitespace from keys', () => {
      plugin.settings.firstLineProperty.propertyKey =
        '  aliases  ,  aka  ,  test  ';
      const keys = firstLinePropertyManager['getFirstLinePropertyKeys']();
      expect(keys).toEqual(['aliases', 'aka', 'test']);
    });

    it('should filter out empty keys', () => {
      plugin.settings.firstLineProperty.propertyKey = 'aliases, , aka, ,';
      const keys = firstLinePropertyManager['getFirstLinePropertyKeys']();
      expect(keys).toEqual(['aliases', 'aka']);
    });

    it('should return no keys when the property name is only commas', () => {
      plugin.settings.firstLineProperty.propertyKey = ', , ,';
      const keys = firstLinePropertyManager['getFirstLinePropertyKeys']();
      expect(keys).toEqual([]);
    });

    // The setting is typed `string` and this function indexes into it directly; the loader keeps the default for a stored value of another shape, so a null in data.json never displaces it.
    it('should never see a null key because the loader keeps the default', () => {
      const merged = mergeSettingsOverDefaults({
        firstLineProperty: { propertyKey: null },
      });
      expect(merged.firstLineProperty.propertyKey).toBe(
        DEFAULT_SETTINGS.firstLineProperty.propertyKey
      );
    });
  });

  // A blank property name is a deliberate "no first line property" choice, not a
  // request for the default. Every entry point must bail before it reaches a
  // write - processFrontMatter opens and rewrites the file even when the
  // per-key loop inside it would iterate zero times.
  describe('blank first line property name', () => {
    beforeEach(() => {
      plugin.settings.firstLineProperty.propertyKey = '';
      plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
    });

    it('should make updateFirstLinePropertyIfNeeded return false without writing', async () => {
      const result =
        await firstLinePropertyManager.updateFirstLinePropertyIfNeeded(
          file,
          'First Line\nBody'
        );

      expect(result).toBe(false);
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should make removeFirstLinePropertyValuesFromFile return without writing', async () => {
      await firstLinePropertyManager.removeFirstLinePropertyValuesFromFile(
        file
      );

      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    // The guard sits ahead of `activeView.save()`, which flushes the editor
    // buffer to disk - reaching it would touch the file on its own.
    it('should not save the active view', async () => {
      const mockView = {
        file,
        save: vi.fn().mockResolvedValue(undefined),
      };
      plugin.app.workspace.getActiveViewOfType = vi
        .fn()
        .mockReturnValue(mockView);

      await updateFromText('First Line\nBody');
      await firstLinePropertyManager.removeFirstLinePropertyValuesFromFile(
        file
      );

      expect(mockView.save).not.toHaveBeenCalled();
    });

    it('should still write once a property name is set', async () => {
      plugin.settings.firstLineProperty.propertyKey = 'aliases';
      installJsonYaml();
      installDiskNote(plugin, 'First Line\nBody');

      await updateFromText('First Line\nBody');

      expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalled();
    });
  });

  describe('updateFirstLinePropertyIfNeeded rename-blocking property', () => {
    // Raw YAML block -> parsed object. Blocks with no entry throw, modelling malformed YAML.
    let yamlFixtures: Map<string, unknown>;

    beforeEach(() => {
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
      plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
    });

    it('should skip when the content blocks renaming before the cache does', async () => {
      yamlFixtures.set('no rename: true\n', { 'no rename': true });
      plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { 'no rename': false },
      });

      const result =
        await firstLinePropertyManager.updateFirstLinePropertyIfNeeded(
          file,
          '---\nno rename: true\n---\nFirst Line\nBody'
        );

      expect(result).toBe(false);
      expect(plugin.app.vault.read).not.toHaveBeenCalled();
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should skip when the text read from the file blocks renaming before the cache does', async () => {
      yamlFixtures.set('no rename: true\n', { 'no rename': true });
      plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue(null);
      plugin.app.vault.cachedRead = vi
        .fn()
        .mockResolvedValue('---\nno rename: true\n---\nFirst Line\nBody');

      const result =
        await firstLinePropertyManager.updateFirstLinePropertyIfNeeded(file);

      expect(result).toBe(false);
      expect(plugin.app.vault.cachedRead).toHaveBeenCalledTimes(1);
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should fall back to the cache when the content properties are malformed', async () => {
      plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { 'no rename': true },
      });

      const result =
        await firstLinePropertyManager.updateFirstLinePropertyIfNeeded(
          file,
          '---\nno rename: [unclosed\n---\nFirst Line\nBody'
        );

      expect(result).toBe(false);
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    // A properties block mid-edit is skipped until it parses, even when the cache would let a write through
    it('should write nothing while the content properties are malformed', async () => {
      plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { aliases: ['Old'] },
      });

      const result =
        await firstLinePropertyManager.updateFirstLinePropertyIfNeeded(
          file,
          '---\naliases: [unclosed\n---\nFirst Line\nBody'
        );

      expect(result).toBe(false);
      expect(plugin.app.vault.read).not.toHaveBeenCalled();
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should read the editor and parse its properties once on a pass that writes nothing', async () => {
      const text = `---\naliases: ["${marked('First Line')}"]\n---\nFirst Line\nBody`;
      yamlFixtures.set(`aliases: ["${marked('First Line')}"]\n`, {
        aliases: [marked('First Line')],
      });
      const target = createEditorTarget(text);

      const result =
        await firstLinePropertyManager.updateFirstLinePropertyIfNeeded(
          file,
          undefined,
          target
        );

      expect(result).toBe(true);
      expect(target.editor.getValue).toHaveBeenCalledTimes(1);
      expect(parseYaml).toHaveBeenCalledTimes(1);
      expect(target.editor.replaceRange).not.toHaveBeenCalled();
    });
  });

  describe('updateFirstLinePropertyIfNeeded with a canvas as the most recent leaf', () => {
    it('should still update the property', async () => {
      plugin.app.workspace.getMostRecentLeaf = vi.fn().mockReturnValue({
        view: { getViewType: () => 'canvas' },
      });
      plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
      installJsonYaml();
      const note = installDiskNote(plugin, 'First Line\nBody');

      await updateFromText('First Line\nBody');

      expect(note.properties().aliases).toEqual([marked('First Line')]);
    });
  });

  // `updateFirstLinePropertyIfNeeded` reads the note's text, derives the value once, and writes it only when the properties do not already hold it
  describe('writing the value', () => {
    let yamlFixtures: Map<string, unknown>;

    beforeEach(() => {
      plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
      yamlFixtures = new Map<string, unknown>();
      installJsonYaml(yamlFixtures);
    });

    /** Put the note on disk and run a pass over it */
    const updateDiskNote = async (text: string) => {
      const note = installDiskNote(plugin, text);
      const result = await updateFromText(text);
      return { note, result };
    };

    it('should skip when file no longer exists', async () => {
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);

      const { result } = await updateDiskNote('First Line\nBody');

      expect(result).toBe(false);
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should add ZWSP marker to the value', async () => {
      const { note, result } = await updateDiskNote('First Line\nBody');

      expect(result).toBe(true);
      expect(note.properties().aliases).toEqual([marked('First Line')]);
    });

    // The `modify` event a file write fires can arrive before `processFrontMatter` resolves; the pending flag must already be set for the handler to skip it.
    it('should mark the file pending before writing the properties', async () => {
      installDiskNote(plugin, 'First Line\nBody');
      const write = plugin.app.fileManager.processFrontMatter;
      let pendingDuringWrite = false;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (...args: unknown[]) => {
          pendingDuringWrite = plugin.fileStateManager.hasPendingMetadataUpdate(
            file.path
          );
          await write(...args);
        }
      );

      await updateFromText('First Line\nBody');

      expect(pendingDuringWrite).toBe(true);
    });

    it('should mark the file as awaiting its metadata update', async () => {
      await updateDiskNote('First Line\nBody');

      expect(plugin.fileStateManager.hasPendingMetadataUpdate(file.path)).toBe(
        true
      );
    });

    it('should truncate the value when enabled and exceeds charCount', async () => {
      plugin.settings.firstLineProperty.truncate = true;
      plugin.settings.core.charCount = 10;
      const longTitle = 'This is a very long title that exceeds the limit';

      const { note } = await updateDiskNote(`${longTitle}\nBody`);

      expect(note.properties().aliases).toEqual([marked('This is a…')]);
    });

    it('should keep a value exactly charCount long whole', async () => {
      plugin.settings.firstLineProperty.truncate = true;
      plugin.settings.core.charCount = 10;

      const { note } = await updateDiskNote('0123456789\nBody');

      expect(note.properties().aliases).toEqual([marked('0123456789')]);
    });

    it('should remove first line property values when the processed value is only ellipsis', async () => {
      plugin.settings.firstLineProperty.truncate = true;
      plugin.settings.core.charCount = 1; // Extreme truncation

      const { note, result } = await updateDiskNote(
        noteText({ aliases: [marked('Old'), 'User'] }, 'Title\nBody')
      );

      expect(result).toBe(false);
      expect(note.properties().aliases).toEqual(['User']);
    });

    it('should remove first line property values when empty heading (# only)', async () => {
      const { note } = await updateDiskNote(
        noteText({ aliases: [marked('Old'), 'User'] }, '#\nBody')
      );

      expect(note.properties().aliases).toEqual(['User']);
    });

    it('should remove first line property values when a custom rule empties the value', async () => {
      plugin.settings.markupStripping.applyCustomReplacementsInFirstLineProperty = true;
      plugin.settings.customReplacements.rules = [
        {
          searchText: 'Gone',
          replaceText: '',
          onlyAtStart: false,
          onlyWholeLine: true,
        },
      ];

      const { note } = await updateDiskNote(
        noteText({ aliases: [marked('Old'), 'User'] }, 'Gone\nBody')
      );

      expect(note.properties().aliases).toEqual(['User']);
    });

    it('should apply custom replacement rules when applying them in the property is on', async () => {
      plugin.settings.markupStripping.applyCustomReplacementsInFirstLineProperty = true;
      plugin.settings.customReplacements.rules = [
        {
          searchText: 'TODO',
          replaceText: 'DONE',
          onlyAtStart: false,
          onlyWholeLine: false,
        },
      ];

      const { note } = await updateDiskNote('TODO: Fix this\nBody');

      expect(note.properties().aliases).toEqual([marked('DONE: Fix this')]);
    });

    it('should leave the property untouched by rules when applying them in the property is off', async () => {
      plugin.settings.markupStripping.applyCustomReplacementsInFirstLineProperty = false;
      plugin.settings.customReplacements.rules = [
        {
          searchText: 'TODO',
          replaceText: 'DONE',
          onlyAtStart: false,
          onlyWholeLine: false,
        },
      ];

      const { note } = await updateDiskNote('TODO: Fix this\nBody');

      expect(note.properties().aliases).toEqual([marked('TODO: Fix this')]);
    });

    it('should apply custom replacement only at start when configured', async () => {
      plugin.settings.markupStripping.applyCustomReplacementsInFirstLineProperty = true;
      plugin.settings.customReplacements.rules = [
        {
          searchText: 'PREFIX ',
          replaceText: 'REPLACED ',
          onlyAtStart: true,
          onlyWholeLine: false,
        },
      ];

      const { note } = await updateDiskNote('PREFIX Task name\nBody');

      expect(note.properties().aliases).toEqual([marked('REPLACED Task name')]);
    });

    // The check that skips the write once the value is stored used to compare the line without the rules, so every save rewrote the block
    describe('with a custom rule that changes the line', () => {
      beforeEach(() => {
        plugin.settings.markupStripping.applyCustomReplacementsInFirstLineProperty = true;
        plugin.settings.customReplacements.rules = [
          {
            searchText: 'bar',
            replaceText: 'baz',
            onlyAtStart: false,
            onlyWholeLine: false,
          },
        ];
      });

      it('should not write the file again once the value is stored', async () => {
        const text = noteText(
          { aliases: [marked('Foo baz')] },
          'Foo bar\nBody'
        );
        installDiskNote(plugin, text);

        expect(await updateFromText(text)).toBe(true);
        expect(await updateFromText(text)).toBe(true);

        expect(
          plugin.app.fileManager.processFrontMatter
        ).not.toHaveBeenCalled();
        expect(
          plugin.fileStateManager.hasPendingMetadataUpdate(file.path)
        ).toBe(false);
      });
    });

    it('should replace an old plugin value and keep user aliases', async () => {
      const { note } = await updateDiskNote(
        noteText(
          { aliases: [marked('Old Title'), 'User Added Alias'] },
          'New Title\nBody'
        )
      );

      expect(note.properties().aliases).toEqual([
        'User Added Alias',
        marked('New Title'),
      ]);
    });

    it('should remove a stale plugin value beside a plain copy of the value', async () => {
      const { note, result } = await updateDiskNote(
        noteText(
          { aliases: ['First Line', marked('Old Title')] },
          'First Line\nBody'
        )
      );

      expect(result).toBe(true);
      expect(note.properties().aliases).toEqual(['First Line']);
    });

    it('should drop the plugin copy of a value the user also holds plain', async () => {
      const { note } = await updateDiskNote(
        noteText(
          { aliases: [marked('First Line'), 'First Line'] },
          'First Line\nBody'
        )
      );

      expect(note.properties().aliases).toEqual(['First Line']);
    });

    it('should not write when the user holds the value plain and no plugin value is left', async () => {
      const text = noteText(
        { aliases: ['Other', 'First Line'] },
        'First Line\nBody'
      );
      installDiskNote(plugin, text);

      expect(await updateFromText(text)).toBe(true);
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should put the new value at the old plugin value position when placing it last is off', async () => {
      plugin.settings.firstLineProperty.placeLast = false;

      const { note } = await updateDiskNote(
        noteText(
          { aliases: [marked('Old Title'), 'User Added Alias'] },
          'New Title\nBody'
        )
      );

      expect(note.properties().aliases).toEqual([
        marked('New Title'),
        'User Added Alias',
      ]);
    });

    it('should handle multiple first line property keys', async () => {
      plugin.settings.firstLineProperty.propertyKey = 'aliases, aka';

      const { note } = await updateDiskNote('First Line\nBody');

      // 'aliases' is Obsidian's canonical list property, so it stays an array.
      // Custom properties use inline (scalar) format for a single value.
      expect(note.properties().aliases).toEqual([marked('First Line')]);
      expect(note.properties().aka).toBe(marked('First Line'));
    });

    it('should keep a custom property a list when it holds user values too', async () => {
      plugin.settings.firstLineProperty.propertyKey = 'aka';

      const { note } = await updateDiskNote(
        noteText({ aka: 'User Value' }, 'First Line\nBody')
      );

      expect(note.properties().aka).toEqual([
        'User Value',
        marked('First Line'),
      ]);
    });

    it("should allow an 'Untitled' value when first line is literally 'Untitled'", async () => {
      const { note } = await updateDiskNote('Untitled\nBody');

      expect(note.properties().aliases).toEqual([marked('Untitled')]);
    });

    // Tests for Untitled produced by markup (Issue #22)
    it('should remove first line property values when Untitled extracted from heading markup', async () => {
      // Markup must be stripped for the value so "# Untitled" reduces to "Untitled"; the "#" means markup processing produced it, not the user
      plugin.settings.markupStripping.stripMarkupInFirstLineProperty = true;

      const { note } = await updateDiskNote(
        noteText({ aliases: [marked('Old'), 'User'] }, '# Untitled\nBody')
      );

      expect(note.properties().aliases).toEqual(['User']);
    });

    it('should remove first line property values when Untitled extracted from template syntax', async () => {
      plugin.settings.markupStripping.stripMarkupInFirstLineProperty = true;

      const { note } = await updateDiskNote(
        noteText(
          { aliases: [marked('Old'), 'User'] },
          '<% tp.file.cursor() %>\nBody'
        )
      );

      expect(note.properties().aliases).toEqual(['User']);
    });

    it('should store a card link title rather than the line opening the card', async () => {
      const { note } = await updateDiskNote(
        '```cardlink\nurl: https://example.com\ntitle: "Link Title"\n```\nBody'
      );

      expect(note.properties().aliases).toEqual([marked('Link Title')]);
    });

    describe('with code as the title source', () => {
      beforeEach(() => {
        plugin.settings.markupStripping.stripMarkupInFirstLineProperty = true;
      });

      // Code is shown as typed, but its indentation would otherwise be stored as a quoted scalar.
      it('should store fenced code as typed, without its indentation', async () => {
        const { note } = await updateDiskNote(
          '```\n    return *x*;\n```\nBody'
        );

        expect(note.properties().aliases).toEqual([marked('return *x*;')]);
      });

      it('should store indented code without the rest of its indentation', async () => {
        const { note } = await updateDiskNote('\t\t__init__\nBody');

        expect(note.properties().aliases).toEqual([marked('__init__')]);
      });

      it('should apply title case and custom rules to code', async () => {
        plugin.settings.core.titleCase = 'uppercase';
        plugin.settings.markupStripping.applyCustomReplacementsInFirstLineProperty = true;
        plugin.settings.customReplacements.rules = [
          {
            searchText: 'x',
            replaceText: 'y',
            onlyAtStart: false,
            onlyWholeLine: false,
          },
        ];

        const { note } = await updateDiskNote('    *x*\nBody');

        expect(note.properties().aliases).toEqual([marked('*Y*')]);
      });
    });

    // The walk's own Untitled fallback (every line skipped, an empty fence) is no line the note holds, unlike a note that literally says Untitled.
    it('should store nothing when the title source is the walk falling back to Untitled', async () => {
      const { note } = await updateDiskNote('```\n```\n');

      expect(note.properties().aliases).toBeUndefined();
    });

    it('should store Untitled when the note literally says it', async () => {
      const { note } = await updateDiskNote('Untitled\nBody');

      expect(note.properties().aliases).toEqual([marked('Untitled')]);
    });

    // `--- ` opens no properties block in Obsidian, so its lines are body: the heading under the rule is the value, and the new properties block goes above it.
    it('should take the value from a block opened by `--- `, not from the line after it', async () => {
      const { note } = await updateDiskNote('--- \nfoo: bar\n---\nBody');

      expect(note.text()).toBe(
        `---\n{"aliases":["${marked('foo: bar')}"]}\n---\n--- \nfoo: bar\n---\nBody`
      );
    });

    it('should handle ENOENT error gracefully (file renamed during operation)', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      installDiskNote(plugin, 'Title\nBody');
      plugin.app.fileManager.processFrontMatter = vi
        .fn()
        .mockRejectedValue(error);
      const consoleErrorSpy = vi.spyOn(console, 'error');

      await expect(updateFromText('Title\nBody')).resolves.toBe(true);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('should log unexpected errors', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      installDiskNote(plugin, 'Title\nBody');
      plugin.app.fileManager.processFrontMatter = vi
        .fn()
        .mockRejectedValue(new Error('Unexpected error'));

      await updateFromText('Title\nBody');

      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should save the active view and write the file without an editor target', async () => {
      const mockView = new MarkdownView(plugin.app);
      mockView.file = file;
      mockView.save = vi.fn();
      plugin.app.workspace.getActiveViewOfType = vi
        .fn()
        .mockReturnValue(mockView);

      await updateDiskNote('Title\nBody');

      expect(mockView.save).toHaveBeenCalled();
      expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalledWith(
        file,
        expect.any(Function)
      );
      expect(vi.mocked(mockView.save).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(plugin.app.vault.read).mock.invocationCallOrder[0]
      );
      expect(
        vi.mocked(plugin.app.vault.read).mock.invocationCallOrder[0]
      ).toBeLessThan(
        vi.mocked(plugin.app.fileManager.processFrontMatter).mock
          .invocationCallOrder[0]
      );
    });

    describe('with an editor target', () => {
      beforeEach(() => {
        vi.mocked(getFrontMatterInfo).mockReset();
        vi.mocked(parseYaml).mockReset();
        vi.mocked(stringifyYaml).mockReset();
      });

      it('should write the first line property into the editor instead of the file', async () => {
        const mockView = new MarkdownView(plugin.app);
        mockView.file = file;
        mockView.save = vi.fn();
        plugin.app.workspace.getActiveViewOfType = vi
          .fn()
          .mockReturnValue(mockView);
        vi.mocked(stringifyYaml).mockReturnValue('aliases: Title\n');
        const target = createEditorTarget('Title\nBody');

        await firstLinePropertyManager.updateFirstLinePropertyIfNeeded(
          file,
          undefined,
          target
        );

        expect(target.editor.cm.dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            changes: { from: 0, to: 0, insert: '---\naliases: Title\n---\n' },
          })
        );
        expect(target.requestSave).toHaveBeenCalled();
        expect(mockView.save).not.toHaveBeenCalled();
        expect(
          plugin.app.fileManager.processFrontMatter
        ).not.toHaveBeenCalled();
        expect(
          plugin.fileStateManager.hasPendingMetadataUpdate(file.path)
        ).toBe(false);
      });

      it('should mark the editor change as the plugin own while it is made', async () => {
        vi.mocked(stringifyYaml).mockReturnValue('aliases: Title\n');
        const target = createEditorTarget('Title\nBody');
        const { markEditorSyncing, clearEditorSyncing } =
          plugin.fileStateManager;

        await firstLinePropertyManager.updateFirstLinePropertyIfNeeded(
          file,
          undefined,
          target
        );

        const dispatchOrder =
          target.editor.cm.dispatch.mock.invocationCallOrder[0];
        expect(markEditorSyncing).toHaveBeenCalledWith(file.path);
        expect(markEditorSyncing.mock.invocationCallOrder[0]).toBeLessThan(
          dispatchOrder
        );
        expect(clearEditorSyncing.mock.invocationCallOrder[0]).toBeGreaterThan(
          dispatchOrder
        );
      });

      it('should not request a save when the editor already holds the result', async () => {
        const target = createEditorTarget('Title\nBody');

        await firstLinePropertyManager.removeFirstLinePropertyValuesFromFile(
          file,
          target
        );

        expect(target.editor.cm.dispatch).not.toHaveBeenCalled();
        expect(target.requestSave).not.toHaveBeenCalled();
      });
    });

    // The setting's copy: "fill only if the first line and the title are not identical" - it compares the value that would be written
    describe('add only if title differs', () => {
      beforeEach(() => {
        plugin.settings.firstLineProperty.addOnlyIfTitleDiffers = true;
      });

      it('should remove first line property values when the value matches the title', async () => {
        const { note, result } = await updateDiskNote(
          noteText({ aliases: [marked('Old'), 'User'] }, 'test\nBody')
        );

        expect(result).toBe(false);
        expect(note.properties().aliases).toEqual(['User']);
      });

      // Deliberate change: the comparison used the stripped line, which matched the title and stored nothing
      it('should store the unstripped line when markup stripping in the property is off', async () => {
        file = createMockFile('Foo.md');
        plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);

        const { note } = await updateDiskNote('# Foo\nBody');

        expect(note.properties().aliases).toEqual([marked('# Foo')]);
      });

      // Deliberate change: the comparison used the whole line, so the truncated value identical to the truncated title was stored
      it('should store nothing when the truncated value equals the truncated title', async () => {
        plugin.settings.firstLineProperty.truncate = true;
        plugin.settings.core.charCount = 10;
        file = createMockFile('This is a….md');
        plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);

        const { note } = await updateDiskNote('This is a long line\nBody');

        expect(note.properties().aliases).toBeUndefined();
        expect(
          plugin.app.fileManager.processFrontMatter
        ).not.toHaveBeenCalled();
      });

      it('should store nothing when a custom rule turns the value into the title', async () => {
        plugin.settings.markupStripping.applyCustomReplacementsInFirstLineProperty = true;
        plugin.settings.customReplacements.rules = [
          {
            searchText: 'bar',
            replaceText: 'baz',
            onlyAtStart: false,
            onlyWholeLine: false,
          },
        ];
        file = createMockFile('Foo baz.md');
        plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);

        const { note } = await updateDiskNote('Foo bar\nBody');

        expect(note.properties().aliases).toBeUndefined();
      });
    });

    // "Put first line in title" ignores exclusions for the property as it does for the rename
    describe('on an excluded note', () => {
      beforeEach(() => {
        file = createMockFile('Notes/test.md');
        plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
        plugin.settings.exclusions.excludedFiles = ['Notes/'];
      });

      it('should write the value when the caller overrides every exclusion', async () => {
        const note = installDiskNote(plugin, 'First Line\nBody');

        await firstLinePropertyManager.updateFirstLinePropertyIfNeeded(
          file,
          'First Line\nBody',
          null,
          {
            ignoreExcludedFiles: true,
            ignoreExcludedTags: true,
            ignoreExcludedProperties: true,
          }
        );

        expect(note.properties().aliases).toEqual([marked('First Line')]);
      });

      it('should write nothing without overrides', async () => {
        installDiskNote(plugin, 'First Line\nBody');

        await updateFromText('First Line\nBody');

        expect(
          plugin.app.fileManager.processFrontMatter
        ).not.toHaveBeenCalled();
      });
    });

    // A tag typed into the title source counts before Obsidian indexes it, but only where the cache will index it: a card link's title sits in a fenced block
    describe('with an excluded tag typed into the title source', () => {
      beforeEach(() => {
        plugin.settings.exclusions.excludedTags = ['/^draft/'];
      });

      it('should write the value of a card link whose title holds the tag', async () => {
        const { note } = await updateDiskNote(
          '```cardlink\ntitle: "#draft-x Plan"\n```\nBody'
        );

        expect(note.properties().aliases).toEqual([marked('#draft-x Plan')]);
      });

      it('should write nothing when a body first line holds the tag', async () => {
        await updateDiskNote('Plan #draft x\nBody');

        expect(
          plugin.app.fileManager.processFrontMatter
        ).not.toHaveBeenCalled();
      });
    });
  });

  describe('removeFirstLinePropertyValuesFromFile', () => {
    let yamlFixtures: Map<string, unknown>;

    beforeEach(() => {
      plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
      yamlFixtures = new Map<string, unknown>();
      installJsonYaml(yamlFixtures);
    });

    /** Put a note holding `properties` on disk and remove the plugin's values from it */
    const removeFrom = async (properties: Record<string, unknown>) => {
      const note = installDiskNote(plugin, noteText(properties));
      await firstLinePropertyManager.removeFirstLinePropertyValuesFromFile(
        file
      );
      return note;
    };

    it('should skip when file no longer exists', async () => {
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);

      await removeFrom({ aliases: [marked('Plugin Value')] });

      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should remove only ZWSP-marked values', async () => {
      const note = await removeFrom({
        aliases: [
          marked('Plugin Value'),
          'User Alias',
          marked('Another Plugin'),
        ],
      });

      expect(note.properties().aliases).toEqual(['User Alias']);
    });

    it('should leave user-added aliases untouched without writing', async () => {
      const note = await removeFrom({
        aliases: ['User Alias 1', 'User Alias 2'],
      });

      expect(note.properties().aliases).toEqual([
        'User Alias 1',
        'User Alias 2',
      ]);
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should delete property when empty and keepEmptyProperty is false', async () => {
      plugin.settings.firstLineProperty.keepEmptyProperty = false;

      const note = await removeFrom({ aliases: [marked('Plugin Value')] });

      expect(note.properties().aliases).toBeUndefined();
    });

    it('should keep property as null when empty and keepEmptyProperty is true', async () => {
      plugin.settings.firstLineProperty.keepEmptyProperty = true;

      const note = await removeFrom({ aliases: [marked('Plugin Value')] });

      expect(note.properties().aliases).toBeNull();
    });

    it('should handle multiple first line property keys', async () => {
      plugin.settings.firstLineProperty.propertyKey = 'aliases, aka';

      const note = await removeFrom({
        aliases: [marked('Plugin'), 'User'],
        aka: marked('Plugin'),
      });

      expect(note.properties().aliases).toEqual(['User']);
      expect(note.properties().aka).toBeNull(); // keepEmptyProperty is true
    });

    it('should collapse non-aliases properties to a scalar after removal', async () => {
      plugin.settings.firstLineProperty.propertyKey = 'aka';

      const note = await removeFrom({ aka: [marked('Plugin'), 'User Value'] });

      // Custom properties collapse to inline (scalar) format when one value remains
      expect(note.properties().aka).toBe('User Value');
    });

    it('should leave a list untouched when it holds no plugin value', async () => {
      const note = await removeFrom({
        aliases: ['Valid', '', 'Also Valid', ''],
      });

      expect(note.properties().aliases).toEqual([
        'Valid',
        '',
        'Also Valid',
        '',
      ]);
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should drop empty strings from a list it removes a plugin value from', async () => {
      const note = await removeFrom({
        aliases: ['Valid', '', marked('Plugin')],
      });

      expect(note.properties().aliases).toEqual(['Valid']);
    });

    // The Keep empty property copy speaks of what the plugin removes; an empty property the user wrote is theirs
    it('should leave an empty property the user wrote untouched', async () => {
      plugin.settings.firstLineProperty.keepEmptyProperty = false;

      const note = await removeFrom({ aliases: null });

      expect(note.properties()).toEqual({ aliases: null });
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    // Re-serializing the block would drop the comment and reformat the values
    it('should not write, so a YAML comment survives, when there is no plugin value', async () => {
      const text = '---\n# kept\naliases:\n  - User\n---\nFirst Line\nBody';
      yamlFixtures.set('# kept\naliases:\n  - User\n', { aliases: ['User'] });
      const note = installDiskNote(plugin, text);

      await firstLinePropertyManager.removeFirstLinePropertyValuesFromFile(
        file
      );

      expect(note.text()).toBe(text);
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
      expect(plugin.fileStateManager.hasPendingMetadataUpdate(file.path)).toBe(
        false
      );
    });

    it('should handle string value (not array)', async () => {
      const note = await removeFrom({ aliases: marked('Plugin Value') });

      expect(note.properties().aliases).toBeNull();
    });

    it('should mark the file as awaiting its metadata update', async () => {
      await removeFrom({ aliases: [marked('Plugin')] });

      expect(plugin.fileStateManager.hasPendingMetadataUpdate(file.path)).toBe(
        true
      );
    });

    it('should handle ENOENT error gracefully', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      installDiskNote(plugin, noteText({ aliases: [marked('Plugin')] }));
      plugin.app.fileManager.processFrontMatter = vi
        .fn()
        .mockRejectedValue(error);

      await expect(
        firstLinePropertyManager.removeFirstLinePropertyValuesFromFile(file)
      ).resolves.not.toThrow();
    });

    it('should remove first line property values in the editor instead of the file', async () => {
      const mockView = new MarkdownView(plugin.app);
      mockView.file = file;
      mockView.save = vi.fn();
      plugin.app.workspace.getActiveViewOfType = vi
        .fn()
        .mockReturnValue(mockView);
      const target = createEditorTarget(
        noteText({ aliases: [marked('Old'), 'User'] })
      );

      await firstLinePropertyManager.removeFirstLinePropertyValuesFromFile(
        file,
        target
      );

      expect(stringifyYaml).toHaveBeenCalledWith({ aliases: ['User'] });
      expect(target.editor.cm.dispatch).toHaveBeenCalledTimes(1);
      expect(target.requestSave).toHaveBeenCalled();
      expect(mockView.save).not.toHaveBeenCalled();
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should save the active view and write the file without an editor target', async () => {
      const mockView = new MarkdownView(plugin.app);
      mockView.file = file;
      mockView.save = vi.fn();
      plugin.app.workspace.getActiveViewOfType = vi
        .fn()
        .mockReturnValue(mockView);

      await removeFrom({ aliases: [marked('Old')] });

      expect(mockView.save).toHaveBeenCalled();
      expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalledWith(
        file,
        expect.any(Function)
      );
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
      installJsonYaml();
    });

    it('should handle file path with special characters', async () => {
      file = createMockFile('folder/file [special] (chars).md');
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
      const note = installDiskNote(plugin, 'Title\nBody');

      await updateFromText('Title\nBody');

      expect(note.properties().aliases).toEqual([marked('Title')]);
    });

    it('should handle very long first line property content', async () => {
      plugin.settings.firstLineProperty.truncate = false;
      const veryLongTitle = 'A'.repeat(1000);
      const note = installDiskNote(plugin, `${veryLongTitle}\nBody`);

      await updateFromText(`${veryLongTitle}\nBody`);

      expect(note.properties().aliases).toEqual([marked(veryLongTitle)]);
    });

    it('should handle a value with special Unicode characters', async () => {
      const title = 'Title with emoji \u{1F680} and symbols ©®™';
      const note = installDiskNote(plugin, `${title}\nBody`);

      await updateFromText(`${title}\nBody`);

      expect(note.properties().aliases).toEqual([marked(title)]);
    });

    it('should handle file deleted during operation', async () => {
      installDiskNote(plugin, 'Title\nBody');
      // First check passes, the re-check before the write fails
      plugin.app.vault.getAbstractFileByPath = vi
        .fn()
        .mockReturnValueOnce(file)
        .mockReturnValueOnce(null);

      await updateFromText('Title\nBody');

      // Should not call processFrontMatter after detecting file deletion
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should store one value when concurrent calls update the same file', async () => {
      const note = installDiskNote(plugin, 'Title\nBody');

      await Promise.all([
        updateFromText('Title\nBody'),
        updateFromText('Title\nBody'),
        updateFromText('Title\nBody'),
      ]);

      expect(note.properties().aliases).toEqual([marked('Title')]);
    });

    it('should not open frontmatter when the property key is empty', async () => {
      plugin.settings.firstLineProperty.propertyKey = '';
      installDiskNote(plugin, 'Title\nBody');

      await updateFromText('Title\nBody');

      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should handle null values in frontmatter', async () => {
      const note = installDiskNote(plugin, noteText({ aliases: null }));

      await firstLinePropertyManager.removeFirstLinePropertyValuesFromFile(
        file
      );

      // Should handle null gracefully (no crash)
      expect(note.properties().aliases).toBeNull();
    });
  });
});
