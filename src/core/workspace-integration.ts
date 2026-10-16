import { TAbstractFile, TFile, MarkdownView, EventRef } from 'obsidian';
import { around } from 'monkey-around';
import { verboseLog } from '../utils';
import { normalizeLineBreaks } from '../utils/string-processing';
import FirstLineIsTitle from '../../main';
import {
  FileCreationActions,
  FileCreationCoordinator,
} from './file-creation-coordinator';
import { TIMING } from '../constants/timing';
import { t } from '../i18n';

/**
 * WorkspaceIntegration
 *
 * Manages integration with Obsidian workspace UI elements:
 * - Ribbon icons
 * - The save command hook for rename on save
 * - The new-note pipeline: title insertion, cursor placement and the creation rename
 */
export class WorkspaceIntegration {
  private plugin: FirstLineIsTitle;
  private saveCommandPatchCleanup?: () => void;
  private fileCreationCoordinator: FileCreationCoordinator;

  // Track last title insertion to prevent mass insertions when canvas is active
  private lastTitleInsertionTime = 0;

  constructor(plugin: FirstLineIsTitle) {
    this.plugin = plugin;
    this.fileCreationCoordinator = new FileCreationCoordinator(plugin);
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
   * Register ribbon icons
   */
  registerRibbonIcons(): void {
    this.plugin.addRibbonIcon(
      'file-type-corner',
      t('commands.putFirstLineInTitle'),
      () => {
        void this.plugin.commandRegistrar.executeRenameCurrentFile();
      }
    );
    this.plugin.addRibbonIcon(
      'file-cog',
      t('commands.toggleAutomaticRenaming'),
      () => {
        void this.plugin.commandRegistrar.executeToggleAutomaticRenaming();
      }
    );
  }

  /**
   * Setup save event hook for rename on save
   */
  setupSaveEventHook(): void {
    // Get the save command
    const saveCommand = this.app.commands?.commands?.['editor:save-file'];
    if (saveCommand?.checkCallback) {
      // Use monkey-around for safe patching that can be uninstalled in any order
      const plugin = this.plugin;

      this.saveCommandPatchCleanup = around(saveCommand, {
        checkCallback(original) {
          return function (checking: boolean): boolean | void {
            // First call the original save logic
            const result = original ? original.call(this, checking) : true;

            // If not checking and save succeeded, run our rename logic - process immediately regardless of check interval
            // Read at call time: Clear settings and Import replace the settings object
            if (!checking && plugin.settings.core.renameOnSave) {
              const activeFile = plugin.app.workspace.getActiveFile();
              if (activeFile && activeFile.extension === 'md') {
                // Run rename (unless excluded) with no delay and show notices like manual command
                window.setTimeout(() => {
                  void plugin.commandRegistrar.executeRenameUnlessExcluded();
                }, TIMING.SAVE_COMPLETE_DELAY_MS);
              }
            }

            return result;
          };
        },
      });

      verboseLog(this.plugin, 'Save event hook installed for rename on save');
    }
  }

  /**
   * Run the new-note pipeline for each note created once the layout is ready
   */
  setupNewNotePipeline(): void {
    // Wait for layout ready before registering create event
    // This ensures we only process genuinely new files, not existing files from vault load
    this.app.workspace.onLayoutReady(() => {
      this.plugin.registerEvent(
        this.app.vault.on('create', (file) => this.handleFileCreated(file))
      );
    });
  }

  /**
   * Run the new-note pipeline for a created file: the wait for a view, the coordinator's decision, title insertion, cursor placement and the creation rename
   * @param file - File the vault `create` event reports
   */
  private async handleFileCreated(file: TAbstractFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    if (!this.isCreatedNoteStillNew(file)) return;

    let { view: createdFileView, content: initialContent } =
      this.captureCreatedNoteView(file);

    verboseLog(
      this.plugin,
      `CREATE: New file created, processing: ${file.name}`
    );

    try {
      const canvasIsActive =
        this.app.workspace.getMostRecentLeaf()?.view?.getViewType?.() ===
        'canvas';
      let createdInBackground = false;

      // Held from the create event on, as no await precedes this: Templater writes its merged text before its event arrives, and a rename pass on that text (a line holding only a cursor placeholder reads as empty) names the note `Untitled`, after which no title goes in
      this.plugin.editorLifecycle.holdForCreationPipeline(file);
      try {
        // Canvas rate limiting: prevent mass insertions when canvas creates many files
        if (canvasIsActive && this.isTitleInsertionRateLimited(file)) {
          this.plugin.editorLifecycle.clearCreationDelayTimer(file.path);
          return;
        }

        // User decision: a note created in the background (sync, another plugin, a script; not shown in an editor) gets no title inserted, no cursor placed and no creation rename pass. Obsidian's own creators create the file first and open it after, so no leaf shows the note yet, and "shown in an editor" means shown within the wait. A creator that opens the note later (Templater's "Create new note from template" with a prompt opens it after its `vault.modify`) counts as background: it loses only a title insertion its own `vault.modify` overwrites, its creation rename pass is refused by the editor check anyway, and later editor and save passes run once the note is shown.
        if (
          createdFileView === null &&
          !canvasIsActive &&
          this.plugin.eventHandlerManager.hasBeenShownInEditor(file) !== true
        ) {
          const shownView = await this.waitForNoteView(
            file,
            () => true,
            TIMING.NEW_NOTE_VIEW_WAIT_MS
          );
          if (shownView) {
            // Re-captured so the coordinator judges, and the title goes into, what the view holds
            createdFileView = shownView;
            initialContent = shownView.getViewData();
            verboseLog(
              this.plugin,
              `CREATE: Editor showed ${file.path} after creation, captured ${initialContent.length} chars`
            );
          } else {
            createdInBackground = true;
            verboseLog(
              this.plugin,
              `CREATE: No editor showed ${file.path} within ${TIMING.NEW_NOTE_VIEW_WAIT_MS}ms - created in the background, skipping title insertion, cursor placement and the immediate rename`
            );
          }
        }

        if (!createdInBackground) {
          const actions = await this.fileCreationCoordinator.determineActions(
            file,
            {
              initialContent,
              pluginLoadTime: this.plugin.pluginLoadTime,
            }
          );
          await this.applyCreationActions(file, actions, createdFileView);
        }
      } finally {
        // Released before the creation rename rather than after it: that rename reads the finished text, and an edit made while it runs gets a pass of its own
        this.plugin.editorLifecycle.releaseFromCreationPipeline(file);
      }

      await this.scheduleCreationRename(
        file,
        createdFileView,
        canvasIsActive,
        createdInBackground
      );
    } catch (error) {
      console.error(`CREATE: Failed to process new file ${file.path}:`, error);
      this.plugin.editorLifecycle.clearCreationDelayTimer(file.path);
    }
  }

  /**
   * Check that a created note still needs the new-note pipeline
   * @param file - Note the vault `create` event reports
   * @returns false when the note was already renamed
   */
  private isCreatedNoteStillNew(file: TFile): boolean {
    // Guard: check if file still exists at original path
    // Prevents duplicate file creation when CREATE event fires after editor-change already renamed the file
    const currentFile = this.app.vault.getAbstractFileByPath(file.path);
    if (!currentFile || !(currentFile instanceof TFile)) {
      verboseLog(
        this.plugin,
        `CREATE: File no longer exists at original path (already renamed), skipping: ${file.path}`
      );
      return false;
    }

    // Guard: skip a late create event for a note a plugin rename already moved into this path, since the pipeline already ran for it
    // A path a rename vacated is deliberately not matched: a note created there within the window (Cmd+N reusing `Untitled`, a click on a link to the old name) is new
    if (
      this.plugin.fileStateManager.wasRecentlyRenamedInto(
        file.path,
        TIMING.STALE_CREATE_WINDOW_MS
      )
    ) {
      verboseLog(
        this.plugin,
        `CREATE: Skipping recently renamed file: ${file.path}`
      );
      return false;
    }

    return true;
  }

  /**
   * Capture the view already showing a created note and the text it holds, read from the view because a Reading view's hidden editor can hold text the note does not.
   * This is the one leaf scan of the creation path: the view it resolves is threaded to every step that needs it, instead of each re-running the scan.
   * @param file - Note just created
   * @returns The view, or null when none shows the note yet, and its text, empty without a view
   */
  private captureCreatedNoteView(file: TFile): {
    view: MarkdownView | null;
    content: string;
  } {
    try {
      const view = this.plugin.fileOperations.resolveMarkdownViewForFile(
        file,
        null
      );
      if (view) {
        const content = view.getViewData();
        verboseLog(
          this.plugin,
          `CREATE: Captured initial editor content for ${file.path}: ${content.length} chars`
        );
        return { view, content };
      }
    } catch {
      verboseLog(this.plugin, `CREATE: Could not read initial editor content`);
    }
    return { view: null, content: '' };
  }

  /**
   * Check whether a title went in too recently while a canvas is active, recording this insertion's time when it may go ahead
   * @param file - Note just created
   * @returns true to skip the new-note pipeline for this note
   */
  private isTitleInsertionRateLimited(file: TFile): boolean {
    const now = Date.now();
    const timeSinceLastInsertion = now - this.lastTitleInsertionTime;
    if (timeSinceLastInsertion < TIMING.TITLE_INSERTION_RATE_LIMIT_MS) {
      verboseLog(
        this.plugin,
        `CREATE: Skipping - rate limited (${timeSinceLastInsertion}ms since last): ${file.name}`
      );
      return true;
    }
    this.lastTitleInsertionTime = now;
    return false;
  }

  /**
   * Insert the title and place the cursor as the coordinator decided, at once rather than after the New note delay
   * @param file - Note just created
   * @param actions - The coordinator's decision, carrying the text it judged
   * @param createdFileView - View showing the note, or null
   */
  private async applyCreationActions(
    file: TFile,
    actions: FileCreationActions,
    createdFileView: MarkdownView | null
  ): Promise<void> {
    if (actions.viewLagsFile) {
      // The cursor pass waits for the view to reload the file's text (measured +1 to +55 ms after the write), since a move into the stale view would be wiped by that reload
      if (actions.shouldInsertTitle) {
        verboseLog(
          this.plugin,
          `CREATE: Inserting title through the file for: ${file.path}`
        );
        await this.plugin.fileOperations.insertTitle(
          file,
          actions.judgedContent,
          'none',
          null,
          true
        );
      }
      if (actions.shouldMoveCursor) {
        await this.moveCursorOnceViewReloads(file, actions.placeCursorAtEnd);
      }
      return;
    }

    let titleInsertionSettledCursor = false;
    if (actions.shouldInsertTitle) {
      verboseLog(this.plugin, `CREATE: Inserting title for: ${file.path}`);
      // The judged text, not the creation snapshot: after a Templater wait the snapshot predates the template
      const titleResult = await this.plugin.fileOperations.insertTitle(
        file,
        actions.judgedContent,
        actions.titleCursor,
        createdFileView
      );
      titleInsertionSettledCursor = titleResult.cursorPositioned;
    }

    // Skip the delayed pass when insertion already placed the cursor: it would re-read the whole editor only to arrive at the state the note is already in. The cursor-only path (nothing inserted) still runs.
    if (actions.shouldMoveCursor && !titleInsertionSettledCursor) {
      verboseLog(
        this.plugin,
        `CREATE: Moving cursor for: ${file.path} (placeCursorAtEnd: ${actions.placeCursorAtEnd})`
      );

      window.setTimeout(() => {
        // No view hint across this timer: handleCursorPositioning resolves the view itself and skips when none shows the note, while a hint captured before the delay could name a closed leaf
        void this.plugin.fileOperations.handleCursorPositioning(
          file,
          actions.placeCursorAtEnd
        );
      }, TIMING.RAF_CURSOR_POSITIONING_DELAY_MS);
    }
  }

  /**
   * Place the cursor in a view that showed older text than the file, once that view has reloaded the file's text
   * @param file - Note just created, written through the file
   * @param placeCursorAtEnd - True for the end of the title line, false for its start
   */
  private async moveCursorOnceViewReloads(
    file: TFile,
    placeCursorAtEnd: boolean
  ): Promise<void> {
    // Through the file: the cursor pass would otherwise write the line break below an ending fence into the hidden editor, leaving the view unsaved for Obsidian's 2 s save, and a file write in that window raises Obsidian's "modified externally, merging" notice (measured)
    await this.plugin.fileOperations.addLineAfterEndingFence(file);

    // Read after the writes above, so the wait matches the view against the note's final text
    const expectedText = normalizeLineBreaks(await this.app.vault.read(file));
    const reloadedView = await this.waitForNoteView(
      file,
      (view) => normalizeLineBreaks(view.getViewData()) === expectedText,
      TIMING.VIEW_RELOAD_WAIT_MS
    );
    if (!reloadedView) {
      verboseLog(
        this.plugin,
        `CREATE: No view showed the file's text for ${file.path} within ${TIMING.VIEW_RELOAD_WAIT_MS}ms - skipping cursor placement`
      );
      return;
    }

    verboseLog(
      this.plugin,
      `CREATE: Moving cursor after the view reloaded: ${file.path} (placeCursorAtEnd: ${placeCursorAtEnd})`
    );
    await this.plugin.fileOperations.handleCursorPositioning(
      file,
      placeCursorAtEnd,
      reloadedView
    );
  }

  /**
   * Run the creation rename at once, or after the New note delay
   * @param file - Note just created
   * @param createdFileView - View showing the note, or null
   * @param canvasIsActive - True when a canvas was active at creation
   * @param createdInBackground - True when no editor showed the note within the wait
   */
  private async scheduleCreationRename(
    file: TFile,
    createdFileView: MarkdownView | null,
    canvasIsActive: boolean,
    createdInBackground: boolean
  ): Promise<void> {
    const newNoteDelay = this.settings.core.newNoteDelay;
    if (newNoteDelay === 0) {
      // No delay - process immediately without blocking events
      if (!createdInBackground) {
        await this.runCreationRename(file, createdFileView, canvasIsActive);
      }
      return;
    }

    // Scheduled for a background note too: the delayed pass resolves the view itself, so a note opened after the wait is still renamed
    // Has delay - use timer and block events during delay
    verboseLog(
      this.plugin,
      `CREATE: Scheduling rename in ${newNoteDelay}ms: ${file.name}`
    );
    const timer = window.setTimeout(() => {
      // No view hint: the leaf may be gone by then
      void this.runCreationRename(file, null, canvasIsActive);
    }, newNoteDelay);
    this.plugin.editorLifecycle.setCreationDelayTimer(file.path, timer);
  }

  /**
   * Rename a created note when automatic renaming is on, then end its creation delay
   * @param file - Note just created
   * @param viewHint - View showing the note, passed only when this runs synchronously with the creation handler
   * @param canvasIsActive - True when a canvas was active at creation
   */
  private async runCreationRename(
    file: TFile,
    viewHint: MarkdownView | null,
    canvasIsActive: boolean
  ): Promise<void> {
    try {
      if (this.settings.core.renameAutomatically && this.isFullyLoaded) {
        verboseLog(
          this.plugin,
          `CREATE: Processing rename after delay: ${file.name}`
        );

        // The view's text rather than its editor's, which goes stale once the note is switched to Reading view and its properties are edited
        let editorContent: string | undefined;
        const renameView =
          this.plugin.fileOperations.resolveMarkdownViewForFile(file, viewHint);
        if (renameView) {
          const value = renameView.getViewData();
          if (typeof value === 'string') {
            editorContent = value;
          }
        }
        // A note never shown in a Markdown leaf (Obsidian's silent creators such as `obsidian://new?silent`, sync, another plugin or a script) is left alone until it is opened and edited; canvas-created notes count as shown.
        const shownInEditor =
          renameView !== null ||
          canvasIsActive ||
          this.plugin.eventHandlerManager.hasBeenShownInEditor(file) === true;
        await this.renameEngine.processFile(file, {
          providedContent: editorContent,
          // Undefined, not false: the central gate then looks for an open editor itself
          hasActiveEditor: shownInEditor ? true : undefined,
        });
      }

      verboseLog(
        this.plugin,
        `CREATE: Completed processing new file: ${file.name}`
      );
    } catch (error) {
      console.error(
        `CREATE: Failed to process rename for ${file.path}:`,
        error
      );
    } finally {
      this.plugin.editorLifecycle.clearCreationDelayTimer(file.path);
    }
  }

  /**
   * Wait for a Markdown view with an editor to show a note in a state `isReady` accepts: a note just created, since Obsidian's own creators open the note only after creating it, or a note's text reloaded after a file write. Re-resolves on each `file-open` for this note, each `layout-change` and each `editor-change` for this note, and keeps waiting while no view passes, because `layout-change` is a 10 ms debounce any unrelated tab change also queues, which can fire before the view attaches; `editor-change` fires for Obsidian's reload of a view (measured).
   * @param file - Note to wait for, matched by identity, which survives a rename during the wait
   * @param isReady - Accepts the view showing the note once it is in the state waited for
   * @param timeoutMs - How long to wait before the last look
   * @returns The view showing the note, or null when none passed by the deadline
   */
  private waitForNoteView(
    file: TFile,
    isReady: (view: MarkdownView) => boolean,
    timeoutMs: number
  ): Promise<MarkdownView | null> {
    const resolveReadyView = (): MarkdownView | null => {
      const view = this.plugin.fileOperations.resolveMarkdownViewForFile(
        file,
        null
      );
      return view && isReady(view) ? view : null;
    };
    return new Promise((resolve) => {
      const eventRefs: EventRef[] = [];
      let settled = false;
      let deadline: number | undefined;
      const settle = (view: MarkdownView | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(deadline);
        for (const eventRef of eventRefs) {
          this.app.workspace.offref(eventRef);
        }
        resolve(view);
      };
      const recheck = () => {
        const view = resolveReadyView();
        if (view) settle(view);
      };
      eventRefs.push(
        this.app.workspace.on('file-open', (openedFile) => {
          if (openedFile === file) recheck();
        }),
        this.app.workspace.on('layout-change', recheck),
        this.app.workspace.on('editor-change', (_editor, info) => {
          if (info.file === file) recheck();
        })
      );
      // Checked once on entry: the reload's `editor-change` can fire before an awaited `vault.read` resolves (measured, 3 of 3 runs), so a wait that only listened would miss it
      recheck();
      if (settled) return;
      // One last look at the deadline, for a view that attached or reloaded without an event this listener heard
      deadline = window.setTimeout(() => settle(resolveReadyView()), timeoutMs);
    });
  }

  /**
   * Cleanup all workspace integrations
   */
  cleanup(): void {
    // Clean up save event hook using monkey-around's cleanup function
    if (this.saveCommandPatchCleanup) {
      this.saveCommandPatchCleanup();
    }

    // Clear any pending creation delay timers
    this.plugin.editorLifecycle.clearAllCreationDelayTimers();
  }
}
