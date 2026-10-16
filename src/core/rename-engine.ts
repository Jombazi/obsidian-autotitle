import {
  TFile,
  Editor,
  Notice,
  MarkdownView,
  MarkdownFileInfo,
  CachedMetadata,
} from 'obsidian';
import {
  TitleRegionCache,
  RenameOutcome,
  RenameOutcomeReason,
  PluginSettings,
  ExclusionList,
  ExclusionOverrides,
  ProcessFileOptions,
} from '../types';
import { TIMING, LIMITS } from '../constants/timing';
import { verboseLog, verboseLogger } from '../utils';
import { escapeRegExp, findExcludingList } from '../utils/file-exclusions';
import { canModifyFile } from '../utils/disable-property';
import {
  findMarkdownViewOfEditor,
  isFileOpenInAnyEditor,
  isOnlyFrontmatterChanged,
} from '../utils/editor-checks';
import {
  extractTitle,
  applyTitleCase,
  isValidHeading,
} from '../utils/title-extraction';
import { processForbiddenChars } from '../utils/string-processing';
import {
  TitleSource,
  findTitleSource,
  lineSourceFromText,
} from '../utils/title-source';
import { t } from '../i18n';
import { RateLimiter } from './rate-limiter';
import { readFileContent } from '../utils/content-reader';
import {
  SourceEditorTarget,
  findSourceEditorForFile,
} from '../utils/frontmatter-edit';
import { hasFirstLinePropertyName } from '../utils/first-line-property-keys';
import { applyCustomReplacementRules } from '../utils/custom-replacement-rules';
import { markdownLinkDestinations } from '../utils/inline-markup';

import FirstLineIsTitle from '../../main';

/** Device names Windows refuses as file names; refused on every platform, as the Windows forbidden characters are */
const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'COM0',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
  'LPT0',
]);

/** The notice a manual command shows when an exclusion list refuses the note */
const EXCLUSION_NOTICE_KEYS: Readonly<Record<ExclusionList, string>> = {
  files: 'notifications.notRenamedExcludedPath',
  tags: 'notifications.notRenamedExcludedTag',
  properties: 'notifications.notRenamedExcludedProperty',
};

/** How a link in the title source was recognized as pointing at the note itself, named in the debug log */
type SelfReferenceKind =
  'wikilink' | 'Markdown link fragment' | 'Markdown link' | 'cached link';

/**
 * Turn the title source into the note's title: custom replacements, markup stripping and forbidden-character handling, in the order the settings give.
 * @param titleSource - Where the title comes from
 * @param plugin - Holder of the settings, which also switch the debug log
 * @returns The title, before any counter a name conflict adds
 */
function buildTitleFromSource(
  titleSource: TitleSource,
  plugin: { settings: PluginSettings }
): string {
  const { settings } = plugin;
  // Code and a callout's default title are shown as typed: only title case applies to them, not markup stripping
  const stripMarkup = (title: string): string =>
    titleSource.raw
      ? applyTitleCase(title, settings)
      : extractTitle(title, settings);

  let title = titleSource.text;
  if (settings.customReplacements.applyAfterForbiddenChars) {
    title = stripMarkup(title);
    title = sanitizeTitleForFileName(title, plugin);
    title = applyCustomReplacements(title, plugin);
    // A rule's replacement text can reintroduce path separators and blow past the char limit, so re-sanitize
    return sanitizeTitleForFileName(title, plugin);
  }
  if (settings.markupStripping.applyCustomReplacementsAfterMarkupStripping) {
    title = stripMarkup(title);
    title = applyCustomReplacements(title, plugin);
  } else {
    title = applyCustomReplacements(title, plugin);
    title = stripMarkup(title);
  }
  return sanitizeTitleForFileName(title, plugin);
}

/**
 * Apply the custom replacement rules, falling back to Untitled when they leave only whitespace.
 * @param title - Title to apply the rules to
 * @param plugin - Holder of the settings, which also switch the debug log
 * @returns The replaced title
 */
function applyCustomReplacements(
  title: string,
  plugin: { settings: PluginSettings }
): string {
  const replaced = applyCustomReplacementRules(
    title,
    plugin.settings.customReplacements.rules
  );
  verboseLog(plugin, `Applied custom replacements:`, {
    from: title,
    to: replaced,
  });
  return replaced.trim() === '' ? t('untitled') : replaced;
}

/**
 * Replace forbidden characters and truncate to the character limit, falling back to Untitled when the result is empty or a Windows reserved name.
 * @param title - Title to make usable as a file name
 * @param plugin - Holder of the settings, which also switch the debug log
 * @returns The sanitized title
 */
function sanitizeTitleForFileName(
  title: string,
  plugin: { settings: PluginSettings }
): string {
  const sanitized = processForbiddenChars(title, plugin.settings, {
    maxLength: plugin.settings.core.charCount,
  });
  if (
    sanitized !== '' &&
    !WINDOWS_RESERVED_NAMES.has(sanitized.toUpperCase())
  ) {
    return sanitized;
  }
  verboseLog(
    plugin,
    `Using fallback name \`${t('untitled')}\` for sanitized title \`${sanitized}\``
  );
  return t('untitled');
}

/**
 * Find a link in the title source's text that points at the note itself.
 * @param text - The title source's text
 * @param file - Note being renamed
 * @returns How the link was recognized, or null when the text holds none
 */
