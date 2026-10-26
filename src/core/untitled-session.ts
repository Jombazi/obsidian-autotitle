import { TFile } from "obsidian";
import { t } from "../i18n";

/**
 * Tracks which notes may be renamed automatically when
 * "Only auto-rename Untitled notes" is enabled.
 *
 * A note is eligible while it is the note you are working in and it was
 * named "Untitled" (or "Untitled n") when you opened it. Once you open a
 * different note, eligibility ends, so later edits never rename it again.
 *
 * TFile objects keep their identity across renames, so tracking the object
 * (not the path) follows the note as it is renamed from "Untitled" onward.
 */
export class UntitledSession {
  private eligible = new Set<TFile>();

  isUntitledName(basename: string): boolean {
    const words = new Set([t("untitled"), "Untitled"]);
    for (const word of words) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`^${escaped}( [1-9]\\d*)?$`).test(basename)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Call when a note becomes the active note.
   * @param hasPendingRename - notes with a queued rename keep eligibility
   *   until that rename runs, so the final characters typed are not lost.
   */
  onFileOpen(
    file: TFile | null,
    hasPendingRename: (file: TFile) => boolean = () => false,
  ): void {
    for (const tracked of [...this.eligible]) {
      if (tracked !== file && !hasPendingRename(tracked)) {
        this.eligible.delete(tracked);
      }
    }
    if (file && file.extension === "md" && this.isUntitledName(file.basename)) {
      this.eligible.add(file);
    }
  }

  /**
   * Whether an automatic (not command-triggered) rename may run.
   * @param activeFile - the note currently open in the editor
   */
  canAutoRename(file: TFile, activeFile: TFile | null): boolean {
    if (this.eligible.has(file)) {
      return true;
    }
    // Covers a brand-new note whose first rename runs before "file-open" fires.
    if (file === activeFile && this.isUntitledName(file.basename)) {
      this.eligible.add(file);
      return true;
    }
    return false;
  }

  clear(): void {
    this.eligible.clear();
  }
}
