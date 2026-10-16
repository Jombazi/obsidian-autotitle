import { TFile, MarkdownView, MarkdownFileInfo, Editor } from 'obsidian';
import { verboseLog, verboseLogger } from '../utils';
import {
  TitleSource,
  findTitleSource,
  lineSourceFromEditor,
  sameTitleSource,
} from '../utils/title-source';
import { isLinkedFromAnyFile } from '../utils/inbound-links';
import { TIMING } from '../constants/timing';
import FirstLineIsTitle from '../../main';

// A closed page preview keeps its 2 s save pending; this many re-arms at the save-complete delay outlast it before the timer processes anyway.
const MAX_UNSAVED_PREVIEW_REARMS = 25;

/** Where an `editor-change` came from, as the throttle needs it */
interface EditorChangeOptions {
  /** True when the editor belongs to a Canvas card */
  inCanvasCard?: boolean;
  /** The `editor-change` event's `info`: the tab's view, or the page preview's or Canvas card's embed */
  owner?: MarkdownView | MarkdownFileInfo;
}

/**
 * Check whether an embed's editor is gone while the embed still holds typing it has not saved.
 * @param owner - The `editor-change` event's `info`
 * @param editor - Editor the edit came from
 * @returns true for a page preview closed before its save landed
 */
function isClosedWithUnsavedTyping(
  owner: MarkdownView | MarkdownFileInfo | undefined,
  editor: Editor
): boolean {
  // A tab saves when it closes or switches notes, and a Canvas card flushes its save on deselect.
  if (!owner || owner instanceof MarkdownView) return false;
  return owner.editor !== editor && 'dirty' in owner && owner.dirty === true;
}

/**
 * EditorLifecycleManager
 *
 * Tracks open editors and schedules the processing of first line changes.
 *
 * Responsibilities:
 * - Track open editors and their first line content
 * - Process a first line change after the Check interval, or after a linked note's typing pause
 * - Process a pending change at once when its tab closes, and rename a note when it gains focus
 * - Hold the new-note creation delay timers and the creation pipeline's hold on each new note
 */
export class EditorLifecycleManager {
  private plugin: FirstLineIsTitle;

  // Track active editors for tab close detection
  private activeEditorFiles = new Map<
    string,
    {
      file: TFile;
      editor: Editor;
      lastTitleSource: TitleSource | null | undefined;
      leafId: string;
    }
  >();

  // Track files in creation delay period with their timer references
  private creationDelayTimers = new Map<string, number>();

  /** Notes the new-note pipeline has not yet given a title and a cursor, keyed by `TFile` because Templater can rename or move a note during its wait, and a note created later at the same path is another object */
  private readonly notesInCreationPipeline = new WeakSet<TFile>();

  // Track files that were just processed on tab close to prevent duplicate processing
  // Performance optimization: prevents redundant checks from multiple workspace events
  private recentlyProcessedCloses = new Set<string>();

  // Track last focused file for rename-on-focus detection
  private lastFocusedFile: string | null = null;

  // Track previous count for logging only on changes
  private previousActiveFileCount: number = 0;

  /** When each note was last treated as linked, keyed by `TFile` because the object survives renames */
  private readonly lastSeenLinkedAt = new WeakMap<TFile, number>();

  /** Paths the last walk of the resolved links found no link to; cleared on every metadata `resolve`, so it never outlives a link change */
  private readonly unlinkedPaths = new Set<string>();

  constructor(plugin: FirstLineIsTitle) {
    this.plugin = plugin;
  }

  get app() {
    return this.plugin.app;
  }

  get settings() {
    return this.plugin.settings;
  }

  get isFullyLoaded() {
    return this.plugin.isFullyLoaded;
  }

  get renameEngine() {
    return this.plugin.renameEngine;
  }

  /**
   * Set creation delay timer for a file
   */
  setCreationDelayTimer(filePath: string, timer: number): void {
    this.creationDelayTimers.set(filePath, timer);
    verboseLog(this.plugin, `Set creation delay timer for: ${filePath}`);
  }

  /**
   * Clear creation delay timer for a file
   */
  clearCreationDelayTimer(filePath: string): void {
    const timer = this.creationDelayTimers.get(filePath);
    if (timer) {
      window.clearTimeout(timer);
      this.creationDelayTimers.delete(filePath);
      verboseLog(this.plugin, `Cleared creation delay timer for: ${filePath}`);
    }
  }

  /**
   * Check if a file is in creation delay period
   */
  private isFileInCreationDelay(filePath: string): boolean {
    return this.creationDelayTimers.has(filePath);
  }

