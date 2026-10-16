import type {} from 'obsidian';
import type { Text } from '@codemirror/state';
import FirstLineIsTitlePlugin from '../../main';
import { TIMING } from '../constants/timing';
import { TitleRegionCache } from '../types';

/**
 * Comprehensive per-file state tracking
 */
export interface FileState {
  path: string;

  // Lifecycle timers
  throttleTimer?: number; // checkInterval > 0 delayed processing
  throttleTimerIsDelayed?: boolean; // The timer waits for typing in a linked note to pause, so each new first-line edit restarts it

  // Content tracking
  lastEditorContent?: string | Text; // A CodeMirror document is kept as is, since it is immutable and shares structure with the live one, and converted to a string only when read
  lastEditorContentTimestamp?: number; // When editor content was last set (for staleness detection)
  lastSavedContent?: string; // Content after last save (for modify handler comparison)
  lastSavedContentTimestamp?: number;
  titleRegionCache?: TitleRegionCache;
  lastSelfRefNotice?: number; // timestamp

  // Operation tracking
  isLocked?: boolean;
  lockTimestamp?: number; // When lock was acquired (for stale lock cleanup)
  pendingFirstLinePropertyRecheck?: boolean;
  isSyncingEditors?: boolean; // True when syncing background editors to prevent spurious rechecks
  pendingMetadataUpdate?: boolean; // A first line property file write whose metadata update has not arrived yet; per path, so the rename move carries it

  // Rename tracking: the one record behind the stale-create guard and the disk-staleness skip, set only on the path a plugin rename moved a note into
  lastRenamedTime?: number; // Timestamp when the plugin renamed a note into this path
}

/**
 * Centralized file state manager
 */
export class FileStateManager {
  private plugin: FirstLineIsTitlePlugin;
  private fileStates: Map<string, FileState>;

  constructor(plugin: FirstLineIsTitlePlugin) {
    this.plugin = plugin;
    this.fileStates = new Map();
  }

  /**
   * Get or create file state
   */
  private getOrCreateState(path: string): FileState {
    if (!this.fileStates.has(path)) {
      this.fileStates.set(path, { path });
    }
    return this.fileStates.get(path)!;
  }

  // ============================================================================
  // LIFECYCLE TIMERS
  // ============================================================================

  /**
   * Set throttle timer for a file (checkInterval > 0 delayed processing)
   * @param delayed - True when the timer waits out a linked note's typing pause
   */
  setThrottleTimer(path: string, timer: number, delayed = false): void {
    const state = this.getOrCreateState(path);
    if (state.throttleTimer) {
      window.clearTimeout(state.throttleTimer);
    }
    state.throttleTimer = timer;
    if (delayed) {
      state.throttleTimerIsDelayed = true;
    } else {
      // Deleted rather than set to false, so runMaintenance can still drop an otherwise empty state.
      delete state.throttleTimerIsDelayed;
    }
  }

  /**
   * Clear throttle timer
   */
  clearThrottleTimer(path: string): void {
    const state = this.fileStates.get(path);
    if (state?.throttleTimer) {
      window.clearTimeout(state.throttleTimer);
      delete state.throttleTimer;
      delete state.throttleTimerIsDelayed;
    }
  }

  /**
   * Check if file has throttle timer
   */
  hasThrottleTimer(path: string): boolean {
    return !!this.fileStates.get(path)?.throttleTimer;
  }

  /**
   * Check if file has a throttle timer waiting out a linked note's typing pause
   */
  hasDelayedThrottleTimer(path: string): boolean {
    const state = this.fileStates.get(path);
    return !!state?.throttleTimer && state.throttleTimerIsDelayed === true;
  }

  /**
   * Clear all throttle timers (used on settings change)
   */
  clearAllThrottleTimers(): void {
    for (const state of this.fileStates.values()) {
      if (state.throttleTimer) {
        window.clearTimeout(state.throttleTimer);
        delete state.throttleTimer;
        delete state.throttleTimerIsDelayed;
      }
    }
  }

  // ============================================================================
  // CONTENT TRACKING
  // ============================================================================

  /**
   * Set last editor content with timestamp
   * @param content - The text, or the editor's CodeMirror document, which is stored without converting it
   */
  setLastEditorContent(path: string, content: string | Text): void {
    const state = this.getOrCreateState(path);
    state.lastEditorContent = content;
    state.lastEditorContentTimestamp = Date.now();
  }

  /**
   * Get last editor content as a string, converting a stored CodeMirror document
   */
  getLastEditorContent(path: string): string | undefined {
    return this.fileStates.get(path)?.lastEditorContent?.toString();
  }

