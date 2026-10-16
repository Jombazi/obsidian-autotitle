import {
  ConfirmationModal,
  App,
  TFile,
  TFolder,
  Notice,
  parseFrontMatterTags,
} from 'obsidian';
import { verboseLog, verboseLogger } from './utils';
import { shouldProcessFile } from './utils/file-exclusions';
import { canModifyFile } from './utils/disable-property';
import { tagKey, tagMatchesTargetTag } from './utils/tag-utils';
import { t, tp, tpSplit } from './i18n';
import { FirstLineIsTitlePlugin, showNotice } from './settings/settings-base';
import { setRenamingDisabledInFrontmatter } from './utils/property-value';
import { addFlitModalClass } from './modals/flit-modal-class';
import { addFormSheetActions } from './modals/form-sheet-header';

/** The caution a bulk-action modal shows above its buttons: renames name the exclusions too, while adding or removing the rename-blocking property ignores them, so it only asks for a backup. */
function appendBulkCaution(
  containerEl: HTMLElement,
  key: 'modals.bulkCaution' | 'modals.bulkBackupCaution' = 'modals.bulkCaution'
): void {
  // Obsidian's own `mod-warning` class gives the theme's warning color, so no plugin CSS is needed.
  containerEl.createEl('p', {
    text: t(key),
    cls: 'mod-warning',
  });
}

/** Appends the split form a plural group takes for `count`, with the count and its noun in bold. */
function appendBoldCount(
  paragraphEl: HTMLElement,
  keyPath: string,
  count: number
): void {
  const { before, noun, after } = tpSplit(keyPath, count);
  paragraphEl.appendText(before);
  paragraphEl.createEl('strong', { text: `${count} ${noun}` });
  paragraphEl.appendText(after);
}

// Deliberately small: enough concurrency to hide per-file await latency, not enough to flood the vault adapter on mobile.
const BULK_WORKER_COUNT = 8;

/**
 * Runs `handler` over `items` on a pool of `BULK_WORKER_COUNT` workers, each taking the next unstarted item as soon as its previous one settles, so one slow note (a rename rewriting many backlinks) holds up a single worker rather than its whole batch. Items start in array order. `handler` must swallow its own failures so one bad item cannot abort the batch.
 * Safe for the rename loops: RenameEngine reserves a destination before it awaits the rename and resolves conflicts against those reservations as well as the vault index, so two notes resolving to the same title while both are in flight still produce one plain title and one counter suffix. Which of the two takes the suffix follows which one reserves first rather than the ctime sort.
 */
async function forEachOnWorkerPool<T>(
  items: T[],
  handler: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      try {
        await handler(item);
      } catch (error) {
        // A rejecting handler breaks the contract, so the batch aborts: no further item starts, because the caller resumes on the rejection (the rename loop then clears its reservations) while the other workers would still be pulling items
        nextIndex = items.length;
        throw error;
      }
    }
  };
  const workerCount = Math.min(BULK_WORKER_COUNT, items.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));
}

interface BulkActionRun {
  plugin: FirstLineIsTitlePlugin;
  files: TFile[];
  /** Stays up until the run ends. */
  progressMessage: string;
  /** Handles one note and resolves whether it counts as done; a throw is recorded as that note's error. */
  processNote: (file: TFile) => Promise<boolean>;
  buildDoneMessage: (doneCount: number) => string;
  /** True keeps the success notice up, tinted, until dismissed; false shows a plain notice that fades, as the disable and enable runs always have. */
  keepDoneNotice: boolean;
  buildErrorMessage: (doneCount: number, errorCount: number) => string;
  /** Runs once every note has settled, whether or not the batch aborted. */
  cleanUp?: () => void;
}

