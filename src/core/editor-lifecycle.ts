import {
  TFile,
  MarkdownView,
  MarkdownFileInfo,
  ViewWithFileEditor,
  Editor,
  getFrontMatterInfo,
} from 'obsidian';
import { verboseLog, findTitleSourceLine } from '../utils';
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
 * Manages editor state tracking and polling/checking systems for detecting
 * first line changes in active editors.
 *
 * Responsibilities:
 * - Track open editors and their first line content
 * - Poll active editors for changes (interval-based)
 * - Immediate change detection (event-based)
 * - Manage editor lifecycle events
 */
export class EditorLifecycleManager {
  private plugin: FirstLineIsTitle;

  // Track files currently open in editors (with last-seen timestamp)
  private openEditorFiles = new Map<string, number>();

  // Interval-based checking system
  private pendingChecks = new Map<
    string,
    { editor: Editor; file: TFile; lastChangeTime: number }
  >();

  // Track active editors for tab close detection
  private activeEditorFiles = new Map<
    string,
    {
      file: TFile;
      editor: Editor;
      lastFirstLine: string | undefined;
      leafId: string;
    }
  >();

  // Track files in creation delay period with their timer references
  private creationDelayTimers = new Map<string, number>();

  // Track files that were just processed on tab close to prevent duplicate processing
  // Performance optimization: prevents redundant checks from multiple workspace events
  private recentlyProcessedCloses = new Set<string>();

  // Track last focused file for rename-on-focus detection
  private lastFocusedFile: string | null = null;

  // Track previous count for logging only on changes
  private previousActiveFileCount: number = 0;

