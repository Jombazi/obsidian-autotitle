import {
  Component,
  Menu,
  TFile,
  TFolder,
  MarkdownView,
  EventRef,
} from 'obsidian';
import FirstLineIsTitlePlugin from '../../main';
import { verboseLog } from '../utils';
import {
  hasDisablePropertyInFile,
  frontmatterHasDisableProperty,
  disablePropertyIsOff,
} from '../utils/disable-property';
import {
  isFileOpenInAnyEditor,
  isOnlyFrontmatterChanged,
} from '../utils/editor-checks';
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
 */
export class EventHandlerManager {
  private plugin: FirstLineIsTitlePlugin;
  /** Tracks files with first line property updates in progress to prevent concurrent updates */
  private pendingFirstLinePropertyUpdates: Set<string> = new Set();
  /** Notes last seen blocking renaming, keyed by `TFile` because the object survives renames */
  private notesBlockingRename = new WeakSet<TFile>();
  /** Notes shown in a Markdown leaf since load, keyed by `TFile` because the object survives renames */
  private notesShownInEditor = new WeakSet<TFile>();
  /** When each note was last edited in any editor, keyed by `TFile` because the object survives renames */
  private lastEditorEditAt = new WeakMap<TFile, number>();
  /** Removes the YAML tag menu patch the last right-click installed; `monkey-around` removers are idempotent, so calling one that already ran is harmless */
  private pendingYamlMenuPatchRemove: (() => void) | null = null;
  /** Whether the unload callback removing a pending YAML tag menu patch is registered; done on the first YAML right-click, since some test stubs construct the manager without `plugin.register` */
  private yamlMenuPatchUnloadRegistered = false;
  /** The tag `contextmenu` listener of each pop-out window's document, unloaded when the window closes, so a closed window's document is not held until the plugin unloads */
  private readonly popoutTagMenuListeners = new Map<Document, Component>();

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
   * Choose where a background first line property update goes, from the file text the handler just read.
   * @param file - Note whose first line property may change
   * @param fileContent - Text the handler read from the file
   * @returns `'user-typing'` to skip the update, since the rename path owns first line property updates while the user has unsaved typing or a scheduled rename; the editor to write into; or null to write the file
   */
  private findBackgroundFirstLinePropertyTarget(
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
    if (!target) return null;
    // An editor holding other text has not loaded an outside change yet; the file write lets Obsidian reload it silently. Lengths first, which the CodeMirror document knows without joining its lines.
    const editorLength =
      target.editor.cm?.state.doc.length ?? target.editor.getValue().length;
    return editorLength === fileContent.length &&
      target.editor.getValue() === fileContent
      ? target
      : null;
  }

  /**
   * Check if a first line property update is in progress for a file.
   * Used by rename-engine to coordinate with event handlers.
   */
  isFirstLinePropertyUpdatePending(path: string): boolean {
    return this.pendingFirstLinePropertyUpdates.has(path);
  }

  /**
   * Mark a first line property update as in progress for a file.
   * Used by rename-engine to coordinate with event handlers.
   */
  markFirstLinePropertyUpdatePending(path: string): void {
    this.pendingFirstLinePropertyUpdates.add(path);
  }

  /**
   * Clear the first line property update in progress flag for a file.
   * Used by rename-engine to coordinate with event handlers.
   */
  clearFirstLinePropertyUpdatePending(path: string): void {
    this.pendingFirstLinePropertyUpdates.delete(path);
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
    // `processFile` takes the file lock before its first `await`, so the first line property `changed` handler registered after it sees the lock and leaves the first line property to the rename path.
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
          this.addMultiNoteMenuItems(menu, markdownFiles);
        }