  /**
   * Check whether a note has last editor content, without converting it
   */
  hasLastEditorContent(path: string): boolean {
    return this.fileStates.get(path)?.lastEditorContent !== undefined;
  }

  /**
   * Delete last editor content
   */
  deleteLastEditorContent(path: string): void {
    const state = this.fileStates.get(path);
    if (state) {
      delete state.lastEditorContent;
      delete state.lastEditorContentTimestamp;
    }
  }

  /**
   * Set last saved content with timestamp (for modify handler comparison)
   */
  setLastSavedContent(path: string, content: string): void {
    const state = this.getOrCreateState(path);
    state.lastSavedContent = content;
    state.lastSavedContentTimestamp = Date.now();
  }

  /**
   * Get last saved content
   */
  getLastSavedContent(path: string): string | undefined {
    return this.fileStates.get(path)?.lastSavedContent;
  }

  /**
   * Delete last saved content (for cleanup on file rename/delete)
   */
  deleteLastSavedContent(path: string): void {
    const state = this.fileStates.get(path);
    if (state) {
      delete state.lastSavedContent;
      delete state.lastSavedContentTimestamp;
    }
  }

  /**
   * Set title region cache
   */
  setTitleRegionCache(path: string, cache: TitleRegionCache): void {
    const state = this.getOrCreateState(path);
    state.titleRegionCache = cache;
  }

  /**
   * Get title region cache
   */
  getTitleRegionCache(path: string): TitleRegionCache | undefined {
    return this.fileStates.get(path)?.titleRegionCache;
  }

  /**
   * Set last self-reference notice timestamp
   */
  setLastSelfRefNotice(path: string): void {
    const state = this.getOrCreateState(path);
    state.lastSelfRefNotice = Date.now();
  }

  /**
   * Check if can show self-ref notice (rate limit)
   */
  canShowSelfRefNotice(path: string): boolean {
    const state = this.fileStates.get(path);
    if (!state?.lastSelfRefNotice) return true;
    return Date.now() - state.lastSelfRefNotice > TIMING.SELF_REF_NOTICE_TTL_MS;
  }

  // ============================================================================
  // OPERATION TRACKING
  // ============================================================================

  /**
   * Acquire file operation lock
   */
  acquireLock(path: string): boolean {
    const state = this.getOrCreateState(path);
    if (state.isLocked) {
      return false;
    }
    state.isLocked = true;
    state.lockTimestamp = Date.now();
    return true;
  }

  /**
   * Release file operation lock
   */
  releaseLock(path: string): void {
    const state = this.fileStates.get(path);
    if (state) {
      // Flags are deleted, never set to false, so runMaintenance can drop a state once nothing else is held
      delete state.isLocked;
      delete state.lockTimestamp;
    }
  }

  /**
   * Check if file is locked
   */
  isLocked(path: string): boolean {
    return this.fileStates.get(path)?.isLocked ?? false;
  }

  /**
   * Mark file for pending first line property recheck
   */
  markPendingFirstLinePropertyRecheck(path: string): void {
    const state = this.getOrCreateState(path);
    state.pendingFirstLinePropertyRecheck = true;
  }

  /**
   * Check if file has pending first line property recheck
   */
  hasPendingFirstLinePropertyRecheck(path: string): boolean {
    return this.fileStates.get(path)?.pendingFirstLinePropertyRecheck ?? false;
  }

  /**
   * Clear pending first line property recheck
   */
  clearPendingFirstLinePropertyRecheck(path: string): void {
    const state = this.fileStates.get(path);
    if (state) {
      delete state.pendingFirstLinePropertyRecheck;
    }
  }

  /**
   * Mark file as currently syncing background editors
   * Used to prevent editor-change events from our own setValue() operations
   * from triggering spurious rechecks
   */
  markEditorSyncing(path: string): void {
    const state = this.getOrCreateState(path);
    state.isSyncingEditors = true;
  }

  /**
   * Check if file is currently syncing background editors
   */
  isEditorSyncing(path: string): boolean {
    return this.fileStates.get(path)?.isSyncingEditors ?? false;
  }

  /**
   * Clear editor syncing flag
   */
  clearEditorSyncing(path: string): void {
    const state = this.fileStates.get(path);
    if (state) {
      delete state.isSyncingEditors;
    }
  }

  /**
   * Mark the path a plugin rename just moved a note into
   * Read by the stale-create guard and by processFile's skip of disk content that can trail the rename, each with its own window
   * @param path - The rename's new path; the path it vacated takes no record, since a note found there afterwards is a different note
   */
  markRecentlyRenamedInto(path: string): void {
    const state = this.getOrCreateState(path);
    state.lastRenamedTime = Date.now();
  }