function findSelfReferenceInText(
  text: string,
  file: TFile
): SelfReferenceKind | null {
  const currentName = file.basename;
  const escapedName = escapeRegExp(currentName);
  const pathWithoutExt = file.path.replace(/\.md$/, '');
  const escapedPath = escapeRegExp(pathWithoutExt);

  // Match [[filename]], [[filename#heading]], [[filename#^block]], [[path/filename#heading]], with optional |alias, by basename or by path, since some users link with the path
  const wikiLinkRegex = new RegExp(
    `\\[\\[(${escapedName}|${escapedPath})(#[^\\]|]*?)?(\\|.*?)?\\]\\]`
  );
  if (wikiLinkRegex.test(text)) {
    return 'wikilink';
  }

  // Markdown links by their destination as Reading view resolves it, so one holding parentheses or angle brackets counts and one inside code or a comment does not
  for (const url of markdownLinkDestinations(text)) {
    let decodedUrl = url;
    try {
      decodedUrl = decodeURIComponent(url);
    } catch {
      // Invalid encoding, use original
    }

    if (url.startsWith('#') && url.includes(currentName)) {
      return 'Markdown link fragment';
    }

    // A relative path, with or without the .md extension, by basename or by path
    const urlWithoutFragment = decodedUrl.split('#')[0];
    if (
      urlWithoutFragment &&
      (urlWithoutFragment === `${currentName}.md` ||
        urlWithoutFragment === currentName ||
        urlWithoutFragment === `${pathWithoutExt}.md` ||
        urlWithoutFragment === pathWithoutExt)
    ) {
      return 'Markdown link';
    }
  }
  return null;
}

/**
 * True when Obsidian's cached links hold a link to the note itself on the title source's line; the cache keeps a link's last parsed form, so it catches a mid-edit link the text patterns miss.
 * @param cache - The note's cached metadata
 * @param file - Note being renamed
 * @param titleLine - The title source's absolute line, which link positions count in too; -1 (part of a line, or a synthetic title) skips the check
 */
function cachedLinkOnLinePointsAtNote(
  cache: CachedMetadata | null,
  file: TFile,
  titleLine: number
): boolean {
  if (!cache?.links || titleLine < 0) {
    return false;
  }
  const pathWithoutExt = file.path.replace(/\.md$/, '');
  return cache.links.some((link) => {
    if (link.position.start.line !== titleLine) {
      return false;
    }
    const linkTarget = link.link.replace(/\.md$/, '');
    return (
      linkTarget === file.basename ||
      linkTarget === pathWithoutExt ||
      link.link === file.path ||
      link.link === pathWithoutExt
    );
  });
}

export class RenameEngine {
  private plugin: FirstLineIsTitle;

  private perFileRateLimiter: RateLimiter;
  private globalRateLimiter: RateLimiter;

  constructor(plugin: FirstLineIsTitle) {
    this.plugin = plugin;

    const isDebugEnabled = (): boolean => this.plugin.settings.core.debug;

    this.perFileRateLimiter = new RateLimiter({
      windowMs: 500,
      maxOperations: 15,
      isDebugEnabled,
    });

    this.globalRateLimiter = new RateLimiter({
      windowMs: 500,
      maxOperations: 30,
      isDebugEnabled,
    });
  }

  checkFileTimeLimit(file: TFile): boolean {
    return this.perFileRateLimiter.checkLimit(file.path, file.path);
  }

  checkGlobalRateLimit(): boolean {
    return this.globalRateLimiter.checkGlobalLimit();
  }

  /**
   * Update the first line property for a file with coordination to prevent concurrent updates.
   * Runs for the outcomes `processFile`'s gate lets through — `renamed`, `no-rename-needed`, `empty-content-retained` — with the caller's exclusion overrides, so a manual rename that ignores exclusions writes the property too.
   * Coordinates with event-handler-manager's pendingFirstLinePropertyUpdates to prevent double-processing.
   *
   * @param file - The file to update the first line property for
   * @param exclusionOverrides - Exclusion rules the caller ignored for the rename
   * @param editor - Editor the rename was read from, which the first line property is written into
   * @returns true if the first line property was updated, false if skipped
   */
  private async updateFirstLinePropertyWithCoordination(
    file: TFile,
    exclusionOverrides?: ExclusionOverrides,
    editor?: Editor
  ): Promise<boolean> {
    // Update the first line property when a property name is set (for both manual and automatic modes)
    if (!hasFirstLinePropertyName(this.plugin.settings)) {
      return false;
    }

    // Check if event handler already has an update in progress
    if (
      this.plugin.eventHandlerManager.isFirstLinePropertyUpdatePending(
        file.path
      )
    ) {
      verboseLog(
        this.plugin,
        `Skipping first line property update - event handler already processing: ${file.path}`
      );
      return false;
    }

    // Mark as in-progress to prevent event handlers from double-processing
    this.plugin.eventHandlerManager.markFirstLinePropertyUpdatePending(
      file.path
    );

    try {
      const target = this.findFirstLinePropertyTarget(file, editor);

      verboseLog(
        this.plugin,
        `EDITOR_PASS (rename): Passing target=${target ? 'editor' : 'file'} to updateFirstLinePropertyIfNeeded`
      );

      const firstLinePropertyResult =
        await this.plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded(
          file,
          undefined,
          target,
          exclusionOverrides
        );
      return firstLinePropertyResult;
    } finally {
      this.plugin.eventHandlerManager.clearFirstLinePropertyUpdatePending(
        file.path
      );
    }
  }

