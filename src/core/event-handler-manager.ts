import { Menu, TFile, TFolder, MarkdownView, EventRef } from 'obsidian';
import FirstLineIsTitlePlugin from '../../main';
import {
  verboseLog,
  isOnlyFrontmatterChanged,
  hasDisablePropertyInFile,
  frontmatterHasDisableProperty,
  disablePropertyIsOff,
  isFileOpenInAnyEditor,
} from '../utils';
import { tp } from '../i18n';
import { RenameModal, DisableEnableModal } from '../modals';
import { around } from 'monkey-around';
import { detectTagFromDOM, detectTagFromEditor } from '../utils/tag-detection';
import {
  SourceEditorTarget,
  findSourceEditorForFile,
} from '../utils/frontmatter-edit';
import { isCanvasCardEmbed } from '../utils/embedded-editors';
import { hasFirstLinePropertyName } from '../utils/first-line-property-keys';
import { TIMING } from '../constants/timing';

// In `Cache` and `File` read modes the `modify` handler's own `processFile` can still hold the lock when `changed` arrives.
const LOCKED_FILE_RETRY_LIMIT = 10;

/**
 * Extended Workspace interface with undocumented search results event
 */
interface WorkspaceWithSearchEvents {
  on(
    name: 'search:results-menu',
    callback: (menu: Menu, leaf: Record<string, unknown>) => void
  ): EventRef;
}

/**
 * Manages all event handler registration for the First Line is Title plugin.
 * Centralizes event handler logic previously scattered in main.ts.
 */
export class EventHandlerManager {
  private plugin: FirstLineIsTitlePlugin;
  /** Tracks files with alias updates in progress to prevent concurrent updates */
  private pendingAliasUpdates: Set<string> = new Set();
  /** Notes last seen blocking renaming, keyed by `TFile` because the object survives renames */
  private notesBlockingRename = new WeakSet<TFile>();
  /** Notes shown in a Markdown leaf since load, keyed by `TFile` because the object survives renames */
  private notesShownInEditor = new WeakSet<TFile>();
  /** When each note was last edited in any editor, keyed by `TFile` because the object survives renames */
  private lastEditorEditAt = new WeakMap<TFile, number>();

  constructor(plugin: FirstLineIsTitlePlugin) {
    this.plugin = plugin;
  }

  /** Check if a note has been shown in a Markdown leaf since the plugin loaded; the new-note path leaves a note that never was alone. */
  hasBeenShownInEditor(file: TFile): boolean {
    return this.notesShownInEditor.has(file);
  }

  /** Check if a note is open in an editor, or was edited in one recently enough that a closed page preview's or deselected Canvas card's pending save still belongs to that edit. */
  private isEditingNote(file: TFile): boolean {
    return (
      isFileOpenInAnyEditor(file, this.plugin.app) ||
      Date.now() - (this.lastEditorEditAt.get(file) ?? 0) <
        TIMING.EMBED_SAVE_GRACE_MS
    );
  }

  /**
   * Choose where a background alias update goes, from the file text the handler just read.
   * @param file - Note whose alias may change
   * @param fileContent - Text the handler read from the file
   * @returns `'user-typing'` to skip the update, since the rename path owns alias updates while the user has unsaved typing or a scheduled rename; the editor to write into; or null to write the file
   */
  private findBackgroundAliasTarget(
    file: TFile,
    fileContent: string
  ): SourceEditorTarget | 'user-typing' | null {
    // A tab, card or preview saves 2 s after its first unsaved keystroke, while typing may go on, and a linked note's rename can still be waiting for typing to pause.
    if (this.plugin.fileStateManager.hasThrottleTimer(file.path)) {
      return 'user-typing';
    }
    const target = findSourceEditorForFile(this.plugin.app, file);
    if (target?.isDirty()) {
      return 'user-typing';
    }
    // An editor holding other text has not loaded an outside change yet; the file write lets Obsidian reload it silently.
    return target && target.editor.getValue() === fileContent ? target : null;
  }

