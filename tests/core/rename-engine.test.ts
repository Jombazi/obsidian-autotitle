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
import {
  CustomReplacement,
  ExclusionOverrides,
  IGNORE_ALL_EXCLUSIONS,
} from '../../src/types';
import { initI18n } from '../../src/i18n';
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
      hadBody: vi.fn().mockReturnValue(false),
      setHadBody: vi.fn(),
      reservePath: vi.fn(),
      releasePath: vi.fn(),
      isPathReserved: vi.fn().mockReturnValue(false),
      notifyFileRenamed: vi.fn(),
    },
    fileStateManager: {
      // Content tracking
      isEditorSyncing: vi.fn().mockReturnValue(false),
      getLastEditorContent: vi.fn().mockReturnValue(undefined),
      hasLastEditorContent: vi.fn().mockReturnValue(false),
      setLastEditorContent: vi.fn(),
      deleteLastEditorContent: vi.fn(),
      getLastSavedContent: vi.fn().mockReturnValue(undefined),
      setLastSavedContent: vi.fn(),
      deleteLastSavedContent: vi.fn(),
      // Title region cache
      getTitleRegionCache: vi.fn().mockReturnValue(undefined),
      setTitleRegionCache: vi.fn(),
      // File lifecycle
      notifyFileRenamed: vi.fn(),
      notifyFileDeleted: vi.fn(),
      markRecentlyRenamedInto: vi.fn(),
      wasRecentlyRenamedInto: vi.fn().mockReturnValue(false),
      // Editor syncing
      markEditorSyncing: vi.fn(),
      clearEditorSyncing: vi.fn(),
      // Pending first line property recheck
      markPendingFirstLinePropertyRecheck: vi.fn(),
      hasPendingFirstLinePropertyRecheck: vi.fn().mockReturnValue(false),
      clearPendingFirstLinePropertyRecheck: vi.fn(),
      // Lifecycle timers
      setThrottleTimer: vi.fn(),
      clearThrottleTimer: vi.fn(),
      hasThrottleTimer: vi.fn().mockReturnValue(false),
      clearAllThrottleTimers: vi.fn(),
      // Locking
      acquireLock: vi.fn().mockReturnValue(true),
      releaseLock: vi.fn(),
      isLocked: vi.fn().mockReturnValue(false),
      // Notice rate limiting
      setLastSelfRefNotice: vi.fn(),
      canShowSelfRefNotice: vi.fn().mockReturnValue(true),
      // Maintenance
      runMaintenance: vi.fn(),
      dispose: vi.fn(),
    },
    eventHandlerManager: {
      isFirstLinePropertyUpdatePending: vi.fn().mockReturnValue(false),
      markFirstLinePropertyUpdatePending: vi.fn(),
      clearFirstLinePropertyUpdatePending: vi.fn(),
    },
    firstLinePropertyManager: {
      updateFirstLinePropertyIfNeeded: vi.fn().mockResolvedValue(false),
    },
    outputDebugFileContent: vi.fn(),
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

      const result = renameEngine.extractTitleRegion(editor);

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

      const result = renameEngine.extractTitleRegion(editor);

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

      const result = renameEngine.extractTitleRegion(editor);

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

      const result = renameEngine.extractTitleRegion(editor);

      expect(result.firstNonEmptyLine).toBe('First Body Line');
      expect(result.titleSourceLine).toBe('First Body Line');
    });

    it('should skip empty lines', () => {
      const content = '\n\n\nFirst Line\nSecond Line';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor);

      expect(result.firstNonEmptyLine).toBe('First Line');
    });

    it('should handle content with only empty lines', () => {
      const content = '\n\n\n';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor);

      expect(result.firstNonEmptyLine).toBe('');
      expect(result.titleSourceLine).toBe('');
    });

    it('should handle empty content', () => {
      const content = '';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor);

      expect(result.firstNonEmptyLine).toBe('');
      expect(result.titleSourceLine).toBe('');
    });

    it('should use provided content instead of editor', () => {
      const content = 'Provided Content';
      editor.getValue = vi.fn().mockReturnValue('Editor Content');

      const result = renameEngine.extractTitleRegion(editor, content);

      expect(result.firstNonEmptyLine).toBe('Provided Content');
      expect(editor.getValue).not.toHaveBeenCalled();
    });

    it('should handle content with whitespace-only lines', () => {
      const content = '   \n\t\t\n  \nFirst Line';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor);

      expect(result.firstNonEmptyLine).toBe('First Line');
    });

    it('should preserve leading/trailing whitespace in title line', () => {
      const content = '  Padded Title  \nSecond Line';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor);

      expect(result.firstNonEmptyLine).toBe('  Padded Title  ');
    });

    it('should handle single line content', () => {
      const content = 'Single Line';
      editor.getValue = vi.fn().mockReturnValue(content);

      const result = renameEngine.extractTitleRegion(editor);

      expect(result.firstNonEmptyLine).toBe('Single Line');
    });

    it('records whether the title source is code', () => {
      expect(renameEngine.extractTitleRegion(editor, '---\n    foo').raw).toBe(
        true
      );
      expect(renameEngine.extractTitleRegion(editor, '---\nfoo').raw).toBe(
        false
      );
    });
  });

  describe('processEditorChange', () => {
    beforeEach(() => {
      editor.getValue = vi.fn().mockReturnValue('Test content');
      plugin.app.vault.read = vi.fn().mockResolvedValue('Test content');
    });

    afterEach(() => {
      vi.mocked(getFrontMatterInfo).mockReset();
    });

    it('should return early when file is locked', async () => {
      plugin.fileStateManager.isLocked = vi.fn().mockReturnValue(true);
      plugin.fileStateManager.isEditorSyncing = vi.fn().mockReturnValue(false);

      await renameEngine.processEditorChange(editor, file);

      expect(
        plugin.fileStateManager.markPendingFirstLinePropertyRecheck
      ).toHaveBeenCalledWith(file.path);
    });

    it('should not mark for recheck when editor is syncing', async () => {
      plugin.fileStateManager.isLocked = vi.fn().mockReturnValue(true);
      plugin.fileStateManager.isEditorSyncing = vi.fn().mockReturnValue(true);

      await renameEngine.processEditorChange(editor, file);

      expect(
        plugin.fileStateManager.markPendingFirstLinePropertyRecheck
      ).not.toHaveBeenCalled();
    });

    it('should return before reading the vault when the editor is syncing', async () => {
      // The plugin's own title insertion fires editor-change like a keystroke; without this
      // guard it opens a second entry into the pipeline and reads the file from disk
      plugin.fileStateManager.isLocked = vi.fn().mockReturnValue(false);
      plugin.fileStateManager.isEditorSyncing = vi.fn().mockReturnValue(true);
      plugin.fileStateManager.getLastEditorContent = vi
        .fn()
        .mockReturnValue(null);

      await renameEngine.processEditorChange(editor, file);

      expect(plugin.app.vault.read).not.toHaveBeenCalled();
      expect(
        plugin.fileStateManager.setLastEditorContent
      ).not.toHaveBeenCalled();
    });

    it('should still process an unlocked file when the editor is not syncing', async () => {
      plugin.fileStateManager.isLocked = vi.fn().mockReturnValue(false);
      plugin.fileStateManager.isEditorSyncing = vi.fn().mockReturnValue(false);
      plugin.fileStateManager.getLastEditorContent = vi
        .fn()
        .mockReturnValue(null);

      await renameEngine.processEditorChange(editor, file);

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

      await renameEngine.processEditorChange(editor, file);

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

      await renameEngine.processEditorChange(editor, file);

      // Should update last editor content
      expect(plugin.fileStateManager.setLastEditorContent).toHaveBeenCalled();
    });

    it('should handle first editor event', async () => {
      plugin.fileStateManager.getLastEditorContent = vi
        .fn()
        .mockReturnValue(null);
      editor.getValue = vi.fn().mockReturnValue('New content');
      plugin.app.vault.read = vi.fn().mockResolvedValue('Old content');

      await renameEngine.processEditorChange(editor, file);

      expect(plugin.app.vault.read).toHaveBeenCalledWith(file);
    });

    it('should skip when no body edits on first open', async () => {
      const content = '---\ntitle: Test\n---\nBody';
      plugin.fileStateManager.getLastEditorContent = vi
        .fn()
        .mockReturnValue(null);
      editor.getValue = vi.fn().mockReturnValue(content);
      plugin.app.vault.read = vi.fn().mockResolvedValue(content);

      await renameEngine.processEditorChange(editor, file);

      // Should initialize cache but not process
      expect(plugin.fileStateManager.setTitleRegionCache).toHaveBeenCalled();
    });

    // A deselected Canvas card's or closed page preview's editor reads as empty once CodeMirror has destroyed its view
    it('should process from the file when the editor has been torn down', async () => {
      (editor as any).cm = { dom: document.createElement('div') };
      const processFile = vi
        .spyOn(renameEngine, 'processFile')
        .mockResolvedValue({ success: true } as any);

      await renameEngine.processEditorChange(editor, file);

      expect(processFile).toHaveBeenCalledTimes(1);
      expect(processFile).toHaveBeenCalledWith(file, {
        hasActiveEditor: true,
      });
      expect(editor.getValue).not.toHaveBeenCalled();
    });

    it('should read the editor while its view is still attached', async () => {
      const dom = document.createElement('div');
      document.body.appendChild(dom);
      (editor as any).cm = { dom };
      const processFile = vi.spyOn(renameEngine, 'processFile');

      await renameEngine.processEditorChange(editor, file);
      dom.remove();

      expect(editor.getValue).toHaveBeenCalled();
      expect(processFile).not.toHaveBeenCalledWith(file, {
        hasActiveEditor: true,
      });
    });

    // A tab switched to another note keeps the same editor, which then holds that note's text.
    describe('with the editor-change owner', () => {
      // No content and no editor, so the pass reads the file
      const fileReadOptions = { hasActiveEditor: true };

      it('should process from the file when the owner shows another note', async () => {
        const owner = { file: createMockFile('other.md'), editor };
        const processFile = vi
          .spyOn(renameEngine, 'processFile')
          .mockResolvedValue({ success: true } as any);

        await renameEngine.processEditorChange(editor, file, owner as any);

        expect(processFile).toHaveBeenCalledWith(file, fileReadOptions);
        expect(editor.getValue).not.toHaveBeenCalled();
      });

      it('should process from the file when the owner no longer has the editor', async () => {
        const owner = { file, editor: undefined };
        const processFile = vi
          .spyOn(renameEngine, 'processFile')
          .mockResolvedValue({ success: true } as any);

        await renameEngine.processEditorChange(editor, file, owner as any);

        expect(processFile).toHaveBeenCalledWith(file, fileReadOptions);
        expect(editor.getValue).not.toHaveBeenCalled();
      });

      // Its editor stays connected but hidden, at the text it loaded
      it('should process from the file when the owner shows the note in Reading view', async () => {
        const owner = Object.assign(new mockObsidian.MarkdownView(plugin.app), {
          file,
          editor,
        });
        vi.mocked(owner.getMode).mockReturnValue('preview');
        const processFile = vi
          .spyOn(renameEngine, 'processFile')
          .mockResolvedValue({ success: true } as any);

        await renameEngine.processEditorChange(editor, file, owner);

        expect(processFile).toHaveBeenCalledWith(file, fileReadOptions);
        expect(editor.getValue).not.toHaveBeenCalled();
      });

      it('should read the editor while the owner still shows the note in it', async () => {
        const owner = { file, editor };
        const processFile = vi.spyOn(renameEngine, 'processFile');

        await renameEngine.processEditorChange(editor, file, owner as any);

        expect(editor.getValue).toHaveBeenCalled();
        expect(processFile).not.toHaveBeenCalledWith(file, fileReadOptions);
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

      await renameEngine.processFile(file, { providedContent });

      // Should not read from vault when content is provided
      expect(plugin.app.vault.read).not.toHaveBeenCalled();
    });

    describe('reads per pass', () => {
      beforeEach(() => {
        plugin.app.vault.cachedRead = vi
          .fn()
          .mockResolvedValue('# Test Title\nContent');
      });

      it('reads the note once on an automatic pass with no text handed in', async () => {
        const result = await renameEngine.processFile(file, {
          hasActiveEditor: true,
        });

        expect(result.reason).toBe('renamed');
        expect(plugin.app.vault.read).toHaveBeenCalledTimes(1);
        expect(plugin.app.vault.cachedRead).not.toHaveBeenCalled();
      });

      it('reads nothing on a keystroke-driven pass, whose text comes from the editor', async () => {
        await renameEngine.processFile(file, {
          providedContent: '# Typed Title\nContent',
          hasActiveEditor: true,
          editor,
        });

        expect(plugin.app.vault.read).not.toHaveBeenCalled();
        expect(plugin.app.vault.cachedRead).not.toHaveBeenCalled();
        expect(plugin.app.fileManager.renameFile).toHaveBeenCalledWith(
          file,
          expect.stringMatching(/Typed Title\.md$/)
        );
      });

      it('takes the title from the text the gate approved, not a later read', async () => {
        plugin.app.vault.read = vi
          .fn()
          .mockResolvedValueOnce('# Approved Title\nContent')
          .mockResolvedValue('# Later Title\nContent');

        await renameEngine.processFile(file, { hasActiveEditor: true });

        expect(plugin.app.fileManager.renameFile).toHaveBeenCalledWith(
          file,
          expect.stringMatching(/Approved Title\.md$/)
        );
      });

      it('refuses a background pass for a note open in no editor without reading it', async () => {
        const result = await renameEngine.processFile(file);

        expect(result).toEqual({
          success: false,
          reason: 'not-open-in-editor',
        });
        expect(plugin.app.vault.read).not.toHaveBeenCalled();
        expect(plugin.app.vault.cachedRead).not.toHaveBeenCalled();
        expect(plugin.outputDebugFileContent).toHaveBeenCalledWith(
          file,
          'BLOCKED'
        );
      });

      it('refuses a pass told no editor shows the note without reading it', async () => {
        const result = await renameEngine.processFile(file, {
          hasActiveEditor: false,
        });

        expect(result.reason).toBe('not-open-in-editor');
        expect(plugin.app.vault.read).not.toHaveBeenCalled();
      });

      it('reads a note open in a Markdown leaf when no editor is vouched for', async () => {
        plugin.app.workspace.getLeavesOfType = vi.fn((type: string) =>
          type === 'markdown' ? [{ view: { file } }] : []
        );

        const result = await renameEngine.processFile(file);

        expect(result.reason).toBe('renamed');
        expect(plugin.app.vault.read).toHaveBeenCalledTimes(1);
      });

      // The read's await can close the editor, so the gate walks the leaves again after it
      it('refuses a note whose editor closed during the read as not open in an editor', async () => {
        plugin.app.workspace.getLeavesOfType = vi
          .fn()
          .mockReturnValueOnce([{ view: { file } }])
          .mockReturnValue([]);

        const result = await renameEngine.processFile(file);

        expect(result).toEqual({
          success: false,
          reason: 'not-open-in-editor',
        });
        expect(plugin.app.vault.read).toHaveBeenCalledTimes(1);
      });

      it('reads a note open in no editor on a manual command', async () => {
        const result = await renameEngine.processFile(file, {
          isManualCommand: true,
        });

        expect(result.reason).toBe('renamed');
        expect(plugin.app.vault.read).toHaveBeenCalledTimes(1);
      });
    });

    describe('disk staleness after a recent rename', () => {
      beforeEach(() => {
        plugin.fileStateManager.wasRecentlyRenamedInto = vi.fn(
          (path: string) => path === file.path
        );
      });

      it('skips a pass on disk text for a note just renamed into its path, checked with the default window', async () => {
        const result = await renameEngine.processFile(file, {
          hasActiveEditor: true,
        });

        expect(result).toEqual({ success: false, reason: 'recently-renamed' });
        expect(
          plugin.fileStateManager.wasRecentlyRenamedInto
        ).toHaveBeenCalledWith(file.path);
        expect(plugin.app.fileManager.renameFile).not.toHaveBeenCalled();
      });

      it('still renames from editor text, which cannot trail the rename', async () => {
        const result = await renameEngine.processFile(file, {
          providedContent: '# Typed Title\nContent',
          hasActiveEditor: true,
          editor,
        });

        expect(result.reason).toBe('renamed');
        expect(
          plugin.fileStateManager.wasRecentlyRenamedInto
        ).not.toHaveBeenCalled();
      });
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
      await renameEngine.processFile(noteInFolder, {
        isManualCommand: true,
        providedContent: `${firstLine}\n\nBody`,
      });

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

  // Every title comes from the title-source walk: the rename reads the same block Reading view shows first.
  describe('title source', () => {
    let noteInFolder: TFile;

    // Drives the full rename path so the assertion is the outcome and the path Obsidian is handed
    const processWith = async (content: string) => {
      const outcome = await renameEngine.processFile(noteInFolder, {
        isManualCommand: true,
        providedContent: content,
      });
      const call = (plugin.app.fileManager.renameFile as any).mock.calls[0];
      return {
        outcome,
        path: call ? (call[1] as string) : undefined,
      };
    };

    /** The cache indexes a link to the note itself on `line`, which the text no longer shows as one. */
    const cacheSelfLinkOnLine = (line: number) => {
      plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({
        links: [
          {
            link: 'Source note',
            original: '[[Source note]]',
            position: {
              start: { line, col: 0, offset: 0 },
              end: { line, col: 15, offset: 0 },
            },
          },
        ],
      });
    };

    beforeEach(() => {
      noteInFolder = createMockFile('Notes/Source note.md');
      noteInFolder.parent = createMockFolder('Notes');
      plugin.app.vault.getAbstractFileByPath = vi.fn((path: string) =>
        path === noteInFolder.path ? noteInFolder : null
      );
      plugin.app.vault.read = vi.fn().mockResolvedValue('');
    });

    it('reads a block opened by `--- ` as body, titling the note after the setext heading under the rule', async () => {
      expect((await processWith('--- \nfoo: bar\n---\nBody')).path).toBe(
        'Notes/foo bar.md'
      );
    });

    it('keeps code as typed, applying no markup stripping', async () => {
      expect((await processWith('```\n__init__ module\n```\nBody')).path).toBe(
        'Notes/__init__ module.md'
      );
    });

    it('applies title case to code', async () => {
      plugin.settings.core.titleCase = 'uppercase';

      expect((await processWith('    __init__ module')).path).toBe(
        'Notes/__INIT__ MODULE.md'
      );
    });

    it('still applies custom replacements to code', async () => {
      plugin.settings.customReplacements.rules = [
        {
          searchText: 'module',
          replaceText: 'package',
          onlyAtStart: false,
          onlyWholeLine: false,
        },
      ];

      expect((await processWith('    __init__ module')).path).toBe(
        'Notes/__init__ package.md'
      );
    });

    describe('only rename if heading', () => {
      beforeEach(() => {
        plugin.settings.core.onlyRenameIfHeading = true;
      });

      it('renames a note whose heading follows a rule', async () => {
        expect((await processWith('---\n# Title\n\nBody')).path).toBe(
          'Notes/Title.md'
        );
      });

      it('renames a note whose heading follows a comment block', async () => {
        expect((await processWith('%%\ndraft\n%%\n# Title')).path).toBe(
          'Notes/Title.md'
        );
      });

      it('refuses a fenced `# comment`, which shows code, not a heading', async () => {
        const { outcome, path } = await processWith(
          '```\n# comment\n```\nBody'
        );

        expect(outcome.reason).toBe('not-heading');
        expect(path).toBeUndefined();
      });

      it('refuses a table, whose title is no heading', async () => {
        expect(
          (await processWith('| a | b |\n|---|---|\n| 1 | 2 |')).outcome.reason
        ).toBe('not-heading');
      });

      it('renames a note whose content was deleted to Untitled', async () => {
        plugin.cacheManager.hadBody = vi.fn().mockReturnValue(true);

        expect((await processWith('')).path).toBe('Notes/Untitled.md');
      });
    });

    describe('Markdown link self-reference check', () => {
      let noteWithParentheses: TFile;

      beforeEach(() => {
        noteWithParentheses = createMockFile('Notes/Plan (draft).md');
        noteWithParentheses.parent = createMockFolder('Notes');
        plugin.app.vault.getAbstractFileByPath = vi.fn((path: string) =>
          path === noteWithParentheses.path ? noteWithParentheses : null
        );
      });

      const reasonFor = async (content: string) =>
        (
          await renameEngine.processFile(noteWithParentheses, {
            isManualCommand: true,
            providedContent: content,
          })
        ).reason;

      it('recognizes a destination holding balanced parentheses', async () => {
        expect(await reasonFor('[Link](Plan%20(draft).md) more')).toBe(
          'self-referential'
        );
      });

      it('recognizes a destination in angle brackets', async () => {
        expect(await reasonFor('[Link](<Plan (draft).md>) more')).toBe(
          'self-referential'
        );
      });

      it('recognizes a destination with a title and a fragment', async () => {
        expect(await reasonFor('[Link](<Notes/Plan (draft)#Part> "t")')).toBe(
          'self-referential'
        );
      });

      it('ignores a link inside a code span, which Reading view shows as code', async () => {
        expect(await reasonFor('`[Link](<Plan (draft).md>)` more')).toBe(
          'renamed'
        );
      });
    });

    describe('cached self-reference check', () => {
      it('refuses a note whose title line holds a cached link to itself, counting from the start of the note', async () => {
        cacheSelfLinkOnLine(3);

        expect(
          (await processWith('---\na: 1\n---\n[[Source note x')).outcome.reason
        ).toBe('self-referential');
      });

      it('ignores a cached link to itself on another line', async () => {
        cacheSelfLinkOnLine(2);

        expect(
          (await processWith('---\na: 1\n---\n[[Source note x')).outcome.reason
        ).toBe('renamed');
      });

      it('skips the text after a comment closer, which is only part of its line', async () => {
        cacheSelfLinkOnLine(2);

        expect(
          (await processWith('%%\nc\n%% [[Source note x')).outcome.reason
        ).toBe('renamed');
      });
    });
  });

  // A note just created, or replaced by sync, reaches processFile before the metadata cache indexes it; the gate has to read the property from the text.
  describe('rename-blocking property on an unindexed note', () => {
    let noteInFolder: TFile;
    // Raw YAML block -> parsed object. Blocks with no entry throw, modelling malformed YAML.
    let yamlFixtures: Map<string, unknown>;

    const BLOCKED_NOTE = '---\nno rename: true\n---\nTitle\n';

    // Mirrors the new-note path: automatic, no content handed in, a new note shown in a Markdown leaf
    const processAsNewNote = () =>
      renameEngine.processFile(noteInFolder, { hasActiveEditor: true });

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

      const result = await renameEngine.processFile(noteInFolder, {
        isManualCommand: true,
      });

      expect(result.reason).toBe('property-disabled');
      expect(plugin.app.fileManager.renameFile).not.toHaveBeenCalled();
    });
  });

  // Typing an excluded tag into the first line used to rename the note on every keystroke until Obsidian re-indexed it
  describe('a tag typed into the title line', () => {
    let note: TFile;

    const processTyped = (text: string) =>
      renameEngine.processFile(note, {
        providedContent: text,
        hasActiveEditor: true,
      });

    beforeEach(() => {
      note = createMockFile('Notes/Source note.md');
      note.parent = createMockFolder('Notes');
      plugin.app.vault.getAbstractFileByPath = vi.fn((path: string) =>
        path === note.path ? note : null
      );
      // The cache has not indexed the tag yet
      plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({});
      plugin.settings.exclusions.excludedTags = ['/^draft/'];
    });

    it('excludes the note before Obsidian indexes the tag', async () => {
      const result = await processTyped('#draft-x Title\n');

      expect(result.reason).toBe('excluded');
      expect(plugin.app.fileManager.renameFile).not.toHaveBeenCalled();
    });

    it('reads no tag from code', async () => {
      const result = await processTyped('    #draft-x Title\n');

      expect(result.reason).toBe('renamed');
    });

    // Obsidian's cache indexes no tag inside a fenced block or on an HTML comment block's closer line, so neither can exclude the note once indexed either
    it.each([
      {
        source: "a card link's title",
        text: '```cardlink\ntitle: "#draft-x Plan"\n```\n',
      },
      {
        source: 'the text after an HTML comment block',
        text: '<!--\nc\n--> #draft x\n',
      },
    ])('reads no tag from $source', async ({ text }) => {
      const result = await processTyped(text);

      expect(result.reason).toBe('renamed');
    });

    it.each([
      { source: 'the text after a `%%` comment', text: '%%\nc\n%% #draft x\n' },
      { source: 'a body first line', text: 'Plan #draft x\n' },
    ])('excludes the note for a tag in $source', async ({ text }) => {
      const result = await processTyped(text);

      expect(result.reason).toBe('excluded');
      expect(plugin.app.fileManager.renameFile).not.toHaveBeenCalled();
    });
  });

  // Properties edited in Reading view reach the view's text but not its hidden editor, which manual commands are handed as `workspace.activeEditor.editor` (measured, Obsidian 1.14.4)
  describe('a Reading view whose editor is stale', () => {
    let note: TFile;
    let readingView: InstanceType<typeof mockObsidian.MarkdownView>;

    beforeEach(() => {
      const yamlFixtures = new Map<string, unknown>([
        ['x: 1\n', { x: 1 }],
        ['x: 1\nok: wow\n', { x: 1, ok: 'wow' }],
      ]);
      vi.mocked(getFrontMatterInfo).mockImplementation(
        splitFrontMatter as unknown as typeof getFrontMatterInfo
      );
      vi.mocked(parseYaml).mockImplementation(((yaml: string) =>
        yamlFixtures.get(yaml)) as typeof parseYaml);

      note = createMockFile('Notes/Title.md');
      note.parent = createMockFolder('Notes');
      plugin.app.vault.getAbstractFileByPath = vi.fn((path: string) =>
        path === note.path ? note : null
      );
      plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue({});
      plugin.settings.exclusions.excludedProperties = [
        { key: 'ok', value: 'wow' },
      ];
      readingView = Object.assign(new mockObsidian.MarkdownView(plugin.app), {
        file: note,
      });
      vi.mocked(readingView.getMode).mockReturnValue('preview');
      vi.mocked(readingView.editor.getValue).mockReturnValue(
        '---\nx: 1\n---\nTitle\n'
      );
      vi.mocked(readingView.getViewData).mockReturnValue(
        '---\nx: 1\nok: wow\n---\nTitle\n'
      );
      plugin.app.workspace.getLeavesOfType = vi.fn((type: string) =>
        type === 'markdown' ? [{ view: readingView }] : []
      );
      plugin.app.workspace.getActiveViewOfType = vi
        .fn()
        .mockReturnValue(readingView);
    });

    afterEach(() => {
      vi.mocked(getFrontMatterInfo).mockReset();
      vi.mocked(parseYaml).mockReset();
    });

    it("excludes the note when the command passes the view's editor", async () => {
      const result = await renameEngine.processFile(note, {
        isManualCommand: true,
        editor: readingView.editor,
      });

      expect(result.reason).toBe('excluded');
      expect(plugin.app.fileManager.renameFile).not.toHaveBeenCalled();
    });

    it('excludes the note when the command passes no editor', async () => {
      const result = await renameEngine.processFile(note, {
        isManualCommand: true,
      });

      expect(result.reason).toBe('excluded');
      expect(plugin.app.fileManager.renameFile).not.toHaveBeenCalled();
    });
  });

  // The manual "unless excluded" command passes no overrides, so a refused note has to say which rule stopped it
  describe('refusal notice', () => {
    let noticeMessages: string[];
    let note: TFile;
    let frontmatter: Record<string, unknown>;

    const runManually = (exclusionOverrides?: ExclusionOverrides) =>
      renameEngine.processFile(note, {
        isManualCommand: true,
        exclusionOverrides,
      });

    // Each note matches every rule its case lists; the notice names the first that applies
    const precedenceCases = [
      {
        rule: 'the rename-blocking property ahead of every exclusion list',
        excludedFiles: ['Notes/'],
        noteFrontmatter: {
          'no rename': true,
          tags: ['probe'],
          status: 'draft',
        },
        reason: 'property-disabled',
        en: '“Source note” not renamed due to property that disables renaming',
        ru: 'Заметка "Source note" не переименована из-за свойства, отключающего переименование',
      },
      {
        rule: 'the path rule ahead of the tag and property rules',
        excludedFiles: ['Notes/'],
        noteFrontmatter: { tags: ['probe'], status: 'draft' },
        reason: 'excluded',
        en: '“Source note” not renamed due to excluded file path',
        ru: 'Заметка "Source note" не переименована из-за исключенного пути к файлу',
      },
      {
        rule: 'the tag rule ahead of the property rule',
        excludedFiles: [],
        noteFrontmatter: { tags: ['probe'], status: 'draft' },
        reason: 'excluded',
        en: '“Source note” not renamed due to excluded tag',
        ru: 'Заметка "Source note" не переименована из-за исключенного тега',
      },
      {
        rule: 'the property rule',
        excludedFiles: [],
        noteFrontmatter: { status: 'draft' },
        reason: 'excluded',
        en: '“Source note” not renamed due to excluded property',
        ru: 'Заметка "Source note" не переименована из-за исключенного свойства',
      },
    ];

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
      // The text has no properties, so every rule reads them from the cache
      plugin.app.vault.read = vi.fn().mockResolvedValue('Title\n');
      frontmatter = {};
      plugin.app.metadataCache.getFileCache = vi.fn(() => ({ frontmatter }));
      plugin.settings.exclusions.excludedFiles = ['Notes/'];
      plugin.settings.exclusions.excludedTags = ['probe'];
      plugin.settings.exclusions.excludedProperties = [
        { key: 'status', value: 'draft' },
      ];
    });

    afterEach(() => {
      vi.mocked(mockObsidian.Notice).mockRestore();
    });

    it.each(precedenceCases)(
      'names $rule',
      async ({ excludedFiles, noteFrontmatter, reason, en }) => {
        plugin.settings.exclusions.excludedFiles = excludedFiles;
        frontmatter = noteFrontmatter;

        const result = await runManually();

        expect(result.reason).toBe(reason);
        expect(noticeMessages).toEqual([en]);
      }
    );

    describe('in Russian', () => {
      beforeEach(() => {
        vi.mocked(mockObsidian.getLanguage).mockReturnValue('ru');
        initI18n();
      });

      afterEach(() => {
        vi.mocked(mockObsidian.getLanguage).mockReturnValue('en');
        initI18n();
      });

      it.each(precedenceCases)(
        'names $rule',
        async ({ excludedFiles, noteFrontmatter, ru }) => {
          plugin.settings.exclusions.excludedFiles = excludedFiles;
          frontmatter = noteFrontmatter;

          await runManually();

          expect(noticeMessages).toEqual([ru]);
        }
      );
    });

    it('names the property rule once the note loses its excluded tag', async () => {
      plugin.settings.exclusions.excludedFiles = [];
      frontmatter = { tags: ['probe'], status: 'draft' };
      await runManually();
      frontmatter = { status: 'draft' };
      await runManually();

      expect(noticeMessages).toEqual([
        '“Source note” not renamed due to excluded tag',
        '“Source note” not renamed due to excluded property',
      ]);
    });

    it('names the first list the command does not skip', async () => {
      frontmatter = { tags: ['probe'], status: 'draft' };

      await runManually({ ignoreExcludedFiles: true });
      await runManually({
        ignoreExcludedFiles: true,
        ignoreExcludedTags: true,
      });

      expect(noticeMessages).toEqual([
        '“Source note” not renamed due to excluded tag',
        '“Source note” not renamed due to excluded property',
      ]);
    });

    it('names no exclusion for the command that skips every list', async () => {
      frontmatter = { tags: ['probe'], status: 'draft' };

      const result = await runManually(IGNORE_ALL_EXCLUSIONS);

      expect(result.reason).toBe('renamed');
      expect(
        noticeMessages.filter((message) => message.includes('not renamed'))
      ).toEqual([]);
    });

    it('names the rename-blocking property for the command that skips every list', async () => {
      frontmatter = { 'no rename': true };

      const result = await runManually(IGNORE_ALL_EXCLUSIONS);

      expect(result.reason).toBe('property-disabled');
      expect(noticeMessages).toEqual([
        '“Source note” not renamed due to property that disables renaming',
      ]);
    });

    it('stays silent for automatic renames and batch runs', async () => {
      // hasActiveEditor, since the always-on safeguard stops an automatic rename with no editor before any exclusion rule
      const automatic = await renameEngine.processFile(note, {
        hasActiveEditor: true,
      });
      const batch = await renameEngine.processFile(note, {
        isManualCommand: true,
        isBatchOperation: true,
      });
      frontmatter = { 'no rename': true };
      const blockedBatch = await renameEngine.processFile(note, {
        isManualCommand: true,
        isBatchOperation: true,
      });

      expect([automatic.reason, batch.reason, blockedBatch.reason]).toEqual([
        'excluded',
        'excluded',
        'property-disabled',
      ]);
      expect(noticeMessages).toEqual([]);
    });
  });

  // A manual command reports its result as the notification mode setting allows
  describe('manual rename notice', () => {
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
      plugin.app.metadataCache.getFileCache = vi.fn().mockReturnValue(null);
    });

    afterEach(() => {
      vi.mocked(mockObsidian.Notice).mockRestore();
    });

    const renameManually = (firstLine: string) =>
      renameEngine.processFile(note, {
        isManualCommand: true,
        providedContent: `${firstLine}\n\nBody`,
      });

    describe('Always', () => {
      beforeEach(() => {
        plugin.settings.core.manualNotificationMode = 'Always';
      });

      it('reports a rename', async () => {
        const result = await renameManually('New title');

        expect(result.reason).toBe('renamed');
        expect(noticeMessages).toHaveLength(1);
        expect(noticeMessages[0]).toContain('New title');
      });

      it('reports a name that was already right', async () => {
        const result = await renameManually('Source note');

        expect(result.reason).toBe('no-rename-needed');
        expect(noticeMessages).toHaveLength(1);
        expect(noticeMessages[0]).toContain('Source note');
      });

      it('stays silent in a bulk run, which reports on its own', async () => {
        await renameEngine.processFile(note, {
          isManualCommand: true,
          providedContent: 'New title\n\nBody',
          isBatchOperation: true,
        });

        expect(noticeMessages).toEqual([]);
      });
    });

    describe('On title change', () => {
      beforeEach(() => {
        plugin.settings.core.manualNotificationMode = 'On title change';
      });

      it('reports a rename', async () => {
        await renameManually('New title');

        expect(noticeMessages).toHaveLength(1);
        expect(noticeMessages[0]).toContain('New title');
      });

      it('stays silent when the name was already right', async () => {
        const result = await renameManually('Source note');

        expect(result.reason).toBe('no-rename-needed');
        expect(noticeMessages).toEqual([]);
      });

      it('names the counter a name conflict added', async () => {
        const taken = createMockFile('Notes/New title.md');
        plugin.app.vault.getAbstractFileByPath = vi.fn((path: string) =>
          path === note.path ? note : path === taken.path ? taken : null
        );

        await renameManually('New title');

        expect(noticeMessages).toHaveLength(1);
        expect(noticeMessages[0]).toContain('New title 1');
      });
    });

    describe('Never', () => {
      beforeEach(() => {
        plugin.settings.core.manualNotificationMode = 'Never';
      });

      it('stays silent after a rename', async () => {
        const result = await renameManually('New title');

        expect(result.reason).toBe('renamed');
        expect(noticeMessages).toEqual([]);
      });
    });
  });

  describe('destination conflicts', () => {
    const SAME_TITLE = 'Same title\n\nBody';

    const serveContent = (content: string) => {
      plugin.app.vault.read = vi.fn().mockResolvedValue(content);
      plugin.app.vault.cachedRead = vi.fn().mockResolvedValue(content);
    };

    /**
     * Vault stub backed by a live index that only learns about a rename once
     * renameFile resolves — the window the reservation set exists to cover.
     * Keyed by exact path, as Obsidian's getAbstractFileByPath is case-exact,
     * with every fixture in one folder whose children the case clash scan reads.
     * Renaming onto an occupied path rejects, as Obsidian's own does.
     */
    const installLiveVault = (files: TFile[], folderPath = '/') => {
      const index = new Map<string, TFile>();
      const folder = createMockFolder(folderPath);
      for (const file of files) {
        file.parent = folder;
        folder.children.push(file);
        index.set(file.path, file);
      }

      // Path, name and basename move together, as on Obsidian's own TFile
      const moveInIndex = (file: TFile, newPath: string) => {
        index.delete(file.path);
        file.path = newPath;
        file.name = newPath.split('/').pop() ?? newPath;
        file.basename = file.name.replace(/\.md$/, '');
        index.set(newPath, file);
      };

      plugin.app.vault.getAbstractFileByPath = vi.fn(
        (path: string) => index.get(path) ?? null
      );
      plugin.app.vault.getAllLoadedFiles = vi.fn(() => [...index.values()]);
      serveContent(SAME_TITLE);
      plugin.app.fileManager.renameFile = vi.fn(
        async (file: TFile, newPath: string) => {
          await Promise.resolve();
          if (index.has(newPath)) {
            throw new Error(`File already exists: ${newPath}`);
          }
          moveInIndex(file, newPath);
        }
      );
      // The vault `rename` event never fires in the suite, so the stub moves the note itself
      plugin.app.vault.rename = vi.fn(async (file: TFile, newPath: string) => {
        await Promise.resolve();
        if (index.has(newPath)) {
          throw new Error('Destination file already exists!');
        }
        moveInIndex(file, newPath);
      });

      return index;
    };

    // Mirrors the bulk modals: manual command, batch operation, content off disk
    const renameInBatch = (file: TFile) =>
      renameEngine.processFile(file, {
        isManualCommand: true,
        isBatchOperation: true,
      });

    beforeEach(() => {
      // Reservations have to be real here: the vi.fn() stubs make every reserved
      // path look free, which is precisely the defect this block guards. Locks
      // still resolve through the mocked fileStateManager.
      plugin.cacheManager = new CacheManager();
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
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const result = await renameInBatch(note);

      expect(result.success).toBe(false);
      expect(plugin.cacheManager.isPathReserved('Same title.md')).toBe(false);
      consoleErrorSpy.mockRestore();
    });

    it('still counter-suffixes around notes renamed sequentially', async () => {
      const first = createMockFile('First.md');
      const second = createMockFile('Second.md');
      const index = installLiveVault([first, second]);

      expect((await renameInBatch(first)).success).toBe(true);
      expect((await renameInBatch(second)).success).toBe(true);

      expect([...index.keys()].sort()).toEqual([
        'Same title 1.md',
        'Same title.md',
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
        'Same title 1.md',
        'Same title.md',
      ]);
    });

    // One record behind both guards, which read it with their own windows; the vacated path takes none, so a new note created there is not taken for a stale create
    it('marks only the path the rename moved the note into as recently renamed', async () => {
      const note = createMockFile('A.md');
      installLiveVault([note]);
      serveContent('B\n\nBody');
      await renameInBatch(note);

      expect(
        plugin.fileStateManager.markRecentlyRenamedInto.mock.calls
      ).toEqual([['B.md']]);
    });

    // The case clash scan reads the note's siblings and never counts the note itself
    describe('case conflicts', () => {
      it('renames a note whose first line differs from its name only by case', async () => {
        const note = createMockFile('foo.md');
        installLiveVault([note]);
        serveContent('Foo\n\nBody');

        const result = await renameInBatch(note);

        expect(result.reason).toBe('renamed');
        expect(plugin.app.fileManager.renameFile).toHaveBeenCalledWith(
          note,
          'Foo.md'
        );
      });

      it('takes a case-only rename to its own counter name beside the plain title', async () => {
        const note = createMockFile('foo 1.md');
        installLiveVault([note, createMockFile('Foo.md')]);
        serveContent('Foo\n\nBody');

        await renameInBatch(note);

        expect(plugin.app.fileManager.renameFile).toHaveBeenCalledWith(
          note,
          'Foo 1.md'
        );
      });

      it('counter-suffixes around a sibling that differs from the title only by case', async () => {
        const note = createMockFile('bar.md');
        installLiveVault([note, createMockFile('foo.md')]);
        serveContent('Foo\n\nBody');

        await renameInBatch(note);

        expect(plugin.app.fileManager.renameFile).toHaveBeenCalledWith(
          note,
          'Foo 1.md'
        );
        expect(plugin.app.vault.getAllLoadedFiles).not.toHaveBeenCalled();
      });

      it('counter-suffixes around a case clash inside a folder', async () => {
        const note = createMockFile('Notes/bar.md');
        installLiveVault([note, createMockFile('Notes/foo.md')], 'Notes');
        serveContent('Foo\n\nBody');

        await renameInBatch(note);

        expect(plugin.app.fileManager.renameFile).toHaveBeenCalledWith(
          note,
          'Notes/Foo 1.md'
        );
      });

      it('ignores a case variant in another folder', async () => {
        const note = createMockFile('Notes/bar.md');
        const index = installLiveVault([note], 'Notes');
        const elsewhere = createMockFile('foo.md');
        elsewhere.parent = createMockFolder('/');
        index.set(elsewhere.path, elsewhere);
        serveContent('Foo\n\nBody');

        await renameInBatch(note);

        expect(plugin.app.fileManager.renameFile).toHaveBeenCalledWith(
          note,
          'Notes/Foo.md'
        );
      });

      it('leaves a note already holding its counter name in place', async () => {
        const note = createMockFile('Foo 1.md');
        installLiveVault([note, createMockFile('Foo.md')]);
        serveContent('Foo\n\nBody');

        const result = await renameInBatch(note);

        expect(result.reason).toBe('no-rename-needed');
        expect(plugin.app.fileManager.renameFile).not.toHaveBeenCalled();
      });

      // A previous pass's rename reserved the note's own path through notifyFileRenamed
      it('lets a note take a case-only rename onto the path it reserved itself', async () => {
        const note = createMockFile('foo.md');
        installLiveVault([note]);
        plugin.cacheManager.reservePath('foo.md');
        serveContent('Foo\n\nBody');

        await renameInBatch(note);

        expect(plugin.app.fileManager.renameFile).toHaveBeenCalledWith(
          note,
          'Foo.md'
        );
      });

      describe('when the direct rename rejects a case-only target', () => {
        let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
          consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        });

        afterEach(() => {
          consoleErrorSpy.mockRestore();
        });

        // Obsidian's mobile adapter rejects it on Android, whose storage folds case
        const installRejectingCaseOnlyVault = () => {
          const note = createMockFile('foo.md');
          installLiveVault([note]);
          serveContent('Foo\n\nBody');
          plugin.app.fileManager.renameFile = vi
            .fn()
            .mockRejectedValue(new Error('Destination file already exists!'));
          return note;
        };

        it('renames through a temporary name in two steps', async () => {
          const note = installRejectingCaseOnlyVault();

          const result = await renameInBatch(note);

          expect(plugin.app.vault.rename).toHaveBeenCalledTimes(2);
          expect(note.path).toBe('Foo.md');
          expect(result.reason).toBe('renamed');
          expect(consoleErrorSpy).not.toHaveBeenCalled();
        });

        it('restores the name when the second step fails', async () => {
          const note = installRejectingCaseOnlyVault();
          const liveRename = plugin.app.vault.rename;
          let step = 0;
          plugin.app.vault.rename = vi.fn((file: TFile, newPath: string) => {
            step += 1;
            return step === 2
              ? Promise.reject(new Error('second step failed'))
              : liveRename(file, newPath);
          });

          const result = await renameInBatch(note);

          expect(note.path).toBe('foo.md');
          expect(result.reason).toBe('error');
          expect(plugin.cacheManager.isPathReserved('Foo.md')).toBe(false);
        });
      });
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
  });
  // The consolidated first line property step in processFile matches on the outcome's `reason`. The
  // successful-rename outcome once carried no reason at all, so the gate skipped exactly
  // the case that renames a file, and only the manual commands noticed — the editor-change
  // handlers call updateFirstLinePropertyIfNeeded themselves.
  describe('processFile first line property gate', () => {
    beforeEach(() => {
      plugin.settings.firstLineProperty.propertyKey = 'aliases';
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
    });

    function stubOutcome(outcome: { success: boolean; reason: string }) {
      return vi
        .spyOn(renameEngine as any, 'processFileInternal')
        .mockResolvedValue(outcome);
    }

    it('should update the first line property after a successful rename', async () => {
      stubOutcome({ success: true, reason: 'renamed' });

      await renameEngine.processFile(file);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).toHaveBeenCalledTimes(1);
    });

    it('should update the first line property when no rename was needed', async () => {
      stubOutcome({ success: true, reason: 'no-rename-needed' });

      await renameEngine.processFile(file);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).toHaveBeenCalledTimes(1);
    });

    it('should update the first line property when empty content was retained', async () => {
      stubOutcome({ success: false, reason: 'empty-content-retained' });

      await renameEngine.processFile(file);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).toHaveBeenCalledTimes(1);
    });

    it('should not update the first line property when the file was excluded', async () => {
      stubOutcome({ success: false, reason: 'excluded' });

      await renameEngine.processFile(file);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).not.toHaveBeenCalled();
    });

    // "Put first line in title" ignores exclusions for the property as it does for the rename
    it('should pass the caller exclusion overrides on to the first line property update', async () => {
      stubOutcome({ success: true, reason: 'renamed' });
      const overrides = {
        ignoreExcludedFiles: true,
        ignoreExcludedTags: true,
        ignoreExcludedProperties: true,
      };

      await renameEngine.processFile(file, {
        isManualCommand: true,
        exclusionOverrides: overrides,
      });

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).toHaveBeenCalledWith(file, undefined, null, overrides);
    });

    it('should not update the first line property when the property name is blank', async () => {
      plugin.settings.firstLineProperty.propertyKey = '';
      stubOutcome({ success: true, reason: 'renamed' });

      await renameEngine.processFile(file);

      expect(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      ).not.toHaveBeenCalled();
    });
  });

  // The first line property goes into the editor the user is typing in; an edit through a Reading view's editor never reaches the file.
  describe('first line property target', () => {
    let markdownLeaves: { view: unknown }[];

    beforeEach(() => {
      plugin.settings.firstLineProperty.propertyKey = 'aliases';
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
      vi.spyOn(renameEngine as any, 'processFileInternal').mockResolvedValue({
        success: true,
        reason: 'renamed',
      });
      markdownLeaves = [];
      plugin.app.workspace.getLeavesOfType = vi.fn((type: string) =>
        type === 'markdown' ? markdownLeaves : []
      );
    });

    /** A tab showing the note in `mode`, listed among the Markdown leaves */
    const openTab = (mode: 'source' | 'preview') => {
      const view = Object.assign(new mockObsidian.MarkdownView(plugin.app), {
        file,
        getMode: () => mode,
        dirty: false,
        requestSave: vi.fn(),
      });
      markdownLeaves.push({ view });
      return view;
    };

    /** The target the first line property update is handed after a rename read from `editorReadFrom` */
    const targetAfterRename = async (editorReadFrom?: Editor) => {
      await renameEngine.processFile(file, {
        hasActiveEditor: true,
        editor: editorReadFrom,
      });
      const update = vi.mocked(
        plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded
      );
      expect(update).toHaveBeenCalledTimes(1);
      return update.mock.calls[0][2];
    };

    it('uses the tab showing the note when the rename was read from no editor', async () => {
      const tab = openTab('source');

      const target = await targetAfterRename();

      expect(target.editor).toBe(tab.editor);
      expect(target.requestSave).toBeDefined();
    });

    it("keeps the tab's own target when the rename was read from that tab's editor", async () => {
      const tab = openTab('source');

      const target = await targetAfterRename(tab.editor);

      expect(target.editor).toBe(tab.editor);
      expect(target.requestSave).toBeDefined();
    });

    it("falls back to the tab in Source view when the rename was read from a Reading view's editor", async () => {
      const readingTab = openTab('preview');
      const sourceTab = openTab('source');

      const target = await targetAfterRename(readingTab.editor);

      expect(target.editor).toBe(sourceTab.editor);
    });

    it("writes the file when the rename was read from a Reading view's editor and no editor shows the note", async () => {
      const readingTab = openTab('preview');

      expect(await targetAfterRename(readingTab.editor)).toBeNull();
    });

    // A Canvas card's or page preview's editor sits in no Markdown leaf, and the user is typing there rather than in the tab
    it('uses the editor the rename was read from when no leaf owns it', async () => {
      openTab('source');
      const cardEditor = new Editor();

      const target = await targetAfterRename(cardEditor);

      expect(target.editor).toBe(cardEditor);
      expect(target.isDirty()).toBe(false);
      expect(target.requestSave).toBeUndefined();
    });
  });

  // Keystrokes that land while processFile holds the lock only set the pending flag. A page preview or Canvas card is never the active MarkdownView, so a recheck gated on that left the name a few characters short of the first line.
  describe('processFile pending recheck', () => {
    let processEditorChange: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers();
      plugin.app.vault.getAbstractFileByPath = vi.fn().mockReturnValue(file);
      plugin.fileStateManager.hasPendingFirstLinePropertyRecheck = vi
        .fn()
        .mockReturnValue(true);
      plugin.fileStateManager.clearPendingFirstLinePropertyRecheck = vi.fn();
      vi.spyOn(renameEngine as any, 'processFileInternal').mockResolvedValue({
        success: false,
        reason: 'excluded',
      });
      processEditorChange = vi
        .spyOn(renameEngine, 'processEditorChange')
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

      expect(
        plugin.fileStateManager.clearPendingFirstLinePropertyRecheck
      ).toHaveBeenCalledWith(file.path);
      expect(processEditorChange).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(TIMING.UI_SETTLE_DELAY_MS);

      expect(processEditorChange).toHaveBeenCalledTimes(1);
      expect(processEditorChange).toHaveBeenCalledWith(embedEditor, file);
    });

    it('should recheck through the active tab when it edits the note', async () => {
      const view = Object.assign(new mockObsidian.MarkdownView(plugin.app), {
        file,
        getMode: () => 'source',
      });
      plugin.app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(view);

      await renameEngine.processFile(file);
      await vi.advanceTimersByTimeAsync(TIMING.UI_SETTLE_DELAY_MS);

      expect(
        plugin.fileStateManager.clearPendingFirstLinePropertyRecheck
      ).toHaveBeenCalledWith(file.path);
      expect(processEditorChange).toHaveBeenCalledTimes(1);
      expect(processEditorChange).toHaveBeenCalledWith(view.editor, file);
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

      expect(
        plugin.fileStateManager.clearPendingFirstLinePropertyRecheck
      ).toHaveBeenCalledWith(file.path);
      expect(vi.getTimerCount()).toBe(0);
      expect(processEditorChange).not.toHaveBeenCalled();
    });

    it('should leave the flag set and schedule nothing when no editor shows the note', async () => {
      await renameEngine.processFile(file);

      expect(vi.getTimerCount()).toBe(0);
      expect(
        plugin.fileStateManager.clearPendingFirstLinePropertyRecheck
      ).not.toHaveBeenCalled();
      expect(processEditorChange).not.toHaveBeenCalled();
    });
  });
});
