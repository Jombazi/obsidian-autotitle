import {
  ConfirmationModal,
  App,
  TFile,
  TFolder,
  Notice,
  Platform,
} from 'obsidian';
import {
  verboseLog,
  shouldProcessFile,
  normalizeTag,
  canModifyFile,
} from './utils';
import { t, getPluralForm, tpSplit } from './i18n';
import { FirstLineIsTitlePlugin } from './settings/settings-base';
import { setDisableRenamingProperty } from './utils/property-value';
import { addFlitModalClass } from './modals/flit-modal-class';
import { addFormSheetHeaderButtons } from './modals/form-sheet-header';

/** The caution every bulk-action modal shows above its buttons. */
function appendBulkCaution(containerEl: HTMLElement): void {
  // Obsidian's own `mod-warning` class gives the theme's warning color, so no plugin CSS is needed.
  containerEl.createEl('p', {
    text: t('modals.bulkCaution'),
    cls: 'mod-warning',
  });
}

// Deliberately small: enough concurrency to hide per-file await latency, not
// enough to flood the vault adapter on mobile.
const BULK_CHUNK_SIZE = 8;

/**
 * Runs `handler` over `items` in fixed-size concurrent chunks, awaiting each
 * chunk before starting the next. `handler` must swallow its own failures so
 * one bad item cannot abort the batch.
 *
 * Safe for the rename loops: RenameEngine reserves a destination before it
 * awaits the rename and resolves conflicts against those reservations as well as
 * the vault index, so two notes resolving to the same title inside one chunk
 * still produce one plain title and one counter suffix. Which of the two takes
 * the suffix follows completion order rather than the ctime sort.
 */
async function forEachInChunks<T>(
  items: T[],
  handler: (item: T) => Promise<void>
): Promise<void> {
  for (let start = 0; start < items.length; start += BULK_CHUNK_SIZE) {
    await Promise.all(items.slice(start, start + BULK_CHUNK_SIZE).map(handler));
  }
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

  // `true` because processFile treats a bulk run as a manual command, which only the rename-blocking property stops.
  const { canModify } = canModifyFile(
    file,
    app,
    settings.exclusions.disableRenamingKey,
    settings.exclusions.disableRenamingValue,
    true
  );
  if (!canModify) return false;

  return shouldProcessFile(file, settings, app, undefined, undefined, plugin);
}

/** True when `file` sits anywhere under `folder`, subfolders included. */
function isFileUnderFolder(file: TFile, folder: TFolder): boolean {
  // The vault root's path is "/", which no note path starts with.
  return folder.isRoot() || file.path.startsWith(`${folder.path}/`);
}

