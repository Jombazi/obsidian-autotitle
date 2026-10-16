import { TFile, MarkdownView, getFrontMatterInfo } from 'obsidian';
import { ExclusionOverrides, PluginSettings } from '../types';
import { verboseLog, verboseLogger } from '../utils';
import {
  resolveCurrentFrontmatter,
  shouldProcessFile,
} from '../utils/file-exclusions';
import { frontmatterHasDisableProperty } from '../utils/disable-property';
import { reverseCharacterReplacements } from '../utils/string-processing';
import { isUntitledName } from '../utils/title-extraction';
import { isOnlyCursorPlaceholders } from '../core/templater-integration';
import { TIMING } from '../constants/timing';
import FirstLineIsTitle from '../../main';

/** Attempts allowed when writing the title through the editor before falling back to vault.process */
const TITLE_INSERTION_MAX_ATTEMPTS = 10;

/** Pause after a programmatic editor write so CodeMirror applies the transaction before it is verified */
const EDITOR_TRANSACTION_SETTLE_MS = 10;

/** Where a title belongs in a note, derived from that note's content */
interface TitleInsertionPoint {
  /** Offset where the body starts: past the properties block and the line break after it, or 0 when there is no block */
  bodyStart: number;
  /** Line the body starts on: the first line below the properties block, or the closing fence's own line when `fenceEndsNote` */
  insertLine: number;
  /** True when the closing fence ends the note with no line break after it, so the title needs one written before it */
  fenceEndsNote: boolean;
  /** True when the body below the properties block already holds content other than Templater cursor placeholders */
  hasBodyContent: boolean;
}

/** An empty ATX heading opening the body, which the title fills */
interface EmptyHeading {
  /** The heading line as found, trimmed */
  line: string;
  /** Its index in the note */
  lineIndex: number;
  /** Its `#` marks */
  hashMarks: string;
}