  /**
   * Choose where the first line property update goes: the editor the rename was read from when there is one, since that is where the user is typing, otherwise any editor showing the note.
   * @param file - Note being renamed
   * @param editor - Editor the rename was read from
   * @returns The editor to write into, or null to write the file
   */
  private findFirstLinePropertyTarget(
    file: TFile,
    editor?: Editor
  ): SourceEditorTarget | null {
    const found = findSourceEditorForFile(this.plugin.app, file);
    if (!editor || found?.editor === editor) {
      return found ?? null;
    }
    // Manual commands pass `workspace.activeEditor.editor`, which a Reading view also has, and an edit through it never reaches the file.
    const owner = findMarkdownViewOfEditor(this.plugin.app, editor);
    const ownedByReadingView = !!owner && owner.getMode() !== 'source';
    return ownedByReadingView
      ? (found ?? null)
      : { editor, isDirty: () => false };
  }

  /**
   * Process a throttled first-line edit.
   * @param editor - Editor the edit came from
   * @param file - Note that was edited
   * @param owner - The `editor-change` event's `info`; the editor is read only while it still shows the note
   */
  async processEditorChange(
    editor: Editor,
    file: TFile,
    owner?: MarkdownView | MarkdownFileInfo
  ): Promise<void> {
    const startTime = Date.now();

    try {
      // Second line of defence behind the same check in handleEditorChangeWithThrottle: a throttle timer scheduled just before the plugin started writing can still land mid write, and this entry point performs a real vault.read() for a file with no tracked previous content. Placed above the lock check so the plugin's own writes into a background editor never mark a spurious pending recheck there either.
      if (this.plugin.fileStateManager.isEditorSyncing(file.path)) {
        verboseLog(
          this.plugin,
          `Editor change ignored - plugin is writing to this editor: ${file.path}`
        );
        return;
      }

      if (this.plugin.fileStateManager.isLocked(file.path)) {
        verboseLog(
          this.plugin,
          `Editor change ignored - file operation in progress: ${file.path}`
        );
        this.plugin.fileStateManager.markPendingFirstLinePropertyRecheck(
          file.path
        );
        return;
      }

      // A throttled change can outlive its editor: a deselected Canvas card's or closed page preview's destroyed view reads as empty and would rename the note "Untitled", and a tab switched to another note keeps the same editor holding that note's text. The file holds the card's flushed save or the tab's save on switch instead. Without an owner (the pending recheck, which re-resolves its editor just before calling), only teardown is detectable.
      // A tab switched to Reading view keeps a hidden, still-connected editor at the text it loaded, while properties edited there and outside changes reach only the view (measured, Obsidian 1.14.4).
      const editorStillShowsNote = owner
        ? owner.file === file &&
          owner.editor === editor &&
          editor.cm?.dom.isConnected !== false &&
          !(owner instanceof MarkdownView && owner.getMode() !== 'source')
        : !(editor.cm && !editor.cm.dom.isConnected);
      if (!editorStillShowsNote) {
        verboseLog(
          this.plugin,
          `Editor change read from file - editor no longer shows the note: ${file.path}`
        );
        await this.processFile(file, { hasActiveEditor: true });
        return;
      }

      // Always use editor content for change detection (avoid cache staleness)
      const currentContent = editor.getValue();

      // Detect if only frontmatter changed (skip processing to preserve YAML formatting)
      const previousContent = this.plugin.fileStateManager.getLastEditorContent(
        file.path
      );
      if (previousContent) {
        if (isOnlyFrontmatterChanged(currentContent, previousContent)) {
          verboseLog(
            this.plugin,
            `Skipping - only frontmatter edited: ${file.path}`
          );
          this.plugin.fileStateManager.setLastEditorContent(
            file.path,
            currentContent
          );
          return;
        }
      } else {
        // First editor event - compare editor vs disk to detect actual edits
        const diskContent = await this.plugin.app.vault.read(file);

        if (isOnlyFrontmatterChanged(currentContent, diskContent)) {
          // No body edits (or YAML-only edit) - skip processing
          verboseLog(
            this.plugin,
            `Skipping - no body edits detected on first open: ${file.path}`
          );
          // Initialize tracking for next edit
          const currentTitleRegion = this.extractTitleRegion(
            editor,
            currentContent
          );
          this.plugin.fileStateManager.setLastEditorContent(
            file.path,
            currentContent
          );
          this.plugin.fileStateManager.setTitleRegionCache(
            file.path,
            currentTitleRegion
          );
          return;
        }

        // Body content differs from disk - user edited body, proceed with processing
        verboseLog(this.plugin, `Body edited, will process: ${file.path}`);
      }

      // Extract title region and check cache
      const currentTitleRegion = this.extractTitleRegion(
        editor,
        currentContent
      );
      const cachedTitleRegion =
        this.plugin.fileStateManager.getTitleRegionCache(file.path);

      if (
        cachedTitleRegion &&
        currentTitleRegion.firstNonEmptyLine ===
          cachedTitleRegion.firstNonEmptyLine &&
        currentTitleRegion.titleSourceLine ===
          cachedTitleRegion.titleSourceLine &&
        currentTitleRegion.raw === cachedTitleRegion.raw
      ) {
        verboseLog(
          this.plugin,
          `Title region unchanged - skipping processing: ${file.path}`
        );
        return;
      }

      // Recorded only on the way to processing, so the content a skipped edit left is never taken for the last processed one
      this.plugin.fileStateManager.setLastEditorContent(
        file.path,
        currentContent
      );
      this.plugin.fileStateManager.setTitleRegionCache(
        file.path,
        currentTitleRegion
      );
      verboseLog(
        this.plugin,
        `Title region changed - processing: ${file.path}`,
        {
          previous: cachedTitleRegion,
          current: currentTitleRegion,
        }
      );

      verboseLog(
        this.plugin,
        `[TIMING] Content changed in ${Date.now() - startTime}ms: ${file.path}`
      );
      // Editor content rather than the cache, which lags the editor by up to Obsidian's autosave delay
      const providedContent = currentContent;
      await this.processFileImmediate(file, providedContent, editor);
    } catch (error) {
      console.error(
        `Error in editor-change processing for ${file.path}:`,
        error
      );
    }
  }

