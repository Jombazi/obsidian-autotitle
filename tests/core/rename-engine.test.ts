import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getFrontMatterInfo, parseYaml } from 'obsidian';
import { RenameEngine } from '../../src/core/rename-engine';
import { CacheManager } from '../../src/core/cache-manager';
import {
  createMockFile,
  createMockFolder,
  createMockApp,
  createTestSettings,
  splitFrontMatter,
} from '../testUtils';
import { CustomReplacement } from '../../src/types';
import * as mockObsidian from '../mockObsidian';
import { TFile, Editor } from '../mockObsidian';
import { TIMING } from '../../src/constants/timing';

// Mock plugin for RenameEngine
function createMockPlugin() {
  const app = createMockApp();
  const settings = createTestSettings();

  return {
    app,
    settings,
    cacheManager: {
      isLocked: vi.fn().mockReturnValue(false),
      acquireLock: vi.fn().mockReturnValue(true),
      releaseLock: vi.fn(),
      markPendingAliasRecheck: vi.fn(),
      hasPendingAliasRecheck: vi.fn().mockReturnValue(false),
      getContent: vi.fn().mockReturnValue(undefined),
      setContent: vi.fn(),
      reservePath: vi.fn(),
      releasePath: vi.fn(),
      isPathReserved: vi.fn().mockReturnValue(false),
      notifyFileRenamed: vi.fn(),
    },
    fileStateManager: {
      // Content tracking
      isEditorSyncing: vi.fn().mockReturnValue(false),
      getLastEditorContent: vi.fn().mockReturnValue(undefined),
      setLastEditorContent: vi.fn(),
      deleteLastEditorContent: vi.fn(),
      getLastSavedContent: vi.fn().mockReturnValue(undefined),
      setLastSavedContent: vi.fn(),
      deleteLastSavedContent: vi.fn(),
      // Title region cache
      getTitleRegionCache: vi.fn().mockReturnValue(undefined),
      setTitleRegionCache: vi.fn(),
      deleteTitleRegionCache: vi.fn(),
      clearAllTitleRegionCaches: vi.fn(),
      updateTitleRegionCacheKey: vi.fn(),
      // File lifecycle
      notifyFileRenamed: vi.fn(),
      notifyFileDeleted: vi.fn(),
      markRecentlyRenamed: vi.fn(),
      wasRecentlyRenamed: vi.fn().mockReturnValue(false),
      // Editor syncing
      markEditorSyncing: vi.fn(),
      clearEditorSyncing: vi.fn(),
      // Pending alias recheck
      markPendingAliasRecheck: vi.fn(),
      hasPendingAliasRecheck: vi.fn().mockReturnValue(false),
      clearPendingAliasRecheck: vi.fn(),
      getFilesWithPendingAliasRecheck: vi.fn().mockReturnValue([]),
      // Lifecycle timers
      setCreationDelayTimer: vi.fn(),
      clearCreationDelayTimer: vi.fn(),
      isFileInCreationDelay: vi.fn().mockReturnValue(false),
      setThrottleTimer: vi.fn(),
      clearThrottleTimer: vi.fn(),
      hasThrottleTimer: vi.fn().mockReturnValue(false),
      clearAllThrottleTimers: vi.fn(),
      // Locking
      acquireLock: vi.fn().mockReturnValue(true),
      releaseLock: vi.fn(),
      isLocked: vi.fn().mockReturnValue(false),
      clearAllLocks: vi.fn(),
      // Notice rate limiting
      setLastSelfRefNotice: vi.fn(),
      canShowSelfRefNotice: vi.fn().mockReturnValue(true),
      // Operation tracking
      getOperationData: vi.fn().mockReturnValue(undefined),
      setOperationData: vi.fn(),
      updateOperationCount: vi.fn(),
      // Maintenance
      runMaintenance: vi.fn(),
      dispose: vi.fn(),
      // State access
      getState: vi.fn().mockReturnValue(undefined),
    },
    eventHandlerManager: {
      isAliasUpdatePending: vi.fn().mockReturnValue(false),
      markAliasUpdatePending: vi.fn(),
      clearAliasUpdatePending: vi.fn(),
    },
    aliasManager: {
      updateAliasIfNeeded: vi.fn().mockResolvedValue(false),
    },
    outputDebugFileContent: vi.fn(),
    recentlyRenamedPaths: new Set<string>(),
  } as any;
}