  /**
   * Check if a plugin rename moved a note into this path within the time window
   * A path a rename vacated never matches
   *
   * @param path - File path to check
   * @param withinMs - Time window in milliseconds (default 100ms)
   */
  wasRecentlyRenamedInto(
    path: string,
    withinMs: number = TIMING.RENAME_RECENTLY_WINDOW_MS
  ): boolean {
    const state = this.fileStates.get(path);
    if (!state?.lastRenamedTime) return false;
    return Date.now() - state.lastRenamedTime < withinMs;
  }

  /**
   * Mark a note's first line property file write as waiting for its metadata update
   */
  markPendingMetadataUpdate(path: string): void {
    this.getOrCreateState(path).pendingMetadataUpdate = true;
  }

  /**
   * Check if a note's first line property file write still waits for its metadata update
   */
  hasPendingMetadataUpdate(path: string): boolean {
    return this.fileStates.get(path)?.pendingMetadataUpdate ?? false;
  }

  /**
   * Clear a note's pending metadata update flag
   */
  clearPendingMetadataUpdate(path: string): void {
    const state = this.fileStates.get(path);
    if (state) {
      delete state.pendingMetadataUpdate;
    }
  }

  // ============================================================================
  // FILE LIFECYCLE MANAGEMENT
  // ============================================================================

  /**
   * Handle file rename - move state to new path
   */
  notifyFileRenamed(oldPath: string, newPath: string): void {
    const state = this.fileStates.get(oldPath);
    if (state) {
      state.path = newPath;
      this.fileStates.delete(oldPath);
      this.fileStates.set(newPath, state);
    }
  }

  /**
   * Handle file deletion - cleanup all state
   */
  notifyFileDeleted(path: string): void {
    const state = this.fileStates.get(path);
    if (state) {
      if (state.throttleTimer) window.clearTimeout(state.throttleTimer);
      this.fileStates.delete(path);
    }
  }

  /**
   * Maintenance: cleanup stale entries
   * Called periodically to remove old content, flags, and timestamps
   */
  runMaintenance(): void {
    const now = Date.now();
    const staleThreshold = 10 * 60 * 1000; // 10 minutes

    for (const [path, state] of this.fileStates.entries()) {
      // Clean up stale lastRenamedTime (prevents memory leak)
      if (state.lastRenamedTime) {
        const age = now - state.lastRenamedTime;
        if (age > TIMING.RECENTLY_RENAMED_RECORD_TTL_MS) {
          delete state.lastRenamedTime;
        }
      }

      // Clean up stale locks (prevents deadlock if lock was never released)
      if (state.isLocked && state.lockTimestamp) {
        const age = now - state.lockTimestamp;
        if (age > TIMING.FILE_LOCK_STALE_THRESHOLD_MS) {
          delete state.isLocked;
          delete state.lockTimestamp;
        }
      }

      // Clean up stale lastEditorContent (prevents memory leak from large notes)
      // Cleanup after 10 minutes (staleThreshold)
      if (state.lastEditorContentTimestamp) {
        const age = now - state.lastEditorContentTimestamp;
        if (age > staleThreshold) {
          delete state.lastEditorContent;
          delete state.lastEditorContentTimestamp;
        }
      }

      // Clean up stale lastSavedContent (prevents memory leak from large notes)
      // Cleanup after 10 minutes (staleThreshold)
      if (state.lastSavedContentTimestamp) {
        const age = now - state.lastSavedContentTimestamp;
        if (age > staleThreshold) {
          delete state.lastSavedContent;
          delete state.lastSavedContentTimestamp;
        }
      }

      // Clean up a stale title region cache, which would otherwise keep a state alive for every path a title passed through
      if (state.titleRegionCache) {
        const age = now - state.titleRegionCache.lastUpdated;
        if (age > staleThreshold) {
          delete state.titleRegionCache;
        }
      }

      // Clean up stale self-ref notice timestamps
      if (state.lastSelfRefNotice) {
        const age = now - state.lastSelfRefNotice;
        if (age > staleThreshold) {
          delete state.lastSelfRefNotice;
        }
      }

      // Remove completely empty state entries (only has path field)
      const stateKeys = Object.keys(state).filter(
        (k) => k !== 'path' && state[k as keyof FileState] !== undefined
      );
      if (stateKeys.length === 0) {
        this.fileStates.delete(path);
      }
    }
  }

  /**
   * Clear all state (on unload)
   */
  dispose(): void {
    for (const state of this.fileStates.values()) {
      if (state.throttleTimer) window.clearTimeout(state.throttleTimer);
    }
    this.fileStates.clear();
  }
}