  /**
   * Extract title region (first non-empty line, title source text and whether it is shown as typed) from editor content
   */
  extractTitleRegion(
    editor: Editor,
    providedContent?: string
  ): TitleRegionCache {
    const content = providedContent || editor.getValue();

    // Properties boundary from the content itself: the cached frontmatterPosition lags the editor by up to Obsidian's autosave delay.
    const titleSource = findTitleSource(
      lineSourceFromText(content),
      this.plugin.settings,
      verboseLogger(this.plugin)
    );

    return {
      firstNonEmptyLine: titleSource?.firstNonEmptyLine ?? '',
      titleSourceLine: titleSource?.text ?? '',
      raw: titleSource?.raw ?? false,
      lastUpdated: Date.now(),
    };
  }

  async processFileImmediate(
    file: TFile,
    content?: string,
    editor?: Editor
  ): Promise<void> {
    // No exclusion check here: processFile applies it, with the caller's overrides

    verboseLog(
      this.plugin,
      `PROCESS: Starting immediate processFile for ${file.path}`
    );

    try {
      // hasActiveEditor because this is called from the editor-change event
      await this.processFile(file, {
        providedContent: content,
        hasActiveEditor: true,
        editor,
      });
    } catch (error) {
      console.error(`Error in immediate process for ${file.path}:`, error);
    }
  }

  /**
   * Run one rename pass for a note: gate it, rename it to its first line, and update its first line property.
   * @param file - Note to process
   * @param options - How the pass was started, and what the caller already holds
   */
  async processFile(
    file: TFile,
    options: ProcessFileOptions = {}
  ): Promise<RenameOutcome> {
    verboseLog(this.plugin, `Processing file: ${file.path}`);

    // The note can be deleted between the event and this pass
    const currentFile = this.plugin.app.vault.getAbstractFileByPath(file.path);
    if (!currentFile || !(currentFile instanceof TFile)) {
      verboseLog(
        this.plugin,
        `Skipping processing - file no longer exists or is not a TFile: ${file.path}`
      );
      return { success: false, reason: 'file-not-found' };
    }

    file = currentFile;

    if (file.extension !== 'md') {
      verboseLog(this.plugin, `Skipping non-Markdown file: ${file.path}`);
      return { success: false, reason: 'not-markdown' };
    }

    // Capture original path before acquiring lock (path may change during rename)
    const originalPath = file.path;

    // One call both tests and takes the lock, so no second pass can slip in between a check and an acquire
    if (!this.plugin.fileStateManager.acquireLock(originalPath)) {
      verboseLog(
        this.plugin,
        `Skipping - file operation already in progress: ${originalPath}`
      );
      return { success: false, reason: 'already-processing' };
    }

    // Track all paths that may need unlocking (prevents orphaned locks on external renames)
    const pathsToUnlock = new Set<string>([originalPath]);

    try {
      const result = await this.processFileInternal(file, options);

      // If file path changed during processing, track new path for cleanup
      if (file.path !== originalPath) {
        pathsToUnlock.add(file.path);
      }

      // The one place a rename pass updates the first line property, for every outcome that leaves the note's title source standing
      const firstLinePropertyHandlingReasons: readonly RenameOutcomeReason[] = [
        'renamed',
        'no-rename-needed',
        'empty-content-retained',
      ];
      if (
        firstLinePropertyHandlingReasons.includes(result.reason) &&
        hasFirstLinePropertyName(this.plugin.settings)
      ) {
        await this.updateFirstLinePropertyWithCoordination(
          file,
          options.exclusionOverrides,
          options.editor
        );
      }

      return result;
    } finally {
      // Release all tracked locks (handles both successful renames and external renames during processing)
      for (const path of pathsToUnlock) {
        this.plugin.fileStateManager.releaseLock(path);
      }

      // Check if content changed during processing (rapid edits during rename/first line property operations)
      const newPath = file.path;
      if (
        this.plugin.fileStateManager.hasPendingFirstLinePropertyRecheck(
          originalPath
        ) ||
        this.plugin.fileStateManager.hasPendingFirstLinePropertyRecheck(newPath)
      ) {
        verboseLog(
          this.plugin,
          `Content changed during processing with pending first line property recheck: ${originalPath}`
        );

        if (
          this.plugin.fileStateManager.hasThrottleTimer(originalPath) ||
          this.plugin.fileStateManager.hasThrottleTimer(newPath)
        ) {
          // A scheduled timer processes the latest text itself, and an immediate recheck would rename once more outside a linked note's delay.
          this.plugin.fileStateManager.clearPendingFirstLinePropertyRecheck(
            originalPath
          );
          if (newPath !== originalPath) {
            this.plugin.fileStateManager.clearPendingFirstLinePropertyRecheck(
              newPath
            );
          }
          verboseLog(
            this.plugin,
            `Pending first line property recheck flag cleared, the scheduled timer processes the latest text: ${newPath}`
          );
        } else if (findSourceEditorForFile(this.plugin.app, file)) {
          // Any editor counts, not just the active tab: keystrokes in a page preview or Canvas card set the flag too, and with no recheck the name would stop short of the first line until the next edit.
          this.plugin.fileStateManager.clearPendingFirstLinePropertyRecheck(
            originalPath
          );
          if (newPath !== originalPath) {
            this.plugin.fileStateManager.clearPendingFirstLinePropertyRecheck(
              newPath
            );
          }

          // Delayed so the editor's own change handling settles before the recheck reads it.
          window.setTimeout(() => {
            void (async () => {
              const recheckFile =
                this.plugin.app.vault.getAbstractFileByPath(newPath);
              if (recheckFile && recheckFile instanceof TFile) {
                // Re-resolved rather than reused, because a tab's editor can switch to another note during the delay.
                const target = findSourceEditorForFile(
                  this.plugin.app,
                  recheckFile
                );
                if (target) {
                  await this.processEditorChange(target.editor, recheckFile);
                }
              }
            })();
          }, TIMING.UI_SETTLE_DELAY_MS);
        } else {
          // No editor holds newer text to recheck against - the flag stays set and the next processFile on this file rechecks it
          verboseLog(
            this.plugin,
            `Pending first line property recheck flag stays set, next processFile on this file rechecks it: ${newPath}`
          );
        }
      }
    }
  }