describe('RenameEngine', () => {
  let plugin: any;
  let renameEngine: RenameEngine;
  let file: TFile;
  let editor: Editor;

  beforeEach(() => {
    plugin = createMockPlugin();
    renameEngine = new RenameEngine(plugin);
    file = createMockFile('test.md');
    editor = new Editor();
  });

  describe('constructor', () => {
    it('should initialize rate limiters', () => {
      expect(renameEngine).toBeDefined();
      expect(renameEngine['perFileRateLimiter']).toBeDefined();
      expect(renameEngine['globalRateLimiter']).toBeDefined();
    });
  });

  describe('checkFileTimeLimit', () => {
    it('should return true when under limit', () => {
      const result = renameEngine.checkFileTimeLimit(file);
      expect(result).toBe(true);
    });

    it('should track per-file rate limits', () => {
      const file1 = createMockFile('file1.md');
      const file2 = createMockFile('file2.md');

      // Different files should have independent limits
      expect(renameEngine.checkFileTimeLimit(file1)).toBe(true);
      expect(renameEngine.checkFileTimeLimit(file2)).toBe(true);
    });

    it('should return false when limit exceeded', () => {
      // Call 20 times (limit is 15 per 500ms)
      for (let i = 0; i < 20; i++) {
        renameEngine.checkFileTimeLimit(file);
      }

      // Should eventually return false
      const result = renameEngine.checkFileTimeLimit(file);
      expect(result).toBe(false);
    });
  });

  describe('checkGlobalRateLimit', () => {
    it('should return true when under global limit', () => {
      const result = renameEngine.checkGlobalRateLimit();
      expect(result).toBe(true);
    });

    it('should return false when global limit exceeded', () => {
      // Call 35 times (global limit is 30 per 500ms)
      for (let i = 0; i < 35; i++) {
        renameEngine.checkGlobalRateLimit();
      }

      const result = renameEngine.checkGlobalRateLimit();
      expect(result).toBe(false);
    });
  });

  describe('stripFrontmatterFromContent', () => {
    it('should strip frontmatter from content', () => {
      const content = '---\ntitle: Test\n---\nBody content';
      const result = renameEngine.stripFrontmatterFromContent(content, file);
      expect(result).toBe('Body content');
    });

    it('should handle content without frontmatter', () => {
      const content = 'Just body content';
      const result = renameEngine.stripFrontmatterFromContent(content, file);
      expect(result).toBe('Just body content');
    });

    it('should return empty string for undefined content', () => {
      const result = renameEngine.stripFrontmatterFromContent(undefined, file);
      expect(result).toBe('');
    });

    it('should return empty string for empty content', () => {
      const result = renameEngine.stripFrontmatterFromContent('', file);
      expect(result).toBe('');
    });

    it('should handle frontmatter with multiple lines', () => {
      const content =
        '---\ntitle: Test\ntags: [tag1, tag2]\ndate: 2024-01-01\n---\nContent here';
      const result = renameEngine.stripFrontmatterFromContent(content, file);
      expect(result).toBe('Content here');
    });

    it('should handle content with only frontmatter', () => {
      const content = '---\ntitle: Test\n---';
      const result = renameEngine.stripFrontmatterFromContent(content, file);
      expect(result).toBe('');
    });

    it('should handle incomplete frontmatter (no closing ---)', () => {
      const content = '---\ntitle: Test\nBody content';
      const result = renameEngine.stripFrontmatterFromContent(content, file);
      expect(result).toBe('---\ntitle: Test\nBody content'); // Returns as-is
    });

    it('should handle content starting with --- but not frontmatter', () => {
      const content = '--- not frontmatter\nContent';
      const result = renameEngine.stripFrontmatterFromContent(content, file);
      // If first line is exactly "---", it searches for closing
      // Since "--- not frontmatter" has text after, it won't be treated as frontmatter
      expect(result).toBe('--- not frontmatter\nContent');
    });

    it('should handle frontmatter with empty lines', () => {
      const content = '---\n\ntitle: Test\n\n---\nContent';
      const result = renameEngine.stripFrontmatterFromContent(content, file);
      expect(result).toBe('Content');
    });

    it('should preserve newlines in body content', () => {
      const content = '---\ntitle: Test\n---\nLine 1\nLine 2\nLine 3';
      const result = renameEngine.stripFrontmatterFromContent(content, file);
      expect(result).toBe('Line 1\nLine 2\nLine 3');
    });
  });

  describe('extractTitleRegion', () => {
    beforeEach(() => {
      plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatterPosition: null,
      });
    });

    afterEach(() => {
      vi.mocked(getFrontMatterInfo).mockReset();
    });

    /** The cache says the frontmatter closes on `cachedEndLine`, while the editor already holds a different frontmatter. */
    function mockCachedFrontmatterEndLine(cachedEndLine: number) {
      plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatterPosition: {
          start: { line: 0, col: 0, offset: 0 },
          end: { line: cachedEndLine, col: 3, offset: 0 },
        },
      });
    }

    it('should extract first non-empty line', () => {
      const content = 'First Line\nSecond Line';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor, file);

      expect(result.firstNonEmptyLine).toBe('First Line');
      expect(result.titleSourceLine).toBeDefined();
      expect(result.lastUpdated).toBeGreaterThan(0);
    });

    it('should skip frontmatter when extracting title', () => {
      vi.mocked(getFrontMatterInfo).mockImplementation(
        splitFrontMatter as unknown as typeof getFrontMatterInfo
      );
      const content = '---\ntitle: Test\n---\nFirst Body Line\nSecond Line';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor, file);

      expect(result.firstNonEmptyLine).toBe('First Body Line');
    });

    it('should find the first body line when a property line was deleted before the cache caught up', () => {
      vi.mocked(getFrontMatterInfo).mockImplementation(
        splitFrontMatter as unknown as typeof getFrontMatterInfo
      );
      mockCachedFrontmatterEndLine(3);
      editor.getValue = vi
        .fn()
        .mockReturnValue('---\ntitle: Test\n---\nFirst Body Line\nSecond Line');

      const result = renameEngine.extractTitleRegion(editor, file);

      expect(result.firstNonEmptyLine).toBe('First Body Line');
      expect(result.titleSourceLine).toBe('First Body Line');
    });

    it('should find the first body line when a property line was added before the cache caught up', () => {
      vi.mocked(getFrontMatterInfo).mockImplementation(
        splitFrontMatter as unknown as typeof getFrontMatterInfo
      );
      mockCachedFrontmatterEndLine(2);
      editor.getValue = vi
        .fn()
        .mockReturnValue(
          '---\ntitle: Test\nstatus: draft\n---\nFirst Body Line\nSecond Line'
        );

      const result = renameEngine.extractTitleRegion(editor, file);

      expect(result.firstNonEmptyLine).toBe('First Body Line');
      expect(result.titleSourceLine).toBe('First Body Line');
    });

    it('should skip empty lines', () => {
      const content = '\n\n\nFirst Line\nSecond Line';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor, file);

      expect(result.firstNonEmptyLine).toBe('First Line');
    });

    it('should handle content with only empty lines', () => {
      const content = '\n\n\n';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor, file);

      expect(result.firstNonEmptyLine).toBe('');
      expect(result.titleSourceLine).toBe('');
    });

    it('should handle empty content', () => {
      const content = '';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor, file);

      expect(result.firstNonEmptyLine).toBe('');
      expect(result.titleSourceLine).toBe('');
    });

    it('should use provided content instead of editor', () => {
      const content = 'Provided Content';
      editor.getValue = vi.fn().mockReturnValue('Editor Content');

      const result = renameEngine.extractTitleRegion(editor, file, content);

      expect(result.firstNonEmptyLine).toBe('Provided Content');
      expect(editor.getValue).not.toHaveBeenCalled();
    });

    it('should handle content with whitespace-only lines', () => {
      const content = '   \n\t\t\n  \nFirst Line';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor, file);

      expect(result.firstNonEmptyLine).toBe('First Line');
    });

    it('should preserve leading/trailing whitespace in title line', () => {
      const content = '  Padded Title  \nSecond Line';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor, file);

      expect(result.firstNonEmptyLine).toBe('  Padded Title  ');
    });

    it('should handle single line content', () => {
      const content = 'Single Line';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor, file);

      expect(result.firstNonEmptyLine).toBe('Single Line');
    });
  });

  describe('clearTitleRegionCache', () => {
    it('should clear title region cache via fileStateManager', () => {
      renameEngine.clearTitleRegionCache();

      expect(
        plugin.fileStateManager.clearAllTitleRegionCaches
      ).toHaveBeenCalled();
    });
  });

  describe('updateTitleRegionCacheKey', () => {
    it('should update cache key when file is renamed', () => {
      plugin.fileStateManager.updateTitleRegionCacheKey = vi.fn();
      const oldPath = 'old/path.md';
      const newPath = 'new/path.md';

      renameEngine.updateTitleRegionCacheKey(oldPath, newPath);

      expect(
        plugin.fileStateManager.updateTitleRegionCacheKey
      ).toHaveBeenCalledWith(oldPath, newPath);
    });
  });

  describe('processEditorChangeOptimal', () => {
    beforeEach(() => {
      editor.getValue = vi.fn().mockReturnValue('Test content');
      plugin.app.vault.read = vi.fn().mockResolvedValue('Test content');
    });

    afterEach(() => {
      vi.mocked(getFrontMatterInfo).mockReset();
    });

    it('should return early when file is locked', async () => {
      plugin.cacheManager.isLocked = vi.fn().mockReturnValue(true);
      plugin.fileStateManager.isEditorSyncing = vi.fn().mockReturnValue(false);

      await renameEngine.processEditorChangeOptimal(editor, file);

      expect(plugin.cacheManager.markPendingAliasRecheck).toHaveBeenCalledWith(
        file.path
      );
    });

    it('should not mark for recheck when editor is syncing', async () => {
      plugin.cacheManager.isLocked = vi.fn().mockReturnValue(true);
      plugin.fileStateManager.isEditorSyncing = vi.fn().mockReturnValue(true);

      await renameEngine.processEditorChangeOptimal(editor, file);

      expect(
        plugin.cacheManager.markPendingAliasRecheck
      ).not.toHaveBeenCalled();
    });

    it('should return before reading the vault when the editor is syncing', async () => {
      // The plugin's own title insertion fires editor-change like a keystroke; without this
      // guard it opens a second entry into the pipeline and reads the file from disk
      plugin.cacheManager.isLocked = vi.fn().mockReturnValue(false);
      plugin.fileStateManager.isEditorSyncing = vi.fn().mockReturnValue(true);
      plugin.fileStateManager.getLastEditorContent = vi
        .fn()
        .mockReturnValue(null);

      await renameEngine.processEditorChangeOptimal(editor, file);

      expect(plugin.app.vault.read).not.toHaveBeenCalled();
      expect(
        plugin.fileStateManager.setLastEditorContent
      ).not.toHaveBeenCalled();
    });

    it('should still process an unlocked file when the editor is not syncing', async () => {
      plugin.cacheManager.isLocked = vi.fn().mockReturnValue(false);
      plugin.fileStateManager.isEditorSyncing = vi.fn().mockReturnValue(false);
      plugin.fileStateManager.getLastEditorContent = vi
        .fn()
        .mockReturnValue(null);

      await renameEngine.processEditorChangeOptimal(editor, file);

      expect(plugin.app.vault.read).toHaveBeenCalledWith(file);
    });

    it('should skip processing when only frontmatter changed', async () => {
      // The default mock reports no frontmatter, so both versions would differ in full and never reach the skip.
      vi.mocked(getFrontMatterInfo).mockImplementation(
        splitFrontMatter as unknown as typeof getFrontMatterInfo
      );
      const previousContent = '---\ntitle: Old\n---\nBody';
      const currentContent = '---\ntitle: New\n---\nBody';

      plugin.fileStateManager.getLastEditorContent = vi
        .fn()
        .mockReturnValue(previousContent);
      editor.getValue = vi.fn().mockReturnValue(currentContent);

      await renameEngine.processEditorChangeOptimal(editor, file);

      expect(plugin.fileStateManager.setLastEditorContent).toHaveBeenCalledWith(
        file.path,
        currentContent
      );
      expect(
        plugin.fileStateManager.setTitleRegionCache
      ).not.toHaveBeenCalled();
    });

    it('should process when body content changes', async () => {
      const previousContent = '---\ntitle: Test\n---\nOld Body';
      const currentContent = '---\ntitle: Test\n---\nNew Body';

      plugin.fileStateManager.getLastEditorContent = vi
        .fn()
        .mockReturnValue(previousContent);
      editor.getValue = vi.fn().mockReturnValue(currentContent);

      await renameEngine.processEditorChangeOptimal(editor, file);

      // Should update last editor content
      expect(plugin.fileStateManager.setLastEditorContent).toHaveBeenCalled();
    });

    it('should handle first editor event', async () => {
      plugin.fileStateManager.getLastEditorContent = vi
        .fn()
        .mockReturnValue(null);
      editor.getValue = vi.fn().mockReturnValue('New content');
      plugin.app.vault.read = vi.fn().mockResolvedValue('Old content');

      await renameEngine.processEditorChangeOptimal(editor, file);

      expect(plugin.app.vault.read).toHaveBeenCalledWith(file);
    });

    it('should skip when no body edits on first open', async () => {
      const content = '---\ntitle: Test\n---\nBody';
      plugin.fileStateManager.getLastEditorContent = vi
        .fn()
        .mockReturnValue(null);
      editor.getValue = vi.fn().mockReturnValue(content);
      plugin.app.vault.read = vi.fn().mockResolvedValue(content);

      await renameEngine.processEditorChangeOptimal(editor, file);

      // Should initialize cache but not process
      expect(plugin.fileStateManager.setTitleRegionCache).toHaveBeenCalled();
    });

    // A deselected Canvas card's or closed page preview's editor reads as empty once CodeMirror has destroyed its view
    it('should process from the file when the editor has been torn down', async () => {
      (editor as any).cm = { dom: document.createElement('div') };
      const processFile = vi
        .spyOn(renameEngine, 'processFile')
        .mockResolvedValue({ success: true } as any);

      await renameEngine.processEditorChangeOptimal(editor, file);

      expect(processFile).toHaveBeenCalledTimes(1);
      expect(processFile).toHaveBeenCalledWith(
        file,
        true,
        false,
        undefined,
        false,
        undefined,
        true
      );
      expect(editor.getValue).not.toHaveBeenCalled();
    });

    it('should read the editor while its view is still attached', async () => {
      const dom = document.createElement('div');
      document.body.appendChild(dom);
      (editor as any).cm = { dom };
      const processFile = vi.spyOn(renameEngine, 'processFile');

      await renameEngine.processEditorChangeOptimal(editor, file);
      dom.remove();

      expect(editor.getValue).toHaveBeenCalled();
      expect(processFile).not.toHaveBeenCalledWith(
        file,
        true,
        false,
        undefined,
        false,
        undefined,
        true
      );
    });

    // A tab switched to another note keeps the same editor, which then holds that note's text.
    describe('with the editor-change owner', () => {
      const fileReadArgs = [
        true,
        false,
        undefined,
        false,
        undefined,
        true,
      ] as const;

      it('should process from the file when the owner shows another note', async () => {
        const owner = { file: createMockFile('other.md'), editor };
        const processFile = vi
          .spyOn(renameEngine, 'processFile')
          .mockResolvedValue({ success: true } as any);

        await renameEngine.processEditorChangeOptimal(
          editor,
          file,
          owner as any
        );

        expect(processFile).toHaveBeenCalledWith(file, ...fileReadArgs);
        expect(editor.getValue).not.toHaveBeenCalled();
      });

      it('should process from the file when the owner no longer has the editor', async () => {
        const owner = { file, editor: undefined };
        const processFile = vi
          .spyOn(renameEngine, 'processFile')
          .mockResolvedValue({ success: true } as any);

        await renameEngine.processEditorChangeOptimal(
          editor,
          file,
          owner as any
        );

        expect(processFile).toHaveBeenCalledWith(file, ...fileReadArgs);
        expect(editor.getValue).not.toHaveBeenCalled();
      });

      it('should read the editor while the owner still shows the note in it', async () => {
        const owner = { file, editor };
        const processFile = vi.spyOn(renameEngine, 'processFile');

        await renameEngine.processEditorChangeOptimal(
          editor,
          file,
          owner as any
        );

        expect(editor.getValue).toHaveBeenCalled();
        expect(processFile).not.toHaveBeenCalledWith(file, ...fileReadArgs);
      });
    });
  });

  describe('processFile', () => {
    beforeEach(() => {
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
      plugin.app.vault.read = vi
        .fn()
        .mockResolvedValue('# Test Title\nContent');
    });

    it('should return false when file not found', async () => {
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);

      const result = await renameEngine.processFile(file);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('file-not-found');
    });

    it('should use provided content when available', async () => {
      const providedContent = '# Provided Title\nContent';
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);

      await renameEngine.processFile(file, false, false, providedContent);

      // Should not read from vault when content is provided
      expect(plugin.app.vault.read).not.toHaveBeenCalled();
    });
  });

  describe('title pipeline', () => {
    let noteInFolder: TFile;

    const makeRule = (overrides: Partial<CustomReplacement> = {}) => ({
      searchText: 'TODO',
      replaceText: 'Archive/Done',
      onlyAtStart: false,
      onlyWholeLine: false,
      ...overrides,
    });

    // Drives the full rename path so the assertion is the path Obsidian is actually handed
    const renameWith = async (firstLine: string) => {
      await renameEngine.processFile(
        noteInFolder,
        false,
        true,
        `${firstLine}\n\nBody`
      );

      const call = (plugin.app.fileManager.renameFile as any).mock.calls[0];
      return call ? (call[1] as string) : undefined;
    };

    beforeEach(() => {
      noteInFolder = createMockFile('Notes/Source note.md');
      noteInFolder.parent = createMockFolder('Notes');

      // Only the note itself exists, so the conflict counter stays out of the asserted path
      plugin.app.vault.getAbstractFileByPath = vi.fn((path: string) =>
        path === noteInFolder.path ? noteInFolder : null
      );
      plugin.app.vault.getAllLoadedFiles = vi.fn().mockReturnValue([]);
      plugin.app.vault.read = vi.fn().mockResolvedValue('');
    });

    it('applies a custom replacement rule with no enable toggle', async () => {
      plugin.settings.customReplacements.rules = [
        makeRule({ replaceText: 'Done' }),
      ];

      expect(await renameWith('TODO item')).toBe('Notes/Done item.md');
    });

    it('applies nothing when there are no custom replacement rules', async () => {
      plugin.settings.customReplacements.rules = [];

      expect(await renameWith('TODO item')).toBe('Notes/TODO item.md');
    });

    describe('custom replacements containing a path separator', () => {
      it('keeps the note in its folder when rules run after forbidden chars', async () => {
        plugin.settings.customReplacements.applyAfterForbiddenChars = true;
        plugin.settings.customReplacements.rules = [makeRule()];

        expect(await renameWith('# TODO item')).toBe(
          'Notes/ArchiveDone item.md'
        );
      });

      it('keeps the note in its folder when rules run after markup stripping', async () => {
        plugin.settings.customReplacements.applyAfterForbiddenChars = false;
        plugin.settings.markupStripping.applyCustomReplacementsAfterMarkupStripping = true;
        plugin.settings.customReplacements.rules = [makeRule()];

        expect(await renameWith('# TODO item')).toBe(
          'Notes/ArchiveDone item.md'
        );
      });

      it('keeps the note in its folder when rules run first', async () => {
        plugin.settings.customReplacements.applyAfterForbiddenChars = false;
        plugin.settings.markupStripping.applyCustomReplacementsAfterMarkupStripping = false;
        plugin.settings.customReplacements.rules = [makeRule()];

        expect(await renameWith('# TODO item')).toBe(
          'Notes/ArchiveDone item.md'
        );
      });

      it('truncates to the character limit after a rule lengthens the title', async () => {
        plugin.settings.customReplacements.applyAfterForbiddenChars = true;
        plugin.settings.core.charCount = 10;
        plugin.settings.customReplacements.rules = [
          makeRule({ replaceText: 'Archive/Done and then some more text' }),
        ];

        expect(await renameWith('# TODO')).toBe('Notes/ArchiveDo….md');
      });
    });

    describe('ordering', () => {
      // A colon survives markup stripping but not forbidden-char processing,
      // and the heading marker survives forbidden-char processing but not markup stripping.
      // Between them the three orderings produce three distinguishable titles.
      const colonRule = makeRule({ searchText: 'TODO:', replaceText: 'Done' });
      const headingRule = makeRule({
        searchText: '# TODO:',
        replaceText: 'Done',
        onlyAtStart: true,
      });

      it('runs rules after forbidden chars have eaten the colon', async () => {
        plugin.settings.customReplacements.applyAfterForbiddenChars = true;
        plugin.settings.customReplacements.rules = [colonRule];

        expect(await renameWith('# TODO: item')).toBe('Notes/TODO item.md');
      });

      it('runs rules before forbidden chars when rules follow markup stripping', async () => {
        plugin.settings.customReplacements.applyAfterForbiddenChars = false;
        plugin.settings.markupStripping.applyCustomReplacementsAfterMarkupStripping = true;
        plugin.settings.customReplacements.rules = [colonRule];

        expect(await renameWith('# TODO: item')).toBe('Notes/Done item.md');
      });

      it('strips the heading marker before rules run when rules follow markup stripping', async () => {
        plugin.settings.customReplacements.applyAfterForbiddenChars = false;
        plugin.settings.markupStripping.applyCustomReplacementsAfterMarkupStripping = true;
        plugin.settings.customReplacements.rules = [headingRule];

        expect(await renameWith('# TODO: item')).toBe('Notes/TODO item.md');
      });

      it('runs rules on the raw line when rules come first', async () => {
        plugin.settings.customReplacements.applyAfterForbiddenChars = false;
        plugin.settings.markupStripping.applyCustomReplacementsAfterMarkupStripping = false;
        plugin.settings.customReplacements.rules = [headingRule];

        expect(await renameWith('# TODO: item')).toBe('Notes/Done item.md');
      });
    });
  });

  // A note just created, or replaced by sync, reaches processFile before the metadata cache indexes it; the gate has to read the property from the text.
  describe('rename-blocking property on an unindexed note', () => {
    let noteInFolder: TFile;
    // Raw YAML block -> parsed object. Blocks with no entry throw, modelling malformed YAML.
    let yamlFixtures: Map<string, unknown>;

    const BLOCKED_NOTE = '---\nno rename: true\n---\nTitle\n';

    // Mirrors the new-note path: noDelay, automatic, no content handed in, a new note shown in a Markdown leaf
    const processAsNewNote = () =>
      renameEngine.processFile(
        noteInFolder,
        true,
        false,
        undefined,
        false,
        undefined,
        true
      );

    beforeEach(() => {
      yamlFixtures = new Map<string, unknown>([
        ['no rename: true\n', { 'no rename': true }],
        ['no rename: false\n', { 'no rename': false }],
        ['status: draft\n', { status: 'draft' }],
      ]);
      // Cleared first: the read-error case asserts the gate never parsed anything, and earlier describes leave calls behind
      vi.mocked(getFrontMatterInfo)
        .mockClear()
        .mockImplementation(
          splitFrontMatter as unknown as typeof getFrontMatterInfo
        );
      vi.mocked(parseYaml).mockImplementation(((yaml: string) => {
        if (!yamlFixtures.has(yaml)) {
          throw new Error(`malformed YAML: ${yaml}`);
        }
        return yamlFixtures.get(yaml);
      }) as typeof parseYaml);

      noteInFolder = createMockFile('Notes/Source note.md');
      noteInFolder.parent = createMockFolder('Notes');

      // Only the note itself exists, so the conflict counter stays out of the asserted path
      plugin.app.vault.getAbstractFileByPath = vi.fn((path: string) =>
        path === noteInFolder.path ? noteInFolder : null
      );
      plugin.app.vault.getAllLoadedFiles = vi.fn().mockReturnValue([]);
      plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue(null);
    });

    afterEach(() => {
      vi.mocked(getFrontMatterInfo).mockReset();
      vi.mocked(parseYaml).mockReset();
    });

    it('keeps the name when the property is in the text the cache has not indexed', async () => {
      plugin.app.vault.read = vi.fn().mockResolvedValue(BLOCKED_NOTE);

      const result = await processAsNewNote();

      expect(result.reason).toBe('property-disabled');
      expect(plugin.app.vault.read).toHaveBeenCalledTimes(1);
      expect(plugin.app.vault.read).toHaveBeenCalledWith(noteInFolder);
      expect(plugin.app.fileManager.renameFile).not.toHaveBeenCalled();
    });

    it('proceeds when the property in the text is switched off', async () => {
      const content = `---\nno rename: false\n---\n${noteInFolder.basename}\n`;
      plugin.app.vault.read = vi.fn().mockResolvedValue(content);
      plugin.app.vault.cachedRead = vi.fn().mockResolvedValue(content);

      const result = await processAsNewNote();

      expect(result.reason).toBe('no-rename-needed');
    });

    it('stops before the gate when the note cannot be read', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      plugin.app.vault.read = vi.fn().mockRejectedValue(new Error('gone'));

      const result = await processAsNewNote();

      expect(result.reason).toBe('read-error');
      expect(getFrontMatterInfo).not.toHaveBeenCalled();
      expect(plugin.app.metadataCache.getFileCache).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('keeps the name when the text comes from the cached read', async () => {
      plugin.settings.core.contentReadMethod = 'Cache';
      plugin.app.vault.cachedRead = vi.fn().mockResolvedValue(BLOCKED_NOTE);

      const result = await processAsNewNote();

      expect(result.reason).toBe('property-disabled');
    });

    it('keeps the name on a manual command when the property is in the text the cache has not indexed', async () => {
      plugin.app.vault.read = vi.fn().mockResolvedValue(BLOCKED_NOTE);

      const result = await renameEngine.processFile(noteInFolder, true, true);

      expect(result.reason).toBe('property-disabled');
      expect(plugin.app.fileManager.renameFile).not.toHaveBeenCalled();
    });
  });

  // The manual "unless excluded" command passes no overrides, so an excluded note has to say why nothing happened
  describe('exclusion notice', () => {
    let noticeMessages: string[];
    let note: TFile;

    beforeEach(() => {
      noticeMessages = [];
      // A regular function, not an arrow: the engine calls `new Notice(...)`
      vi.spyOn(mockObsidian, 'Notice').mockImplementation(function (
        message: string
      ) {
        noticeMessages.push(message);
        return { containerEl: document.createElement('div') } as any;
      } as any);

      note = createMockFile('Notes/Source note.md');
      note.parent = createMockFolder('Notes');
      plugin.app.vault.getAbstractFileByPath = vi.fn((path: string) =>
        path === note.path ? note : null
      );
      plugin.app.vault.read = vi.fn().mockResolvedValue('Title\n');
      plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue(null);
      plugin.settings.exclusions.excludedFiles = ['Notes/'];
    });

    afterEach(() => {
      vi.mocked(mockObsidian.Notice).mockRestore();
    });

    it('notifies a manual command that a path rule skipped the note', async () => {
      const result = await renameEngine.processFile(note, true, true);

      expect(result.reason).toBe('excluded');
      expect(noticeMessages).toHaveLength(1);
      expect(noticeMessages[0]).toContain('Source note');
    });

    it('stays silent for automatic renames and batch runs', async () => {
      // hasActiveEditor, since the always-on safeguard stops an automatic rename with no editor before any exclusion rule
      const automatic = await renameEngine.processFile(
        note,
        true,
        false,
        undefined,
        false,
        undefined,
        true
      );
      const batch = await renameEngine.processFile(
        note,
        true,
        true,
        undefined,
        true
      );

      expect([automatic.reason, batch.reason]).toEqual([
        'excluded',
        'excluded',
      ]);
      expect(noticeMessages).toEqual([]);
    });
  });

  describe('checkFileExistsCaseInsensitive', () => {
    it('should return false when file does not exist', () => {
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);
      plugin.app.vault.getAllLoadedFiles = vi.fn().mockReturnValue([]);

      const result = renameEngine.checkFileExistsCaseInsensitive('test.md');

      expect(result).toBe(false);
    });

    it('should return true with exact case match', () => {
      const existingFile = createMockFile('Test.md');
      plugin.app.vault.getAbstractFileByPath = vi
        .fn()
        .mockReturnValue(existingFile);

      const result = renameEngine.checkFileExistsCaseInsensitive('Test.md');

      expect(result).toBe(true);
    });

    it('should return true with case-insensitive match', () => {
      const existingFile = createMockFile('Test.md');
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);
      plugin.app.vault.getAllLoadedFiles = vi
        .fn()
        .mockReturnValue([existingFile]);

      const result = renameEngine.checkFileExistsCaseInsensitive('test.md');

      expect(result).toBe(true);
    });

    it('should find file among multiple files', () => {
      const file1 = createMockFile('file1.md');
      const file2 = createMockFile('Target.md');
      const file3 = createMockFile('file3.md');

      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);
      plugin.app.vault.getAllLoadedFiles = vi
        .fn()
        .mockReturnValue([file1, file2, file3]);

      const result = renameEngine.checkFileExistsCaseInsensitive('target.md');

      expect(result).toBe(true);
    });

    it('should handle paths with folders', () => {
      const existingFile = createMockFile('Folder/File.md');
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);
      plugin.app.vault.getAllLoadedFiles = vi
        .fn()
        .mockReturnValue([existingFile]);

      const result =
        renameEngine.checkFileExistsCaseInsensitive('folder/file.md');

      expect(result).toBe(true);
    });

    it('should return true when multiple case-variants exist', () => {
      const file1 = createMockFile('test.md');
      const file2 = createMockFile('Test.md');
      const file3 = createMockFile('TEST.md');

      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(null);
      plugin.app.vault.getAllLoadedFiles = vi
        .fn()
        .mockReturnValue([file1, file2, file3]);

      const result = renameEngine.checkFileExistsCaseInsensitive('TeSt.md');

      expect(result).toBe(true); // Found match
    });
  });

  describe('destination conflicts', () => {
    const SAME_TITLE = 'Same title\n\nBody';

    /**
     * Vault stub backed by a live index that only learns about a rename once
     * renameFile resolves — the window the reservation set exists to cover.
     * Renaming onto an occupied path rejects, as Obsidian's own does.
     */
    const installLiveVault = (files: TFile[]) => {
      const index = new Map<string, TFile>();
      for (const file of files) {
        file.parent = createMockFolder('/');
        index.set(file.path.toLowerCase(), file);
      }

      plugin.app.vault.getAbstractFileByPath = vi.fn(
        (path: string) => index.get(path.toLowerCase()) ?? null
      );
      plugin.app.vault.getAllLoadedFiles = vi.fn(() => [...index.values()]);
      plugin.app.vault.read = vi.fn().mockResolvedValue(SAME_TITLE);
      plugin.app.vault.cachedRead = vi.fn().mockResolvedValue(SAME_TITLE);
      plugin.app.fileManager.renameFile = vi.fn(
        async (file: TFile, newPath: string) => {
          await Promise.resolve();
          if (index.has(newPath.toLowerCase())) {
            throw new Error(`File already exists: ${newPath}`);
          }
          index.delete(file.path.toLowerCase());
          file.path = newPath;
          index.set(newPath.toLowerCase(), file);
        }
      );

      return index;
    };

    // Mirrors the bulk modals: noDelay on, batch operation, content off disk
    const renameInBatch = (file: TFile) =>
      renameEngine.processFile(file, true, true, undefined, true);

    beforeEach(() => {
      // Reservations have to be real here: the vi.fn() stubs make every reserved
      // path look free, which is precisely the defect this block guards. Locks
      // still resolve through the mocked fileStateManager.
      plugin.cacheManager = new CacheManager(plugin);
    });

    it('treats a reserved path with no file behind it as taken', async () => {
      const note = createMockFile('Source note.md');
      installLiveVault([note]);
      plugin.cacheManager.reservePath('Same title.md');

      await renameInBatch(note);

      expect(plugin.app.fileManager.renameFile).toHaveBeenCalledWith(
        note,
        'Same title 1.md'
      );
    });

    it('frees the path again once the reservation is released', async () => {
      const note = createMockFile('Source note.md');
      installLiveVault([note]);
      plugin.cacheManager.reservePath('Same title.md');
      plugin.cacheManager.releasePath('Same title.md');

      await renameInBatch(note);

      expect(plugin.app.fileManager.renameFile).toHaveBeenCalledWith(
        note,
        'Same title.md'
      );
    });

    it('releases the reservation when the rename fails', async () => {
      const note = createMockFile('Source note.md');
      installLiveVault([note]);
      plugin.app.fileManager.renameFile = vi
        .fn()
        .mockRejectedValue(new Error('rename failed'));

      const result = await renameInBatch(note);

      expect(result.success).toBe(false);
      expect(plugin.cacheManager.isPathReserved('Same title.md')).toBe(false);
    });

    it('still counter-suffixes around notes renamed sequentially', async () => {
      const first = createMockFile('First.md');
      const second = createMockFile('Second.md');
      const index = installLiveVault([first, second]);

      expect((await renameInBatch(first)).success).toBe(true);
      expect((await renameInBatch(second)).success).toBe(true);

      expect([...index.keys()].sort()).toEqual([
        'same title 1.md',
        'same title.md',
      ]);
    });

    // Regression guard for the silent drop: concurrently, the loser's rename
    // used to reject into { success: false, reason: 'error' }, which the modals
    // count as neither renamed nor errored
    it('counter-suffixes the second of two same-titled notes in one chunk', async () => {
      const first = createMockFile('First.md');
      const second = createMockFile('Second.md');
      const index = installLiveVault([first, second]);

      const results = await Promise.all(
        [first, second].map((file) => renameInBatch(file))
      );

      expect(results.map((result) => result.success)).toEqual([true, true]);
      expect([...index.keys()].sort()).toEqual([
        'same title 1.md',
        'same title.md',
      ]);
    });
  });

  describe('edge cases', () => {
    it('should handle very long file paths', () => {
      const longPath = 'a/'.repeat(100) + 'file.md';
      const file = createMockFile(longPath);

      expect(() => renameEngine.checkFileTimeLimit(file)).not.toThrow();
    });

    it('should handle special characters in file paths', () => {
      const file = createMockFile('folder/file [special] (chars).md');

      expect(() => renameEngine.checkFileTimeLimit(file)).not.toThrow();
    });

    it('should handle rapid successive calls to rate limiter', () => {
      for (let i = 0; i < 100; i++) {
        renameEngine.checkGlobalRateLimit();
      }

      // Should not throw, just return false when limit exceeded
      expect(() => renameEngine.checkGlobalRateLimit()).not.toThrow();
    });

    it('should handle null/undefined gracefully in stripFrontmatter', () => {
      expect(() =>
        renameEngine.stripFrontmatterFromContent(null as any, file)
      ).not.toThrow();
      expect(() =>
        renameEngine.stripFrontmatterFromContent(undefined, file)
      ).not.toThrow();
    });

    it('should handle very large content in stripFrontmatter', () => {
      const largeFrontmatter = '---\n' + 'x'.repeat(10000) + '\n---\nBody';

      const result = renameEngine.stripFrontmatterFromContent(
        largeFrontmatter,
        file
      );

      expect(result).toBe('Body');
    });

    it('should handle content with many lines', () => {
      const manyLines = Array(1000).fill('line').join('\n');
      const content = '---\ntitle: Test\n---\n' + manyLines;

      const result = renameEngine.stripFrontmatterFromContent(content, file);

      expect(result.split('\n').length).toBe(1000);
    });
  });
  // The consolidated alias step in processFile matches on the outcome's `reason`. The
  // successful-rename outcome once carried no reason at all, so the gate skipped exactly
  // the case that renames a file, and only the manual commands noticed — the editor-change
  // handlers call updateAliasIfNeeded themselves.
  describe('processFile alias gate', () => {
    beforeEach(() => {
      plugin.settings.firstLineProperty.propertyKey = 'aliases';
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
    });

    function stubOutcome(outcome: { success: boolean; reason: string }) {
      return vi
        .spyOn(renameEngine as any, 'processFileInternal')
        .mockResolvedValue(outcome);
    }

    it('should update the alias after a successful rename', async () => {
      stubOutcome({ success: true, reason: 'renamed' });

      await renameEngine.processFile(file);

      expect(plugin.aliasManager.updateAliasIfNeeded).toHaveBeenCalledTimes(1);
    });

    it('should update the alias when no rename was needed', async () => {
      stubOutcome({ success: true, reason: 'no-rename-needed' });

      await renameEngine.processFile(file);

      expect(plugin.aliasManager.updateAliasIfNeeded).toHaveBeenCalledTimes(1);
    });

    it('should update the alias when empty content was retained', async () => {
      stubOutcome({ success: false, reason: 'empty-content-retained' });

      await renameEngine.processFile(file);

      expect(plugin.aliasManager.updateAliasIfNeeded).toHaveBeenCalledTimes(1);
    });

    it('should not update the alias when the file was excluded', async () => {
      stubOutcome({ success: false, reason: 'excluded' });

      await renameEngine.processFile(file);

      expect(plugin.aliasManager.updateAliasIfNeeded).not.toHaveBeenCalled();
    });

    it('should not update the alias when the property name is blank', async () => {
      plugin.settings.firstLineProperty.propertyKey = '';
      stubOutcome({ success: true, reason: 'renamed' });

      await renameEngine.processFile(file);

      expect(plugin.aliasManager.updateAliasIfNeeded).not.toHaveBeenCalled();
    });
  });

  // Keystrokes that land while processFile holds the lock only set the pending flag. A page preview or Canvas card is never the active MarkdownView, so a recheck gated on that left the name a few characters short of the first line.
  describe('processFile pending recheck', () => {
    let processEditorChangeOptimal: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers();
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
      plugin.cacheManager.hasPendingAliasRecheck = vi
        .fn()
        .mockReturnValue(true);
      plugin.cacheManager.clearPendingAliasRecheck = vi.fn();
      vi.spyOn(renameEngine as any, 'processFileInternal').mockResolvedValue({
        success: false,
        reason: 'excluded',
      });
      processEditorChangeOptimal = vi
        .spyOn(renameEngine, 'processEditorChangeOptimal')
        .mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should recheck through an editing embed when no tab shows the note', async () => {
      const embedEditor = new Editor();
      const embed = { file, dirty: true, editor: embedEditor };
      plugin.app.workspace.iterateAllLeaves = vi.fn(
        (callback: (leaf: unknown) => void) =>
          callback({ view: { hoverPopover: { embed } } })
      );

      await renameEngine.processFile(file);

      expect(plugin.cacheManager.clearPendingAliasRecheck).toHaveBeenCalledWith(
        file.path
      );
      expect(processEditorChangeOptimal).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(TIMING.UI_SETTLE_DELAY_MS);

      expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
      expect(processEditorChangeOptimal).toHaveBeenCalledWith(
        embedEditor,
        file
      );
    });

    it('should recheck through the active tab when it edits the note', async () => {
      const view = Object.assign(new mockObsidian.MarkdownView(plugin.app), {
        file,
        getMode: () => 'source',
      });
      plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);

      await renameEngine.processFile(file);
      await vi.advanceTimersByTimeAsync(TIMING.UI_SETTLE_DELAY_MS);

      expect(plugin.cacheManager.clearPendingAliasRecheck).toHaveBeenCalledWith(
        file.path
      );
      expect(processEditorChangeOptimal).toHaveBeenCalledTimes(1);
      expect(processEditorChangeOptimal).toHaveBeenCalledWith(
        view.editor,
        file
      );
    });

    // A newer delayed timer processes the latest text, and an immediate recheck would rename outside a linked note's delay.
    it('should clear the flag and schedule nothing when a timer is scheduled', async () => {
      const embed = { file, dirty: true, editor: new Editor() };
      plugin.app.workspace.iterateAllLeaves = vi.fn(
        (callback: (leaf: unknown) => void) =>
          callback({ view: { hoverPopover: { embed } } })
      );
      plugin.fileStateManager.hasThrottleTimer = vi.fn().mockReturnValue(true);

      await renameEngine.processFile(file);

      expect(plugin.cacheManager.clearPendingAliasRecheck).toHaveBeenCalledWith(
        file.path
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(processEditorChangeOptimal).not.toHaveBeenCalled();
    });

    it('should leave the flag set and schedule nothing when no editor shows the note', async () => {
      await renameEngine.processFile(file);

      expect(vi.getTimerCount()).toBe(0);
      expect(
        plugin.cacheManager.clearPendingAliasRecheck
      ).not.toHaveBeenCalled();
      expect(processEditorChangeOptimal).not.toHaveBeenCalled();
    });
  });
});