  /**
   * Check if alias update is in progress for a file.
   * Used by rename-engine to coordinate with event handlers.
   */
  isAliasUpdatePending(path: string): boolean {
    return this.pendingAliasUpdates.has(path);
  }

  /**
   * Mark alias update as in progress for a file.
   * Used by rename-engine to coordinate with event handlers.
   */
  markAliasUpdatePending(path: string): void {
    this.pendingAliasUpdates.add(path);
  }

  /**
   * Clear alias update in progress flag for a file.
   * Used by rename-engine to coordinate with event handlers.
   */
  clearAliasUpdatePending(path: string): void {
    this.pendingAliasUpdates.delete(path);
  }

  /**
   * Register all event handlers for the plugin.
   * Called during plugin load.
   * Note: Obsidian automatically manages event cleanup via Plugin.registerEvent().
   */
  registerAllHandlers(): void {
    this.registerFileMenuHandler();
    this.registerFilesMenuHandler();
    this.registerEditorMenuHandler();
    this.registerTagSearchMenuHandler();
    this.registerSearchResultsMenuHandler();
    this.registerEditorChangeHandler();
    // `processFile` takes the file lock before its first `await`, so the alias `changed` handler registered after it sees the lock and leaves the alias to the rename path.
    this.registerDisablePropertyTransitionHandler();
    this.registerFileSystemHandlers();
  }