  private async processFileInternal(
    file: TFile,
    options: ProcessFileOptions
  ): Promise<RenameOutcome> {
    const {
      isManualCommand = false,
      providedContent,
      isBatchOperation = false,
      exclusionOverrides,
      hasActiveEditor,
      editor,
    } = options;
    // canModifyFile's editor half, checked before the read because it needs no text: a background pass for a note no editor shows would otherwise read the note only to refuse it.
    if (
      !isManualCommand &&
      (hasActiveEditor === false ||
        (hasActiveEditor === undefined &&
          !isFileOpenInAnyEditor(file, this.plugin.app)))
    ) {
      verboseLog(
        this.plugin,
        `Skipping file: file not open in editor, refused before reading, so the BLOCKED dump has no text: ${file.path}`
      );
      this.plugin.outputDebugFileContent(file, 'BLOCKED');
      return { success: false, reason: 'not-open-in-editor' };
    }

    let initialContent: string;
    try {
      initialContent = await readFileContent(this.plugin, file, {
        providedContent,
        providedEditor: editor, // The editor a manual command or keystroke read from
        preferFresh: true,
        searchWorkspace: isManualCommand, // Manual commands search for open editors, page previews and Canvas cards included
      });
    } catch (error) {
      console.error(`Error reading file content: ${file.path}`, error);
      return { success: false, reason: 'read-error' };
    }

    // Central gate: check policy requirements and always-on safeguards. It reads the rename-blocking property from the note's text, so a note the metadata cache has not indexed yet (just created, or replaced by sync) still counts it; the cache is the fallback when the text has no parseable frontmatter. Its editor half runs again with its own leaf walk, because the read's await can close the editor.
    const verdict = canModifyFile(file, this.plugin.app, this.plugin.settings, {
      isManualCommand,
      hasActiveEditor,
      content: initialContent,
    });

    if (!verdict.canModify) {
      verboseLog(this.plugin, `Skipping file: ${verdict.reason}: ${file.path}`);

      // Output file content if debug setting enabled
      this.plugin.outputDebugFileContent(file, 'BLOCKED', initialContent);

      // A manual command skips the editor half, so it never meets `not-open-in-editor`, which only automatic passes reach and which shows no notice; the reason is checked anyway so that refusal can never show the rename-blocking property's notice.
      if (
        isManualCommand &&
        !isBatchOperation &&
        verdict.reason === 'disable-property'
      ) {
        new Notice(
          t('notifications.notRenamedDisableProperty', {
            filename: file.basename,
          })
        );
      }
      return {
        success: false,
        reason:
          verdict.reason === 'disable-property'
            ? 'property-disabled'
            : 'not-open-in-editor',
      };
    }

    // Output debug file content if enabled
    this.plugin.outputDebugFileContent(file, 'PROCESSING', initialContent);

    // Time-based rate limiting (per-file always enforced, global bypassed for batches)
    if (!this.checkFileTimeLimit(file)) {
      return { success: false, reason: 'time-rate-limited' };
    }

    // Global rate limiting bypassed for batch operations to avoid blocking legitimate bulk operations
    if (!isBatchOperation) {
      if (!this.checkGlobalRateLimit()) {
        return { success: false, reason: 'global-rate-limited' };
      }
    }

    // The text the gate approved, so the title never comes from a later read; built before the exclusion check, which reads tags typed into it ahead of the metadata cache, and its lines are read lazily, so a refused note costs no more than before
    let titleSource: TitleSource | null = findTitleSource(
      lineSourceFromText(initialContent),
      this.plugin.settings,
      verboseLogger(this.plugin)
    );

    // Pass exclusionOverrides to skip checks for manual single-file commands; only text whose tags Obsidian will index passes, so a tag in code, a card link's title or after an HTML comment block never excludes the note
    const excludingList = findExcludingList(
      file,
      this.plugin.settings,
      this.plugin.app,
      {
        content: initialContent,
        exclusionOverrides,
        log: verboseLogger(this.plugin),
        titleLine: titleSource?.tagsIndexed ? titleSource.text : undefined,
      }
    );
    if (excludingList !== null) {
      verboseLog(
        this.plugin,
        `Skipping file based on include/exclude strategy: ${file.path}`
      );
      if (isManualCommand && !isBatchOperation) {
        new Notice(
          t(EXCLUSION_NOTICE_KEYS[excludingList], { filename: file.basename })
        );
      }
      return { success: false, reason: 'excluded' };
    }

    const startTime = Date.now();
    verboseLog(this.plugin, `RENAME: Starting renameFile for ${file.name}`);

    const cacheManager = this.plugin.cacheManager;

    const currentName = file.basename;

    // No non-empty line after the properties block
    let contentBecameEmpty = false;
    if (titleSource === null) {
      if (cacheManager.hadBody(file.path)) {
        // Content was deleted - rename to Untitled
        verboseLog(
          this.plugin,
          `Content became empty - renaming to ${t('untitled')}: ${file.path}`
        );
        contentBecameEmpty = true;
        titleSource = {
          firstNonEmptyLine: t('untitled'),
          text: t('untitled'),
          lineIndex: -1,
          raw: false,
          tagsIndexed: false,
        };
      } else {
        // File was always empty - retain current filename
        cacheManager.setHadBody(file.path, false);

        // A distinct outcome rather than a refusal: processFile's first line property step still runs for it and removes a stale plugin value from the empty note
        verboseLog(
          this.plugin,
          `Skipping rename for empty file - retaining current filename: ${file.path}`
        );
        return { success: false, reason: 'empty-content-retained' };
      }
    }

    // Check if only headings should be processed. The title source decides, so a `# Title` after a rule or comment block passes and a fenced `# comment` (code, not a heading) does not.
    if (this.plugin.settings.core.onlyRenameIfHeading) {
      // Only the content-became-empty fallback is exempt, so deleting a note's text still renames it Untitled; synthetic titles such as Table or a card link's are no heading and stay refused.
      if (
        !contentBecameEmpty &&
        (titleSource.raw || !isValidHeading(titleSource.text))
      ) {
        verboseLog(
          this.plugin,
          `Skipping file - first line is not a valid heading: ${file.path}`
        );

        // Show notice if requested and not in batch operation
        if (isManualCommand && !isBatchOperation) {
          new Notice(
            t('notifications.notRenamedNoHeading', { filename: file.basename })
          );
        }

        return { success: false, reason: 'not-heading' };
      }
    }

    // Recorded for the next pass, which reads it when the body comes up empty; not when the content became empty, whose synthetic Untitled is no body
    if (!contentBecameEmpty) {
      cacheManager.setHadBody(file.path, true);
    }

    const newTitle = buildTitleFromSource(titleSource, this.plugin);
    verboseLog(this.plugin, `Extracted title from ${file.path}`, {
      firstNonEmptyLine: titleSource.firstNonEmptyLine,
      titleSource: titleSource.text,
      raw: titleSource.raw,
      extracted: newTitle,
    });

    const parentPath = file.parent?.path === '/' ? '' : file.parent?.path + '/';

    let newPath: string = `${parentPath}${newTitle}.md`;

    verboseLog(
      this.plugin,
      `Initial target path: ${newPath} for file: ${file.path}`
    );
    if (file.path === newPath) {
      verboseLog(
        this.plugin,
        `No rename needed for ${file.path} - already has correct name`
      );
      this.showManualRenameNotice(
        currentName,
        newPath,
        newTitle,
        isManualCommand,
        isBatchOperation
      );
      return { success: true, reason: 'no-rename-needed' };
    }

    // Only text read from disk can trail a rename this recent; editor text is always current
    // The vacated path is not needed: the renamed note's own `TFile.path` is the new one, and a note found at the vacated path is a different note whose disk text cannot trail this rename
    if (
      !providedContent &&
      this.plugin.fileStateManager.wasRecentlyRenamedInto(file.path)
    ) {
      verboseLog(
        this.plugin,
        `Skipping rename - file was recently renamed, disk may be stale: ${file.path}`
      );
      return { success: false, reason: 'recently-renamed' };
    }

    let counter: number = 0;
    let fileExists: boolean = this.isRenameTargetTaken(newPath, file);

    verboseLog(
      this.plugin,
      `Conflict check for ${newPath}: fileExists=${fileExists}`
    );
    if (fileExists) {
      verboseLog(
        this.plugin,
        `Found conflicts for ${newPath}, starting counter loop`
      );
      let conflictCount = 0;
      while (fileExists && conflictCount < LIMITS.MAX_CONFLICT_ITERATIONS) {
        conflictCount++;
        counter += 1;
        newPath = `${parentPath}${newTitle} ${counter}.md`;
        fileExists = this.isRenameTargetTaken(newPath, file, false); // Don't log individual conflicts
      }

      // Still taken after the last candidate: the limit stopped the loop, not a free name
      if (fileExists) {
        console.error(
          `Max conflict iterations (${LIMITS.MAX_CONFLICT_ITERATIONS}) reached for ${file.path}. Aborting rename to prevent infinite loop.`
        );
        return { success: false, reason: 'max-conflicts-exceeded' };
      }

      verboseLog(
        this.plugin,
        `Found available filename with counter ${counter} after checking ${conflictCount} conflicts`
      );
    } else {
      verboseLog(
        this.plugin,
        `No conflicts found for ${newPath}, proceeding without counter`
      );
    }

    // The note's own path never counts as taken, so a note already holding the first free counter name (`Foo 1.md` beside `Foo.md`) lands back on its own path; renaming it there would report `renamed` and arm the recently-renamed guards on every pass.
    if (newPath === file.path) {
      verboseLog(
        this.plugin,
        `No rename needed for ${file.path} - already has correct name with counter`
      );
      this.showManualRenameNotice(
        currentName,
        newPath,
        newTitle,
        isManualCommand,
        isBatchOperation
      );
      return { success: true, reason: 'no-rename-needed' };
    }

    if (this.isTitleSourceSelfReferencing(file, titleSource)) {
      if (!isBatchOperation) {
        // Rate limit: show notice max once per 2 seconds per file
        if (this.plugin.fileStateManager.canShowSelfRefNotice(file.path)) {
          verboseLog(
            this.plugin,
            `Showing notice: File not renamed due to self-referential link in first line: ${file.basename}`
          );
          new Notice(
            t('notifications.notRenamedSelfReference', {
              filename: file.basename,
            })
          );
          this.plugin.fileStateManager.setLastSelfRefNotice(file.path);
        }
      }
      verboseLog(this.plugin, `Skipping self-referencing file: ${file.path}`);
      return { success: false, reason: 'self-referential' };
    }

    // Claims the destination until the vault index catches up, so a sibling rename resolving to the same title in the same batch takes a counter suffix instead of colliding
    cacheManager.reservePath(newPath);

    const oldPath = file.path;
    const renameReport = {
      oldPath,
      newPath,
      currentName,
      newTitle,
      startTime,
      isManualCommand,
      isBatchOperation,
    };
    try {
      await this.plugin.app.fileManager.renameFile(file, newPath);
    } catch (error) {
      if (
        newPath.toLowerCase() === oldPath.toLowerCase() &&
        (await this.renameCaseOnlyThroughTemporaryName(
          file,
          oldPath,
          newPath,
          parentPath
        ))
      ) {
        verboseLog(
          this.plugin,
          `Direct case-only rename of ${oldPath} to ${newPath} was rejected, renamed through a temporary name instead:`,
          error
        );
        return this.completeRename(renameReport);
      }
      // The rename never took the path and only notifyFileRenamed releases reservations, so keeping this one would wedge the title for the rest of the session outside a modal batch
      cacheManager.releasePath(newPath);
      console.error(`Failed to rename file ${oldPath} to ${newPath}:`, error);
      return { success: false, reason: 'error' };
    }
    return this.completeRename(renameReport);
  }