/** The line break `content` already uses, so an inserted title does not mix CRLF and LF */
function lineBreakOf(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Find the body's first non-empty line when it is an empty ATX heading.
 * @param content - Note text
 * @param fromLine - Line the body starts on
 * @returns The heading, or null when the first non-empty line is anything else
 */
function findEmptyHeading(
  content: string,
  fromLine: number
): EmptyHeading | null {
  const lines = content.split('\n');
  for (let lineIndex = fromLine; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trim();
    if (line !== '') {
      const headingMatch = line.match(/^(#{1,6})(\s*)$/);
      return headingMatch
        ? { line, lineIndex, hashMarks: headingMatch[1] }
        : null;
    }
  }
  return null;
}

/** Outcome of a title insertion attempt */
export interface TitleInsertionResult {
  /** True when the title ended up in the note (freshly written, or already present) */
  inserted: boolean;
  /** True when this call scheduled the cursor move, so the delayed cursor pass would only repeat it */
  cursorPositioned: boolean;
}

/** Where title insertion leaves the cursor, as the new-note coordinator decided: `line-end` puts it at the end of the title line (or of the body's first line when no title goes in), `none` leaves it where CodeMirror maps it, `keep-template-cursor` leaves the cursor a template placed unless it sits where the title goes, which then ends at the title line end as `line-end` would; chosen only where FLIT's own placement would be `line-end` */
export type TitleCursorPlacement = 'line-end' | 'none' | 'keep-template-cursor';

/** Returned by every insertion path that leaves the note and the cursor alone */
const NOT_INSERTED: Readonly<TitleInsertionResult> = Object.freeze({
  inserted: false,
  cursorPositioned: false,
});

export class FileOperations {
  constructor(private plugin: FirstLineIsTitle) {}

  get app() {
    return this.plugin.app;
  }

  get settings(): PluginSettings {
    return this.plugin.settings;
  }

  /**
   * Derive where a title belongs in `content`, and whether a body is already there.
   *
   * Single source of truth for every path that has to answer that question. The editor
   * write path, the vault.process fallback and the cursor pass each derived it separately
   * before, which let them disagree: the editor path could insert a second title into a
   * note whose body had filled in since its snapshot was taken.
   */
  private deriveTitleInsertionPoint(content: string): TitleInsertionPoint {
    // getFrontMatterInfo rather than a scan for '---' lines: the scan split on '\n' alone, so a CRLF note's fences read as '---\r' and its properties counted as body
    const frontmatterInfo = getFrontMatterInfo(content);
    const bodyStart = frontmatterInfo.exists ? frontmatterInfo.contentStart : 0;

    return {
      bodyStart,
      insertLine: content.slice(0, bodyStart).split('\n').length - 1,
      fenceEndsNote: frontmatterInfo.exists && content[bodyStart - 1] !== '\n',
      // A cursor placeholder is Templater's transient marker, not note content, so the title goes in above a body of only placeholders, which stay for a later jump, whatever "Strip Templater markup" says
      hasBodyContent: !isOnlyCursorPlaceholders(content.slice(bodyStart)),
    };
  }

  /**
   * Find the Markdown view showing `file`, preferring one the caller already resolved.
   *
   * A single note creation used to run this scan up to seven times across the call chain,
   * each one allocating a fresh array and walking every leaf in every pane. The hint lets
   * the chain share one resolution. It is re-validated rather than trusted, because a leaf
   * can be closed or re-targeted between the caller's lookup and this call, and a stale view
   * would act on the wrong note. Callers must not pass a hint across a timer boundary.
   */
  resolveMarkdownViewForFile(
    file: TFile,
    hint?: MarkdownView | null
  ): MarkdownView | null {
    // Every caller reads the view or writes through its editor, so a view without one never matches
    const matches = (view: MarkdownView | null | undefined): boolean =>
      !!view && view.file?.path === file.path && !!view.editor;

    if (matches(hint)) {
      return hint as MarkdownView;
    }

    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && matches(view)) {
        return view;
      }
    }

    return null;
  }

  /**
   * Find the view showing `file` whose editor writes reach the note.
   * A Reading view's hidden editor takes a write and fires `editor-change`, but the view never saves it (measured, Obsidian 1.14.4), so a title written there is lost while the editor reads back as holding it.
   * @param hint - View already resolved by the caller, re-validated before use
   * @returns The view in Source view or Live Preview, or null to write the file
   */
  private resolveEditingViewForFile(
    file: TFile,
    hint?: MarkdownView | null
  ): MarkdownView | null {
    const view = this.resolveMarkdownViewForFile(file, hint);
    return view?.getMode() === 'source' ? view : null;
  }

  /**
   * Inserts the filename as the first line of a newly created file
   * @param initialContent - Content the new-note coordinator judged: the creation snapshot, or the note as a template left it
   * @param cursorPlacement - Where the coordinator decided the cursor ends up
   * @param viewHint - View already resolved by the caller, re-validated before use
   * @param writeThroughFile - True to write the file even when a view shows the note
   */
  async insertTitle(
    file: TFile,
    initialContent: string,
    cursorPlacement: TitleCursorPlacement,
    viewHint?: MarkdownView | null,
    writeThroughFile = false
  ): Promise<TitleInsertionResult> {
    try {
      if (isUntitledName(file.basename)) {
        verboseLog(
          this.plugin,
          `Skipping title insertion for untitled file: ${file.path}`
        );
        return NOT_INSERTED;
      }

      // "Convert replacement characters" governs title insertion only; the insert-filename command follows the Character replacements toggle alone
      // Title goes into the note body, so restore the spacing the trim flags stripped from the filename
      const cleanTitle = this.settings.core.convertReplacementChars
        ? reverseCharacterReplacements(
            file.basename,
            this.settings,
            verboseLogger(this.plugin),
            { restoreTrimmedSpacing: true }
          )
        : file.basename;

      verboseLog(
        this.plugin,
        `Inserting title "${cleanTitle}" in new file: ${file.path}`
      );

      const snapshotPoint = this.deriveTitleInsertionPoint(initialContent);

      // One lookup for every path below - the CREATE handler has usually resolved it already
      // No view through the file: the view still shows text older than the file, and its reload would wipe an editor write
      const targetView = writeThroughFile
        ? null
        : this.resolveEditingViewForFile(file, viewHint);

      if (!snapshotPoint.hasBodyContent) {
        return await this.insertTitleIntoEmptyBody(
          file,
          cleanTitle,
          targetView,
          cursorPlacement
        );
      }

      verboseLog(this.plugin, `File has content (excluding YAML)`);
      const emptyHeading = findEmptyHeading(
        initialContent,
        snapshotPoint.insertLine
      );
      if (emptyHeading) {
        return await this.fillEmptyHeading(
          file,
          cleanTitle,
          emptyHeading,
          targetView,
          cursorPlacement
        );
      }

      verboseLog(
        this.plugin,
        `File has content without heading pattern, skipping title insertion for ${file.path}`
      );
      return {
        inserted: false,
        cursorPositioned: this.placeCursorOnBodyLine(
          file,
          initialContent,
          snapshotPoint.insertLine,
          targetView,
          cursorPlacement
        ),
      };
    } catch (error) {
      console.error(
        `Error inserting title on creation for ${file.path}:`,
        error
      );
      return NOT_INSERTED;
    }
  }

  /**
   * Write the title into the empty heading a template opened the body with.
   * @param emptyHeading - The heading found in the creation snapshot
   * @param targetView - View showing the note, or null to write the file
   * @param cursorPlacement - Where the coordinator decided the cursor ends up
   */
  private async fillEmptyHeading(
    file: TFile,
    cleanTitle: string,
    emptyHeading: EmptyHeading,
    targetView: MarkdownView | null,
    cursorPlacement: TitleCursorPlacement
  ): Promise<TitleInsertionResult> {
    // The heading's own level is kept, so formatAsHeading does not apply here
    const titleWithHeading = `${emptyHeading.hashMarks} ${cleanTitle}`;

    verboseLog(
      this.plugin,
      `[TITLE-INSERT] Found heading pattern "${emptyHeading.line}" at line ${emptyHeading.lineIndex}, inserting title`
    );

    let cursorPositioned = false;

    if (targetView) {
      // Read before the write: the title fills this line, so a template cursor anywhere on it sits where the title goes
      const templateCursorAtTitle =
        cursorPlacement === 'keep-template-cursor' &&
        targetView.editor.getCursor().line === emptyHeading.lineIndex;

      // Guard our own write: CodeMirror fires editor-change for setLine exactly as it does for a keystroke, and the flag keeps that event out of the rename pipeline independently of the creation window the new-note pipeline holds the note in
      this.plugin.fileStateManager.markEditorSyncing(file.path);
      try {
        targetView.editor.setLine(emptyHeading.lineIndex, titleWithHeading);
        verboseLog(
          this.plugin,
          `[TITLE-INSERT] Replaced heading at line ${emptyHeading.lineIndex} via editor`
        );

        if (cursorPlacement === 'line-end' || templateCursorAtTitle) {
          this.positionCursorAfterTitleInsertion(
            targetView,
            emptyHeading.lineIndex,
            titleWithHeading.length
          );
          cursorPositioned = true;
        }
      } finally {
        this.plugin.fileStateManager.clearEditorSyncing(file.path);
      }
    } else {
      verboseLog(
        this.plugin,
        `[TITLE-INSERT] Replacing heading via vault.process`
      );
      await this.app.vault.process(file, (content) => {
        // Re-found in the fresh content, since the snapshot's line index can be stale; `split('\n')` leaves a CRLF note's `\r` on each line, which the replacement keeps
        const lines = content.split('\n');
        const { insertLine } = this.deriveTitleInsertionPoint(content);
        const headingIndex = lines.findIndex(
          (line, index) => index >= insertLine && line.trim() !== ''
        );
        if (
          headingIndex === -1 ||
          lines[headingIndex].trim() !== emptyHeading.line
        ) {
          return content;
        }
        const carriageReturn = lines[headingIndex].endsWith('\r') ? '\r' : '';
        lines[headingIndex] = titleWithHeading + carriageReturn;
        return lines.join('\n');
      });
    }

    verboseLog(
      this.plugin,
      `Successfully inserted title in heading for ${file.path}`
    );
    return { inserted: true, cursorPositioned };
  }

  /**
   * Put the cursor at the end of the body's first line when the note already has a body and no title goes in.
   * @param content - The creation snapshot, read for the exclusion check
   * @param bodyLine - Line the body starts on
   * @param targetView - View showing the note, if any
   * @param cursorPlacement - Where the coordinator decided the cursor ends up; only `line-end` moves it here, since no title goes where a template cursor could sit
   * @returns True when a cursor move was scheduled
   */
  private placeCursorOnBodyLine(
    file: TFile,
    content: string,
    bodyLine: number,
    targetView: MarkdownView | null,
    cursorPlacement: TitleCursorPlacement
  ): boolean {
    if (!targetView || cursorPlacement !== 'line-end') {
      return false;
    }
    // The cursor is never moved in an excluded note
    if (this.isFileExcludedForCursorPositioning(file, content)) {
      return false;
    }
    this.positionCursorAfterTitleInsertion(
      targetView,
      bodyLine,
      targetView.editor.getLine(bodyLine).length
    );
    return true;
  }

  /**
   * Write the title as the body's first line, through the editor when one shows the note, otherwise through vault.process.
   * @param targetView - View showing the note, or null to write the file
   * @param cursorPlacement - Where the coordinator decided the cursor ends up
   */
  private async insertTitleIntoEmptyBody(
    file: TFile,
    cleanTitle: string,
    targetView: MarkdownView | null,
    cursorPlacement: TitleCursorPlacement
  ): Promise<TitleInsertionResult> {
    // Apply formatAsHeading setting since no heading pattern was found
    const finalTitle = this.settings.core.formatAsHeading
      ? '# ' + cleanTitle
      : cleanTitle;

    // Check if canvas active - canvas files have no editor, use vault.process() immediately
    const canvasIsActive =
      this.app.workspace.getMostRecentLeaf()?.view?.getViewType?.() ===
      'canvas';
    let insertedViaEditor = false;
    let cursorPositioned = false;

    if (!canvasIsActive && targetView) {
      const view = targetView;

      // Re-derive from live editor content rather than the creation-time snapshot. Reports
      // 'inserted' when the title is already on the insertion line, 'blocked' when a body
      // appeared underneath the properties block, 'pending' when a write is still needed.
      // Order matters: our own successful write makes a body appear, so the
      // already-inserted test has to come first.
      const inspectLiveContent = (): {
        state: 'inserted' | 'blocked' | 'pending';
        point: TitleInsertionPoint;
        lineBreak: string;
      } => {
        const liveContent = view.editor.getValue();
        const point = this.deriveTitleInsertionPoint(liveContent);
        const lineBreak = lineBreakOf(liveContent);
        const lineAtInsertPoint = liveContent.split('\n')[point.insertLine];

        if (lineAtInsertPoint?.trim() === finalTitle.trim()) {
          return { state: 'inserted', point, lineBreak };
        }
        if (point.hasBodyContent) {
          return { state: 'blocked', point, lineBreak };
        }
        return { state: 'pending', point, lineBreak };
      };

      // Verify before writing. The previous loop wrote first and never undid a failed
      // attempt, so ten failed verifications prepended ten titles.
      let outcome = inspectLiveContent();

      // Read before the write: CodeMirror keeps a cursor at the insertion offset in front of the inserted text, so a template cursor there would end up before the title
      const templateCursorAtTitle =
        cursorPlacement === 'keep-template-cursor' &&
        view.editor.posToOffset(view.editor.getCursor()) ===
          outcome.point.bodyStart;

      if (outcome.state === 'pending') {
        // Guard our own writes for the whole retry loop: CodeMirror fires editor-change for replaceRange exactly as it does for a keystroke, and the flag keeps those events out of the rename pipeline independently of the creation window the new-note pipeline holds the note in; the finally clears it on every exit path, throws included
        this.plugin.fileStateManager.markEditorSyncing(file.path);
        try {
          for (
            let attempt = 0;
            attempt < TITLE_INSERTION_MAX_ATTEMPTS &&
            outcome.state === 'pending';
            attempt++
          ) {
            if (attempt > 0) {
              verboseLog(
                this.plugin,
                `[TITLE-INSERT] Verification failed, retry in ${TIMING.VIEW_READINESS_RETRY_DELAY_MS}ms (attempt ${attempt + 1})`
              );
              await new Promise((resolve) =>
                window.setTimeout(resolve, TIMING.VIEW_READINESS_RETRY_DELAY_MS)
              );
            }

            // Every position comes from the live re-derivation, never the creation snapshot: Live Preview appends the closing fence's line break itself, so a snapshot can report a fence ending the note after it no longer does
            const { point, lineBreak } = outcome;
            if (point.fenceEndsNote) {
              // Line insertLine is the fence itself and no line exists below it yet, so the title goes after the fence behind a line break of its own
              view.editor.replaceRange(
                lineBreak + finalTitle + lineBreak,
                view.editor.offsetToPos(point.bodyStart)
              );
            } else {
              view.editor.replaceRange(finalTitle + lineBreak, {
                line: point.insertLine,
                ch: 0,
              });
            }

            // Let editor process the change before verification
            await new Promise((resolve) =>
              window.setTimeout(resolve, EDITOR_TRANSACTION_SETTLE_MS)
            );

            outcome = inspectLiveContent();
          }
        } finally {
          this.plugin.fileStateManager.clearEditorSyncing(file.path);
        }
      }

      if (outcome.state === 'blocked') {
        // A body appeared between the snapshot and now - the same race the vault.process
        // fallback names. Return instead of falling through to it: vault.process reads from
        // disk, which lags the editor by Obsidian's ~2s save debounce, so it would see an
        // empty body and insert a duplicate (odkb/obsidian-api-quirks.md).
        verboseLog(
          this.plugin,
          `[TITLE-INSERT] Body content appeared since creation, skipping insertion for ${file.path}`
        );
        return NOT_INSERTED;
      }

      if (outcome.state === 'inserted') {
        verboseLog(
          this.plugin,
          `[TITLE-INSERT] Verified insertion at line ${outcome.point.insertLine}`
        );
        if (cursorPlacement === 'line-end' || templateCursorAtTitle) {
          this.positionCursorAfterTitleInsertion(
            view,
            outcome.point.insertLine,
            finalTitle.length
          );
          cursorPositioned = true;
        }
        insertedViaEditor = true;
      } else {
        verboseLog(
          this.plugin,
          `[TITLE-INSERT] Verification failed after ${TITLE_INSERTION_MAX_ATTEMPTS} attempts, fallback to vault.process`
        );
      }
    }

    if (!insertedViaEditor) {
      verboseLog(
        this.plugin,
        `[TITLE-INSERT] Inserting title via vault.process`
      );
      let wroteViaVault = false;

      await this.app.vault.process(file, (content) => {
        // Re-derive from the callback's content rather than the creation-time snapshot,
        // through the same helper the editor path uses so the two cannot drift again.
        const point = this.deriveTitleInsertionPoint(content);

        if (point.hasBodyContent) {
          // Content exists - skip insertion to avoid duplicate
          return content;
        }

        wroteViaVault = true;

        const lineBreak = lineBreakOf(content);
        return (
          content.slice(0, point.bodyStart) +
          (point.fenceEndsNote ? lineBreak : '') +
          finalTitle +
          lineBreak +
          content.slice(point.bodyStart)
        );
      });

      if (!wroteViaVault) {
        verboseLog(
          this.plugin,
          `[TITLE-INSERT] Body content already present on disk, skipped insertion for ${file.path}`
        );
        return NOT_INSERTED;
      }
    }

    verboseLog(this.plugin, `Successfully inserted title in ${file.path}`);
    return { inserted: true, cursorPositioned };
  }

  /**
   * Put the cursor on a new note's title line, as the new-note coordinator decided
   * @param file - The file to position cursor in
   * @param placeCursorAtEnd - True for the end of the title line, false for its start
   * @param viewHint - View already resolved by the caller, re-validated before use
   */
  async handleCursorPositioning(
    file: TFile,
    placeCursorAtEnd: boolean,
    viewHint?: MarkdownView | null
  ): Promise<void> {
    try {
      verboseLog(
        this.plugin,
        `handleCursorPositioning called for ${file.path}, placeCursorAtEnd: ${placeCursorAtEnd}`
      );

      // Every step below goes through the editor, so only a view whose editor writes reach the note counts
      const targetView = this.resolveEditingViewForFile(file, viewHint);

      verboseLog(
        this.plugin,
        `Target view found: ${!!targetView}, file matches: ${targetView?.file?.path === file.path}`
      );

      if (targetView) {
        const editor = targetView.editor;
        // No view-state transition here: Obsidian's own creators open a new note in Source view or Live Preview whatever "Default view for new tabs" says (app.js 1.14.4), and a note another plugin opens in Reading view is left as the user configured it.
        editor.focus();

        const content = editor.getValue();
        const point = this.deriveTitleInsertionPoint(content);
        const titleLineNumber = point.insertLine;

        if (point.bodyStart > 0) {
          verboseLog(
            this.plugin,
            `Found frontmatter, title on line ${titleLineNumber}`
          );
        } else {
          verboseLog(
            this.plugin,
            `No frontmatter found, title on line ${titleLineNumber}`
          );
        }

        const titleLineLength = editor.getLine(titleLineNumber).length;

        let targetPosition = {
          line: titleLineNumber,
          ch: placeCursorAtEnd ? titleLineLength : 0,
        };

        if (point.fenceEndsNote) {
          // The note ends at the closing fence, so the cursor gets a new line below it: on the fence line, typing would turn `---` into `---text` and the block would stop being properties
          this.plugin.fileStateManager.markEditorSyncing(file.path);
          try {
            editor.replaceRange(
              lineBreakOf(content),
              editor.offsetToPos(point.bodyStart)
            );
          } finally {
            this.plugin.fileStateManager.clearEditorSyncing(file.path);
          }
          targetPosition = { line: titleLineNumber + 1, ch: 0 };
        }

        verboseLog(
          this.plugin,
          `[CURSOR-FLIT] file-operations.ts - BEFORE setCursor() | target: line ${targetPosition.line} ch ${targetPosition.ch}`
        );
        editor.setCursor(targetPosition);
        verboseLog(
          this.plugin,
          `[CURSOR-POS] Set cursor to line ${targetPosition.line}, ch ${targetPosition.ch} for ${file.path}`
        );
      } else {
        verboseLog(
          this.plugin,
          `Skipping cursor positioning - no matching active view for ${file.path}`
        );
      }
    } catch (error) {
      console.error(`Error positioning cursor for ${file.path}:`, error);
    }
  }

  /**
   * Write the line break below a closing fence that ends the note through the file, as `handleCursorPositioning` writes it through the editor
   * @param file - Note to write, re-derived from its current text
   */
  async addLineAfterEndingFence(file: TFile): Promise<void> {
    await this.app.vault.process(file, (content) => {
      const point = this.deriveTitleInsertionPoint(content);
      if (!point.fenceEndsNote) {
        return content;
      }
      return (
        content.slice(0, point.bodyStart) +
        lineBreakOf(content) +
        content.slice(point.bodyStart)
      );
    });
  }

  /**
   * Check if file is excluded from processing (path/tag/property exclusions + disable property)
   * Uses real-time content checking for tags if content provided
   * @param exclusionOverrides - Per-caller opt-outs; callers own which exclusion types apply
   */
  isFileExcludedForCursorPositioning(
    file: TFile,
    content?: string,
    exclusionOverrides?: ExclusionOverrides
  ): boolean {
    if (
      !shouldProcessFile(file, this.settings, this.app, {
        content,
        exclusionOverrides,
        log: verboseLogger(this.plugin),
      })
    ) {
      return true;
    }

    // Empty content reads as none, so a note just created with nothing in it is judged by the cache
    return this.checkDisablePropertyInContent(file, content || undefined);
  }

  /**
   * Check for the disable-renaming property in the content's properties, falling back to the metadata cache as the rename gate does when the content has none that parse.
   * Excluded properties are deliberately NOT checked here: shouldProcessFile now reads the
   * same real-time content, so duplicating the rules would fork the matcher again.
   */
  private checkDisablePropertyInContent(
    file: TFile,
    content: string | undefined
  ): boolean {
    const { disableRenamingKey, disableRenamingValue } =
      this.settings.exclusions;
    const hasDisableProperty = frontmatterHasDisableProperty(
      resolveCurrentFrontmatter(file, this.app, content) ?? {},
      disableRenamingKey,
      disableRenamingValue
    );

    if (hasDisableProperty) {
      verboseLog(
        this.plugin,
        `Found disable property: ${disableRenamingKey}: ${disableRenamingValue}`
      );
    }

    return hasDisableProperty;
  }

  /**
   * Schedule the cursor move to the end of the title line after insertion; callers decide whether it happens, following the coordinator's `TitleCursorPlacement`
   * @param view The Markdown view where title was inserted
   * @param titleLine Line number where title was inserted
   * @param titleLength Length of the inserted title
   */
  private positionCursorAfterTitleInsertion(
    view: MarkdownView,
    titleLine: number,
    titleLength: number
  ): void {
    window.setTimeout(() => {
      if (view.editor) {
        view.editor.focus();
        verboseLog(
          this.plugin,
          `[CURSOR-FLIT] file-operations.ts - BEFORE setCursor() | target: line ${titleLine} ch ${titleLength}`
        );
        view.editor.setCursor({ line: titleLine, ch: titleLength });
        verboseLog(
          this.plugin,
          `[TITLE-INSERT] Positioned cursor at end of title line ${titleLine} (${titleLength} chars)`
        );
      }
    }, 0);
  }
}