/** Runs a bulk action over its notes, oldest first, behind a progress notice, then reports exactly one outcome. */
async function runBulkAction(run: BulkActionRun): Promise<void> {
  const { plugin, progressMessage } = run;
  // Copied because the sort would otherwise reorder the caller's list.
  const files = [...run.files].sort((a, b) => a.stat.ctime - b.stat.ctime);

  verboseLog(plugin, `Showing notice: ${progressMessage}`);
  const progressNotice = new Notice(progressMessage, 0);

  let doneCount = 0;
  const errors: string[] = [];
  try {
    await forEachOnWorkerPool(files, async (file) => {
      try {
        if (await run.processNote(file)) doneCount++;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        errors.push(`Failed to process ${file.path}: ${errorMessage}`);
        console.error(`Error processing ${file.path}`, error);
      }
    });
  } finally {
    progressNotice.hide();
    run.cleanUp?.();
  }

  // Exactly one outcome: a success notice beside the errors would contradict itself and misreport a total failure as "…for 0 notes" (Issue #6)
  const hasErrors = errors.length > 0;
  const outcomeMessage = hasErrors
    ? run.buildErrorMessage(doneCount, errors.length)
    : run.buildDoneMessage(doneCount);
  verboseLog(plugin, `Showing notice: ${outcomeMessage}`);
  if (!hasErrors && !run.keepDoneNotice) {
    new Notice(outcomeMessage);
  } else {
    // The outcome of a run the user may have walked away from stays up until dismissed
    showNotice(outcomeMessage, hasErrors ? 'warning' : 'success', 0);
  }
  if (hasErrors) console.error('Bulk action errors:', errors);
}

/**
 * Whether a bulk rename processes `file`, judged from the metadata cache without reading the note.
 * Applies the gates `RenameEngine.processFile` applies, so a note whose first line already matches its name still counts.
 */
function isProcessedByBulkRename(
  file: TFile,
  plugin: FirstLineIsTitlePlugin
): boolean {
  const { app, settings } = plugin;

  // A manual command, because processFile treats a bulk run as one, which only the rename-blocking property stops.
  const { canModify } = canModifyFile(file, app, settings, {
    isManualCommand: true,
  });
  if (!canModify) return false;

  return shouldProcessFile(file, settings, app, {
    log: verboseLogger(plugin),
  });
}

/** True when `file` sits anywhere under `folder`, subfolders included. */
function isFileUnderFolder(file: TFile, folder: TFolder): boolean {
  // The vault root's path is "/", which no note path starts with.
  return folder.isRoot() || file.path.startsWith(`${folder.path}/`);
}

/** A bulk "Put first line in title" action. The exclusion settings alone decide which notes it covers, so the dialog only confirms the run. */
abstract class BulkRenameModal extends ConfirmationModal {
  plugin: FirstLineIsTitlePlugin;
  protected readonly focusesCancelOnOpen: boolean = false;
  // Filled once: the modal is too short-lived for the vault to drift between the preview and the run.
  private filesToProcess: TFile[] | null = null;

  constructor(app: App, plugin: FirstLineIsTitlePlugin) {
    super(app);
    addFlitModalClass(this);
    this.plugin = plugin;
  }

  /** Every Markdown note the action targets, before exclusions. */
  protected abstract getNotesInScope(): TFile[];

  /** Shown in place of the dialog when exclusions leave no note to process. */
  protected abstract getNothingToRenameMessage(): string;

  // The one list behind both the run and the dialog's default count, so outside a multi-selection the two cannot disagree.
  private getFilesToProcess(): TFile[] {
    if (!this.filesToProcess) {
      this.filesToProcess = this.getNotesInScope().filter((file) =>
        isProcessedByBulkRename(file, this.plugin)
      );
    }
    return this.filesToProcess;
  }

  /** The number of notes the dialog says it will rename. */
  protected getDialogNoteCount(): number {
    return this.getFilesToProcess().length;
  }

  open(): void {
    if (this.getFilesToProcess().length === 0) {
      new Notice(this.getNothingToRenameMessage());
      return;
    }
    // Added here, not in onOpen, because ConfirmationModal.open reads setInitialFocus before it runs onOpen
    this.addButton((btn) =>
      btn
        .setButtonText(t('modals.buttons.rename'))
        .setCta()
        .onClick(() => {
          void this.renameFilesToProcess();
        })
    );
    // By hand rather than `addCancelButton`, which returns the modal and so leaves no button to give initial focus; hence FLIT's own Cancel label instead of Obsidian's
    this.addButton((btn) => {
      btn.setButtonText(t('modals.buttons.cancel')).setCancel();
      if (this.focusesCancelOnOpen) btn.setInitialFocus();
    });
    super.open();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    this.setTitle(t('modals.renameNotes'));

    appendBoldCount(
      contentEl.createEl('p'),
      'modals.renameNNotes',
      this.getDialogNoteCount()
    );

    appendBulkCaution(contentEl);
  }

