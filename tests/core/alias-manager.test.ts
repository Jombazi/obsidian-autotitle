/**
 * Comprehensive test suite for AliasManager
 *
 * Tests cover:
 * - getAliasPropertyKeys: parsing, whitespace, blank key
 * - updateAliasIfNeeded: alias matching, YAML handling
 * - addAliasToFile: ZWSP markers, truncation, custom replacements, multi-property
 * - removePluginAliasesFromFile: selective removal, keepEmptyProperty
 * - Write target: the editor showing the note, or the file
 * - Edge cases: ENOENT, concurrent calls, special characters
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getFrontMatterInfo, parseYaml, stringifyYaml } from 'obsidian';
import { AliasManager } from '../../src/core/alias-manager';
import { createMockFile, createMockApp, splitFrontMatter } from '../testUtils';
import { TFile, MarkdownView } from '../mockObsidian';
import { DeepPartial, PluginSettings } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/constants';
import { deepMerge } from '../../src/utils/deep-merge';

// Create mock plugin for AliasManager
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

  return {
    app,
    settings,
    renameEngine: {
      stripFrontmatterFromContent: vi.fn((content: string) => {
        // Simple frontmatter stripping for tests
        if (!content.startsWith('---\n')) return content;
        const endIndex = content.indexOf('\n---\n', 4);
        if (endIndex === -1) return content;
        return content.substring(endIndex + 5);
      }),
    },
    pendingMetadataUpdates: new Set<TFile>(),
    fileStateManager: {
      markEditorSyncing: vi.fn(),
      clearEditorSyncing: vi.fn(),
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

describe('AliasManager', () => {
  let plugin: ReturnType<typeof createMockPlugin>;
  let aliasManager: AliasManager;
  let file: TFile;

  beforeEach(() => {
    plugin = createMockPlugin();
    aliasManager = new AliasManager(plugin);
    file = createMockFile('test.md');

    // Reset all mocks
    vi.clearAllMocks();

    // Default mocks
    plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor and accessors', () => {
    it('should initialize with plugin reference', () => {
      expect(aliasManager).toBeDefined();
      expect(aliasManager['plugin']).toBe(plugin);
    });

    it('should have access to app through plugin', () => {
      expect(aliasManager.app).toBe(plugin.app);
    });

    it('should have access to settings through plugin', () => {
      expect(aliasManager.settings).toBe(plugin.settings);
    });
  });

  describe('getAliasPropertyKeys', () => {
    it('should return no keys when the property name is blank', () => {
      plugin.settings.firstLineProperty.propertyKey = '';
      const keys = aliasManager['getAliasPropertyKeys']();
      expect(keys).toEqual([]);
    });

    it('should return single property key', () => {
      plugin.settings.firstLineProperty.propertyKey = 'aliases';
      const keys = aliasManager['getAliasPropertyKeys']();
      expect(keys).toEqual(['aliases']);
    });

    it('should return multiple comma-separated keys', () => {
      plugin.settings.firstLineProperty.propertyKey =
        'aliases, aka, also-known-as';
      const keys = aliasManager['getAliasPropertyKeys']();
      expect(keys).toEqual(['aliases', 'aka', 'also-known-as']);
    });

    it('should trim whitespace from keys', () => {
      plugin.settings.firstLineProperty.propertyKey =
        '  aliases  ,  aka  ,  test  ';
      const keys = aliasManager['getAliasPropertyKeys']();
      expect(keys).toEqual(['aliases', 'aka', 'test']);
    });

    it('should filter out empty keys', () => {
      plugin.settings.firstLineProperty.propertyKey = 'aliases, , aka, ,';
      const keys = aliasManager['getAliasPropertyKeys']();
      expect(keys).toEqual(['aliases', 'aka']);
    });

    it('should return no keys when the property name is only commas', () => {
      plugin.settings.firstLineProperty.propertyKey = ', , ,';
      const keys = aliasManager['getAliasPropertyKeys']();
      expect(keys).toEqual([]);
    });

    // The setting is typed `string` and this function indexes into it directly.
    // What makes that safe is the loader: deepMerge skips null and undefined
    // source values, so a null in data.json can never displace the default.
    it('should never see a null key because deepMerge keeps the default', () => {
      const merged = deepMerge(DEFAULT_SETTINGS, {
        firstLineProperty: { propertyKey: null as any },
      });
      expect(merged.firstLineProperty.propertyKey).toBe(
        DEFAULT_SETTINGS.firstLineProperty.propertyKey
      );
    });
  });

  // A blank property name is a deliberate "no alias property" choice, not a
  // request for the default. Every entry point must bail before it reaches a
  // write - processFrontMatter opens and rewrites the file even when the
  // per-key loop inside it would iterate zero times.
  describe('blank alias property name', () => {
    beforeEach(() => {
      plugin.settings.firstLineProperty.propertyKey = '';
      plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
    });

    it('should make updateAliasIfNeeded return false without writing', async () => {
      const result = await aliasManager.updateAliasIfNeeded(
        file,
        'First Line\nBody'
      );

      expect(result).toBe(false);
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should make addAliasToFile return without writing', async () => {
      await aliasManager.addAliasToFile(file, 'First Line', 'filename');

      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should make removePluginAliasesFromFile return without writing', async () => {
      await aliasManager.removePluginAliasesFromFile(file);

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

      await aliasManager.addAliasToFile(file, 'First Line', 'filename');
      await aliasManager.removePluginAliasesFromFile(file);

      expect(mockView.save).not.toHaveBeenCalled();
    });

    it('should still write once a property name is set', async () => {
      plugin.settings.firstLineProperty.propertyKey = 'aliases';

      await aliasManager.addAliasToFile(file, 'First Line', 'filename');

      expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalled();
    });
  });

  describe('updateAliasIfNeeded rename-blocking property', () => {
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

    afterEach(() => {
      vi.mocked(getFrontMatterInfo).mockReset();
      vi.mocked(parseYaml).mockReset();
    });

    it('should skip when the content blocks renaming before the cache does', async () => {
      yamlFixtures.set('no rename: true\n', { 'no rename': true });
      plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { 'no rename': false },
      });
      const addAliasToFile = vi
        .spyOn(aliasManager, 'addAliasToFile')
        .mockResolvedValue(undefined);

      const result = await aliasManager.updateAliasIfNeeded(
        file,
        '---\nno rename: true\n---\nFirst Line\nBody'
      );

      expect(result).toBe(false);
      expect(addAliasToFile).not.toHaveBeenCalled();
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });
  });

  describe('updateAliasIfNeeded with a canvas as the most recent leaf', () => {
    it('should still update the property', async () => {
      plugin.app.workspace.getMostRecentLeaf = vi.fn().mockReturnValue({
        view: { getViewType: () => 'canvas' },
      });
      plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
      const addAliasToFile = vi
        .spyOn(aliasManager, 'addAliasToFile')
        .mockResolvedValue(undefined);

      await aliasManager.updateAliasIfNeeded(file, 'First Line\nBody');

      expect(addAliasToFile).toHaveBeenCalledWith(
        file,
        'First Line',
        file.basename,
        null
      );
    });
  });

  describe('addAliasToFile', () => {
    beforeEach(() => {
      plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
    });

    it('should skip when file no longer exists', async () => {
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);

      await aliasManager.addAliasToFile(file, 'First Line', 'filename');

      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should add ZWSP marker to alias', async () => {
      const title = 'First Line';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {};
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.addAliasToFile(file, title, 'filename');

      const zwsp = '\u200B';
      expect(capturedFrontmatter.aliases).toEqual([`${zwsp}${title}${zwsp}`]);
    });

    // The `modify` event a file write fires can arrive before `processFrontMatter` resolves; the pending flag must already be set for the handler to skip it.
    it('should mark the file pending before writing the properties', async () => {
      let pendingDuringWrite = false;
      plugin.app.fileManager.processFrontMatter = vi.fn(async () => {
        pendingDuringWrite = plugin.pendingMetadataUpdates.has(file);
      });

      await aliasManager.addAliasToFile(file, 'First Line', 'filename');

      expect(pendingDuringWrite).toBe(true);
    });

    it('should truncate alias when enabled and exceeds charCount', async () => {
      plugin.settings.firstLineProperty.truncate = true;
      plugin.settings.core.charCount = 10;

      const longTitle = 'This is a very long title that exceeds the limit';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {};
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.addAliasToFile(file, longTitle, 'filename');

      const zwsp = '\u200B';
      const expectedTruncated = longTitle.slice(0, 9).trimEnd() + '…';
      expect(capturedFrontmatter.aliases).toEqual([
        `${zwsp}${expectedTruncated}${zwsp}`,
      ]);
    });

    it('should remove aliases when processed alias is only ellipsis', async () => {
      plugin.settings.firstLineProperty.truncate = true;
      plugin.settings.core.charCount = 1; // Extreme truncation

      const removeAliasesSpy = vi.spyOn(
        aliasManager,
        'removePluginAliasesFromFile'
      );

      await aliasManager.addAliasToFile(file, 'Title', 'filename');

      expect(removeAliasesSpy).toHaveBeenCalledWith(file, null);
    });

    it('should remove aliases when empty heading (# only)', async () => {
      const removeAliasesSpy = vi.spyOn(
        aliasManager,
        'removePluginAliasesFromFile'
      );

      await aliasManager.addAliasToFile(file, '#', 'filename');

      expect(removeAliasesSpy).toHaveBeenCalledWith(file, null);
    });

    it('should remove aliases when processed alias is empty', async () => {
      const removeAliasesSpy = vi.spyOn(
        aliasManager,
        'removePluginAliasesFromFile'
      );

      await aliasManager.addAliasToFile(file, '   ', 'filename');

      expect(removeAliasesSpy).toHaveBeenCalledWith(file, null);
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

      const title = 'TODO: Fix this';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {};
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.addAliasToFile(file, title, 'filename');

      expect(capturedFrontmatter.aliases[0]).toContain('DONE: Fix this');
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

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {};
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.addAliasToFile(file, 'TODO: Fix this', 'filename');

      expect(capturedFrontmatter.aliases[0]).toContain('TODO: Fix this');
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

      const title = 'PREFIX Task name';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {};
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.addAliasToFile(file, title, 'filename');

      expect(capturedFrontmatter.aliases[0]).toContain('REPLACED Task name');
    });

    it('should remove existing plugin aliases before adding new one', async () => {
      const title = 'New Title';
      const zwsp = '\u200B';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          // Simulate existing frontmatter with plugin alias and user alias
          const fm: Record<string, any> = {
            aliases: [`${zwsp}Old Title${zwsp}`, 'User Added Alias'],
          };
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.addAliasToFile(file, title, 'filename');

      expect(capturedFrontmatter.aliases).toHaveLength(2);
      expect(capturedFrontmatter.aliases).toContain('User Added Alias');
      expect(capturedFrontmatter.aliases).toContain(`${zwsp}${title}${zwsp}`);
      expect(capturedFrontmatter.aliases).not.toContain(
        `${zwsp}Old Title${zwsp}`
      );
    });

    it('should handle multiple alias property keys', async () => {
      plugin.settings.firstLineProperty.propertyKey = 'aliases, aka';
      const title = 'First Line';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {};
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.addAliasToFile(file, title, 'filename');

      const zwsp = '\u200B';
      // 'aliases' is Obsidian's canonical list property, so it stays an array.
      // Custom properties use inline (scalar) format for a single value.
      expect(capturedFrontmatter.aliases).toEqual([`${zwsp}${title}${zwsp}`]);
      expect(capturedFrontmatter.aka).toBe(`${zwsp}${title}${zwsp}`);
    });

    it("should allow 'Untitled' alias when first line is literally 'Untitled'", async () => {
      const title = 'Untitled';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {};
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.addAliasToFile(file, title, 'filename');

      const zwsp = '\u200B';
      expect(capturedFrontmatter.aliases).toEqual([`${zwsp}${title}${zwsp}`]);
    });

    it('should handle ENOENT error gracefully (file renamed during operation)', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';

      plugin.app.fileManager.processFrontMatter = vi
        .fn()
        .mockRejectedValue(error);

      // Should not throw
      await expect(
        aliasManager.addAliasToFile(file, 'Title', 'filename')
      ).resolves.not.toThrow();
    });

    it('should log unexpected errors', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      const error = new Error('Unexpected error');

      plugin.app.fileManager.processFrontMatter = vi
        .fn()
        .mockRejectedValue(error);

      await aliasManager.addAliasToFile(file, 'Title', 'filename');

      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    describe('with an editor target', () => {
      afterEach(() => {
        vi.mocked(stringifyYaml).mockReset();
      });

      it('should write the alias into the editor instead of the file', async () => {
        const mockView = new MarkdownView(plugin.app);
        mockView.file = file;
        mockView.save = vi.fn();
        plugin.app.workspace.getActiveViewOfType = vi
          .fn()
          .mockReturnValue(mockView);
        vi.mocked(stringifyYaml).mockReturnValue('aliases: Title\n');
        const target = createEditorTarget('Title\nBody');

        await aliasManager.addAliasToFile(file, 'Title', 'filename', target);

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
        expect(plugin.pendingMetadataUpdates.has(file)).toBe(false);
      });

      it('should mark the editor change as the plugin own while it is made', async () => {
        vi.mocked(stringifyYaml).mockReturnValue('aliases: Title\n');
        const target = createEditorTarget('Title\nBody');
        const { markEditorSyncing, clearEditorSyncing } =
          plugin.fileStateManager;

        await aliasManager.addAliasToFile(file, 'Title', 'filename', target);

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

        await aliasManager.removePluginAliasesFromFile(file, target);

        expect(target.editor.cm.dispatch).not.toHaveBeenCalled();
        expect(target.requestSave).not.toHaveBeenCalled();
      });
    });

    it('should save the active view and write the file without an editor target', async () => {
      const mockView = new MarkdownView(plugin.app);
      mockView.file = file;
      mockView.save = vi.fn();
      plugin.app.workspace.getActiveViewOfType = vi
        .fn()
        .mockReturnValue(mockView);

      await aliasManager.addAliasToFile(file, 'Title', 'filename', null);

      expect(mockView.save).toHaveBeenCalled();
      expect(plugin.app.fileManager.processFrontMatter).toHaveBeenCalledWith(
        file,
        expect.any(Function)
      );
      expect(vi.mocked(mockView.save).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(plugin.app.fileManager.processFrontMatter).mock
          .invocationCallOrder[0]
      );
    });

    it('should remove aliases when alias matches filename and setting enabled', async () => {
      plugin.settings.firstLineProperty.addOnlyIfTitleDiffers = true;
      const title = 'filename';

      const removeAliasesSpy = vi.spyOn(
        aliasManager,
        'removePluginAliasesFromFile'
      );

      await aliasManager.addAliasToFile(file, title, 'filename');

      expect(removeAliasesSpy).toHaveBeenCalledWith(file, null);
    });

    it('should add file to pendingMetadataUpdates', async () => {
      const title = 'First Line';

      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {};
          callback(fm);
        }
      );

      await aliasManager.addAliasToFile(file, title, 'filename');

      expect(plugin.pendingMetadataUpdates.has(file)).toBe(true);
    });

    // Tests for firstNonEmptyLine parameter edge cases (Issue #22)
    it('should remove aliases when Untitled extracted from heading markup', async () => {
      // First line is "# Untitled" (heading), titleSourceLine after stripping is "Untitled"
      // Should NOT add alias because original line "# Untitled" is not literally "Untitled"
      // The "#" prefix means markup processing produced "Untitled", not the user

      // Markup must be stripped for the alias so "# Untitled" reduces to "Untitled"
      plugin.settings.markupStripping.stripMarkupInFirstLineProperty = true;

      const removeAliasesSpy = vi.spyOn(
        aliasManager,
        'removePluginAliasesFromFile'
      );

      await aliasManager.addAliasToFile(
        file,
        '# Untitled', // originalFirstNonEmptyLine (before processing - has # prefix)
        'filename' // newTitle
      );

      // Should remove aliases because "# Untitled" doesn't literally match "Untitled" pattern
      expect(removeAliasesSpy).toHaveBeenCalledWith(file, null);
    });

    it('should remove aliases when Untitled extracted from template syntax', async () => {
      // First line is template code, but after processing results in "Untitled"
      // Should NOT add alias since original wasn't literally "Untitled"

      plugin.settings.markupStripping.stripMarkupInFirstLineProperty = true;

      const removeAliasesSpy = vi.spyOn(
        aliasManager,
        'removePluginAliasesFromFile'
      );

      await aliasManager.addAliasToFile(
        file,
        '<% tp.file.cursor() %>', // originalFirstNonEmptyLine (template syntax)
        'filename' // newTitle
      );

      expect(removeAliasesSpy).toHaveBeenCalledWith(file, null);
    });

    it('should handle card link where firstNonEmptyLine differs from titleSourceLine', async () => {
      // First line is Markdown link, titleSourceLine is extracted link text

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {};
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.addAliasToFile(
        file,
        'Link Title', // originalFirstNonEmptyLine
        'filename' // newTitle
      );

      const zwsp = '\u200B';
      expect(capturedFrontmatter.aliases).toEqual([`${zwsp}Link Title${zwsp}`]);
    });
  });

  describe('removePluginAliasesFromFile', () => {
    beforeEach(() => {
      plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
    });

    it('should skip when file no longer exists', async () => {
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);

      await aliasManager.removePluginAliasesFromFile(file);

      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should remove only ZWSP-marked aliases', async () => {
      const zwsp = '\u200B';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {
            aliases: [
              `${zwsp}Plugin Alias${zwsp}`,
              'User Alias',
              `${zwsp}Another Plugin${zwsp}`,
            ],
          };
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.removePluginAliasesFromFile(file);

      expect(capturedFrontmatter.aliases).toEqual(['User Alias']);
    });

    it('should preserve user-added aliases', async () => {
      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {
            aliases: ['User Alias 1', 'User Alias 2'],
          };
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.removePluginAliasesFromFile(file);

      expect(capturedFrontmatter.aliases).toEqual([
        'User Alias 1',
        'User Alias 2',
      ]);
    });

    it('should delete property when empty and keepEmptyProperty is false', async () => {
      plugin.settings.firstLineProperty.keepEmptyProperty = false;
      const zwsp = '\u200B';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {
            aliases: [`${zwsp}Plugin Alias${zwsp}`],
          };
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.removePluginAliasesFromFile(file);

      expect(capturedFrontmatter.aliases).toBeUndefined();
    });

    it('should keep property as null when empty and keepEmptyProperty is true', async () => {
      plugin.settings.firstLineProperty.keepEmptyProperty = true;
      const zwsp = '\u200B';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {
            aliases: [`${zwsp}Plugin Alias${zwsp}`],
          };
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.removePluginAliasesFromFile(file);

      expect(capturedFrontmatter.aliases).toBeNull();
    });

    it('should handle multiple alias property keys', async () => {
      plugin.settings.firstLineProperty.propertyKey = 'aliases, aka';
      const zwsp = '\u200B';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {
            aliases: [`${zwsp}Plugin${zwsp}`, 'User'],
            aka: `${zwsp}Plugin${zwsp}`,
          };
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.removePluginAliasesFromFile(file);

      expect(capturedFrontmatter.aliases).toEqual(['User']);
      expect(capturedFrontmatter.aka).toBeNull(); // keepEmptyProperty is true
    });

    it('should collapse non-aliases properties to a scalar after removal', async () => {
      plugin.settings.firstLineProperty.propertyKey = 'aka';
      const zwsp = '\u200B';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {
            aka: [`${zwsp}Plugin${zwsp}`, 'User Value'],
          };
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.removePluginAliasesFromFile(file);

      // Custom properties collapse to inline (scalar) format when one value remains
      expect(capturedFrontmatter.aka).toBe('User Value');
    });

    it('should filter out empty strings', async () => {
      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {
            aliases: ['Valid', '', 'Also Valid', ''],
          };
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.removePluginAliasesFromFile(file);

      expect(capturedFrontmatter.aliases).toEqual(['Valid', 'Also Valid']);
    });

    it('should handle string value (not array)', async () => {
      const zwsp = '\u200B';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {
            aliases: `${zwsp}Plugin Alias${zwsp}`,
          };
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.removePluginAliasesFromFile(file);

      expect(capturedFrontmatter.aliases).toBeNull();
    });

    it('should add file to pendingMetadataUpdates', async () => {
      const zwsp = '\u200B';

      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = { aliases: [`${zwsp}Plugin${zwsp}`] };
          callback(fm);
        }
      );

      await aliasManager.removePluginAliasesFromFile(file);

      expect(plugin.pendingMetadataUpdates.has(file)).toBe(true);
    });

    it('should handle ENOENT error gracefully', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';

      plugin.app.fileManager.processFrontMatter = vi
        .fn()
        .mockRejectedValue(error);

      await expect(
        aliasManager.removePluginAliasesFromFile(file)
      ).resolves.not.toThrow();
    });

    it('should remove aliases in the editor instead of the file', async () => {
      const zwsp = '\u200B';
      const mockView = new MarkdownView(plugin.app);
      mockView.file = file;
      mockView.save = vi.fn();
      plugin.app.workspace.getActiveViewOfType = vi
        .fn()
        .mockReturnValue(mockView);
      vi.mocked(getFrontMatterInfo).mockImplementationOnce(
        splitFrontMatter as unknown as typeof getFrontMatterInfo
      );
      vi.mocked(parseYaml).mockReturnValueOnce({
        aliases: [`${zwsp}Old${zwsp}`, 'User'],
      });
      vi.mocked(stringifyYaml).mockReturnValueOnce('aliases:\n  - User\n');
      const target = createEditorTarget(
        `---\naliases:\n  - ${zwsp}Old${zwsp}\n  - User\n---\nBody`
      );

      await aliasManager.removePluginAliasesFromFile(file, target);

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

      await aliasManager.removePluginAliasesFromFile(file);

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
    });

    it('should handle file path with special characters', async () => {
      file.path = 'folder/file [special] (chars).md';
      file.basename = 'file [special] (chars)';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {};
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.addAliasToFile(file, 'Title', file.basename);

      expect(capturedFrontmatter.aliases).toBeDefined();
    });

    it('should handle very long alias content', async () => {
      plugin.settings.firstLineProperty.truncate = false;
      const veryLongTitle = 'A'.repeat(1000);

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {};
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.addAliasToFile(file, veryLongTitle, 'filename');

      expect(capturedFrontmatter.aliases[0]).toContain('A'.repeat(1000));
    });

    it('should handle alias with special Unicode characters', async () => {
      const title = 'Title with emoji \u{1F680} and symbols \u00A9\u00AE\u2122';

      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = {};
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.addAliasToFile(file, title, 'filename');

      expect(capturedFrontmatter.aliases[0]).toContain('\u{1F680}');
      expect(capturedFrontmatter.aliases[0]).toContain('\u00A9\u00AE\u2122');
    });

    it('should handle file deleted during operation', async () => {
      // First check passes, second fails
      plugin.app.vault.getAbstractFileByPath = vi
        .fn()
        .mockReturnValueOnce(file)
        .mockReturnValueOnce(null);

      await aliasManager.addAliasToFile(file, 'Title', 'filename');

      // Should not call processFrontMatter after detecting file deletion
      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should handle concurrent calls to same file', async () => {
      const title = 'Title';

      let callCount = 0;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          callCount++;
          const fm: Record<string, any> = {};
          callback(fm);
        }
      );

      // Simulate concurrent calls
      await Promise.all([
        aliasManager.addAliasToFile(file, title, 'filename'),
        aliasManager.addAliasToFile(file, title, 'filename'),
        aliasManager.addAliasToFile(file, title, 'filename'),
      ]);

      expect(callCount).toBe(3); // All should complete
    });

    it('should not open frontmatter when the property key is empty', async () => {
      plugin.settings.firstLineProperty.propertyKey = '';

      plugin.app.fileManager.processFrontMatter = vi.fn();

      await aliasManager.addAliasToFile(file, 'Title', 'filename');

      expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    });

    it('should handle null values in frontmatter', async () => {
      let capturedFrontmatter: any;
      plugin.app.fileManager.processFrontMatter = vi.fn(
        async (_file: TFile, callback: (fm: any) => void) => {
          const fm: Record<string, any> = { aliases: null };
          callback(fm);
          capturedFrontmatter = fm;
        }
      );

      await aliasManager.removePluginAliasesFromFile(file);

      // Should handle null gracefully (no crash)
      expect(capturedFrontmatter.aliases).toBeNull();
    });
  });
});