  /**
   * Hold FLIT's own editor-change, focus and event passes off a new note until the creation pipeline releases it
   * @param file - Note the vault `create` event reports
   */
  holdForCreationPipeline(file: TFile): void {
    this.notesInCreationPipeline.add(file);
  }

  /**
   * End the hold `holdForCreationPipeline` put on a note; harmless when none is held
   * @param file - Note the creation pipeline is done with
   */
  releaseFromCreationPipeline(file: TFile): void {
    this.notesInCreationPipeline.delete(file);
  }

  /**
   * Check whether the new-note pipeline or the New note delay still owns a note, so FLIT's own passes leave it alone
   * @param file - Note an editor-change, focus or event pass is about to process
   */
  isFileInCreationWindow(file: TFile): boolean {
    return (
      this.notesInCreationPipeline.has(file) ||
      this.isFileInCreationDelay(file.path)
    );
  }

  /**
   * Clear all creation delay timers (for plugin unload)
   */
  clearAllCreationDelayTimers(): void {
    for (const timer of this.creationDelayTimers.values()) {
      window.clearTimeout(timer);
    }
    this.creationDelayTimers.clear();
    verboseLog(this.plugin, 'Cleared all creation delay timers');
  }

  /**
   * Start tracking open editors and link resolution, clearing any earlier tracking first
   */
  initializeCheckingSystem(): void {
    // Clear any existing system
    this.clearCheckingSystems();

    // Always track active editors for tab close detection
    this.trackActiveEditors();

    this.trackLinkResolution();
  }