  /**
   * Record a finished rename everywhere that tracks notes by path, and show the manual command's notice.
   * @param report - The rename's paths, the names the notice compares, and how the pass was started
   * @returns The `renamed` outcome
   */
  private completeRename(report: {
    oldPath: string;
    newPath: string;
    currentName: string;
    newTitle: string;
    startTime: number;
    isManualCommand: boolean;
    isBatchOperation: boolean;
  }): RenameOutcome {
    const { oldPath, newPath } = report;
    verboseLog(
      this.plugin,
      `Successfully renamed ${oldPath} to ${newPath} (${Date.now() - report.startTime}ms)`
    );

    // Only the rename's own record is left to write: the vault `rename` event fires before `renameFile` resolves (desktop and Android, Obsidian 1.14.4, measured), so its handler has already moved every per-path state to the new path
    // The new path only: a late event for this note carries its `TFile`, whose path is already the new one, and a note created at the vacated path (Cmd+N reusing `Untitled`, a click on a link to the old name) is new to both guards
    this.plugin.fileStateManager.markRecentlyRenamedInto(newPath);

    this.showManualRenameNotice(
      report.currentName,
      newPath,
      report.newTitle,
      report.isManualCommand,
      report.isBatchOperation
    );

    return { success: true, reason: 'renamed' };
  }

