import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Text } from '@codemirror/state';
import { FileState, FileStateManager } from '../../src/core/file-state-manager';
import { TIMING } from '../../src/constants/timing';

// Mock plugin
function createMockPlugin() {
  return {} as any;
}

/** Read a path's whole state from the private map, which no public getter exposes, to check what moves and maintenance leave behind */
function stateAt(
  manager: FileStateManager,
  path: string
): FileState | undefined {
  return (
    manager as unknown as { fileStates: Map<string, FileState> }
  ).fileStates.get(path);
}

describe('FileStateManager', () => {
  let plugin: any;
  let manager: FileStateManager;

  beforeEach(() => {
    vi.useFakeTimers();
    plugin = createMockPlugin();
    manager = new FileStateManager(plugin);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('lastEditorContent', () => {
    it('should set and get editor content', () => {
      manager.setLastEditorContent('test.md', 'content');
      expect(manager.getLastEditorContent('test.md')).toBe('content');
    });

    it('should return undefined for non-existent path', () => {
      expect(manager.getLastEditorContent('nonexistent.md')).toBeUndefined();
    });

    it('should delete editor content', () => {
      manager.setLastEditorContent('test.md', 'content');
      manager.deleteLastEditorContent('test.md');
      expect(manager.getLastEditorContent('test.md')).toBeUndefined();
    });

    it('should handle delete on non-existent path', () => {
      expect(() =>
        manager.deleteLastEditorContent('nonexistent.md')
      ).not.toThrow();
    });

    // An unchanged first-line keystroke stores the editor's document instead of joining the whole note.
    describe('CodeMirror document baseline', () => {
      it('stores a document without converting it and reads it back as a string', () => {
        const doc = Text.of(['Title', 'Body']);
        const toString = vi.spyOn(doc, 'toString');

        manager.setLastEditorContent('test.md', doc);

        expect(toString).not.toHaveBeenCalled();
        expect(manager.getLastEditorContent('test.md')).toBe('Title\nBody');
      });

      it('answers presence without converting the document', () => {
        const doc = Text.of(['Title', 'Body']);
        const toString = vi.spyOn(doc, 'toString');
        manager.setLastEditorContent('test.md', doc);

        expect(manager.hasLastEditorContent('test.md')).toBe(true);
        expect(manager.hasLastEditorContent('other.md')).toBe(false);
        expect(toString).not.toHaveBeenCalled();
      });

      it('counts an empty string as present', () => {
        manager.setLastEditorContent('test.md', '');

        expect(manager.hasLastEditorContent('test.md')).toBe(true);
      });

      it('answers false once the content is deleted', () => {
        manager.setLastEditorContent('test.md', 'content');
        manager.deleteLastEditorContent('test.md');

        expect(manager.hasLastEditorContent('test.md')).toBe(false);
      });

      it('moves the stored document to a renamed note’s path without converting it', () => {
        const doc = Text.of(['Title', 'Body']);
        const toString = vi.spyOn(doc, 'toString');
        manager.setLastEditorContent('old.md', doc);

        manager.notifyFileRenamed('old.md', 'new.md');

        expect(toString).not.toHaveBeenCalled();
        expect(manager.hasLastEditorContent('old.md')).toBe(false);
        expect(stateAt(manager, 'new.md')?.lastEditorContent).toBe(doc);
      });
    });
  });

  describe('lastSavedContent', () => {
    it('should set and get saved content', () => {
      manager.setLastSavedContent('test.md', 'saved content');
      expect(manager.getLastSavedContent('test.md')).toBe('saved content');
    });

    it('should return undefined for non-existent path', () => {
      expect(manager.getLastSavedContent('nonexistent.md')).toBeUndefined();
    });

    it('should delete saved content', () => {
      manager.setLastSavedContent('test.md', 'content');
      manager.deleteLastSavedContent('test.md');
      expect(manager.getLastSavedContent('test.md')).toBeUndefined();
    });

    it('should handle delete on non-existent path', () => {
      expect(() =>
        manager.deleteLastSavedContent('nonexistent.md')
      ).not.toThrow();
    });

    it('should restart the purge clock when the same content is stored again', () => {
      manager.setLastSavedContent('test.md', 'content');

      vi.advanceTimersByTime(9 * 60 * 1000);
      manager.setLastSavedContent('test.md', 'content');
      vi.advanceTimersByTime(9 * 60 * 1000);
      manager.runMaintenance();

      expect(manager.getLastSavedContent('test.md')).toBe('content');
    });
  });

  describe('file lifecycle', () => {
    it('should migrate state on file rename', () => {
      manager.setLastEditorContent('old.md', 'editor content');
      manager.setLastSavedContent('old.md', 'saved content');

      manager.notifyFileRenamed('old.md', 'new.md');

      // Old path should have no state
      expect(manager.getLastEditorContent('old.md')).toBeUndefined();
      expect(manager.getLastSavedContent('old.md')).toBeUndefined();

      // New path should have all state
      expect(manager.getLastEditorContent('new.md')).toBe('editor content');
      expect(manager.getLastSavedContent('new.md')).toBe('saved content');
    });

    it('should cleanup state on file delete', () => {
      manager.setLastEditorContent('test.md', 'content');
      manager.setLastSavedContent('test.md', 'saved');

      manager.notifyFileDeleted('test.md');

      expect(manager.getLastEditorContent('test.md')).toBeUndefined();
      expect(manager.getLastSavedContent('test.md')).toBeUndefined();
    });

    it('should handle delete on non-existent path', () => {
      expect(() => manager.notifyFileDeleted('nonexistent.md')).not.toThrow();
    });

    it('should handle rename from non-existent path', () => {
      expect(() =>
        manager.notifyFileRenamed('nonexistent.md', 'new.md')
      ).not.toThrow();
    });
  });

  describe('title region cache', () => {
    const cache = {
      firstNonEmptyLine: 'Title',
      titleSourceLine: 'Title',
      raw: false,
      lastUpdated: Date.now(),
    };

    it('should set and get title region cache', () => {
      manager.setTitleRegionCache('test.md', cache);
      expect(manager.getTitleRegionCache('test.md')).toEqual(cache);
    });

    it('should move to the new path on rename', () => {
      manager.setTitleRegionCache('old.md', cache);
      manager.notifyFileRenamed('old.md', 'new.md');

      expect(manager.getTitleRegionCache('old.md')).toBeUndefined();
      expect(manager.getTitleRegionCache('new.md')).toEqual(cache);
    });
  });

  describe('locking', () => {
    it('should acquire lock on first attempt', () => {
      expect(manager.acquireLock('test.md')).toBe(true);
      expect(manager.isLocked('test.md')).toBe(true);
    });

    it('should fail to acquire lock when already locked', () => {
      manager.acquireLock('test.md');
      expect(manager.acquireLock('test.md')).toBe(false);
    });

    it('should release lock', () => {
      manager.acquireLock('test.md');
      manager.releaseLock('test.md');
      expect(manager.isLocked('test.md')).toBe(false);
    });

    it('should allow re-acquiring lock after release', () => {
      manager.acquireLock('test.md');
      manager.releaseLock('test.md');
      expect(manager.acquireLock('test.md')).toBe(true);
    });
  });

  describe('pending first line property recheck', () => {
    it('should mark and check pending first line property recheck', () => {
      expect(manager.hasPendingFirstLinePropertyRecheck('test.md')).toBe(false);

      manager.markPendingFirstLinePropertyRecheck('test.md');
      expect(manager.hasPendingFirstLinePropertyRecheck('test.md')).toBe(true);
    });

    it('should clear pending first line property recheck', () => {
      manager.markPendingFirstLinePropertyRecheck('test.md');
      manager.clearPendingFirstLinePropertyRecheck('test.md');

      expect(manager.hasPendingFirstLinePropertyRecheck('test.md')).toBe(false);
    });
  });

  describe('pending metadata update', () => {
    it('should mark, check and clear a pending metadata update', () => {
      expect(manager.hasPendingMetadataUpdate('test.md')).toBe(false);

      manager.markPendingMetadataUpdate('test.md');
      expect(manager.hasPendingMetadataUpdate('test.md')).toBe(true);

      manager.clearPendingMetadataUpdate('test.md');
      expect(manager.hasPendingMetadataUpdate('test.md')).toBe(false);
    });

    it('should move to the new path on rename', () => {
      manager.markPendingMetadataUpdate('old.md');

      manager.notifyFileRenamed('old.md', 'new.md');

      expect(manager.hasPendingMetadataUpdate('old.md')).toBe(false);
      expect(manager.hasPendingMetadataUpdate('new.md')).toBe(true);
    });
  });

  describe('editor syncing', () => {
    it('should mark and check editor syncing', () => {
      expect(manager.isEditorSyncing('test.md')).toBe(false);

      manager.markEditorSyncing('test.md');
      expect(manager.isEditorSyncing('test.md')).toBe(true);
    });

    it('should clear editor syncing', () => {
      manager.markEditorSyncing('test.md');
      manager.clearEditorSyncing('test.md');

      expect(manager.isEditorSyncing('test.md')).toBe(false);
    });
  });

  describe('recently renamed', () => {
    it('should mark and check recently renamed', () => {
      expect(manager.wasRecentlyRenamedInto('test.md')).toBe(false);

      manager.markRecentlyRenamedInto('test.md');
      expect(manager.wasRecentlyRenamedInto('test.md')).toBe(true);
    });

    it('should return false after time window expires', () => {
      manager.markRecentlyRenamedInto('test.md');

      vi.advanceTimersByTime(150);
      expect(manager.wasRecentlyRenamedInto('test.md')).toBe(false);
    });

    it('should use custom time window', () => {
      manager.markRecentlyRenamedInto('test.md');

      vi.advanceTimersByTime(50);
      expect(manager.wasRecentlyRenamedInto('test.md', 100)).toBe(true);
      expect(manager.wasRecentlyRenamedInto('test.md', 30)).toBe(false);
    });

    it('answers each window from the one record, the stale-create guard’s longer one included', () => {
      manager.markRecentlyRenamedInto('test.md');

      vi.advanceTimersByTime(500);

      expect(manager.wasRecentlyRenamedInto('test.md')).toBe(false);
      expect(
        manager.wasRecentlyRenamedInto('test.md', TIMING.STALE_CREATE_WINDOW_MS)
      ).toBe(true);
    });

    // The sequence of a plugin rename: the vault `rename` handler moves the state, then the engine marks the new path
    it('matches the path a rename moved the note into in either window, never the path it vacated', () => {
      manager.setLastSavedContent('A.md', 'A');
      manager.notifyFileRenamed('A.md', 'B.md');
      manager.markRecentlyRenamedInto('B.md');

      expect(manager.wasRecentlyRenamedInto('B.md')).toBe(true);
      expect(
        manager.wasRecentlyRenamedInto('B.md', TIMING.STALE_CREATE_WINDOW_MS)
      ).toBe(true);
      expect(manager.wasRecentlyRenamedInto('A.md')).toBe(false);
      expect(
        manager.wasRecentlyRenamedInto('A.md', TIMING.STALE_CREATE_WINDOW_MS)
      ).toBe(false);
    });
  });

  describe('runMaintenance', () => {
    it('should cleanup stale lastEditorContent after 10 minutes', () => {
      manager.setLastEditorContent('test.md', 'content');

      vi.advanceTimersByTime(11 * 60 * 1000);
      manager.runMaintenance();

      expect(manager.getLastEditorContent('test.md')).toBeUndefined();
    });

    it('should keep fresh lastEditorContent', () => {
      manager.setLastEditorContent('test.md', 'content');

      vi.advanceTimersByTime(5 * 60 * 1000);
      manager.runMaintenance();

      expect(manager.getLastEditorContent('test.md')).toBe('content');
    });

    it('should cleanup stale lastSavedContent after 10 minutes', () => {
      manager.setLastSavedContent('test.md', 'content');

      vi.advanceTimersByTime(11 * 60 * 1000);
      manager.runMaintenance();

      expect(manager.getLastSavedContent('test.md')).toBeUndefined();
    });

    it('drops an aged title region cache, and the state it alone kept', () => {
      manager.setTitleRegionCache('Intermediate name.md', {
        firstNonEmptyLine: 'Intermediate name',
        titleSourceLine: 'Intermediate name',
        raw: false,
        lastUpdated: Date.now(),
      });

      vi.advanceTimersByTime(11 * 60 * 1000);
      manager.runMaintenance();

      expect(
        manager.getTitleRegionCache('Intermediate name.md')
      ).toBeUndefined();
      expect(stateAt(manager, 'Intermediate name.md')).toBeUndefined();
    });

    it('keeps a fresh title region cache', () => {
      manager.setTitleRegionCache('test.md', {
        firstNonEmptyLine: 'Title',
        titleSourceLine: 'Title',
        raw: false,
        lastUpdated: Date.now(),
      });

      vi.advanceTimersByTime(5 * 60 * 1000);
      manager.runMaintenance();

      expect(manager.getTitleRegionCache('test.md')).toBeDefined();
    });

    it('should cleanup stale locks', () => {
      manager.acquireLock('test.md');

      // Advance past 60 second stale threshold (FILE_LOCK_STALE_THRESHOLD_MS)
      vi.advanceTimersByTime(65 * 1000);
      manager.runMaintenance();

      expect(manager.isLocked('test.md')).toBe(false);
    });

    it('should remove empty state entries', () => {
      manager.setLastEditorContent('test.md', 'content');
      manager.deleteLastEditorContent('test.md');

      manager.runMaintenance();

      // State entry should be removed when empty
      expect(stateAt(manager, 'test.md')).toBeUndefined();
    });

    it('removes a state whose lock, recheck and syncing flags were all cleared', () => {
      manager.acquireLock('test.md');
      manager.releaseLock('test.md');
      manager.markPendingFirstLinePropertyRecheck('test.md');
      manager.clearPendingFirstLinePropertyRecheck('test.md');
      manager.markEditorSyncing('test.md');
      manager.clearEditorSyncing('test.md');

      manager.runMaintenance();

      expect(stateAt(manager, 'test.md')).toBeUndefined();
    });

    it('removes a state whose lock went stale', () => {
      manager.acquireLock('test.md');

      vi.advanceTimersByTime(65 * 1000);
      manager.runMaintenance();

      expect(stateAt(manager, 'test.md')).toBeUndefined();
    });

    it('should cleanup lastRenamedTime after 1 second', () => {
      manager.markRecentlyRenamedInto('test.md');

      vi.advanceTimersByTime(2000);
      manager.runMaintenance();

      // The wasRecentlyRenamedInto check should return false since timestamp is cleared
      expect(manager.wasRecentlyRenamedInto('test.md')).toBe(false);
    });
  });

  describe('throttle timers', () => {
    it('should set and check throttle timer', () => {
      const timer = window.setTimeout(() => {}, 1000);
      manager.setThrottleTimer('test.md', timer);

      expect(manager.hasThrottleTimer('test.md')).toBe(true);
    });

    it('should clear throttle timer', () => {
      const timer = window.setTimeout(() => {}, 1000);
      manager.setThrottleTimer('test.md', timer);
      manager.clearThrottleTimer('test.md');

      expect(manager.hasThrottleTimer('test.md')).toBe(false);
    });

    it('should clear all throttle timers', () => {
      manager.setThrottleTimer(
        'test1.md',
        window.setTimeout(() => {}, 1000)
      );
      manager.setThrottleTimer(
        'test2.md',
        window.setTimeout(() => {}, 1000)
      );

      manager.clearAllThrottleTimers();

      expect(manager.hasThrottleTimer('test1.md')).toBe(false);
      expect(manager.hasThrottleTimer('test2.md')).toBe(false);
    });

    it('should replace existing throttle timer', () => {
      const timer1 = window.setTimeout(() => {}, 1000);
      const timer2 = window.setTimeout(() => {}, 2000);

      manager.setThrottleTimer('test.md', timer1);
      manager.setThrottleTimer('test.md', timer2);

      expect(manager.hasThrottleTimer('test.md')).toBe(true);
    });

    describe('delayed flag', () => {
      const setDelayedTimer = (path: string) =>
        manager.setThrottleTimer(
          path,
          window.setTimeout(() => {}, 2000),
          true
        );

      it('should mark a delayed timer', () => {
        setDelayedTimer('test.md');
        manager.setThrottleTimer(
          'plain.md',
          window.setTimeout(() => {}, 1000)
        );

        expect(manager.hasDelayedThrottleTimer('test.md')).toBe(true);
        expect(manager.hasDelayedThrottleTimer('plain.md')).toBe(false);
      });

      it('should drop the flag when a plain timer replaces a delayed one', () => {
        setDelayedTimer('test.md');
        manager.setThrottleTimer(
          'test.md',
          window.setTimeout(() => {}, 1000)
        );

        expect(manager.hasDelayedThrottleTimer('test.md')).toBe(false);
      });

      it('should clear the flag with the timer', () => {
        setDelayedTimer('test.md');
        manager.clearThrottleTimer('test.md');

        expect(manager.hasDelayedThrottleTimer('test.md')).toBe(false);
        expect(stateAt(manager, 'test.md')?.throttleTimerIsDelayed).toBe(
          undefined
        );
      });

      it('should clear the flag with all timers', () => {
        setDelayedTimer('test.md');
        manager.clearAllThrottleTimers();

        expect(manager.hasDelayedThrottleTimer('test.md')).toBe(false);
      });

      it('should clear the flag when the file is deleted', () => {
        setDelayedTimer('test.md');
        manager.notifyFileDeleted('test.md');

        expect(manager.hasDelayedThrottleTimer('test.md')).toBe(false);
      });

      it('should carry the flag to the new path on rename', () => {
        setDelayedTimer('old.md');
        manager.notifyFileRenamed('old.md', 'new.md');

        expect(manager.hasDelayedThrottleTimer('new.md')).toBe(true);
        expect(manager.hasDelayedThrottleTimer('old.md')).toBe(false);
      });

      it('should let maintenance drop a state whose timer was cleared', () => {
        setDelayedTimer('test.md');
        manager.clearThrottleTimer('test.md');

        manager.runMaintenance();

        expect(stateAt(manager, 'test.md')).toBeUndefined();
      });
    });
  });

  describe('dispose', () => {
    it('should clear all state and timers', () => {
      manager.setLastEditorContent('test.md', 'content');
      manager.setThrottleTimer(
        'test.md',
        window.setTimeout(() => {}, 1000)
      );

      manager.dispose();

      expect(manager.getLastEditorContent('test.md')).toBeUndefined();
      expect(manager.hasThrottleTimer('test.md')).toBe(false);
    });
  });

  describe('notice rate limiting', () => {
    it('should rate limit self-ref notices', () => {
      expect(manager.canShowSelfRefNotice('test.md')).toBe(true);

      manager.setLastSelfRefNotice('test.md');
      expect(manager.canShowSelfRefNotice('test.md')).toBe(false);

      // Advance past TTL (SELF_REF_NOTICE_TTL_MS = 2000ms)
      vi.advanceTimersByTime(2100);
      expect(manager.canShowSelfRefNotice('test.md')).toBe(true);
    });
  });
});
