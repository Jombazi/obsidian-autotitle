import type {} from 'obsidian';
import FirstLineIsTitlePlugin from '../../main';
import { TIMING } from '../constants/timing';
import { TitleRegionCache } from '../types';

/**
 * Operation tracking data for a file
 */
export interface OperationData {
  count: number;
  lastContent: string;
  lastUpdate: number;
}

/**
 * Comprehensive per-file state tracking
 */
export interface FileState {
  path: string;

  // Lifecycle timers
  creationDelayTimer?: number;
  throttleTimer?: number; // checkInterval > 0 delayed processing
  throttleTimerIsDelayed?: boolean; // The timer waits for typing in a linked note to pause, so each new first-line edit restarts it

  // Content tracking
  lastEditorContent?: string;
  lastEditorContentTimestamp?: number; // When editor content was last set (for staleness detection)
  lastSavedContent?: string; // Content after last save (for modify handler comparison)
  lastSavedContentTimestamp?: number;
  titleRegionCache?: TitleRegionCache;
  lastSelfRefNotice?: number; // timestamp

  // Operation tracking
  operationData?: OperationData;
  isLocked?: boolean;
  lockTimestamp?: number; // When lock was acquired (for stale lock cleanup)
  pendingAliasRecheck?: boolean;
  isSyncingEditors?: boolean; // True when syncing background editors to prevent spurious rechecks

  // Rename tracking - prevents processing stale content after rename
  lastRenamedTime?: number; // Timestamp when file was renamed by plugin
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

  /**
   * Get file state (read-only)
   */
  getState(path: string): Readonly<FileState> | undefined {
    return this.fileStates.get(path);
  }

  // ============================================================================
  // LIFECYCLE TIMERS
  // ============================================================================

  /**
   * Set creation delay timer for a file
   */
  setCreationDelayTimer(path: string, timer: number): void {
    const state = this.getOrCreateState(path);
    if (state.creationDelayTimer) {
      window.clearTimeout(state.creationDelayTimer);
    }
    state.creationDelayTimer = timer;
  }

  /**
   * Clear creation delay timer
   */
  clearCreationDelayTimer(path: string): void {
    const state = this.fileStates.get(path);
    if (state?.creationDelayTimer) {
      window.clearTimeout(state.creationDelayTimer);
      delete state.creationDelayTimer;
    }
  }

  /**
   * Check if file is in creation delay
   */
  isFileInCreationDelay(path: string): boolean {
    return !!this.fileStates.get(path)?.creationDelayTimer;
  }

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
   */
  setLastEditorContent(path: string, content: string): void {
    const state = this.getOrCreateState(path);
    state.lastEditorContent = content;
    state.lastEditorContentTimestamp = Date.now();
  }

  /**
   * Get last editor content
   */
  getLastEditorContent(path: string): string | undefined {
    return this.fileStates.get(path)?.lastEditorContent;
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
   * Delete title region cache
   */
  deleteTitleRegionCache(path: string): void {
    const state = this.fileStates.get(path);
    if (state) {
      delete state.titleRegionCache;
    }
  }

  /**
   * Clear all title region caches (on settings change)
   */
  clearAllTitleRegionCaches(): void {
    for (const state of this.fileStates.values()) {
      delete state.titleRegionCache;
    }
  }

  /**
   * Update title region cache key on rename
   */
  updateTitleRegionCacheKey(oldPath: string, newPath: string): void {
    const state = this.fileStates.get(oldPath);
    if (state?.titleRegionCache) {
      const cache = state.titleRegionCache;
      delete state.titleRegionCache;
      this.setTitleRegionCache(newPath, cache);
    }
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
   * Get operation data
   */
  getOperationData(path: string): OperationData | undefined {
    return this.fileStates.get(path)?.operationData;
  }

  /**
   * Set operation data
   */
  setOperationData(path: string, data: OperationData): void {
    const state = this.getOrCreateState(path);
    state.operationData = data;
  }

  /**
   * Update operation count
   */
  updateOperationCount(path: string, content: string): void {
    const state = this.getOrCreateState(path);
    if (!state.operationData) {
      state.operationData = {
        count: 1,
        lastContent: content,
        lastUpdate: Date.now(),
      };
    } else {
      state.operationData.count++;
      state.operationData.lastContent = content;
      state.operationData.lastUpdate = Date.now();
    }
  }

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
   * Clear all locks (on unload)
   */
  clearAllLocks(): void {
    for (const state of this.fileStates.values()) {
      delete state.isLocked;
    }
  }

  /**
   * Mark file for pending alias recheck
   */
  markPendingAliasRecheck(path: string): void {
    const state = this.getOrCreateState(path);
    state.pendingAliasRecheck = true;
  }

  /**
   * Check if file has pending alias recheck
   */
  hasPendingAliasRecheck(path: string): boolean {
    return this.fileStates.get(path)?.pendingAliasRecheck ?? false;
  }

  /**
   * Clear pending alias recheck
   */
  clearPendingAliasRecheck(path: string): void {
    const state = this.fileStates.get(path);
    if (state) {
      delete state.pendingAliasRecheck;
    }
  }

  /**
   * Get all file paths with pending alias recheck
   */
  getFilesWithPendingAliasRecheck(): string[] {
    const files: string[] = [];
    for (const [path, state] of this.fileStates.entries()) {
      if (state.pendingAliasRecheck) {
        files.push(path);
      }
    }
    return files;
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
   * Mark file as recently renamed by plugin
   * Used to prevent processFile from running with stale content immediately after rename
   */
  markRecentlyRenamed(path: string): void {
    const state = this.getOrCreateState(path);
    state.lastRenamedTime = Date.now();
  }

  /**
   * Check if file was recently renamed by plugin
   * Returns true if renamed within the specified time window
   *
   * @param path - File path to check
   * @param withinMs - Time window in milliseconds (default 100ms)
   */
  wasRecentlyRenamed(
    path: string,
    withinMs: number = TIMING.RENAME_RECENTLY_WINDOW_MS
  ): boolean {
    const state = this.fileStates.get(path);
    if (!state?.lastRenamedTime) return false;
    return Date.now() - state.lastRenamedTime < withinMs;
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
      if (state.creationDelayTimer)
        window.clearTimeout(state.creationDelayTimer);
      if (state.throttleTimer) window.clearTimeout(state.throttleTimer);
      this.fileStates.delete(path);
    }
  }

  /**
   * Maintenance: cleanup stale entries
   * Called periodically to remove old operation data, flags, and timestamps
   */
  runMaintenance(): void {
    const now = Date.now();
    const staleThreshold = 10 * 60 * 1000; // 10 minutes

    for (const [path, state] of this.fileStates.entries()) {
      // Clean up stale operation data
      if (state.operationData) {
        const age = now - state.operationData.lastUpdate;
        if (age > staleThreshold) {
          delete state.operationData;
        }
      }

      // Clean up stale lastRenamedTime (prevents memory leak)
      // Cleanup after 1 second (wasRecentlyRenamed checks 100ms window)
      if (state.lastRenamedTime) {
        const age = now - state.lastRenamedTime;
        if (age > 1000) {
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
      if (state.creationDelayTimer)
        window.clearTimeout(state.creationDelayTimer);
      if (state.throttleTimer) window.clearTimeout(state.throttleTimer);
    }
    this.fileStates.clear();
  }
}