  /**
   * True when the title source holds a link to the note itself. Checked on the title source as typed, so custom replacements cannot change the characters the link is compared by.
   * @param file - Note being renamed
   * @param titleSource - Where the title comes from
   */
  private isTitleSourceSelfReferencing(
    file: TFile,
    titleSource: TitleSource
  ): boolean {
    const kind: SelfReferenceKind | null =
      findSelfReferenceInText(titleSource.text, file) ??
      (cachedLinkOnLinePointsAtNote(
        this.plugin.app.metadataCache.getFileCache(file),
        file,
        titleSource.lineIndex
      )
        ? 'cached link'
        : null);
    verboseLog(
      this.plugin,
      kind
        ? `Self-reference found in ${file.path}: ${kind}`
        : `No self-reference found in ${file.path}`
    );
    return kind !== null;
  }

  /**
   * Show the notice a manual command reports its result with, as the notification mode setting allows.
   * @param currentName - The note's name before the pass
   * @param finalPath - Path the note ends the pass at
   * @param newTitle - Title the pass derived, the fallback when the path yields no name
   * @param isManualCommand - Whether a manual command started the pass
   * @param isBatchOperation - Whether the pass is one of a bulk run, which reports on its own
   */
  private showManualRenameNotice(
    currentName: string,
    finalPath: string,
    newTitle: string,
    isManualCommand: boolean,
    isBatchOperation: boolean
  ): void {
    if (!isManualCommand || isBatchOperation) {
      return;
    }
    // Extract actual final filename from the path (includes counter if added)
    const finalFileName =
      finalPath.replace(/\.md$/, '').split('/').pop() || newTitle;
    const titleChanged = currentName !== finalFileName;
    const shouldShowNotice =
      this.plugin.settings.core.manualNotificationMode === 'Always' ||
      (this.plugin.settings.core.manualNotificationMode === 'On title change' &&
        titleChanged);

    if (shouldShowNotice) {
      verboseLog(
        this.plugin,
        `Showing notice: ${currentName} → ${finalFileName}`
      );
      new Notice(t('notifications.renamedTo', { filename: finalFileName }));
    }
  }