  /** When each note was last treated as linked, keyed by `TFile` because the object survives renames */
  private readonly lastSeenLinkedAt = new WeakMap<TFile, number>();

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
  isFileInCreationDelay(filePath: string): boolean {
    return this.creationDelayTimers.has(filePath);
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
   * Initialize the checking system based on settings
   */
  initializeCheckingSystem(): void {
    // Clear any existing system
    this.clearCheckingSystems();

    // Always track active editors for tab close detection
    this.trackActiveEditors();

    if (this.settings.core.checkInterval === 0) {
      // Use event-based immediate checking
      this.setupEventBasedChecking();
    } else {
      // Use throttle-based checking
      this.setupThrottleBasedChecking();
    }
  }

  /**
   * Setup event-based checking (immediate processing)
   */
  private setupEventBasedChecking(): void {
    verboseLog(this.plugin, 'Setting up event-based checking (immediate)');
    // This will be set up in the main event registration
  }

  /**
   * Setup throttle-based checking (process N ms after editor change)
   */
  private setupThrottleBasedChecking(): void {
    verboseLog(
      this.plugin,
      `Setting up throttle-based checking (${this.settings.core.checkInterval}ms delay)`
    );
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
   * Update tracking of active editors
   */
  async updateActiveEditorTracking(): Promise<void> {
    const markdownViews = this.app.workspace.getLeavesOfType('markdown');
    const newActiveFiles = new Map<
      string,
      {
        file: TFile;
        editor: Editor;
        lastFirstLine: string | undefined;
        leafId: string;
      }
    >();

    // Track which leafIds are currently active
    const activeLeafIds = new Set<string>();

    // Build new active files map
    for (const leaf of markdownViews) {
      // Cast to ViewWithFileEditor to access MarkdownView properties
      const view = leaf.view as ViewWithFileEditor;
      if (view && view.file && view.editor) {
        try {
          const leafId = leaf.id;
          if (!leafId) continue;

          activeLeafIds.add(leafId);

          const existing = this.activeEditorFiles.get(view.file.path);

          newActiveFiles.set(view.file.path, {
            file: view.file,
            editor: view.editor,
            lastFirstLine: existing ? existing.lastFirstLine : undefined, // Preserve existing (even if undefined)
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
              // hasActiveEditor=true because throttle was created when editor was active
              await this.renameEngine.processFile(
                oldData.file,
                true,
                false,
                undefined,
                false,
                undefined,
                true
              );
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
          // Skip files in creation delay - let the delay timer handle them
          // Check BEFORE updating lastFocusedFile so re-focus after delay works
          if (this.isFileInCreationDelay(currentPath)) {
            verboseLog(
              this.plugin,
              `Skipping focus rename: file in creation delay: ${currentPath}`
            );
            // Don't update lastFocusedFile - allows re-trigger when delay expires
            return;
          }

          this.lastFocusedFile = currentPath;

          verboseLog(this.plugin, `File focused: ${currentPath}`);

          // Process file with rename-on-focus (async but don't await to avoid blocking)
          // hasActiveEditor=true because file just became active
          this.renameEngine
            .processFile(
              currentActiveFile,
              true,
              false,
              undefined,
              false,
              undefined,
              true
            )
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
   * Handle editor change with throttle for checkInterval > 0
   * Only starts timer if first line actually changed from last known state
   * A note another file links to, or one edited in a Canvas card, waits until typing pauses instead, since each of its renames raises Obsidian's link-update notices
   */
  handleEditorChangeWithThrottle(
    editor: Editor,
    file: TFile,
    options?: EditorChangeOptions
  ): void {
    const filePath = file.path;

    // Skip files in creation delay
    if (this.isFileInCreationDelay(filePath)) {
      verboseLog(
        this.plugin,
        `File in creation delay, skipping throttle: ${filePath}`
      );
      return;
    }

    // Skip the plugin's own programmatic writes. CodeMirror fires editor-change for
    // view.editor.replaceRange/setLine exactly as it does for a keystroke, and the creation
    // delay guard above only covers newNoteDelay > 0 - at the default 0 this is the only
    // thing keeping title insertion from opening a second, independent entry into the rename
    // pipeline. It has to be checked here rather than only in processEditorChangeOptimal:
    // this handler runs synchronously with the write, while that one runs from a throttle
    // timer, by which point the flag has already been cleared.
    if (this.plugin.fileStateManager.isEditorSyncing(filePath)) {
      verboseLog(
        this.plugin,
        `Editor change from plugin's own write, skipping throttle: ${filePath}`
      );
      return;
    }

    // Get current first line
    const currentFirstLine = this.extractFirstLineFromEditor(editor, file);

    // Get last known first line from tracking
    let tracked = this.activeEditorFiles.get(filePath);

    // If file not tracked yet (first change event before workspace event), initialize it now
    if (!tracked) {
      tracked = {
        file: file,
        editor: editor,
        lastFirstLine: undefined, // Initialize as undefined so first change is processed
        leafId: '', // Will be set properly by updateActiveEditorTracking
      };
      this.activeEditorFiles.set(filePath, tracked);
      verboseLog(
        this.plugin,
        `Initialized tracking on first editor change for ${filePath}: "${currentFirstLine}"`
      );
    }

    // TypeScript: tracked is always defined here (either from get() or newly created)
    const lastFirstLine = tracked.lastFirstLine;

    // If first line hasn't changed, skip throttle
    // Explicit check: if lastFirstLine is defined and matches current, no processing needed
    if (lastFirstLine !== undefined && currentFirstLine === lastFirstLine) {
      verboseLog(
        this.plugin,
        `First line unchanged for ${filePath}, skipping throttle`
      );

      // Keeps the compared text current so a later check reads a properties-only edit as one; skipped while a timer waits, since a repeated editor-change with unchanged text (a Canvas card fires one per keystroke) or an edit on another line would otherwise erase the change that timer is waiting to process.
      if (!this.plugin.fileStateManager.hasThrottleTimer(filePath)) {
        this.plugin.fileStateManager.setLastEditorContent(
          filePath,
          editor.getValue()
        );
      }

      return;
    }

    // First line changed - update tracking
    tracked.lastFirstLine = currentFirstLine;

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
    if (fileStateManager.getLastEditorContent(file.path) !== undefined) return;
    // Without a baseline the timer compares the editor with the file, but a tab or Canvas card saves 2 s after its first unsaved keystroke rather than its last, often before a linked note's timer fires: the two then match and the rename is skipped. An edit fires before its save, so the file still holds the text from before it.
    void this.app.vault.cachedRead(file).then(
      (content) => {
        if (fileStateManager.getLastEditorContent(file.path) === undefined) {
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
      isLinkedFromAnyFile(this.app, file);
    if (linked) {
      this.lastSeenLinkedAt.set(file, Date.now());
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
        .processEditorChangeOptimal(editor, file, owner)
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
   * Update lastFirstLine for a file after processing
   * Called after rename completes to sync tracking state
   */
  updateLastFirstLine(filePath: string, firstLine: string): void {
    const tracked = this.activeEditorFiles.get(filePath);
    if (tracked) {
      tracked.lastFirstLine = firstLine;
      verboseLog(
        this.plugin,
        `Updated lastFirstLine for ${filePath}: "${firstLine}"`
      );
    }
  }

  /**
   * Update activeEditorFiles map key when file is renamed
   * Called from vault rename event handler
   */
  notifyFileRenamed(oldPath: string, newPath: string): void {
    const tracked = this.activeEditorFiles.get(oldPath);
    if (tracked) {
      this.activeEditorFiles.delete(oldPath);
      this.activeEditorFiles.set(newPath, tracked);
      verboseLog(
        this.plugin,
        `Updated editor tracking key: ${oldPath} → ${newPath}`
      );
    }
  }

  /**
   * Clear all checking systems and state
   * Note: Creation delay and view readiness timers are self-cleaning (100ms-3s TTL)
   * but we clear them explicitly for consistency on unload
   */
  clearCheckingSystems(): void {
    // Clear all throttle timers via FileStateManager
    this.plugin.fileStateManager.clearAllThrottleTimers();

    // Note: Creation delay and view readiness timers are now managed by FileStateManager
    // and will be cleaned up in its dispose() method

    this.activeEditorFiles.clear();
    this.pendingChecks.clear();
  }

  /**
   * Extract first line from editor content
   */
  public extractFirstLineFromEditor(editor: Editor, file: TFile): string {
    try {
      const content = editor.getValue();

      // Frontmatter boundary from the editor content itself: the cached frontmatterPosition lags the editor by up to Obsidian's autosave delay, so after a property line is added or removed it points at the wrong line.
      const contentLines = content
        .slice(getFrontMatterInfo(content).contentStart)
        .split('\n');

      // Find first non-empty line after frontmatter
      let firstNonEmptyLine = '';
      for (const line of contentLines) {
        if (line.trim() !== '') {
          firstNonEmptyLine = line;
          break;
        }
      }

      if (firstNonEmptyLine === '') {
        return ''; // No non-empty line found
      }

      // Use findTitleSourceLine to get effective title line
      // This handles HRs, code fences, etc. that should be skipped
      return findTitleSourceLine(
        contentLines,
        this.plugin.settings,
        this.plugin
      );
    } catch (error) {
      console.error(`Error extracting first line from ${file.path}:`, error);
      return '';
    }
  }

  /**
   * Check if a file is currently open in an editor
   */
  isFileOpenInEditor(file: TFile): boolean {
    let isOpen = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (
        leaf.view instanceof MarkdownView &&
        leaf.view.file?.path === file.path
      ) {
        isOpen = true;
        return false; // break iteration
      }
    });
    return isOpen;
  }

  /**
   * Get open editor files map (for external access)
   */
  getOpenEditorFiles(): Map<string, number> {
    return this.openEditorFiles;
  }

  /**
   * Get active editor files map (for external access)
   */
  getActiveEditorFiles(): Map<
    string,
    {
      file: TFile;
      editor: Editor;
      lastFirstLine: string | undefined;
      leafId: string;
    }
  > {
    return this.activeEditorFiles;
  }
}
