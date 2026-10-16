import { describe, it, expect, vi, beforeEach, MockedFunction } from 'vitest';
// Type-only, so it resolves to the real Obsidian types under tsc while the runtime import below stays mocked
import type { App as ObsidianApp, CachedMetadata } from 'obsidian';
import { App, MarkdownView, TFile } from '../mockObsidian';
import {
  createMockFile,
  createMockFolder,
  createTestSettings,
} from '../testUtils';
import { DEFAULT_SETTINGS } from '../../src/constants';
import { TIMING } from '../../src/constants/timing';
import { verboseLog } from '../../src/utils';
// The gate the rename path calls to decide renaming
import { shouldProcessFile } from '../../src/utils/file-exclusions';
import type FirstLineIsTitle from '../../main';
import type { FileOperations } from '../../src/operations/file-operations';
import type {
  DeepPartial,
  ExclusionStrategy,
  PluginSettings,
} from '../../src/types';

// Only verboseLog is stubbed, to keep decision-path logging out of the test output.
vi.mock('../../src/utils', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/utils')>('../../src/utils');
  return { ...actual, verboseLog: vi.fn() };
});

type ExclusionGate = FileOperations['isFileExcludedForCursorPositioning'];
type ViewResolver = FileOperations['resolveMarkdownViewForFile'];

/** The slice of the plugin the coordinator actually reads. */
interface CoordinatorPluginStub {
  app: App;
  settings: PluginSettings;
  fileOperations: Pick<
    FileOperations,
    'isFileExcludedForCursorPositioning' | 'resolveMarkdownViewForFile'
  >;
}