  async renameFilesToProcess() {
    const { renameEngine } = this.plugin;
    const filesToRename = this.getFilesToProcess();
    // The dialog's own count, so a multi-selection's notices count every selected note ("Renamed 2/5"), the ones exclusions skip included
    const total = this.getDialogNoteCount();
    await runBulkAction({
      plugin: this.plugin,
      files: filesToRename,
      progressMessage: tp('notifications.renamingNotes', total),
      processNote: async (file) => {
        // No exclusion overrides: processFile re-applies the gates to the note's live content, which can be ahead of the cache the count came from.
        const result = await renameEngine.processFile(file, {
          isManualCommand: true,
          isBatchOperation: true,
        });
        return result.success;
      },
      keepDoneNotice: true,
      buildDoneMessage: (renamed) =>
        t('notifications.renamedNotes', { renamed, total }),
      buildErrorMessage: (renamed, errorCount) =>
        tp('notifications.renamedNotesWithNErrors', errorCount, {
          renamed,
          total,
        }),
      cleanUp: () => this.plugin.cacheManager.clearReservedPaths(),
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class RenameAllFilesModal extends BulkRenameModal {
  // Renaming every note in the vault is the most destructive thing the plugin does, so the safe choice takes focus and Enter confirms it.
  protected readonly focusesCancelOnOpen = true;

  protected getNotesInScope(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  protected getNothingToRenameMessage(): string {
    return t('notifications.noNotesToRename');
  }
}

export class RenameFolderModal extends BulkRenameModal {
  folder: TFolder;

  constructor(app: App, plugin: FirstLineIsTitlePlugin, folder: TFolder) {
    super(app, plugin);
    this.folder = folder;
  }

  protected getNotesInScope(): TFile[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => isFileUnderFolder(file, this.folder));
  }

  protected getNothingToRenameMessage(): string {
    return t('notifications.noNotesFoundInFolder', {
      folder: this.folder.path,
    });
  }
}

export class RenameMultipleFoldersModal extends BulkRenameModal {
  folders: TFolder[];

  constructor(app: App, plugin: FirstLineIsTitlePlugin, folders: TFolder[]) {
    super(app, plugin);
    this.folders = folders;
  }

  // One pass over the vault, so a note under a selected folder and its selected subfolder is counted and renamed once.
  protected getNotesInScope(): TFile[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) =>
        this.folders.some((folder) => isFileUnderFolder(file, folder))
      );
  }

  protected getNothingToRenameMessage(): string {
    return t('notifications.noNotesFoundInFolders');
  }
}

export class ProcessTagModal extends BulkRenameModal {
  tag: string;
  private normalizedTag: string;

  constructor(app: App, plugin: FirstLineIsTitlePlugin, tag: string) {
    super(app, plugin);
    this.tag = tag;
    this.normalizedTag = tagKey(tag);
  }

  /** Every Markdown file carrying the tag or one of its subtags. */
  protected getNotesInScope(): TFile[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => this.fileHasTag(file));
  }

  protected getNothingToRenameMessage(): string {
    return t('notifications.noNotesFoundWithTag', { tag: this.tag });
  }

  private fileHasTag(file: TFile): boolean {
    const cache = this.app.metadataCache.getFileCache(file);
    // Subtags always count: the dialog covers the tag's whole branch, whatever the exclusion settings say
    const isMatch = (rawTag: string): boolean =>
      tagMatchesTargetTag(tagKey(rawTag), this.normalizedTag, true);

    // Read as Obsidian reads them, so the dialog finds the notes Obsidian lists under the tag
    const frontmatterTags = parseFrontMatterTags(cache?.frontmatter) ?? [];
    if (frontmatterTags.some(isMatch)) return true;

    // Body tags live in the metadata cache rather than the frontmatter block.
    return cache?.tags?.some((tagCache) => isMatch(tagCache.tag)) ?? false;
  }
}

export class RenameModal extends BulkRenameModal {
  files: TFile[];

  constructor(app: App, plugin: FirstLineIsTitlePlugin, files: TFile[]) {
    super(app, plugin);
    this.files = files;
  }

  protected getNotesInScope(): TFile[] {
    return this.files;
  }