  /**
   * Retry a case-only rename the direct call rejected, as two `vault.rename` steps through an unused temporary name.
   * Obsidian's mobile adapter never marks itself case-insensitive and rejects a destination whose stat succeeds, which Android's case-folding storage reports for a case variant of the note's own name.
   * `vault.rename` skips link updates, which a case-only change does not need because Obsidian resolves links ignoring case (Canvas rewrites its card paths from the vault `rename` event itself).
   * @param file - Note to rename
   * @param oldPath - The note's path before the attempt
   * @param newPath - Case variant of `oldPath` to arrive at
   * @param parentPath - The note's folder path with a trailing slash, empty at the vault root
   * @returns True when the note now sits at `newPath`
   */
  private async renameCaseOnlyThroughTemporaryName(
    file: TFile,
    oldPath: string,
    newPath: string,
    parentPath: string
  ): Promise<boolean> {
    const temporaryPath = `${parentPath}${file.basename}.flit-case-${Date.now()}.md`;
    if (this.plugin.app.vault.getAbstractFileByPath(temporaryPath)) {
      console.error(
        `Case-only rename of ${oldPath} skipped - temporary path already exists: ${temporaryPath}`
      );
      return false;
    }

    try {
      await this.plugin.app.vault.rename(file, temporaryPath);
    } catch (error) {
      console.error(
        `Case-only rename of ${oldPath} failed at its first step:`,
        error
      );
      return false;
    }

    try {
      await this.plugin.app.vault.rename(file, newPath);
      return true;
    } catch (error) {
      console.error(
        `Case-only rename of ${oldPath} failed at its second step, restoring the name:`,
        error
      );
      try {
        await this.plugin.app.vault.rename(file, oldPath);
      } catch (restoreError) {
        // The next pass renames the temporary name straight to the title: it is no case variant of the title, and the caller's error branch releases the title's reservation.
        console.error(
          `Could not restore ${oldPath}, the note stays at ${temporaryPath}:`,
          restoreError
        );
      }
      return false;
    }
  }

  /**
   * True when `path` is unavailable as a rename destination for `file`: another
   * file already sits there or differs from it only by case, or a rename
   * already in flight has reserved it. The note itself never counts.
   */
  private isRenameTargetTaken(
    path: string,
    file: TFile,
    logConflict: boolean = true
  ): boolean {
    // Performance: Fast path for exact match (O(1) hash lookup)
    const exactMatch = this.plugin.app.vault.getAbstractFileByPath(path);
    if (exactMatch !== null && exactMatch !== file) {
      if (logConflict) {
        verboseLog(
          this.plugin,
          `Exact file conflict found: ${path} (existing file: ${exactMatch.path})`
        );
      }
      return true;
    }

    if (this.hasSiblingCaseClash(path, file, logConflict)) {
      return true;
    }

    // A case variant of the note's own path is reserved by the note itself: `notifyFileRenamed` reserves every path a rename arrives at, and reservations ignore case.
    if (
      path.toLowerCase() !== file.path.toLowerCase() &&
      this.plugin.cacheManager.isPathReserved(path)
    ) {
      if (logConflict) {
        verboseLog(this.plugin, `Reserved path conflict found: ${path}`);
      }
      return true;
    }

    return false;
  }

  /**
   * True when a note's sibling other than the note itself has the target's name under a different case, which a case-insensitive file system treats as the same file.
   * Siblings are the only possible clash, since every rename target is built from `file.parent.path`.
   * @param path - Rename target
   * @param file - Note being renamed
   * @param logConflict - Whether to log a clash
   */
  private hasSiblingCaseClash(
    path: string,
    file: TFile,
    logConflict: boolean
  ): boolean {
    const targetName = (path.split('/').pop() ?? path).toLowerCase();
    for (const child of file.parent?.children ?? []) {
      if (child !== file && child.name.toLowerCase() === targetName) {
        if (logConflict) {
          verboseLog(
            this.plugin,
            `Case-insensitive file conflict found: ${path} (existing file: ${child.path})`
          );
        }
        return true;
      }
    }
    return false;
  }
}