describe('FileCreationCoordinator', () => {
  let mockPlugin: CoordinatorPluginStub;
  let mockApp: App;
  let mockExclusionGate: MockedFunction<ExclusionGate>;
  let mockResolveView: MockedFunction<ViewResolver>;
  let file: TFile;

  // The stub is structurally narrower than the plugin, so the cast lives here rather than in every test
  async function determineActions(initialContent: string) {
    const { FileCreationCoordinator } =
      await import('../../src/core/file-creation-coordinator');
    const coordinator = new FileCreationCoordinator(
      mockPlugin as unknown as FirstLineIsTitle
    );
    return coordinator.determineActions(file, {
      initialContent,
      pluginLoadTime: Date.now(),
    });
  }

  /** Swap the stubbed gate for the real one, so exclusion rules are evaluated instead of asserted. */
  async function useRealExclusionGate() {
    const { FileOperations } =
      await import('../../src/operations/file-operations');
    mockPlugin.fileOperations = new FileOperations(
      mockPlugin as unknown as FirstLineIsTitle
    );
  }

  /** Both features on, plus the exclusion rules under test. */
  function applyExclusions(
    exclusions: DeepPartial<PluginSettings>['exclusions']
  ) {
    mockPlugin.settings = createTestSettings({
      core: { insertTitle: true, moveCursorToFirstLine: true },
      exclusions,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockApp = new App();
    file = createMockFile('test.md');
    mockExclusionGate = vi.fn().mockReturnValue(false);
    // No view by default, so the walk after templater-event:Y judges the creation snapshot
    mockResolveView = vi.fn<ViewResolver>().mockReturnValue(null);

    mockPlugin = {
      app: mockApp,
      settings: createTestSettings({
        core: {
          ...structuredClone(DEFAULT_SETTINGS.core),
          insertTitle: true,
          moveCursorToFirstLine: true,
        },
      }),
      fileOperations: {
        isFileExcludedForCursorPositioning: mockExclusionGate,
        resolveMarkdownViewForFile: mockResolveView,
      },
    };
  });

  /** Installs Templater with its trigger on and a folder template for `notes/`, plus `settings`, with the note Templater's active file in an editor */
  function installMatchingTemplater(settings: Record<string, unknown> = {}) {
    file = createMockFile('notes/test.md');
    file.parent = createMockFolder('notes');
    mockApp.plugins.plugins['templater-obsidian'] = {
      settings: {
        trigger_on_file_creation_mode: 'folder',
        templates_folder: 'Templates',
        folder_templates: [{ folder: 'notes', template: 'Templates/note.md' }],
        ...settings,
      },
    };
    // The trigger lives in device-local storage, never in Templater's synced settings
    mockApp.loadLocalStorage = vi.fn().mockReturnValue({
      trigger_on_file_creation: true,
    });
    makeNoteTemplaterActiveFile();
  }

  /** Makes the note Templater's active file in a Markdown view, Templater's editor-branch condition */
  function makeNoteTemplaterActiveFile() {
    // So the walk after the event reads the view (template-wrote-file:N); the file-write tests unset it
    mockApp.workspace.activeEditor = {
      file,
      editor: {},
    } as unknown as typeof mockApp.workspace.activeEditor;
    mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(file);
    mockApp.workspace.getActiveViewOfType = vi
      .fn()
      .mockReturnValue(new MarkdownView(mockApp));
  }

  /** Makes Obsidian's parser resolve `metadata` for the judged text, standing in for what it returns for the template under test */
  function parseTemplateAs(metadata: CachedMetadata | undefined) {
    vi.mocked(mockApp.metadataCache.computeMetadataAsync).mockResolvedValue(
      metadata
    );
  }

  /** The text the coordinator handed Obsidian's parser */
  function parsedText(): string {
    const [buffer] = vi.mocked(mockApp.metadataCache.computeMetadataAsync).mock
      .calls[0];
    return new TextDecoder().decode(buffer);
  }

  /**
   * Delivers Templater's new-note event once the coordinator listens, after which the note's view shows `noteText`.
   * @param templateOutput - The parsed template the event carries
   * @param noteText - What the note's view holds after the event, or null for no view showing the note
   * @returns The listener registration, to assert on
   */
  function fireTemplaterEvent(templateOutput: string, noteText: string | null) {
    const listen = vi.fn(
      (
        _name: string,
        callback: (data: { file: TFile; content: string }) => void
      ) => {
        // Deferred rather than fired inline: the coordinator's own `eventRef` is still in its temporal dead zone while `on` is running
        window.setTimeout(() => {
          // Only the text is read, so a stand-in carrying it is cast to the view type
          mockResolveView.mockReturnValue(
            noteText === null
              ? null
              : ({
                  getViewData: () => noteText,
                } as unknown as ReturnType<ViewResolver>)
          );
          callback({ file, content: templateOutput });
        }, 0);
        return {};
      }
    );
    // Cast because the mock exposes Obsidian's overloaded `on`, which no single implementation signature satisfies
    mockApp.workspace.on = listen as unknown as typeof mockApp.workspace.on;
    return listen;
  }

  /** Registers a listener that never fires, so a test can assert the walk never waited */
  function listenWithoutEvent() {
    const listen = vi.fn(() => ({}));
    mockApp.workspace.on = listen as unknown as typeof mockApp.workspace.on;
    return listen;
  }

  it('inserts title and moves cursor when both features enabled, no exclusions, empty content (regression baseline)', async () => {
    const result = await determineActions('');

    expect(result.shouldInsertTitle).toBe(true);
    expect(result.shouldMoveCursor).toBe(true);
    expect(result.placeCursorAtEnd).toBe(true);
    // Sole breadcrumb assertion in the suite, kept as a smoke check that the tree still walks the expected nodes
    expect(result.decisionPath).toBe(
      'feature-enabled:Y → path-excluded:N → content-excluded:N → templater-enabled:N → features:both → cursor-at-end:Y → content-below-yaml:N'
    );
  });

  it('does nothing when content-excluded (tag/property/disable-renaming)', async () => {
    mockExclusionGate.mockReturnValue(true);

    const initialContent = '---\ntags: excluded\n---\n';
    const result = await determineActions(initialContent);

    expect(result.shouldMoveCursor).toBe(false);
    expect(result.shouldInsertTitle).toBe(false);
    expect(result.placeCursorAtEnd).toBe(false);
    expect(mockExclusionGate).toHaveBeenCalledWith(file, initialContent, {
      ignoreExcludedFiles: true,
    });
  });

  it('does nothing for a new note that cannot match a tag whitelist', async () => {
    await useRealExclusionGate();
    applyExclusions({
      excludedTags: ['keep'],
      tagScopeStrategy: 'Exclude all except...',
    });

    const result = await determineActions('');

    expect(result.shouldInsertTitle).toBe(false);
    expect(result.shouldMoveCursor).toBe(false);
    expect(result.placeCursorAtEnd).toBe(false);
  });

  it('inserts the title for a new note that carries no blacklisted tag', async () => {
    await useRealExclusionGate();
    applyExclusions({
      excludedTags: ['skip'],
      tagScopeStrategy: 'Only exclude...',
    });

    const result = await determineActions('');

    expect(result.shouldInsertTitle).toBe(true);
    expect(result.shouldMoveCursor).toBe(true);
  });

  it('does nothing for a new note that cannot match a property whitelist', async () => {
    await useRealExclusionGate();
    applyExclusions({
      excludedProperties: [{ key: 'status', value: 'draft' }],
      propertyScopeStrategy: 'Exclude all except...',
    });

    const result = await determineActions('');

    expect(result.shouldInsertTitle).toBe(false);
    expect(result.shouldMoveCursor).toBe(false);
    expect(result.placeCursorAtEnd).toBe(false);
  });

  it('inserts the title for a new note that carries no blacklisted property', async () => {
    await useRealExclusionGate();
    applyExclusions({
      excludedProperties: [{ key: 'status', value: 'draft' }],
      propertyScopeStrategy: 'Only exclude...',
    });

    const result = await determineActions('');

    expect(result.shouldInsertTitle).toBe(true);
    expect(result.shouldMoveCursor).toBe(true);
  });

  it('acts exactly when the rename path would rename, for every tag and property exclusion shape', async () => {
    await useRealExclusionGate();

    const noMetadata = { frontmatter: {}, tags: [] };
    const taggedNote = { frontmatter: { tags: ['keep'] }, tags: [] };
    const draftNote = { frontmatter: { status: 'draft' }, tags: [] };

    const cases: {
      name: string;
      exclusions: DeepPartial<PluginSettings>['exclusions'];
      cache: unknown;
    }[] = [
      {
        name: 'tag blacklist, untagged note',
        exclusions: {
          excludedTags: ['keep'],
          tagScopeStrategy: 'Only exclude...',
        },
        cache: noMetadata,
      },
      {
        name: 'tag blacklist, tagged note',
        exclusions: {
          excludedTags: ['keep'],
          tagScopeStrategy: 'Only exclude...',
        },
        cache: taggedNote,
      },
      {
        name: 'tag whitelist, untagged note',
        exclusions: {
          excludedTags: ['keep'],
          tagScopeStrategy: 'Exclude all except...',
        },
        cache: noMetadata,
      },
      {
        name: 'tag whitelist, tagged note',
        exclusions: {
          excludedTags: ['keep'],
          tagScopeStrategy: 'Exclude all except...',
        },
        cache: taggedNote,
      },
      {
        name: 'property blacklist, bare note',
        exclusions: {
          excludedProperties: [{ key: 'status', value: 'draft' }],
          propertyScopeStrategy: 'Only exclude...',
        },
        cache: noMetadata,
      },
      {
        name: 'property blacklist, draft note',
        exclusions: {
          excludedProperties: [{ key: 'status', value: 'draft' }],
          propertyScopeStrategy: 'Only exclude...',
        },
        cache: draftNote,
      },
      {
        name: 'property whitelist, bare note',
        exclusions: {
          excludedProperties: [{ key: 'status', value: 'draft' }],
          propertyScopeStrategy: 'Exclude all except...',
        },
        cache: noMetadata,
      },
      {
        name: 'property whitelist, draft note',
        exclusions: {
          excludedProperties: [{ key: 'status', value: 'draft' }],
          propertyScopeStrategy: 'Exclude all except...',
        },
        cache: draftNote,
      },
    ];

    const renameVerdicts: boolean[] = [];

    for (const testCase of cases) {
      applyExclusions(testCase.exclusions);
      mockApp.metadataCache.getFileCache = vi
        .fn()
        .mockReturnValue(testCase.cache);

      // The rename path's own gate, with the overrides rename-engine passes
      const renameAllowed = shouldProcessFile(
        file,
        mockPlugin.settings,
        mockApp as unknown as ObsidianApp,
        { content: '' }
      );
      renameVerdicts.push(renameAllowed);

      const result = await determineActions('');

      expect(result.shouldInsertTitle, testCase.name).toBe(renameAllowed);
      expect(result.shouldMoveCursor, testCase.name).toBe(renameAllowed);
    }

    // Guards against a matrix that agrees only because nothing is ever excluded
    expect(renameVerdicts).toContain(true);
    expect(renameVerdicts).toContain(false);
  });

  it('short-circuits at a folder entry (path-excluded) without calling content exclusion check', async () => {
    file = createMockFile('test-folder/test.md');
    file.parent = createMockFolder('test-folder');
    mockPlugin.settings = createTestSettings({
      core: {
        ...structuredClone(DEFAULT_SETTINGS.core),
        insertTitle: true,
        moveCursorToFirstLine: true,
      },
      exclusions: {
        ...structuredClone(DEFAULT_SETTINGS.exclusions),
        excludedFiles: ['test-folder/'],
      },
    });

    const result = await determineActions('');

    expect(result.shouldInsertTitle).toBe(false);
    expect(result.shouldMoveCursor).toBe(false);
    expect(result.placeCursorAtEnd).toBe(false);
    expect(mockExclusionGate).toHaveBeenCalledTimes(0);
  });

  it("short-circuits at a regex entry matching the note's name (path-excluded)", async () => {
    mockPlugin.settings = createTestSettings({
      core: {
        ...structuredClone(DEFAULT_SETTINGS.core),
        insertTitle: true,
        moveCursorToFirstLine: true,
      },
      exclusions: {
        excludedFiles: ['/^test\\.md$/'],
      },
    });

    const result = await determineActions('');

    expect(result.shouldInsertTitle).toBe(false);
    expect(result.shouldMoveCursor).toBe(false);
    expect(mockExclusionGate).toHaveBeenCalledTimes(0);
  });

  it('proceeds to settings hub when content not excluded, no Templater, and no exclusions configured (regression baseline)', async () => {
    const result = await determineActions('');

    expect(mockExclusionGate).toHaveBeenCalledTimes(1);
    expect(result.shouldInsertTitle).toBe(true);
    expect(result.shouldMoveCursor).toBe(true);
    expect(result.placeCursorAtEnd).toBe(true);
  });

  it('excludes at content-excluded through the real exclusion gate, not a stub', async () => {
    const { FileOperations } =
      await import('../../src/operations/file-operations');
    mockPlugin.settings = createTestSettings({
      core: {
        ...structuredClone(DEFAULT_SETTINGS.core),
        insertTitle: true,
        moveCursorToFirstLine: true,
      },
      exclusions: {
        ...structuredClone(DEFAULT_SETTINGS.exclusions),
        excludedProperties: [{ key: 'status', value: 'draft' }],
      },
    });
    // Empty initial content has no frontmatter, so the gate must fall back to the cache
    mockApp.metadataCache.getFileCache = vi.fn().mockReturnValue({
      frontmatter: { status: 'draft' },
      tags: [],
    });
    mockPlugin.fileOperations = new FileOperations(
      mockPlugin as unknown as FirstLineIsTitle
    );

    const result = await determineActions('');

    expect(result.shouldInsertTitle).toBe(false);
    expect(result.shouldMoveCursor).toBe(false);
    expect(result.placeCursorAtEnd).toBe(false);
  });

  it('does nothing when Templater renames the note into an excluded path after path-excluded cleared it (path-excluded-after-template)', async () => {
    file = createMockFile('notes/test.md');
    file.parent = createMockFolder('notes');
    mockPlugin.settings = createTestSettings({
      core: {
        ...structuredClone(DEFAULT_SETTINGS.core),
        insertTitle: true,
        moveCursorToFirstLine: true,
      },
      exclusions: {
        excludedFiles: ['/daily/'],
      },
    });
    mockApp.plugins.plugins['templater-obsidian'] = {
      settings: {
        trigger_on_file_creation_mode: 'folder',
        templates_folder: 'Templates',
        folder_templates: [{ folder: 'notes', template: 'Templates/daily.md' }],
      },
    };
    // The trigger lives in device-local storage, never in Templater's synced settings
    mockApp.loadLocalStorage = vi.fn().mockReturnValue({
      trigger_on_file_creation: true,
    });
    makeNoteTemplaterActiveFile();
    // The rename lands during the templater-event wait, so the path path-excluded cleared is stale by template-excluded.
    // Deferred rather than fired inline: the coordinator's own `eventRef` is still in its temporal dead zone while `on` is running.
    const fireTemplaterEvent = (
      _name: string,
      callback: (data: { file: TFile }) => void
    ) => {
      window.setTimeout(() => {
        file.name = 'daily.md';
        file.path = 'notes/daily.md';
        callback({ file });
      }, 0);
      return {};
    };
    // Cast because the mock exposes Obsidian's overloaded `on`, which no single implementation signature satisfies
    mockApp.workspace.on =
      fireTemplaterEvent as unknown as typeof mockApp.workspace.on;

    const result = await determineActions('');

    expect(result.shouldInsertTitle).toBe(false);
    expect(result.shouldMoveCursor).toBe(false);
    expect(result.placeCursorAtEnd).toBe(false);
    expect(result.decisionPath).toContain('path-excluded-after-template:Y');
  });

  it('does nothing when the template carries a property only a name pattern lists (template-excluded)', async () => {
    file = createMockFile('notes/test.md');
    file.parent = createMockFolder('notes');
    applyExclusions({ excludedProperties: [{ key: '/^stat/', value: '' }] });
    mockApp.plugins.plugins['templater-obsidian'] = {
      settings: {
        trigger_on_file_creation_mode: 'folder',
        templates_folder: 'Templates',
        folder_templates: [{ folder: 'notes', template: 'Templates/draft.md' }],
      },
    };
    mockApp.loadLocalStorage = vi.fn().mockReturnValue({
      trigger_on_file_creation: true,
    });
    makeNoteTemplaterActiveFile();
    // The template's properties land during the templater-event wait, after content-excluded read the empty note; the file's cache has not indexed them yet at the event
    mockApp.metadataCache.getFileCache = vi.fn().mockReturnValue({});
    parseTemplateAs({ frontmatter: { Status: 'draft' } });
    // Deferred rather than fired inline: the coordinator's own `eventRef` is still in its temporal dead zone while `on` is running
    const fireTemplaterEvent = (
      _name: string,
      callback: (data: { file: TFile; content: string }) => void
    ) => {
      window.setTimeout(
        () => callback({ file, content: '---\nStatus: draft\n---\n' }),
        0
      );
      return {};
    };
    // Cast because the mock exposes Obsidian's overloaded `on`, which no single implementation signature satisfies
    mockApp.workspace.on =
      fireTemplaterEvent as unknown as typeof mockApp.workspace.on;

    const result = await determineActions('');

    expect(result.shouldInsertTitle).toBe(false);
    expect(result.decisionPath).toContain('template-excluded:Y');
  });

  it('proceeds to settings hub when content not excluded, tag rules configured, and Templater not installed (templater-enabled:N regression baseline)', async () => {
    mockPlugin.settings = createTestSettings({
      core: {
        ...structuredClone(DEFAULT_SETTINGS.core),
        insertTitle: true,
        moveCursorToFirstLine: true,
      },
      exclusions: {
        ...structuredClone(DEFAULT_SETTINGS.exclusions),
        excludedTags: ['exclude-me'],
      },
    });

    const result = await determineActions('');

    expect(result.shouldInsertTitle).toBe(true);
    expect(result.shouldMoveCursor).toBe(true);
    expect(result.placeCursorAtEnd).toBe(true);
  });

  describe('Templater gates', () => {
    /** Installs Templater with synced settings and a device-local trigger state. */
    function installTemplater(
      syncedSettings: Record<string, unknown>,
      localSettings: Record<string, unknown> | undefined
    ) {
      mockApp.plugins.plugins['templater-obsidian'] = {
        settings: { templates_folder: 'Templates', ...syncedSettings },
      };
      // Templater keeps the trigger out of its synced settings, so the coordinator reads it here
      mockApp.loadLocalStorage = vi.fn().mockReturnValue(localSettings);
    }

    it('takes the folder branch when the trigger is on and the mode is folder', async () => {
      file.parent = createMockFolder('notes');
      installTemplater(
        {
          trigger_on_file_creation_mode: 'folder',
          // Deliberately non-matching: a matching entry would enter the templater-event wait against
          // a mock `workspace.on` that never fires, stalling the run for the full timeout
          folder_templates: [
            { folder: 'other', template: 'Templates/other.md' },
          ],
        },
        { trigger_on_file_creation: true }
      );

      const result = await determineActions('');

      expect(result.decisionPath).toContain('templater-trigger:Y');
      expect(result.decisionPath).toContain('folder-templates-mode:Y');
    });

    it('falls through to the regex branch when the mode is regex', async () => {
      // `file_templates` left absent so regex-template-matches:N returns before the templater-event wait
      installTemplater(
        { trigger_on_file_creation_mode: 'regex' },
        { trigger_on_file_creation: true }
      );

      const result = await determineActions('');

      expect(result.decisionPath).toContain('templater-trigger:Y');
      expect(result.decisionPath).toContain('folder-templates-mode:N');
      expect(result.decisionPath).toContain('regex-templates-mode:Y');
    });

    it('takes neither template branch when the mode is none', async () => {
      installTemplater(
        { trigger_on_file_creation_mode: 'none' },
        { trigger_on_file_creation: true }
      );

      const result = await determineActions('');

      expect(result.decisionPath).toContain('templater-trigger:Y');
      expect(result.decisionPath).toContain('folder-templates-mode:N');
      expect(result.decisionPath).toContain('regex-templates-mode:N');
    });

    it('takes neither template branch when the mode key is absent', async () => {
      installTemplater({}, { trigger_on_file_creation: true });

      const result = await determineActions('');

      expect(result.decisionPath).toContain('folder-templates-mode:N');
    });

    it('stops at the trigger gate when the device-local trigger is off', async () => {
      // The state every freshly migrated and every newly synced device starts in
      installTemplater({ trigger_on_file_creation_mode: 'folder' }, undefined);

      const result = await determineActions('');

      expect(result.decisionPath).toContain('templater-trigger:N');
    });

    it('ignores the pre-migration folder-template boolean', async () => {
      // Pins the decision to drop the legacy fallback: re-adding it must be a deliberate test change
      installTemplater(
        { enable_folder_templates: true },
        { trigger_on_file_creation: true }
      );

      const result = await determineActions('');

      expect(result.decisionPath).toContain('folder-templates-mode:N');
    });
  });

  describe('Templater wait', () => {
    // A title inserted before the template lands loses its cursor to Templater's own selection, whatever the exclusion settings
    it('waits for the template with no tag or property exclusions configured', async () => {
      installMatchingTemplater();
      const listen = fireTemplaterEvent('---\na: b\n---\n', '---\na: b\n---\n');

      const result = await determineActions('');

      expect(listen).toHaveBeenCalledWith(
        'templater:new-note-from-template',
        expect.any(Function)
      );
      expect(result.decisionPath).toContain(
        'folder-template-matches:Y → templater-event:Y'
      );
      expect(result.shouldInsertTitle).toBe(true);
      expect(result.shouldMoveCursor).toBe(true);
      expect(result.titleCursor).toBe('line-end');
    });

    it('does not wait for a note in a folder Templater ignores on creation', async () => {
      installMatchingTemplater({
        ignore_folders_on_creation: [{ folder: 'notes/' }],
      });
      const listen = listenWithoutEvent();

      const result = await determineActions('');

      expect(listen).not.toHaveBeenCalled();
      expect(result.decisionPath).toContain('in-ignored-folder:Y');
      expect(result.shouldInsertTitle).toBe(true);
    });

    // Templater measures the raw text past the properties, so a lone line break sends it to its overwrite commands instead of the template
    it('does not wait for a note whose snapshot already holds a body, a lone line break included', async () => {
      installMatchingTemplater();
      const listen = listenWithoutEvent();

      const result = await determineActions('---\na: b\n---\n\n');

      expect(listen).not.toHaveBeenCalled();
      expect(result.decisionPath).toContain('body-not-empty:Y');
    });

    // Templater tests the templates folder as a substring of the path, not a prefix
    it('does not wait for a note whose path holds the templates folder anywhere', async () => {
      installMatchingTemplater({ templates_folder: 'Templates/' });
      file = createMockFile('notes/Templates/test.md');
      file.parent = createMockFolder('notes/Templates');
      const listen = listenWithoutEvent();

      const result = await determineActions('');

      expect(listen).not.toHaveBeenCalled();
      expect(result.decisionPath).toContain('in-template-folder:Y');
    });

    it('never treats the vault root as the templates folder', async () => {
      installMatchingTemplater({ templates_folder: '/' });
      fireTemplaterEvent('', '');

      const result = await determineActions('');

      expect(result.decisionPath).toContain('in-template-folder:N');
      expect(result.decisionPath).toContain('templater-event:Y');
    });

    it('judges the note as Templater left it, not the creation snapshot', async () => {
      installMatchingTemplater();
      const templated = '---\na: b\n---\nTemplate body\n';
      fireTemplaterEvent(templated, templated);

      const result = await determineActions('');

      expect(result.decisionPath).toContain('content-below-yaml:Y');
      expect(result.shouldInsertTitle).toBe(false);
      expect(result.judgedContent).toBe(templated);
    });

    it('judges the creation snapshot when no event arrives', async () => {
      vi.useFakeTimers();
      installMatchingTemplater();
      listenWithoutEvent();

      const pending = determineActions('');
      await vi.advanceTimersByTimeAsync(
        TIMING.TEMPLATER_EVENT_TIMEOUT_MS +
          TIMING.TEMPLATER_EVENT_CLEANUP_GRACE_MS
      );
      const result = await pending;
      vi.useRealTimers();

      expect(result.decisionPath).toContain('templater-event:N');
      expect(result.judgedContent).toBe('');
      expect(mockResolveView).not.toHaveBeenCalled();
    });

    // Templater's jumper deletes the placeholder it jumps to before the walk resumes
    it('leaves the cursor where the jump put it when the note lost a placeholder, still inserting the title', async () => {
      installMatchingTemplater();
      fireTemplaterEvent(
        '---\na: b\n---\n<% tp.file.cursor() %>',
        '---\na: b\n---\n'
      );

      const result = await determineActions('');

      expect(result.decisionPath).toContain('template-cursor:Y');
      expect(result.shouldInsertTitle).toBe(true);
      expect(result.shouldMoveCursor).toBe(false);
      expect(result.placeCursorAtEnd).toBe(false);
      expect(result.titleCursor).toBe('keep-template-cursor');
    });

    // With automatic jump off the placeholder stays in the note as text, so no cursor was placed
    it('places the cursor itself when automatic jump is off', async () => {
      installMatchingTemplater({ auto_jump_to_cursor: false });
      fireTemplaterEvent(
        '---\na: b\n---\n<% tp.file.cursor(1) %>',
        '---\na: b\n---\n<% tp.file.cursor(1) %>'
      );

      const result = await determineActions('');

      expect(result.decisionPath).toContain('template-cursor:N');
      expect(result.shouldMoveCursor).toBe(true);
      expect(result.placeCursorAtEnd).toBe(true);
    });

    // Measured: a placeholder inside the properties stayed in the note with automatic jump on
    it('places the cursor itself when the note keeps every placeholder, automatic jump on or not', async () => {
      installMatchingTemplater({ auto_jump_to_cursor: true });
      const templated = '---\na: <% tp.file.cursor() %>\n---\n';
      fireTemplaterEvent(templated, templated);

      const result = await determineActions('');

      expect(result.decisionPath).toContain('template-cursor:N');
      expect(result.shouldMoveCursor).toBe(true);
      expect(result.titleCursor).toBe('line-end');
    });

    // The jumper takes the lowest order first and leaves later ones for the next jump
    it('counts a jump to the first of ordered placeholders as the template placing the cursor', async () => {
      installMatchingTemplater();
      fireTemplaterEvent(
        '---\na: b\n---\n<% tp.file.cursor(1) %>\nNotes: <% tp.file.cursor(2) %>',
        '---\na: b\n---\n\nNotes: <% tp.file.cursor(2) %>'
      );

      const result = await determineActions('');

      expect(result.decisionPath).toContain('template-cursor:Y');
      expect(result.shouldMoveCursor).toBe(false);
    });

    // The jumper needs the note in an editor, and the creation snapshot holds no placeholder to compare
    it('places the cursor itself when no view shows the note after the event', async () => {
      installMatchingTemplater();
      fireTemplaterEvent('<% tp.file.cursor() %>', null);

      const result = await determineActions('');

      expect(result.decisionPath).toContain('template-cursor:N');
      expect(result.judgedContent).toBe('');
      expect(result.shouldMoveCursor).toBe(true);
    });

    it('leaves a template cursor where the title goes to CodeMirror with Place cursor at line end off', async () => {
      installMatchingTemplater();
      mockPlugin.settings.core.placeCursorAtLineEnd = false;
      fireTemplaterEvent('<% tp.file.cursor() %>', '');

      const result = await determineActions('');

      expect(result.decisionPath).toContain('template-cursor:Y');
      expect(result.shouldInsertTitle).toBe(true);
      expect(result.shouldMoveCursor).toBe(false);
      expect(result.titleCursor).toBe('none');
    });

    it('leaves a template cursor where the title goes to CodeMirror with Move cursor to first line off', async () => {
      installMatchingTemplater();
      mockPlugin.settings.core.moveCursorToFirstLine = false;
      fireTemplaterEvent('<% tp.file.cursor() %>', '');

      const result = await determineActions('');

      expect(result.decisionPath).toContain('template-cursor:Y');
      expect(result.shouldInsertTitle).toBe(true);
      expect(result.titleCursor).toBe('none');
    });

    it('places the cursor itself when the template holds no cursor placeholder', async () => {
      installMatchingTemplater({ auto_jump_to_cursor: true });
      fireTemplaterEvent('---\na: b\n---\n', '---\na: b\n---\n');

      const result = await determineActions('');

      expect(result.decisionPath).toContain('template-cursor:N');
      expect(result.titleCursor).toBe('line-end');
    });

    it('logs one outcome naming the cursor the template kept', async () => {
      installMatchingTemplater({ auto_jump_to_cursor: true });
      fireTemplaterEvent('<% tp.file.cursor() %>', '');

      const result = await determineActions('');

      const loggedOutcomes = vi
        .mocked(verboseLog)
        .mock.calls.map((call) => call[1])
        .filter((message) => message.startsWith('[FileCreation]'));
      expect(loggedOutcomes).toEqual([
        `[FileCreation] Decision path: ${result.decisionPath} → Insert title (cursor left where the template put it)`,
      ]);
    });
  });

  // Measured: with automatic jump off, or in a background tab, Templater leaves its placeholder in the note, which then got no title and was renamed Untitled
  describe('a body of only cursor placeholders', () => {
    const placeholderOnlyBodies = [
      {
        name: 'one placeholder',
        note: '---\nkind: probe\n---\n<% tp.file.cursor() %>\n',
      },
      {
        name: 'an ordered placeholder',
        note: '---\nkind: probe\n---\n<% tp.file.cursor(2) %>\n',
      },
      {
        name: 'placeholders and blank lines',
        note: '---\nkind: probe\n---\n\n<% tp.file.cursor(1) %>\n\n  <%tp.file.cursor(2)%>\n\n',
      },
    ];

    it.each(placeholderOnlyBodies)(
      'inserts the title for $name the view keeps',
      async ({ note }) => {
        installMatchingTemplater({ auto_jump_to_cursor: false });
        fireTemplaterEvent(note, note);

        const result = await determineActions('');

        expect(result.decisionPath).toContain('template-cursor:N');
        expect(result.decisionPath).toContain('content-below-yaml:N');
        expect(result.shouldInsertTitle).toBe(true);
        expect(result.titleCursor).toBe('line-end');
        expect(result.judgedContent).toBe(note);
      }
    );

    it.each(placeholderOnlyBodies)(
      'inserts the title for $name Templater wrote into a background tab',
      async ({ note }) => {
        installMatchingTemplater({ auto_jump_to_cursor: true });
        mockApp.workspace.activeEditor = null;
        fireTemplaterEvent(note, '');

        const result = await determineActions('');

        expect(result.decisionPath).toContain('template-wrote-file:Y');
        expect(result.decisionPath).toContain('content-below-yaml:N');
        expect(result.shouldInsertTitle).toBe(true);
        expect(result.viewLagsFile).toBe(true);
      }
    );

    it.each([true, false])(
      'inserts the title with Strip Templater markup %s',
      async (stripTemplaterSyntax) => {
        mockPlugin.settings.markupStripping.stripTemplaterSyntax =
          stripTemplaterSyntax;

        const result = await determineActions(
          '---\nkind: probe\n---\n<% tp.file.cursor() %>\n'
        );

        expect(result.decisionPath).toContain('content-below-yaml:N');
        expect(result.shouldInsertTitle).toBe(true);
      }
    );

    it('inserts no title when other text sits beside the placeholder', async () => {
      installMatchingTemplater({ auto_jump_to_cursor: false });
      const note = '---\nkind: probe\n---\n<% tp.file.cursor() %>\nNotes\n';
      fireTemplaterEvent(note, note);

      const result = await determineActions('');

      expect(result.decisionPath).toContain('content-below-yaml:Y');
      expect(result.shouldInsertTitle).toBe(false);
    });

    it('inserts no title when other text shares the placeholder line', async () => {
      const result = await determineActions(
        '---\nkind: probe\n---\nNotes: <% tp.file.cursor() %>\n'
      );

      expect(result.decisionPath).toContain('content-below-yaml:Y');
      expect(result.shouldInsertTitle).toBe(false);
    });
  });

  // Templater writes the editor only for its active file, and otherwise the file, whose view then still shows the text from before the write
  describe('Templater writing the file', () => {
    const fileWriteConditions: { name: string; leave: () => void }[] = [
      {
        name: 'another note is the active file',
        leave: () => {
          const other = createMockFile('notes/other.md');
          mockApp.workspace.activeEditor = {
            file: other,
            editor: {},
          } as unknown as typeof mockApp.workspace.activeEditor;
          mockApp.workspace.getActiveFile = vi.fn().mockReturnValue(other);
        },
      },
      {
        name: 'no editor is active',
        leave: () => {
          mockApp.workspace.activeEditor = null;
        },
      },
      {
        name: 'no Markdown view is active',
        leave: () => {
          mockApp.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);
        },
      },
    ];

    it.each(fileWriteConditions)(
      'judges the text the event carries, not the stale view, when $name',
      async ({ leave }) => {
        installMatchingTemplater({ auto_jump_to_cursor: true });
        leave();
        // The merged note keeps its placeholder while the stale view shows fewer, which would read as a jump if the view were counted
        const merged = '---\na: <% tp.file.cursor() %>\n---\n';
        fireTemplaterEvent(merged, '');

        const result = await determineActions('');

        expect(result.decisionPath).toContain(
          'templater-event:Y → template-wrote-file:Y'
        );
        expect(result.decisionPath).toContain('template-cursor:N');
        expect(result.judgedContent).toBe(merged);
        expect(result.viewLagsFile).toBe(true);
        expect(result.shouldInsertTitle).toBe(true);
        expect(mockResolveView).not.toHaveBeenCalled();
      }
    );

    it('judges the view after an editor write, with the note Templater’s active file in a Markdown view', async () => {
      installMatchingTemplater();
      const noteText = '---\na: b\n---\n';
      fireTemplaterEvent('---\na: b\n---\n<% tp.file.cursor() %>', noteText);

      const result = await determineActions('');

      expect(result.decisionPath).toContain(
        'templater-event:Y → template-wrote-file:N'
      );
      expect(result.decisionPath).toContain('template-cursor:Y');
      expect(result.judgedContent).toBe(noteText);
      expect(result.viewLagsFile).toBe(false);
    });

    it('reports the view current when no Templater wait ran', async () => {
      const result = await determineActions('');

      expect(result.viewLagsFile).toBe(false);
    });

    it('carries the lagging view into a result that does nothing', async () => {
      installMatchingTemplater();
      mockApp.workspace.activeEditor = null;
      applyExclusions({ excludedTags: ['inbox'] });
      parseTemplateAs({ frontmatter: { tags: 'inbox' } });
      fireTemplaterEvent('---\ntags: inbox\n---\n', '');

      const result = await determineActions('');

      expect(result.decisionPath).toContain('template-excluded:Y');
      expect(result.viewLagsFile).toBe(true);
    });
  });

  // At the event the file's cache holds none of the tags or properties the template added: it fills 4-7 ms later
  describe('template-excluded on the parsed template', () => {
    /** A body tag as Obsidian's parser reports it, at the line after a one-property block */
    const bodyTag = (tag: string) => ({
      tag,
      position: {
        start: { line: 3, col: 0, offset: 12 },
        end: { line: 3, col: tag.length, offset: 12 + tag.length },
      },
    });

    beforeEach(() => {
      installMatchingTemplater();
      mockApp.metadataCache.getFileCache = vi.fn().mockReturnValue({});
    });

    /** A tag list that excludes a template carrying `#inbox`, under each strategy */
    const excludingTagLists: {
      strategy: ExclusionStrategy;
      excludedTags: string[];
    }[] = [
      { strategy: 'Only exclude...', excludedTags: ['inbox'] },
      { strategy: 'Exclude all except...', excludedTags: ['keep'] },
    ];

    /** Runs the walk on a template the view shows as written, which Obsidian's parser resolves to `metadata` */
    async function judgeTemplate(
      template: string,
      metadata: CachedMetadata | undefined
    ) {
      parseTemplateAs(metadata);
      fireTemplaterEvent(template, template);
      const result = await determineActions('');
      expect(parsedText()).toBe(template);
      return result;
    }

    it.each(excludingTagLists)(
      'excludes a template adding a property tag under $strategy',
      async ({ strategy, excludedTags }) => {
        applyExclusions({ excludedTags, tagScopeStrategy: strategy });

        const result = await judgeTemplate('---\ntags: inbox\n---\n', {
          frontmatter: { tags: 'inbox' },
        });

        expect(result.decisionPath).toContain('template-excluded:Y');
        expect(result.shouldInsertTitle).toBe(false);
        expect(result.shouldMoveCursor).toBe(false);
      }
    );

    it.each(excludingTagLists)(
      'excludes a template adding a body tag under $strategy',
      async ({ strategy, excludedTags }) => {
        applyExclusions({ excludedTags, tagScopeStrategy: strategy });

        const result = await judgeTemplate('---\na: b\n---\n#inbox\n', {
          frontmatter: { a: 'b' },
          tags: [bodyTag('#inbox')],
        });

        expect(result.decisionPath).toContain('template-excluded:Y');
        expect(result.shouldInsertTitle).toBe(false);
      }
    );

    it.each([
      { strategy: 'Only exclude...', listedKey: 'status' },
      { strategy: 'Exclude all except...', listedKey: 'keep' },
    ] as const)(
      'excludes a template adding a property under $strategy',
      async ({ strategy, listedKey }) => {
        applyExclusions({
          excludedProperties: [{ key: listedKey, value: '' }],
          propertyScopeStrategy: strategy,
        });

        const result = await judgeTemplate('---\nstatus: draft\n---\n', {
          frontmatter: { status: 'draft' },
        });

        expect(result.decisionPath).toContain('template-excluded:Y');
        expect(result.shouldInsertTitle).toBe(false);
      }
    );

    it('keeps a template whose tag the whitelist lists', async () => {
      applyExclusions({
        excludedTags: ['inbox'],
        tagScopeStrategy: 'Exclude all except...',
      });

      const result = await judgeTemplate('---\ntags: inbox\n---\n', {
        frontmatter: { tags: 'inbox' },
      });

      expect(result.decisionPath).toContain('template-excluded:N');
      expect(result.shouldInsertTitle).toBe(true);
    });

    // Obsidian's parser leaves a tag inside a code block out of `tags`, as the metadata cache does
    it('does not count a tag inside a code block in the template', async () => {
      applyExclusions({ excludedTags: ['inbox'] });

      const result = await judgeTemplate('---\na: b\n---\n```\n#inbox\n```\n', {
        frontmatter: { a: 'b' },
      });

      expect(result.decisionPath).toContain('template-excluded:N');
    });

    it('judges the file’s cache when the parser fails', async () => {
      applyExclusions({ excludedTags: ['inbox'] });
      mockApp.metadataCache.getFileCache = vi.fn().mockReturnValue({
        frontmatter: { tags: 'inbox' },
      });

      const result = await judgeTemplate('---\ntags: inbox\n---\n', undefined);

      expect(result.decisionPath).toContain('template-excluded:Y');
      expect(
        vi
          .mocked(verboseLog)
          .mock.calls.some((call) =>
            call[1].startsWith('Template metadata parse failed')
          )
      ).toBe(true);
    });
  });

  // The Templater wait lets a second creation run its whole walk inside the first one's
  it("keeps each overlapping creation's decision path to its own walk", async () => {
    vi.useFakeTimers();
    mockApp.plugins.plugins['templater-obsidian'] = {
      settings: {
        trigger_on_file_creation_mode: 'folder',
        templates_folder: 'Templates',
        folder_templates: [{ folder: 'notes', template: 'Templates/daily.md' }],
      },
    };
    mockApp.loadLocalStorage = vi.fn().mockReturnValue({
      trigger_on_file_creation: true,
    });
    // Templater never reports the note, so the templated creation waits out its timeout
    mockApp.workspace.on = vi.fn(
      () => ({})
    ) as unknown as typeof mockApp.workspace.on;
    const templated = createMockFile('notes/templated.md');
    templated.parent = createMockFolder('notes');
    const plain = createMockFile('other/plain.md');
    plain.parent = createMockFolder('other');
    const { FileCreationCoordinator } =
      await import('../../src/core/file-creation-coordinator');
    const coordinator = new FileCreationCoordinator(
      mockPlugin as unknown as FirstLineIsTitle
    );
    const context = { initialContent: '', pluginLoadTime: Date.now() };

    const waiting = coordinator.determineActions(templated, context);
    const plainResult = await coordinator.determineActions(plain, context);
    await vi.advanceTimersByTimeAsync(
      TIMING.TEMPLATER_EVENT_TIMEOUT_MS +
        TIMING.TEMPLATER_EVENT_CLEANUP_GRACE_MS
    );
    const templatedResult = await waiting;
    vi.useRealTimers();

    expect(plainResult.decisionPath).toContain('folder-template-matches:N');
    expect(templatedResult.decisionPath).toContain(
      'folder-template-matches:Y → templater-event:N'
    );
    const loggedOutcomes = vi
      .mocked(verboseLog)
      .mock.calls.map((call) => call[1])
      .filter((message) => message.startsWith('[FileCreation]'));
    expect(loggedOutcomes).toEqual([
      `[FileCreation] Decision path: ${plainResult.decisionPath} → Insert title + Move cursor + Place at end`,
      `[FileCreation] Decision path: ${templatedResult.decisionPath} → Insert title + Move cursor + Place at end`,
    ]);
  });
});