  /**
   * Register workspace events to track open editors
   */
  private trackActiveEditors(): void {
    // Register workspace events to track open editors
    this.plugin.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        void this.updateActiveEditorTracking();
      })
    );

    this.plugin.registerEvent(
      this.app.workspace.on('layout-change', () => {
        void this.updateActiveEditorTracking();
      })
    );

    // Initial tracking
    void this.updateActiveEditorTracking();
  }

  /**
   * Forget every cached unlinked answer whenever Obsidian resolves a note's links, so the negative cache never holds a stale entry
   */
  private trackLinkResolution(): void {
    // A note's own autosave re-index fires `resolve` about every 2 s while it is edited, so an unlinked note's walk drops from once per first-line keystroke to about once per autosave, not to once.
    this.plugin.registerEvent(
      this.app.metadataCache.on('resolve', () => {
        this.unlinkedPaths.clear();
      })
    );
  }

  /**
   * Update tracking of active editors
   */
  async updateActiveEditorTracking(): Promise<void> {
    const markdownViews = this.app.workspace.getLeavesOfType('markdown');
    const newActiveFiles = new Map<
      string,
      {
        file: TFile;
        editor: Editor;
        lastTitleSource: TitleSource | null | undefined;
        leafId: string;
      }
    >();

    // Track which leafIds are currently active
    const activeLeafIds = new Set<string>();

    // Build new active files map
    for (const leaf of markdownViews) {
      // A deferred leaf's view is no MarkdownView and has no file or editor (measured, Obsidian 1.14.4), so it is skipped until the leaf loads
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && view.editor) {
        try {
          const leafId = leaf.id;
          if (!leafId) continue;

          activeLeafIds.add(leafId);

          const existing = this.activeEditorFiles.get(view.file.path);

          newActiveFiles.set(view.file.path, {
            file: view.file,
            editor: view.editor,
            lastTitleSource: existing ? existing.lastTitleSource : undefined, // Preserve existing (even if undefined)
            leafId: leafId,
          });
        } catch (error) {
          console.error(`Error tracking editor for ${view.file.path}:`, error);
        }
      }
    }

    // Process files that were closed (in old map but not in new map)
    if (this.isFullyLoaded && this.settings.core.renameAutomatically) {
      for (const [filePath, oldData] of this.activeEditorFiles) {
        if (!newActiveFiles.has(filePath)) {
          // Check if this TFile object still exists in new tracking (just renamed, not closed)
          let stillOpen = false;
          for (const newData of newActiveFiles.values()) {
            if (newData.file === oldData.file) {
              stillOpen = true;
              verboseLog(
                this.plugin,
                `File ${filePath} was renamed, not closed - skipping tab close processing`
              );
              break;
            }
          }

          if (stillOpen) {
            continue; // File was renamed, not actually closed
          }

          // Tracked from an editor-change with no leaf: a Canvas card or page preview, which no Markdown leaf ever lists, so its absence here is no close; its timer checks its own editor when it fires
          if (!oldData.leafId) {
            continue;
          }

          // Check if the leaf that had this file is still active (tab switch vs tab close)
          if (activeLeafIds.has(oldData.leafId)) {
            verboseLog(
              this.plugin,
              `File ${filePath} switched in same tab (leaf ${oldData.leafId} still active) - skipping tab close processing`
            );
            continue; // Tab still exists, just switched files
          }

          // Check if we already processed this file's close recently (prevent duplicate processing)
          if (this.recentlyProcessedCloses.has(filePath)) {
            verboseLog(
              this.plugin,
              `File ${filePath} already processed on tab close - skipping duplicate`
            );
            continue;
          }

          // Tab actually closed - handle based on pending delays
          verboseLog(this.plugin, `Tab closed for: ${filePath}`);

          // Mark as processed to prevent duplicate processing from multiple events
          this.recentlyProcessedCloses.add(filePath);
          window.setTimeout(() => {
            this.recentlyProcessedCloses.delete(filePath);
          }, 250); // Clear after 250ms to handle slow workspace events

          // Check if there's a pending throttle timer (first line was modified)
          const hasThrottleTimer =
            this.plugin.fileStateManager.hasThrottleTimer(filePath);

          if (hasThrottleTimer) {
            // Tab close overrides throttle delay - process immediately
            verboseLog(
              this.plugin,
              `Tab close overriding throttle timer for: ${filePath}`
            );
            this.plugin.fileStateManager.clearThrottleTimer(filePath);

            verboseLog(
              this.plugin,
              `Processing immediately due to pending throttle: ${filePath}`
            );
            try {
              // hasActiveEditor because throttle was created when editor was active
              await this.renameEngine.processFile(oldData.file, {
                hasActiveEditor: true,
              });
            } catch (error) {
              console.error(`Error processing closed file ${filePath}:`, error);
            }
          } else {
            // No pending throttle - do nothing
            // Tab close with unsaved changes triggers immediate save → modify event
            verboseLog(
              this.plugin,
              `Tab closed with no pending throttle: ${filePath} - no action needed`
            );
          }
        }
      }
    }

    this.activeEditorFiles = newActiveFiles;

    // Only log if count changed to reduce spam from excessive workspace events
    if (this.activeEditorFiles.size !== this.previousActiveFileCount) {
      verboseLog(
        this.plugin,
        `Tracking ${this.activeEditorFiles.size} active editor files for tab close detection`
      );
      this.previousActiveFileCount = this.activeEditorFiles.size;
    }

    // Handle rename-on-focus: detect when active file changes.
    // Gated on renameAutomatically like every other automatic path, because the
    // settings row is hidden when that is off — an ungated read would keep
    // renaming with no surface left to stop it.
    if (
      this.settings.core.renameOnFocus &&
      this.settings.core.renameAutomatically &&
      this.isFullyLoaded
    ) {
      const currentActiveFile = this.app.workspace.getActiveFile();
      if (currentActiveFile && currentActiveFile.extension === 'md') {
        const currentPath = currentActiveFile.path;

        // Only process if the focused file actually changed
        if (currentPath !== this.lastFocusedFile) {
          // Skip files in the creation window - the creation rename handles them
          // Check BEFORE updating lastFocusedFile so re-focus after delay works
          if (this.isFileInCreationWindow(currentActiveFile)) {
            verboseLog(
              this.plugin,
              `Skipping focus rename: file in creation window: ${currentPath}`
            );
            // Don't update lastFocusedFile - allows re-trigger when delay expires
            return;
          }

          this.lastFocusedFile = currentPath;

          verboseLog(this.plugin, `File focused: ${currentPath}`);

          // Process file with rename-on-focus (async but don't await to avoid blocking)
          // hasActiveEditor because file just became active
          this.renameEngine
            .processFile(currentActiveFile, { hasActiveEditor: true })
            .catch((error) => {
              console.error(
                `Error processing rename-on-focus for ${currentPath}:`,
                error
              );
            });
        }
      }
    }
  }

  /**
   * Handle every editor change: start a timer for the Check interval (0 included) only when the first line changed from its last known state
   * A note another file links to, or one edited in a Canvas card, waits until typing pauses instead, since each of its renames raises Obsidian's link-update notices
   */
  handleEditorChangeWithThrottle(
    editor: Editor,
    file: TFile,
    options?: EditorChangeOptions
  ): void {
    const filePath = file.path;

    // Skip files in the creation window
    if (this.isFileInCreationWindow(file)) {
      verboseLog(
        this.plugin,
        `File in creation window, skipping throttle: ${filePath}`
      );
      return;
    }

    // Skip the plugin's own programmatic writes, which fire editor-change exactly as a keystroke does: title insertion also runs inside the creation window above, but the delayed cursor pass's line break below a closing fence and first line property writes into the editor run outside it
    // Checked here rather than only in processEditorChange: this handler runs synchronously with the write, while that one runs from a throttle timer, by which point the flag has already been cleared
    if (this.plugin.fileStateManager.isEditorSyncing(filePath)) {
      verboseLog(
        this.plugin,
        `Editor change from plugin's own write, skipping throttle: ${filePath}`
      );
      return;
    }

    // Get the current title source
    const currentTitleSource = this.extractFirstLineFromEditor(editor, file);

    // Get last known first line from tracking
    let tracked = this.activeEditorFiles.get(filePath);

    // If file not tracked yet (first change event before workspace event), initialize it now
    if (!tracked) {
      tracked = {
        file: file,
        editor: editor,
        lastTitleSource: undefined, // Initialize as undefined so first change is processed
        leafId: '', // Will be set properly by updateActiveEditorTracking
      };
      this.activeEditorFiles.set(filePath, tracked);
      verboseLog(
        this.plugin,
        `Initialized tracking on first editor change for ${filePath}: "${currentTitleSource?.text ?? ''}"`
      );
    }

    // TypeScript: tracked is always defined here (either from get() or newly created)
    const lastTitleSource = tracked.lastTitleSource;

    // If the title source hasn't changed, skip throttle
    // Explicit check: if lastTitleSource is defined and matches current, no processing needed
    if (
      lastTitleSource !== undefined &&
      sameTitleSource(currentTitleSource, lastTitleSource)
    ) {
      verboseLog(
        this.plugin,
        `First line unchanged for ${filePath}, skipping throttle`
      );

      // Keeps the compared text current so a later check reads a properties-only edit as one; skipped while a timer waits, since a repeated editor-change with unchanged text (a Canvas card fires one per keystroke) or an edit on another line would otherwise erase the change that timer is waiting to process.
      // The CodeMirror document rather than `getValue()`, which would join the whole note on every such keystroke; it is immutable and converted only when compared.
      if (!this.plugin.fileStateManager.hasThrottleTimer(filePath)) {
        this.plugin.fileStateManager.setLastEditorContent(
          filePath,
          editor.cm?.state.doc ?? editor.getValue()
        );
      }

      return;
    }

    // First line changed - update tracking
    tracked.lastTitleSource = currentTitleSource;

    const owner = options?.owner;

    // Each first-line edit of a linked note restarts its wait; the pending delayed timer already settled that the note counts as linked, so links are not scanned again.
    if (this.plugin.fileStateManager.hasDelayedThrottleTimer(filePath)) {
      this.lastSeenLinkedAt.set(file, Date.now());
      verboseLog(
        this.plugin,
        `Restarting linked-note delay (${this.getLinkedNoteDelay()}ms) for: ${filePath}`
      );
      this.scheduleThrottleTimer(editor, file, owner, true);
      return;
    }

    // Check if timer already running for this file
    if (this.plugin.fileStateManager.hasThrottleTimer(filePath)) {
      verboseLog(
        this.plugin,
        `Throttle timer already running for: ${filePath}, not starting new one`
      );
      return;
    }

    const delayed = this.countsAsLinked(file, options?.inCanvasCard ?? false);
    verboseLog(
      this.plugin,
      delayed
        ? `Starting linked-note delay (${this.getLinkedNoteDelay()}ms) for: ${filePath}`
        : `Starting throttle timer (${this.settings.core.checkInterval}ms) for: ${filePath}`
    );
    this.seedEditorContentBaseline(file);
    this.scheduleThrottleTimer(editor, file, owner, delayed);
  }

  /**
   * Seed the content a throttled change is compared against, from the file as it was before this edit.
   * @param file - Note being edited
   */
  private seedEditorContentBaseline(file: TFile): void {
    const { fileStateManager } = this.plugin;
    if (fileStateManager.hasLastEditorContent(file.path)) return;
    // Without a baseline the timer compares the editor with the file, but a tab or Canvas card saves 2 s after its first unsaved keystroke rather than its last, often before a linked note's timer fires: the two then match and the rename is skipped. An edit fires before its save, so the file still holds the text from before it.
    void this.app.vault.cachedRead(file).then(
      (content) => {
        if (!fileStateManager.hasLastEditorContent(file.path)) {
          fileStateManager.setLastEditorContent(file.path, content);
        }
      },
      () => {}
    );
  }

  /** How long a linked note waits after its last first-line edit */
  private getLinkedNoteDelay(): number {
    return Math.max(
      TIMING.LINKED_NOTE_RENAME_DELAY_MS,
      this.settings.core.checkInterval
    );
  }

  /**
   * Decide whether a note's rename waits for typing to pause, and remember the answer when it does.
   * @param file - Note being edited
   * @param inCanvasCard - True when the edit comes from a Canvas card
   * @returns true when the note counts as linked
   */
  private countsAsLinked(file: TFile, inCanvasCard: boolean): boolean {
    const seenLinkedAt = this.lastSeenLinkedAt.get(file);
    // A card just added to a canvas is linked only once the canvas saves and is re-indexed, about 2 s later, and a note just renamed reads as unlinked until its links are re-resolved, about 530 ms for a canvas.
    const linked =
      inCanvasCard ||
      (seenLinkedAt !== undefined &&
        Date.now() - seenLinkedAt < TIMING.LINKED_NOTE_MEMORY_MS) ||
      this.isLinkedByResolvedLinks(file);
    if (linked) {
      this.lastSeenLinkedAt.set(file, Date.now());
    }
    return linked;
  }

  /**
   * Walk the resolved links for a note, unless a walk since links were last resolved found none; only the unlinked answer is cached, since a linked one is already remembered by the pending delayed timer and the memory window.
   * @param file - Note being edited
   * @returns true when any source in the resolved link map lists the note
   */
  private isLinkedByResolvedLinks(file: TFile): boolean {
    if (this.unlinkedPaths.has(file.path)) return false;
    const linked = isLinkedFromAnyFile(this.app, file);
    if (!linked) {
      this.unlinkedPaths.add(file.path);
    }
    return linked;
  }

  /**
   * Start, or restart, the timer that processes a note's first-line edit.
   * @param editor - Editor the edit came from
   * @param file - Note being edited
   * @param owner - The `editor-change` event's `info`, which tells whether the editor still shows the note
   * @param delayed - True to wait out a linked note's typing pause rather than the Check interval
   * @param delayMs - Wait before processing; defaults from `delayed`
   * @param rearmsLeft - Re-arms still allowed while a closed page preview's save is pending
   */
  private scheduleThrottleTimer(
    editor: Editor,
    file: TFile,
    owner: MarkdownView | MarkdownFileInfo | undefined,
    delayed: boolean,
    delayMs = delayed
      ? this.getLinkedNoteDelay()
      : this.settings.core.checkInterval,
    rearmsLeft = MAX_UNSAVED_PREVIEW_REARMS
  ): void {
    const timer = window.setTimeout(() => {
      if (delayed) {
        // Stamped when the timer fires so the memory window runs from the rename itself, whatever the burst length or Check interval.
        this.lastSeenLinkedAt.set(file, Date.now());
      }

      // A closed page preview's file still holds the old text until its pending save lands, and that save's modify writes only the property.
      if (rearmsLeft > 0 && isClosedWithUnsavedTyping(owner, editor)) {
        verboseLog(
          this.plugin,
          `Page preview closed with unsaved typing, waiting for its save: ${file.path}`
        );
        this.scheduleThrottleTimer(
          editor,
          file,
          owner,
          delayed,
          TIMING.SAVE_COMPLETE_DELAY_MS,
          rearmsLeft - 1
        );
        return;
      }

      verboseLog(
        this.plugin,
        `Throttle timer expired, processing: ${file.path}`
      );

      // Remove timer from tracking (use file.path for current location after potential renames)
      this.plugin.fileStateManager.clearThrottleTimer(file.path);

      // Process file
      this.renameEngine
        .processEditorChange(editor, file, owner)
        .catch((error) => {
          console.error(
            `Error processing throttled change for ${file.path}:`,
            error
          );
        });
    }, delayMs);

    this.plugin.fileStateManager.setThrottleTimer(file.path, timer, delayed);
  }

  /**
   * Clear the throttle timers and editor tracking; creation delay timers stay, since `clearAllCreationDelayTimers` clears them on unload
   */
  clearCheckingSystems(): void {
    // Clear all throttle timers via FileStateManager
    this.plugin.fileStateManager.clearAllThrottleTimers();

    this.activeEditorFiles.clear();
  }

  /**
   * Extract the title source from editor content
   * @returns null when the body holds no non-empty line
   */
  public extractFirstLineFromEditor(
    editor: Editor,
    file: TFile
  ): TitleSource | null {
    try {
      // Read line by line through CodeMirror, so a keystroke never joins or splits the whole note; the properties boundary comes from the editor too, as the cached frontmatterPosition lags it by up to Obsidian's autosave delay.
      return findTitleSource(
        lineSourceFromEditor(editor),
        this.plugin.settings,
        verboseLogger(this.plugin)
      );
    } catch (error) {
      console.error(`Error extracting first line from ${file.path}:`, error);
      return null;
    }
  }
}
