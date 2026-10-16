import { Editor, MarkdownFileInfo, Notice, TFile } from 'obsidian';
import { verboseLog } from '../utils';
import { reverseCharacterReplacements } from '../utils/string-processing';
import { hasDisablePropertyInFile } from '../utils/disable-property';
import { RenameAllFilesModal } from '../modals';
import FirstLineIsTitle from '../../main';
import { t } from '../i18n';
import { IGNORE_ALL_EXCLUSIONS } from '../types';

/**
 * The active editor's editor for a rename command, or none when it shows one section of the note: a focused footnote or heading preview holds only that section's text, which would rename the note after it. The editor-change handler skips such embeds too; without an editor the rename reads the whole note itself.
 * @param activeEditor - `workspace.activeEditor`
 */
function wholeNoteEditor(activeEditor: MarkdownFileInfo): Editor | undefined {
  return activeEditor.subpath ? undefined : activeEditor.editor;
}

/** The active editor when it shows a Markdown note, which the rename commands need. */
type ActiveNoteEditor = MarkdownFileInfo & { file: TFile };

/**
 * CommandRegistrar
 *
 * Handles registration of all command palette commands for the plugin.
 *
 * Responsibilities:
 * - Register rename commands (current file, unless excluded, all files)
 * - Register link commands (safe internal link, with display text)
 * - Register toggle and utility commands
 */
export class CommandRegistrar {
  constructor(private plugin: FirstLineIsTitle) {}

  get app() {
    return this.plugin.app;
  }

  get settings() {
    return this.plugin.settings;
  }

  /**
   * Register all command palette commands
   */
  registerCommands(): void {
    this.registerRenameCurrentFileCommand();
    this.registerRenameCurrentFileUnlessExcludedCommand();
    this.registerRenameAllFilesCommand();
    this.registerSafeInternalLinkCommand();
    this.registerSafeInternalLinkWithDisplayTextCommand();
    this.registerInternalLinkWithDisplayTextAndCustomTargetCommand();
    this.registerToggleAutomaticRenamingCommand();
    this.registerDisableRenamingCommand();
    this.registerEnableRenamingCommand();
    this.registerInsertFilenameCommand();
  }

  /**
   * Register command: Put first line in title
   * Note: This command ignores path/tag/property exclusions but ALWAYS respects disable property
   */
  private registerRenameCurrentFileCommand(): void {
    this.plugin.addCommand({
      id: 'rename-current-file',
      name: t('commands.putFirstLineInTitle'),
      icon: 'file-type-corner',
      checkCallback: (checking: boolean) => {
        if (!this.getActiveNoteEditor()) return false;
        if (!checking) void this.executeRenameCurrentFile();
        return true;
      },
    });
  }

  /**
   * Register command: Put first line in title (unless excluded)
   */
  private registerRenameCurrentFileUnlessExcludedCommand(): void {
    this.plugin.addCommand({
      id: 'rename-current-file-unless-excluded',
      name: t('commands.putFirstLineInTitleUnlessExcluded'),
      icon: 'file-type-corner',
      checkCallback: (checking: boolean) => {
        if (!this.getActiveNoteEditor()) return false;
        if (!checking) void this.executeRenameUnlessExcluded();
        return true;
      },
    });
  }

  /**
   * Register command: Put first line in title in all notes
   */
  private registerRenameAllFilesCommand(): void {
    this.plugin.addCommand({
      id: 'rename-all-files',
      name: t('commands.putFirstLineInTitleAllNotes'),
      icon: 'file-stack',
      callback: () => {
        verboseLog(this.plugin, 'Bulk rename command triggered');
        new RenameAllFilesModal(this.app, this.plugin).open();
      },
    });
  }

  /**
   * Register command: Add safe internal link
   */
  private registerSafeInternalLinkCommand(): void {
    this.plugin.addCommand({
      id: 'add-safe-internal-link',
      name: t('commands.addSafeInternalLink'),
      icon: 'link',
      editorCallback: (editor) => {
        this.plugin.linkManager.addSafeInternalLink(editor);
      },
    });
  }

  /**
   * Register command: Add safe internal link with selection as display text
   */
  private registerSafeInternalLinkWithDisplayTextCommand(): void {
    this.plugin.addCommand({
      id: 'add-safe-internal-link-with-display-text',
      name: t('commands.addSafeInternalLinkWithDisplayText'),
      icon: 'link',
      editorCallback: (editor) => {
        this.plugin.linkManager.addSafeInternalLinkWithDisplayText(editor);
      },
    });
  }

  /**
   * Register command: Add internal link with display text and custom target
   */
  private registerInternalLinkWithDisplayTextAndCustomTargetCommand(): void {
    this.plugin.addCommand({
      id: 'add-internal-link-with-display-text-and-custom-target',
      name: t('commands.addInternalLinkWithDisplayTextAndCustomTarget'),
      icon: 'link',
      editorCallback: (editor) => {
        this.plugin.linkManager.addInternalLinkWithDisplayTextAndCustomTarget(
          editor
        );
      },
    });
  }