  // A selection is never empty, so nothing left to rename means every selected note was excluded or blocked
  protected getNothingToRenameMessage(): string {
    return t('notifications.allSelectedNotesExcluded');
  }

  // Every selected note, as the file menu label that opened the dialog counts them, even those exclusions will skip
  protected getDialogNoteCount(): number {
    return this.files.length;
  }
}

export class DisableEnableModal extends ConfirmationModal {
  plugin: FirstLineIsTitlePlugin;
  files: TFile[];
  action: 'disable' | 'enable';

  constructor(
    app: App,
    plugin: FirstLineIsTitlePlugin,
    files: TFile[],
    action: 'disable' | 'enable'
  ) {
    super(app);
    addFlitModalClass(this);
    this.plugin = plugin;
    this.files = files;
    this.action = action;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    this.setTitle(
      t(
        this.action === 'disable'
          ? 'commands.disableRenaming'
          : 'commands.enableRenaming'
      )
    );

    const key = this.plugin.settings.exclusions.disableRenamingKey;
    const value = this.plugin.settings.exclusions.disableRenamingValue;

    const messagePara = contentEl.createEl('p');
    messagePara.appendText(
      this.action === 'disable'
        ? t('modals.disableEnableAddProperty')
        : t('modals.disableEnableRemoveProperty')
    );
    messagePara.createEl('strong', { text: `${key}: ${value}` });
    appendBoldCount(
      messagePara,
      this.action === 'disable'
        ? 'modals.addPropertyToNNotes'
        : 'modals.removePropertyFromNNotes',
      this.files.length
    );
    appendBulkCaution(contentEl, 'modals.bulkBackupCaution');

    this.addButton((btn) =>
      btn
        .setButtonText(
          this.action === 'disable'
            ? t('modals.buttons.disable')
            : t('modals.buttons.enable')
        )
        .setCta()
        .onClick(() => {
          void this.processFiles();
        })
    );
    this.addCancelButton();
  }

  async processFiles() {
    // Ensure property type is set to checkbox before adding properties
    if (this.action === 'disable') {
      await this.plugin.propertyManager.ensurePropertyTypeIsCheckbox();
    }

    const total = this.files.length;
    const isEnabling = this.action === 'enable';
    await runBulkAction({
      plugin: this.plugin,
      files: this.files,
      // This operation only writes a property, so it must not claim to rename.
      progressMessage: tp('notifications.processingNotes', total),
      // Safe to run concurrently: processFrontMatter is atomic per file and these writes have no cross-file coupling.
      processNote: async (file) => {
        await this.app.fileManager.processFrontMatter(
          file,
          (frontmatter: Record<string, unknown>) => {
            setRenamingDisabledInFrontmatter(
              frontmatter,
              this.plugin.settings,
              !isEnabling
            );
          }
        );
        return true;
      },
      keepDoneNotice: false,
      buildDoneMessage: (processed) =>
        tp(
          isEnabling
            ? 'notifications.enabledRenamingForNNotes'
            : 'notifications.disabledRenamingForNNotes',
          processed
        ),
      buildErrorMessage: (processed, errorCount) =>
        tp('notifications.processedNotesWithNErrors', errorCount, {
          processed,
          total,
        }),
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class InternalLinkModal extends ConfirmationModal {
  onSubmit: (linkText: string) => void;

  constructor(app: App, onSubmit: (linkText: string) => void) {
    super(app);
    addFlitModalClass(this);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    this.setTitle(t('modals.internalLink'));

    // Single text input - always just one field
    const inputContainer = contentEl.createDiv({ cls: 'flit-input-container' });
    const textInput = inputContainer.createEl('input', {
      type: 'text',
      placeholder: t('modals.enterText'),
      cls: 'flit-link-input-full',
    });

    // Returns true while the input is empty, which keeps the confirmation dialog open
    const handleSubmit = (): true | undefined => {
      const inputText = textInput.value.trim();
      if (!inputText) return true;
      this.close();
      this.onSubmit(inputText);
    };

    addFormSheetActions(this, {
      submitText: t('modals.buttons.add'),
      submit: handleSubmit,
      submitOnEnterEls: [textInput],
      mobileFocusEl: textInput,
    });
  }

  onClose() {
    // Nothing to unregister: emptying detaches the input, and its Enter listener goes with it
    this.contentEl.empty();
  }
}