  /**
   * File menu handler - single file/folder context menu
   */
  private registerFileMenuHandler(): void {
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('file-menu', (menu, file) => {
        if (!this.plugin.settings.core.enableContextMenus) return;

        if (file instanceof TFile && file.extension === 'md') {
          this.plugin.contextMenuManager.addFileMenuItems(menu, file);
        } else if (file instanceof TFolder) {
          this.plugin.contextMenuManager.addFolderMenuItems(menu, file);
        }
      })
    );
  }

  /**
   * Files menu handler - multiple files/folders selection
   */
  private registerFilesMenuHandler(): void {
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('files-menu', (menu, files) => {
        if (!this.plugin.settings.core.enableContextMenus) return;

        const markdownFiles = files.filter(
          (file): file is TFile =>
            file instanceof TFile && file.extension === 'md'
        );
        const folders = files.filter(
          (file): file is TFolder => file instanceof TFolder
        );

        // If both files and folders are selected, don't show any commands
        if (markdownFiles.length > 0 && folders.length > 0) return;
        if (markdownFiles.length === 0 && folders.length === 0) return;

        // Handle multiple Markdown files
        if (markdownFiles.length > 0) {
          if (!this.plugin.settings.core.enableFileCommands) return;

          // No separator here — see MenuRenderer.render for why.
          menu.addItem((item) => {
            item
              .setTitle(
                tp('commands.putFirstLineInTitleNNotes', markdownFiles.length)
              )
              .setIcon('file-type-corner')
              .onClick(() => {
                new RenameModal(
                  this.plugin.app,
                  this.plugin,
                  markdownFiles
                ).open();
              });
          });

          menu.addItem((item) => {
            item
              .setTitle(
                tp('commands.disableRenamingNNotes', markdownFiles.length)
              )
              .setIcon('pen-off')
              .onClick(() => {
                new DisableEnableModal(
                  this.plugin.app,
                  this.plugin,
                  markdownFiles,
                  'disable'
                ).open();
              });
          });

          menu.addItem((item) => {
            item
              .setTitle(
                tp('commands.enableRenamingNNotes', markdownFiles.length)
              )
              .setIcon('file-pen')
              .onClick(() => {
                new DisableEnableModal(
                  this.plugin.app,
                  this.plugin,
                  markdownFiles,
                  'enable'
                ).open();
              });
          });
        }

        // Handle multiple folders
        if (folders.length > 1) {
          this.plugin.contextMenuManager.addMultiFolderMenuItems(menu, folders);
        }
      })
    );
  }

  /**
   * Editor menu handler - tag context menus in editor.
   * Uses unified tag detection for hashtags in note body.
   */
  private registerEditorMenuHandler(): void {
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('editor-menu', (menu, editor, view) => {
        if (!this.plugin.settings.core.enableContextMenus) return;
        if (!(view instanceof MarkdownView)) return;

        const pos = editor.getCursor();
        const line = editor.getLine(pos.line);
        const tagName = detectTagFromEditor(line, pos.ch);

        if (tagName) {
          this.plugin.contextMenuManager.addTagMenuItems(menu, tagName);
        }
      })
    );
  }

  /**
   * Unified tag context menu handler using event delegation.
   * Handles both tag pane and YAML frontmatter tags with a single DOM listener.
   */
  private registerTagSearchMenuHandler(): void {
    // Single event-delegated handler for all DOM-based tag contexts
    this.plugin.registerDomEvent(document, 'contextmenu', (evt) => {
      if (!this.plugin.settings.core.enableContextMenus) return;

      if (!(evt.target instanceof HTMLElement)) return;
      const target = evt.target;
      const tagInfo = detectTagFromDOM(target);

      if (!tagInfo) return;

      // Different handling based on where tag was found
      if (tagInfo.location === 'tag-pane') {
        // Tag pane: use Tag Wrangler's menuForEvent pattern
        const menu = this.plugin.contextMenuManager.menuForEvent(evt);
        this.plugin.contextMenuManager.addTagMenuItems(menu, tagInfo.tagName);
      } else if (tagInfo.location === 'yaml') {
        // YAML tags: use monkey-patching to inject into Obsidian's native menu
        const plugin = this.plugin;
        const remove = around(Menu.prototype, {
          showAtPosition(old) {
            return function (this: Menu, ...args: unknown[]) {
              remove();
              plugin.contextMenuManager.addTagMenuItems(this, tagInfo.tagName);
              return old.apply(this, args);
            };
          },
        });
      }
    });
  }

  /**
   * Search results menu handler
   */
  private registerSearchResultsMenuHandler(): void {
    this.plugin.registerEvent(
      (this.plugin.app.workspace as unknown as WorkspaceWithSearchEvents).on(
        'search:results-menu',
        (menu: Menu, leaf: Record<string, unknown>) => {
          if (!this.plugin.settings.core.enableSearchCommands) return;

          // Extract files from search results DOM structure
          let files: TFile[] = [];
          if (
            leaf.dom &&
            typeof leaf.dom === 'object' &&
            'vChildren' in leaf.dom &&
            leaf.dom.vChildren &&
            typeof leaf.dom.vChildren === 'object' &&
            'children' in leaf.dom.vChildren &&
            Array.isArray(leaf.dom.vChildren.children)
          ) {
            leaf.dom.vChildren.children.forEach(
              (e: Record<string, unknown>) => {
                if (
                  e.file &&
                  e.file instanceof TFile &&
                  e.file.extension === 'md'
                ) {
                  files.push(e.file);
                }
              }
            );
          }

          if (files.length < 1) return;

          // No separator here — see MenuRenderer.render for why.
          menu.addItem((item) => {
            item
              .setTitle(tp('commands.putFirstLineInTitleNNotes', files.length))
              .setIcon('file-type-corner')
              .onClick(() => {
                new RenameModal(this.plugin.app, this.plugin, files).open();
              });
          });

          menu.addItem((item) => {
            item
              .setTitle(tp('commands.disableRenamingNNotes', files.length))
              .setIcon('pen-off')
              .onClick(() => {
                new DisableEnableModal(
                  this.plugin.app,
                  this.plugin,
                  files,
                  'disable'
                ).open();
              });
          });

          menu.addItem((item) => {
            item
              .setTitle(tp('commands.enableRenamingNNotes', files.length))
              .setIcon('file-pen')
              .onClick(() => {
                new DisableEnableModal(
                  this.plugin.app,
                  this.plugin,
                  files,
                  'enable'
                ).open();
              });
          });
        }
      )
    );
  }

  /**
   * Editor change handler - processes file changes in real-time
   */
  private registerEditorChangeHandler(): void {
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('editor-change', (editor, info) => {
        if (this.plugin.settings.core.debug) {
          console.debug(
            `Editor change detected for file: ${info.file?.path || 'unknown'}`
          );
        }

        if (!this.plugin.settings.core.renameAutomatically) {
          if (this.plugin.settings.core.debug) {
            console.debug(
              `Skipping editor-change: renameAutomatically=${this.plugin.settings.core.renameAutomatically}`
            );
          }
          return;
        }

        if (!info.file) {
          if (this.plugin.settings.core.debug) {
            console.debug(`Skipping editor-change: no file in info`);
          }
          return;
        }

        if (info.file.extension !== 'md') {
          if (this.plugin.settings.core.debug) {
            console.debug(
              `Skipping editor-change: not Markdown (${info.file.extension})`
            );
          }
          return;
        }

        // A page preview or Canvas card showing one section passes itself as `info`, and its editor's first line is the section's, not the note's.
        if ('subpath' in info && info.subpath) {
          if (this.plugin.settings.core.debug) {
            console.debug(
              `Skipping editor-change: section embed (${info.subpath})`
            );
          }
          return;
        }

        this.rememberIfBlockingRename(info.file);
        this.lastEditorEditAt.set(info.file, Date.now());
        this.rememberSavedContentBaseline(info.file);

        // Early exit if still within creation delay window
        if (info.file && editor) {
          if (
            this.plugin.editorLifecycle.isFileInCreationDelay(info.file.path)
          ) {
            if (this.plugin.settings.core.debug) {
              console.debug(
                `Skipping editor-change: file in creation delay: ${info.file.path}`
              );
            }
            return;
          }
        }

        if (!this.plugin.isFullyLoaded) {
          if (this.plugin.settings.core.debug) {
            console.debug(`Skipping editor-change: plugin not fully loaded`);
          }
          return;
        }

        // A card just added to a canvas is missing from the resolved links until the canvas saves and is re-indexed, about 2 s, so a card counts as linked by where it is.
        const inCanvasCard =
          !(info instanceof MarkdownView) &&
          isCanvasCardEmbed(this.plugin.app, info);

        // Use optimal editor change handler
        this.plugin.editorLifecycle.handleEditorChangeWithThrottle(
          editor,
          info.file,
          { inCanvasCard, owner: info }
        );
      })
    );
  }

  /**
   * Renames a note as soon as its rename-blocking property is unchecked or removed, and records which notes have been shown in a Markdown leaf.
   */
  private registerDisablePropertyTransitionHandler(): void {
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file?.extension !== 'md') return;
        this.notesShownInEditor.add(file);
        this.rememberIfBlockingRename(file);
        this.rememberSavedContentBaseline(file);
      })
    );

    // Runs at once on a plugin reload, which fires no `file-open`; deferred leaves are seeded by `file-open` when activated.
    this.plugin.app.workspace.onLayoutReady(() => {
      for (const leaf of this.plugin.app.workspace.getLeavesOfType(
        'markdown'
      )) {
        if (leaf.view instanceof MarkdownView && leaf.view.file) {
          this.notesShownInEditor.add(leaf.view.file);
          this.rememberIfBlockingRename(leaf.view.file);
          this.rememberSavedContentBaseline(leaf.view.file);
        }
      }
    });

    this.plugin.registerEvent(
      // The metadata `changed` event is the first point where cache, disk and editor agree, while the editor-change path still sees the old cached value.
      this.plugin.app.metadataCache.on('changed', (file, _data, cache) =>
        this.handleDisablePropertyChange(
          file,
          cache.frontmatter,
          LOCKED_FILE_RETRY_LIMIT
        )
      )
    );
  }

  private rememberIfBlockingRename(file: TFile): void {
    if (
      hasDisablePropertyInFile(
        file,
        this.plugin.app,
        this.plugin.settings.exclusions.disableRenamingKey,
        this.plugin.settings.exclusions.disableRenamingValue
      )
    ) {
      this.notesBlockingRename.add(file);
    }
  }

  /** Seeds the baseline the alias handlers compare a save against, so a properties-only save of an open note never writes an alias. */
  private rememberSavedContentBaseline(file: TFile): void {
    const { fileStateManager } = this.plugin;
    const existingBaseline = fileStateManager.getLastSavedContent(file.path);
    if (existingBaseline !== undefined) {
      // Refreshes the timestamp so the 10-minute purge cannot fall between an edit and its save.
      fileStateManager.setLastSavedContent(file.path, existingBaseline);
      return;
    }
    // An edit fires before its save, so disk still holds the content the alias handlers compare that save against.
    void this.plugin.app.vault.cachedRead(file).then(
      (content) => {
        if (fileStateManager.getLastSavedContent(file.path) === undefined) {
          fileStateManager.setLastSavedContent(file.path, content);
        }
      },
      () => {}
    );
  }

  private handleDisablePropertyChange(
    file: TFile,
    frontmatter: Record<string, unknown> | undefined,
    retriesLeft: number
  ): void {
    if (file.extension !== 'md') return;

    const { disableRenamingKey, disableRenamingValue } =
      this.plugin.settings.exclusions;
    if (
      frontmatterHasDisableProperty(
        frontmatter ?? {},
        disableRenamingKey,
        disableRenamingValue
      )
    ) {
      this.notesBlockingRename.add(file);
      return;
    }

    if (!this.notesBlockingRename.has(file)) return;
    // A half-typed value keeps the note remembered until it settles.
    if (!disablePropertyIsOff(frontmatter, disableRenamingKey)) return;
    // The note stays remembered; the delayed new-note processing renames it.
    if (this.plugin.editorLifecycle.isFileInCreationDelay(file.path)) return;

    if (this.plugin.cacheManager?.isLocked(file.path)) {
      if (retriesLeft > 0) {
        window.setTimeout(
          () =>
            this.handleDisablePropertyChange(
              file,
              this.plugin.app.metadataCache.getFileCache(file)?.frontmatter,
              retriesLeft - 1
            ),
          TIMING.UI_SETTLE_DELAY_MS
        );
      }
      return;
    }

    if (
      !this.plugin.settings.core.renameAutomatically ||
      !this.plugin.isFullyLoaded
    ) {
      return;
    }

    this.notesBlockingRename.delete(file);
    // No `await` before this call, so `processFile` takes the lock synchronously; `canModifyFile` then requires the note open in any Markdown leaf, Reading view included.
    void this.plugin.renameEngine.processFile(file, true);
  }

  /**
   * File system event handlers (rename, delete, modify)
   */
  private registerFileSystemHandlers(): void {
    // File rename handler
    this.plugin.registerEvent(
      this.plugin.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') {
          // Update file state
          this.plugin.fileStateManager?.notifyFileRenamed(oldPath, file.path);

          // Update cache
          if (this.plugin.cacheManager) {
            this.plugin.cacheManager.notifyFileRenamed(oldPath, file.path);
          }

          // Clean up pendingAliasUpdates for old path (state moved to new path)
          this.pendingAliasUpdates.delete(oldPath);

          verboseLog(
            this.plugin,
            `File renamed, updated cache: ${oldPath} -> ${file.path}`
          );
        }
      })
    );

    // File delete handler
    this.plugin.registerEvent(
      this.plugin.app.vault.on('delete', (file) => {
        if (file instanceof TFile) {
          this.plugin.cacheManager?.notifyFileDeleted(file.path);
          this.plugin.editorLifecycle.clearCreationDelayTimer(file.path);
          this.plugin.fileStateManager?.notifyFileDeleted(file.path);
          // Clean up pendingAliasUpdates to prevent memory leak and blocking
          this.pendingAliasUpdates.delete(file.path);
        }
      })
    );

    // File modify handler
    this.plugin.registerEvent(
      this.plugin.app.vault.on('modify', async (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension !== 'md') return;

        // Skip if file operation in progress (rename, etc.)
        if (this.plugin.cacheManager?.isLocked(file.path)) return;

        // Skip if file is in creation delay period
        if (this.plugin.editorLifecycle.isFileInCreationDelay(file.path)) {
          verboseLog(
            this.plugin,
            `Skipping modify: file in creation delay: ${file.path}`
          );
          return;
        }

        // Process rename for Cache/File modes (catches cache updates after save)
        if (
          this.plugin.settings.core.contentReadMethod === 'Cache' ||
          this.plugin.settings.core.contentReadMethod === 'File'
        ) {
          if (
            this.plugin.settings.core.renameAutomatically &&
            this.plugin.isFullyLoaded
          ) {
            // A save during a linked note's delay, from an autosave or a card deselect, would otherwise rename it at once while its timer still waits.
            if (this.plugin.fileStateManager.hasThrottleTimer(file.path)) {
              verboseLog(
                this.plugin,
                `Modify event: skipping ${file.path}, its scheduled timer processes it`
              );
            } else {
              verboseLog(
                this.plugin,
                `Modify event: processing ${file.path} (contentReadMethod: ${this.plugin.settings.core.contentReadMethod})`
              );
              await this.plugin.renameEngine.processFile(file, true);
            }
          }
        }

        // Update aliases if a property name is set (respects manual/automatic mode)
        // Note: Alias updates happen on save events only (not every keystroke) to reduce
        // "modified externally" notifications from processFrontMatter writes.
        if (
          hasFirstLinePropertyName(this.plugin.settings) &&
          this.plugin.settings.core.renameAutomatically
        ) {
          // Skip if file has pending metadata update from processFrontMatter
          const hasPending = this.plugin.pendingMetadataUpdates.has(file);
          verboseLog(
            this.plugin,
            `// PENDING_META_CHECK (modify): Checking ${file.path} in pendingMetadataUpdates → ${hasPending}`
          );
          if (hasPending) {
            return;
          }

          // Skip if alias update already in progress for this file
          if (this.pendingAliasUpdates.has(file.path)) {
            return;
          }

          // Background alias updates follow only notes being edited: a closed note changed by sync, another plugin or a script is left alone, its saved-content baseline is dropped so the next open reseeds it from disk, and manual commands write their own aliases.
          if (!this.isEditingNote(file)) {
            this.plugin.fileStateManager.deleteLastSavedContent(file.path);
            return;
          }

          // Mark as in-progress BEFORE any async operation to prevent race
          // between modify and metadata-changed handlers
          this.pendingAliasUpdates.add(file.path);
          try {
            let currentContent: string;
            try {
              currentContent = await this.plugin.app.vault.read(file);
            } catch {
              // File was deleted or inaccessible - clean up and return
              this.pendingAliasUpdates.delete(file.path);
              return;
            }

            // Skip if only frontmatter changed (user manually editing YAML)
            // Use lastSavedContent - represents content from PREVIOUS save, not current editor buffer
            const previousContent =
              this.plugin.fileStateManager.getLastSavedContent(file.path);
            if (
              previousContent !== undefined &&
              isOnlyFrontmatterChanged(currentContent, previousContent)
            ) {
              verboseLog(
                this.plugin,
                `Skipping modify-alias update - only frontmatter edited: ${file.path}`
              );
              // Still update lastSavedContent even when skipping
              this.plugin.fileStateManager.setLastSavedContent(
                file.path,
                currentContent
              );
              return;
            }

            const target = this.findBackgroundAliasTarget(file, currentContent);
            if (target === 'user-typing') {
              verboseLog(
                this.plugin,
                `Skipping modify-alias update - unsaved typing or a scheduled rename: ${file.path}`
              );
              // Still update lastSavedContent even when skipping
              this.plugin.fileStateManager.setLastSavedContent(
                file.path,
                currentContent
              );
              return;
            }

            verboseLog(
              this.plugin,
              `// EDITOR_PASS (modify): Passing target=${target ? 'editor' : 'file'} to updateAliasIfNeeded`
            );

            await this.plugin.aliasManager.updateAliasIfNeeded(
              file,
              currentContent,
              undefined,
              target
            );

            // Update lastSavedContent after processing
            this.plugin.fileStateManager.setLastSavedContent(
              file.path,
              currentContent
            );
          } finally {
            this.pendingAliasUpdates.delete(file.path);
          }
        }
      })
    );

    // Metadata change handler
    this.plugin.registerEvent(
      this.plugin.app.metadataCache.on('changed', async (file) => {
        if (!hasFirstLinePropertyName(this.plugin.settings)) return;
        if (!this.plugin.settings.core.renameAutomatically) return;
        if (file.extension !== 'md') return;

        // Skip if file operation in progress (rename, etc.)
        if (this.plugin.cacheManager?.isLocked(file.path)) return;

        // Skip if file is in creation delay period
        if (this.plugin.editorLifecycle.isFileInCreationDelay(file.path)) {
          if (this.plugin.settings.core.debug) {
            console.debug(
              `Skipping metadata-alias: file in creation delay: ${file.path}`
            );
          }
          return;
        }

        // Clear pending metadata flag FIRST - before any other checks that might return early
        // This ensures the flag is cleared when metadataCache processes our processFrontMatter write
        if (this.plugin.pendingMetadataUpdates.has(file)) {
          this.plugin.pendingMetadataUpdates.delete(file);
          verboseLog(
            this.plugin,
            `// PENDING_META_CLEAR: Clearing ${file.path} from pendingMetadataUpdates (set size: ${this.plugin.pendingMetadataUpdates.size})`
          );
          // Don't return - continue to check if alias update is needed
        }

        // Skip if alias update already in progress for this file
        if (this.pendingAliasUpdates.has(file.path)) {
          return;
        }

        // Background alias updates follow only notes being edited: a closed note changed by sync, another plugin or a script is left alone, its saved-content baseline is dropped so the next open reseeds it from disk, and manual commands write their own aliases.
        if (!this.isEditingNote(file)) {
          this.plugin.fileStateManager.deleteLastSavedContent(file.path);
          return;
        }

        // Mark as in-progress BEFORE any async operation to prevent race
        // between modify and metadata-changed handlers
        this.pendingAliasUpdates.add(file.path);
        try {
          // Check if only frontmatter changed - skip alias update to preserve YAML formatting
          let currentContent: string;
          try {
            currentContent = await this.plugin.app.vault.read(file);
          } catch {
            // File was deleted or inaccessible - clean up and return
            this.pendingAliasUpdates.delete(file.path);
            return;
          }

          // Use lastSavedContent - represents content from PREVIOUS save, not current editor buffer
          const previousContent =
            this.plugin.fileStateManager.getLastSavedContent(file.path);

          if (
            previousContent !== undefined &&
            isOnlyFrontmatterChanged(currentContent, previousContent)
          ) {
            if (this.plugin.settings.core.debug) {
              console.debug(
                `Skipping metadata-alias update - only frontmatter edited: ${file.path}`
              );
            }
            // Still update lastSavedContent even when skipping
            this.plugin.fileStateManager.setLastSavedContent(
              file.path,
              currentContent
            );
            return;
          }
          // No previousContent means no baseline: a note open or just edited but not yet seeded, or purged, so a YAML-only edit cannot be told apart and the alias update proceeds

          const target = this.findBackgroundAliasTarget(file, currentContent);
          if (target === 'user-typing') {
            verboseLog(
              this.plugin,
              `Skipping metadata-alias update - unsaved typing or a scheduled rename: ${file.path}`
            );
            // Still update lastSavedContent even when skipping
            this.plugin.fileStateManager.setLastSavedContent(
              file.path,
              currentContent
            );
            return;
          }

          verboseLog(
            this.plugin,
            `// EDITOR_PASS (metadata): Passing target=${target ? 'editor' : 'file'} to updateAliasIfNeeded`
          );

          await this.plugin.aliasManager.updateAliasIfNeeded(
            file,
            currentContent,
            undefined,
            target
          );

          // Update lastSavedContent after processing
          this.plugin.fileStateManager.setLastSavedContent(
            file.path,
            currentContent
          );
        } finally {
          this.pendingAliasUpdates.delete(file.path);
        }
      })
    );
  }
}