  /**
   * Register command: Toggle automatic renaming
   */
  private registerToggleAutomaticRenamingCommand(): void {
    this.plugin.addCommand({
      id: 'toggle-automatic-renaming',
      name: t('commands.toggleAutomaticRenaming'),
      icon: 'file-cog',
      callback: async () => {
        await this.executeToggleAutomaticRenaming();
      },
    });
  }

  /**
   * Execute rename current file command (public method for ribbon/external use)
   */
  async executeRenameCurrentFile(): Promise<void> {
    const activeEditor = this.getActiveNoteEditorOrNotify();
    if (!activeEditor) return;
    verboseLog(
      this.plugin,
      `Manual rename command triggered for ${activeEditor.file.path} (ignoring path/tag/property exclusions, respecting disable property)`
    );
    await this.plugin.renameEngine.processFile(activeEditor.file, {
      isManualCommand: true,
      exclusionOverrides: IGNORE_ALL_EXCLUSIONS,
      hasActiveEditor: true,
      editor: wholeNoteEditor(activeEditor),
    });
  }

  /**
   * Execute rename unless excluded command (public method for ribbon/external use)
   */
  async executeRenameUnlessExcluded(): Promise<void> {
    const activeEditor = this.getActiveNoteEditorOrNotify();
    if (!activeEditor) return;
    verboseLog(
      this.plugin,
      `Manual rename command triggered for ${activeEditor.file.path} (unless excluded)`
    );
    await this.plugin.renameEngine.processFile(activeEditor.file, {
      isManualCommand: true,
      hasActiveEditor: true,
      editor: wholeNoteEditor(activeEditor),
    });
  }

  private getActiveNoteEditor(): ActiveNoteEditor | null {
    const activeEditor = this.app.workspace.activeEditor;
    if (!activeEditor?.file || activeEditor.file.extension !== 'md') {
      return null;
    }
    return activeEditor as ActiveNoteEditor;
  }

  /** The ribbon runs the rename with no availability check, so it is told here when no note is active. */
  private getActiveNoteEditorOrNotify(): ActiveNoteEditor | null {
    const activeEditor = this.getActiveNoteEditor();
    if (!activeEditor) {
      verboseLog(
        this.plugin,
        `Showing notice: ${t('notifications.errorNoActiveNote')}`
      );
      new Notice(t('notifications.errorNoActiveNote'));
    }
    return activeEditor;
  }

  /**
   * Execute toggle automatic renaming command (public method for ribbon/external use)
   */
  async executeToggleAutomaticRenaming(): Promise<void> {
    const newValue = !this.settings.core.renameAutomatically;
    this.settings.core.renameAutomatically = newValue;
    await this.plugin.saveSettings();
    // Settings can stay open in its own window while the ribbon or command palette flips this.
    this.plugin.refreshSettingsTab();
    const notificationKey = newValue
      ? 'notifications.automaticRenamingEnabled'
      : 'notifications.automaticRenamingDisabled';
    new Notice(t(notificationKey));
  }

  /**
   * Register command: Disable renaming for current note
   * Uses checkCallback to only show when the note does not carry the disable property's value
   */
  private registerDisableRenamingCommand(): void {
    this.plugin.addCommand({
      id: 'disable-renaming-for-note',
      name: t('commands.disableRenamingForNote'),
      icon: 'pen-off',
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') {
          return false;
        }

        // Check the disable property (synchronously using cache)
        const hasProperty = hasDisablePropertyInFile(
          activeFile,
          this.app,
          this.settings
        );

        if (checking) {
          // Only show command if renaming is not already disabled
          return !hasProperty;
        }

        void this.plugin.setRenamingDisabledForNote(activeFile, true);
        return true;
      },
    });
  }

  /**
   * Register command: Enable renaming for current note
   * Uses checkCallback to only show when the note carries the disable property's value
   */
  private registerEnableRenamingCommand(): void {
    this.plugin.addCommand({
      id: 'enable-renaming-for-note',
      name: t('commands.enableRenamingForNote'),
      icon: 'file-pen',
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== 'md') {
          return false;
        }

        // Check the disable property (synchronously using cache)
        const hasProperty = hasDisablePropertyInFile(
          activeFile,
          this.app,
          this.settings
        );

        if (checking) {
          // Only show command if renaming is disabled
          return hasProperty;
        }

        void this.plugin.setRenamingDisabledForNote(activeFile, false);
        return true;
      },
    });
  }

  /**
   * Register command: Insert filename at cursor position
   * Inserts current filename at cursor position with character reversal
   */
  private registerInsertFilenameCommand(): void {
    this.plugin.addCommand({
      id: 'insert-filename',
      name: t('commands.insertFilename'),
      icon: 'clipboard-type',
      editorCheckCallback: (checking: boolean, editor, view) => {
        const file = view.file;
        if (!file || file.extension !== 'md') {
          return false;
        }

        if (checking) {
          return true;
        }

        // Reverses replacement characters whenever Character replacements is on; "Convert replacement characters" governs title insertion only
        const filename = reverseCharacterReplacements(
          file.basename,
          this.settings
        );

        // Insert filename at cursor
        editor.replaceSelection(filename);
        return true;
      },
    });
  }
}
