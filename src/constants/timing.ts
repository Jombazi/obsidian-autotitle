/**
 * Timing constants for delays, debounces, and timeouts.
 * Centralized to make delays clear and easy to adjust.
 */

export const TIMING = {
  /** Next tick delay (push to end of event loop) */
  NEXT_TICK_MS: 0,

  /** Delay for UI settling before rechecking file state */
  UI_SETTLE_DELAY_MS: 50,

  /** Delay to ensure file save is complete before processing */
  SAVE_COMPLETE_DELAY_MS: 100,

  /** Delay for view readiness check retry */
  VIEW_READINESS_RETRY_DELAY_MS: 100,

  /** Delay before positioning the cursor in a newly created file, so the editor view has mounted and can be found by path */
  RAF_CURSOR_POSITIONING_DELAY_MS: 200,

  /** How long a new note's creation waits for a Markdown view to show it before treating it as created in the background. Obsidian's own creators create the file first and open it after; measured from `create`: desktop, a view with an editor at +7–9 ms in a new tab or +0.5 ms in the current one and `file-open` at +9–32 ms; Pixel 8a, the view at +20–87 ms with `file-open` within 0.2 ms of it */
  NEW_NOTE_VIEW_WAIT_MS: 500,

  /** How long a new note's cursor pass waits for its view to reload the note's text after a file write; a view's reload after an external write was measured at +1 to +55 ms */
  VIEW_RELOAD_WAIT_MS: 500,

  /** Race window for Templater's creation event, measured from the file's ctime rather than from now because the CREATE handler has usually already burned part of it */
  TEMPLATER_EVENT_TIMEOUT_MS: 2000,

  /** Grace period before dropping the Templater listener, kept longer than the timeout above so the timeout resolves first and a late event cannot settle an already-settled promise */
  TEMPLATER_EVENT_CLEANUP_GRACE_MS: 100,

  /** Minimum gap between title insertions while a canvas is active, so a canvas creating many files at once does not trigger a mass insertion */
  TITLE_INSERTION_RATE_LIMIT_MS: 1000,

  /** Rate limit for self-reference notices (prevents notice spam) */
  SELF_REF_NOTICE_TTL_MS: 2000,

  /** Window for detecting recently renamed files (prevents stale content processing) */
  RENAME_RECENTLY_WINDOW_MS: 100,

  /** How long after a plugin rename a vault `create` event naming the path it moved the note into is taken as stale, since the new-note pipeline already ran for the note */
  STALE_CREATE_WINDOW_MS: 1000,

  /** How long maintenance keeps a note's last plugin-rename time; never shorter than the longest window a caller checks it with */
  RECENTLY_RENAMED_RECORD_TTL_MS: 1000,

  /** Threshold for stale file locks (cleaned up during maintenance) */
  FILE_LOCK_STALE_THRESHOLD_MS: 60000,

  /** A page preview saves 2 s after its first unsaved keystroke, so at most 2 s after its last; a Canvas card does the same while it stays selected, and saves at once on deselect. Either save can land after the embed's editor is gone, so background first line property updates stay allowed this long after an edit */
  EMBED_SAVE_GRACE_MS: 5000,

  /** Each rename of a linked note raises Obsidian's link-update notices, so a note another file links to waits for typing to pause before its rename and first line property update; a longer Check interval wins. Applies whatever "Automatically update internal links" says: with it off, each rename opens Obsidian's "Update links" dialog instead, and Canvas shows its notice either way */
  LINKED_NOTE_RENAME_DELAY_MS: 2000,

  /** Right after a rename Obsidian re-resolves the note's links asynchronously, and a canvas-linked note reads as unlinked for about 530 ms, so a note seen linked this recently still counts as linked */
  LINKED_NOTE_MEMORY_MS: 5000,
} as const;

export const LIMITS = {
  /** Maximum conflict resolution iterations (prevents infinite loops) */
  MAX_CONFLICT_ITERATIONS: 10000,
} as const;