        // Handle multiple folders
        if (folders.length > 1) {
          this.plugin.contextMenuManager.addMultiFolderMenuItems(menu, folders);
        }
      })
    );
  }

  /**
   * Add the rename, disable and enable items for several notes to the file explorer's selection menu or the search results menu.
   * @param menu - Menu being built
   * @param notes - Selected or matched Markdown notes
   */
  private addMultiNoteMenuItems(menu: Menu, notes: TFile[]): void {
    // No separator here — see MenuRenderer.render for why.
    menu.addItem((item) => {
      item
        .setTitle(tp('commands.putFirstLineInTitleNNotes', notes.length))
        .setIcon('file-type-corner')
        .onClick(() => {
          new RenameModal(this.plugin.app, this.plugin, notes).open();
        });
    });

    menu.addItem((item) => {
      item
        .setTitle(tp('commands.disableRenamingNNotes', notes.length))
        .setIcon('pen-off')
        .onClick(() => {
          new DisableEnableModal(
            this.plugin.app,
            this.plugin,
            notes,
            'disable'
          ).open();
        });
    });

    menu.addItem((item) => {
      item
        .setTitle(tp('commands.enableRenamingNNotes', notes.length))
        .setIcon('file-pen')
        .onClick(() => {
          new DisableEnableModal(
            this.plugin.app,
            this.plugin,
            notes,
            'enable'
          ).open();
        });
    });
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

        const tagInfo = detectTagFromEditor(view, editor.getCursor());

        if (tagInfo) {
          this.plugin.contextMenuManager.addTagMenuItems(menu, tagInfo.tagName);
        }
      })
    );
  }

  /**
   * Unified tag context menu handler using event delegation.
   * Handles both tag pane and YAML frontmatter tags with one DOM listener per window document.
   */
  private registerTagSearchMenuHandler(): void {
    // Module-scope `document` is the main window's, which lives as long as the plugin
    this.plugin.registerDomEvent(document, 'contextmenu', (evt) =>
      this.handleTagContextMenu(evt)
    );

    // A pop-out window has its own document, which the main one's listener never hears. A pop-out open when the plugin loads (a plugin reload with one open) sends no `window-open`, so those are read off the leaves they hold.
    this.plugin.app.workspace.onLayoutReady(() => {
      this.plugin.app.workspace.iterateAllLeaves((leaf) => {
        this.listenForPopoutTagMenus(leaf.view.containerEl.ownerDocument);
      });
    });
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('window-open', (_, win) => {
        this.listenForPopoutTagMenus(win.document);
      })
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('window-close', (_, win) => {
        const listener = this.popoutTagMenuListeners.get(win.document);
        if (!listener) return;
        this.popoutTagMenuListeners.delete(win.document);
        this.plugin.removeChild(listener);
      })
    );
  }

  /**
   * Listen for tag right-clicks in a pop-out window's document, once per document.
   * @param doc - Document of a window that may be a pop-out
   */
  private listenForPopoutTagMenus(doc: Document): void {
    // The leaf scan meets each document once per leaf, and a window can reach both the scan and `window-open`
    if (doc === document || this.popoutTagMenuListeners.has(doc)) return;
    // A child component per window rather than `plugin.registerDomEvent`, which would keep every closed window's document until the plugin unloads
    const listener = this.plugin.addChild(new Component());
    listener.registerDomEvent(doc, 'contextmenu', (evt) =>
      this.handleTagContextMenu(evt)
    );
    this.popoutTagMenuListeners.set(doc, listener);
  }

  /**
   * Add the plugin's tag items to the menu a right-click on a tag pane entry or a properties tag pill opens.
   * @param evt - The `contextmenu` event, from any window's document
   */
  private handleTagContextMenu(evt: MouseEvent): void {
    if (!this.plugin.settings.core.enableContextMenus) return;

    if (!(evt.target instanceof HTMLElement)) return;
    const target = evt.target;
    const tagInfo = detectTagFromDOM(target);

    if (!tagInfo) return;

    // Different handling based on where tag was found
    if (tagInfo.location === 'tag-pane') {
      // Tag pane: use Tag Wrangler's menuForEvent pattern; the event's own document shows the menu in the window that was clicked
      const menu = this.plugin.contextMenuManager.menuForEvent(evt, target.doc);
      this.plugin.contextMenuManager.addTagMenuItems(menu, tagInfo.tagName);
    } else if (tagInfo.location === 'yaml') {
      // YAML tags: use monkey-patching to inject into Obsidian's native menu
      this.pendingYamlMenuPatchRemove?.();
      if (!this.yamlMenuPatchUnloadRegistered) {
        this.yamlMenuPatchUnloadRegistered = true;
        this.plugin.register(() => this.pendingYamlMenuPatchRemove?.());
      }

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
      this.pendingYamlMenuPatchRemove = remove;
      // The pill's handler shows its menu from a 0 ms timer on the event's window, queued before this one (measured), so a patch still installed here met no menu and must not reach the next one
      target.win.setTimeout(remove, 0);
    }
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

          this.addMultiNoteMenuItems(menu, files);
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
        verboseLog(
          this.plugin,
          `Editor change detected for file: ${info.file?.path || 'unknown'}`
        );

        if (!this.plugin.settings.core.renameAutomatically) {
          verboseLog(
            this.plugin,
            `Skipping editor-change: renameAutomatically=${this.plugin.settings.core.renameAutomatically}`
          );
          return;
        }

        if (!info.file) {
          verboseLog(this.plugin, `Skipping editor-change: no file in info`);
          return;
        }

        if (info.file.extension !== 'md') {
          verboseLog(
            this.plugin,
            `Skipping editor-change: not Markdown (${info.file.extension})`
          );
          return;
        }

        // A page preview or Canvas card showing one section passes itself as `info`, and its editor's first line is the section's, not the note's.
        if ('subpath' in info && info.subpath) {
          verboseLog(
            this.plugin,
            `Skipping editor-change: section embed (${info.subpath})`
          );
          return;
        }

        // Another plugin writing into a Reading view's hidden editor fires this event too, and the view never saves that text (measured, Obsidian 1.14.4).
        if (info instanceof MarkdownView && info.getMode() !== 'source') {
          verboseLog(
            this.plugin,
            `Skipping editor-change: Reading view (${info.file.path})`
          );
          return;
        }

        this.rememberIfBlockingRename(info.file);
        this.lastEditorEditAt.set(info.file, Date.now());
        this.rememberSavedContentBaseline(info.file);

        // Early exit while the new-note pipeline or the New note delay still owns the note
        if (info.file && editor) {
          if (this.plugin.editorLifecycle.isFileInCreationWindow(info.file)) {
            verboseLog(
              this.plugin,
              `Skipping editor-change: file in creation window: ${info.file.path}`
            );
            return;
          }
        }

        if (!this.plugin.isFullyLoaded) {
          verboseLog(
            this.plugin,
            `Skipping editor-change: plugin not fully loaded`
          );
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
    if (hasDisablePropertyInFile(file, this.plugin.app, this.plugin.settings)) {
      this.notesBlockingRename.add(file);
    }
  }

  /** Seeds the baseline the first line property handlers compare a save against, so a properties-only save of an open note never writes a first line property value. */
  private rememberSavedContentBaseline(file: TFile): void {
    // Both readers return without a property name. A note already open when a name is first set therefore has no baseline, so its first properties-only save writes the value once (accepted).
    if (!hasFirstLinePropertyName(this.plugin.settings)) return;
    const { fileStateManager } = this.plugin;
    const existingBaseline = fileStateManager.getLastSavedContent(file.path);
    if (existingBaseline !== undefined) {
      // Refreshes the timestamp so the 10-minute purge cannot fall between an edit and its save.
      fileStateManager.setLastSavedContent(file.path, existingBaseline);
      return;
    }
    // An edit fires before its save, so disk still holds the content the first line property handlers compare that save against.
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
    // The note stays remembered; the new-note pipeline's creation rename, immediate or delayed, renames it.
    if (this.plugin.editorLifecycle.isFileInCreationWindow(file)) return;

    if (this.plugin.fileStateManager.isLocked(file.path)) {
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
    void this.plugin.renameEngine.processFile(file);
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
          this.plugin.fileStateManager.notifyFileRenamed(oldPath, file.path);

          // Update cache
          this.plugin.cacheManager.notifyFileRenamed(oldPath, file.path);

          // Clean up pendingFirstLinePropertyUpdates for old path (state moved to new path)
          this.pendingFirstLinePropertyUpdates.delete(oldPath);

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
          this.plugin.cacheManager.notifyFileDeleted(file.path);
          this.plugin.editorLifecycle.clearCreationDelayTimer(file.path);
          this.plugin.fileStateManager.notifyFileDeleted(file.path);
          // Clean up pendingFirstLinePropertyUpdates to prevent memory leak and blocking
          this.pendingFirstLinePropertyUpdates.delete(file.path);
        }
      })
    );

    // File modify handler
    this.plugin.registerEvent(
      this.plugin.app.vault.on('modify', async (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension !== 'md') return;

        // Skip if file operation in progress (rename, etc.)
        if (this.plugin.fileStateManager.isLocked(file.path)) return;

        // Skip if the new-note pipeline or the New note delay still owns the file
        if (this.plugin.editorLifecycle.isFileInCreationWindow(file)) {
          verboseLog(
            this.plugin,
            `Skipping modify: file in creation window: ${file.path}`
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
              await this.plugin.renameEngine.processFile(file);
            }
          }
        }

        // Update the first line property if a property name is set (respects manual/automatic mode)
        // Note: First line property updates happen on save events only (not every keystroke) to reduce
        // "modified externally" notifications from processFrontMatter writes.
        if (
          hasFirstLinePropertyName(this.plugin.settings) &&
          this.plugin.settings.core.renameAutomatically
        ) {
          // Skip if file has pending metadata update from processFrontMatter
          const hasPending =
            this.plugin.fileStateManager.hasPendingMetadataUpdate(file.path);
          verboseLog(
            this.plugin,
            `PENDING_META_CHECK (modify): ${file.path} awaits the metadata update of a first line property write → ${hasPending}`
          );
          if (hasPending) {
            return;
          }

          await this.updateFirstLinePropertyAfterSave(
            file,
            () => this.plugin.app.vault.read(file),
            'modify'
          );
        }
      })
    );

    // Metadata change handler
    this.plugin.registerEvent(
      this.plugin.app.metadataCache.on('changed', async (file, data) => {
        // Clear pending metadata flag FIRST, before any early return: a write made in manual mode (bulk or menu rename) would otherwise stay flagged, and once automatic renaming is back the next save's first line property update would be skipped
        if (this.plugin.fileStateManager.hasPendingMetadataUpdate(file.path)) {
          this.plugin.fileStateManager.clearPendingMetadataUpdate(file.path);
          verboseLog(
            this.plugin,
            `PENDING_META_CLEAR: ${file.path} received the metadata update of a first line property write`
          );
          // Don't return - continue to check if first line property update is needed
        }

        if (!hasFirstLinePropertyName(this.plugin.settings)) return;
        if (!this.plugin.settings.core.renameAutomatically) return;
        if (file.extension !== 'md') return;

        // Skip if file operation in progress (rename, etc.)
        if (this.plugin.fileStateManager.isLocked(file.path)) return;

        // Skip if the new-note pipeline or the New note delay still owns the file
        if (this.plugin.editorLifecycle.isFileInCreationWindow(file)) {
          verboseLog(
            this.plugin,
            `Skipping first line property update (metadata): file in creation window: ${file.path}`
          );
          return;
        }

        // The text Obsidian just indexed, read from the file in the same work item, so no second read is needed
        await this.updateFirstLinePropertyAfterSave(
          file,
          () => data,
          'metadata'
        );
      })
    );
  }

  /**
   * Update a saved note's first line property in the background, for the vault `modify` and metadata `changed` handlers.
   * @param file - Note just saved
   * @param readSavedContent - Returns the saved text; throws when the note was deleted or cannot be read
   * @param handlerLabel - Names the calling handler in debug logs
   */
  private async updateFirstLinePropertyAfterSave(
    file: TFile,
    readSavedContent: () => string | Promise<string>,
    handlerLabel: 'modify' | 'metadata'
  ): Promise<void> {
    // Skip if first line property update already in progress for this file
    if (this.pendingFirstLinePropertyUpdates.has(file.path)) {
      return;
    }

    // Background first line property updates follow only notes being edited: a closed note changed by sync, another plugin or a script is left alone, its saved-content baseline is dropped so the next open reseeds it from disk, and manual commands write their own first line property values.
    if (!this.isEditingNote(file)) {
      this.plugin.fileStateManager.deleteLastSavedContent(file.path);
      return;
    }

    // Mark as in-progress BEFORE any async operation to prevent race between modify and metadata-changed handlers
    this.pendingFirstLinePropertyUpdates.add(file.path);
    try {
      let currentContent: string;
      try {
        currentContent = await readSavedContent();
      } catch {
        // File was deleted or inaccessible
        return;
      }

      // Skip if only frontmatter changed (user manually editing YAML), to preserve its formatting
      // Use lastSavedContent - represents content from PREVIOUS save, not current editor buffer
      const previousContent = this.plugin.fileStateManager.getLastSavedContent(
        file.path
      );
      if (
        previousContent !== undefined &&
        isOnlyFrontmatterChanged(currentContent, previousContent)
      ) {
        verboseLog(
          this.plugin,
          `Skipping first line property update (${handlerLabel}) - only frontmatter edited: ${file.path}`
        );
        // Still update lastSavedContent even when skipping
        this.plugin.fileStateManager.setLastSavedContent(
          file.path,
          currentContent
        );
        return;
      }
      // No previousContent means no baseline: a note open or just edited but not yet seeded, or purged, so a YAML-only edit cannot be told apart and the first line property update proceeds

      const target = this.findBackgroundFirstLinePropertyTarget(
        file,
        currentContent
      );
      if (target === 'user-typing') {
        verboseLog(
          this.plugin,
          `Skipping first line property update (${handlerLabel}) - unsaved typing or a scheduled rename: ${file.path}`
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
        `EDITOR_PASS (${handlerLabel}): Passing target=${target ? 'editor' : 'file'} to updateFirstLinePropertyIfNeeded`
      );

      await this.plugin.firstLinePropertyManager.updateFirstLinePropertyIfNeeded(
        file,
        currentContent,
        target
      );

      // Update lastSavedContent after processing
      this.plugin.fileStateManager.setLastSavedContent(
        file.path,
        currentContent
      );
    } finally {
      this.pendingFirstLinePropertyUpdates.delete(file.path);
    }
  }
}