/**
 * A bulk "Put first line in title" action. The exclusion settings alone decide
 * which notes it covers, so the dialog only confirms the run.
 */
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

  // The one list behind both the dialog's count and the run, so the two cannot disagree.
  private getFilesToProcess(): TFile[] {
    if (!this.filesToProcess) {
      this.filesToProcess = this.getNotesInScope().filter((file) =>
        isProcessedByBulkRename(file, this.plugin)
      );
    }
    return this.filesToProcess;
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

    const count = this.getFilesToProcess().length;
    const messagePara = contentEl.createEl('p');
    const parts = tpSplit('modals.renameNNotes', count);
    messagePara.appendText(parts.before);
    messagePara.createEl('strong', { text: `${count} ${parts.noun}` });
    messagePara.appendText(parts.after);

    appendBulkCaution(contentEl);
  }

  async renameFilesToProcess() {
    if (!this.plugin.renameEngine) {
      const notice = new Notice(t('notifications.renameEngineNotInitialized'));
      notice.containerEl.addClass('mod-warning');
      return;
    }

    // Copied because the sort below would otherwise reorder the cached list.
    const filesToRename = [...this.getFilesToProcess()];
    filesToRename.sort((a, b) => a.stat.ctime - b.stat.ctime);

    const renamingMsg = t('notifications.renamingNNotes').replace(
      '{{count}}',
      String(filesToRename.length)
    );
    verboseLog(this.plugin, `Showing notice: ${renamingMsg}`);
    const pleaseWaitNotice = new Notice(renamingMsg, 0);

    let renamedFileCount = 0;
    const errors: string[] = [];
    try {
      await forEachInChunks(filesToRename, async (file) => {
        try {
          // No exclusion overrides: processFile re-applies the gates to the note's live content, which can be ahead of the cache the count came from.
          const result = await this.plugin.renameEngine?.processFile(
            file,
            true,
            true,
            undefined,
            true
          );
          if (result?.success) {
            renamedFileCount++;
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          errors.push(`Failed to rename ${file.path}: ${errorMessage}`);
          console.error(`Error renaming ${file.path}`, error);
        }
      });

      if (errors.length > 0) {
        const errorMsg = t('notifications.renamedNotesWithErrors')
          .replace('{{renamed}}', String(renamedFileCount))
          .replace('{{total}}', String(filesToRename.length))
          .replace('{{errors}}', String(errors.length));
        verboseLog(this.plugin, `Showing notice: ${errorMsg}`);
        const errorNotice = new Notice(errorMsg, 0);
        errorNotice.containerEl.addClass('mod-warning');
        console.error('Rename errors:', errors);
      }
    } finally {
      if (this.plugin.cacheManager) {
        this.plugin.cacheManager.clearReservedPaths();
      }

      pleaseWaitNotice.hide();
      if (errors.length === 0) {
        const renamedMsg = t('notifications.renamedNotes')
          .replace('{{renamed}}', String(renamedFileCount))
          .replace('{{total}}', String(filesToRename.length));
        verboseLog(this.plugin, `Showing notice: ${renamedMsg}`);
        const successNotice = new Notice(renamedMsg, 0);
        successNotice.containerEl.addClass('mod-success');
      }
      verboseLog(
        this.plugin,
        `Bulk rename completed: ${renamedFileCount}/${filesToRename.length} files renamed`
      );
    }
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
    this.normalizedTag = normalizeTag(tag);
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
    const isMatch = (rawTag: string): boolean => {
      const normalized = normalizeTag(rawTag);
      return (
        normalized === this.normalizedTag ||
        normalized.startsWith(`${this.normalizedTag}/`)
      );
    };

    if (cache?.frontmatter?.tags) {
      const frontmatterTags = Array.isArray(cache.frontmatter.tags)
        ? cache.frontmatter.tags
        : [cache.frontmatter.tags];
      if (frontmatterTags.some((tag) => isMatch(String(tag)))) return true;
    }

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

  protected getNothingToRenameMessage(): string {
    return t('notifications.noNotesToRename');
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
    const count = this.files.length;

    const messagePara = contentEl.createEl('p');
    messagePara.appendText(
      this.action === 'disable'
        ? t('modals.disableEnableAddProperty')
        : t('modals.disableEnableRemoveProperty')
    );
    messagePara.createEl('strong', { text: `${key}:${value}` });
    messagePara.appendText(
      this.action === 'disable'
        ? t('modals.propertyTo')
        : t('modals.propertyFrom')
    );
    const nounForm =
      this.action === 'disable'
        ? getPluralForm(
            count,
            t('modals.note'),
            t('modals.noteFew'),
            t('modals.notes')
          )
        : count === 1
          ? t('modals.note')
          : t('modals.notesPrepositional');
    messagePara.createEl('strong', { text: `${count} ${nounForm}` });
    messagePara.appendText('.');
    appendBulkCaution(contentEl);

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
    this.addCancelButton(t('modals.buttons.cancel'));
  }

  async processFiles() {
    const filesToProcess = [...this.files];
    filesToProcess.sort((a, b) => a.stat.ctime - b.stat.ctime);

    // Ensure property type is set to checkbox before adding properties
    if (this.action === 'disable') {
      if (!this.plugin.propertyManager) {
        const notice = new Notice(
          t('notifications.propertyManagerNotInitialized')
        );
        notice.containerEl.addClass('mod-warning');
        return;
      }
      await this.plugin.propertyManager.ensurePropertyTypeIsCheckbox();
    }

    verboseLog(this.plugin, `Processing ${filesToProcess.length} notes...`);
    // This operation only writes a property, so it must not claim to rename.
    const processingMsg = t('notifications.processingNNotes').replace(
      '{{count}}',
      String(filesToProcess.length)
    );
    const pleaseWaitNotice = new Notice(processingMsg, 0);

    let processedCount = 0;
    const errors: string[] = [];

    try {
      // Safe to chunk: processFrontMatter is atomic per file and these writes
      // have no cross-file coupling.
      await forEachInChunks(filesToProcess, async (file) => {
        try {
          await this.app.fileManager.processFrontMatter(
            file,
            (frontmatter: Record<string, unknown>) => {
              setDisableRenamingProperty(
                frontmatter,
                this.plugin.settings,
                this.action === 'enable'
              );
            }
          );
          processedCount++;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          errors.push(`Failed to process ${file.path}: ${errorMessage}`);
          console.error(`Error processing ${file.path}`, error);
        }
      });
    } finally {
      pleaseWaitNotice.hide();
    }

    // Report exactly one outcome. Reporting success alongside errors contradicts
    // itself and misreports a total failure as "…for 0 notes" (Issue #6).
    if (errors.length > 0) {
      const errorMsg = t('notifications.processedNotesWithErrors')
        .replace('{{processed}}', String(processedCount))
        .replace('{{total}}', String(filesToProcess.length))
        .replace('{{errors}}', String(errors.length));
      const errorNotice = new Notice(errorMsg, 0);
      errorNotice.containerEl.addClass('mod-warning');
      console.error('Process errors:', errors);
    } else {
      const notificationKey =
        this.action === 'disable'
          ? 'notifications.disabledRenamingForNNotes'
          : 'notifications.enabledRenamingForNNotes';
      const actionPast = this.action === 'disable' ? 'Disabled' : 'Enabled';
      verboseLog(
        this.plugin,
        `${actionPast} renaming in ${processedCount} notes.`
      );
      new Notice(
        t(notificationKey).replace('{{count}}', String(processedCount))
      );
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class InternalLinkModal extends ConfirmationModal {
  plugin: FirstLineIsTitlePlugin;
  onSubmit: (linkTarget: string, linkDisplayText?: string) => void;
  withDisplayText: boolean;
  private enterKeyHandler?: (e: KeyboardEvent) => void;

  constructor(
    app: App,
    plugin: FirstLineIsTitlePlugin,
    onSubmit: (linkTarget: string, linkDisplayText?: string) => void,
    withDisplayText: boolean = false
  ) {
    super(app);
    addFlitModalClass(this);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
    this.withDisplayText = withDisplayText;
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
    textInput.focus();

    // Returns true while the input is empty, which keeps the confirmation dialog open
    const handleSubmit = (): true | undefined => {
      const inputText = textInput.value.trim();
      if (!inputText) return true;
      this.close();
      this.onSubmit(inputText, this.withDisplayText ? inputText : undefined);
    };

    const headerSubmitEl = Platform.isPhone
      ? addFormSheetHeaderButtons(this, () => {
          handleSubmit();
        })
      : null;
    if (headerSubmitEl === null) {
      this.addButton((btn) =>
        btn
          .setButtonText(t('modals.buttons.add'))
          .setCta()
          .onClick(handleSubmit)
      );
      this.addCancelButton(t('modals.buttons.cancel'));
    } else {
      // ConfirmationModal builds the row in its constructor; left empty, it would still leave a margin under the input
      this.buttonContainerEl.remove();
    }

    // Handle Enter key
    this.enterKeyHandler = (e: KeyboardEvent) => {
      // An Enter that confirms an IME composition (e.g., CJK input) belongs to the input method, not to the dialog
      if (e.isComposing || e.key !== 'Enter') return;
      e.preventDefault();
      handleSubmit();
    };
    textInput.addEventListener('keydown', this.enterKeyHandler);
  }

  onClose() {
    const { contentEl } = this;
    // Note: textInput is a child of contentEl, so its listener is removed when contentEl.empty() is called
    contentEl.empty();
  }
}
