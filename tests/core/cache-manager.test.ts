import { describe, it, expect, beforeEach } from 'vitest';
import { CacheManager } from '../../src/core/cache-manager';

describe('CacheManager', () => {
  let cacheManager: CacheManager;

  beforeEach(() => {
    cacheManager = new CacheManager();
  });

  describe('Body presence record', () => {
    it('records whether a body had content', () => {
      cacheManager.setHadBody('with-body.md', true);
      cacheManager.setHadBody('empty.md', false);

      expect(cacheManager.hadBody('with-body.md')).toBe(true);
      expect(cacheManager.hadBody('empty.md')).toBe(false);
    });

    it('answers false for a note never recorded', () => {
      expect(cacheManager.hadBody('non-existent.md')).toBe(false);
    });

    it('keeps the latest record', () => {
      const filePath = 'test.md';

      cacheManager.setHadBody(filePath, true);
      cacheManager.setHadBody(filePath, false);

      expect(cacheManager.hadBody(filePath)).toBe(false);
    });
  });

  describe('Path Reservation', () => {
    it('should reserve and release paths', () => {
      const path = 'Notes/test.md';

      cacheManager.reservePath(path);
      expect(cacheManager.isPathReserved(path)).toBe(true);

      cacheManager.releasePath(path);
      expect(cacheManager.isPathReserved(path)).toBe(false);
    });

    it('should handle case-insensitive path reservation', () => {
      cacheManager.reservePath('Notes/Test.md');
      expect(cacheManager.isPathReserved('notes/test.md')).toBe(true);
      expect(cacheManager.isPathReserved('NOTES/TEST.MD')).toBe(true);
    });

    it('should clear all reserved paths', () => {
      cacheManager.reservePath('file1.md');
      cacheManager.reservePath('file2.md');
      cacheManager.reservePath('file3.md');

      cacheManager.clearReservedPaths();

      expect(cacheManager.isPathReserved('file1.md')).toBe(false);
      expect(cacheManager.isPathReserved('file2.md')).toBe(false);
      expect(cacheManager.isPathReserved('file3.md')).toBe(false);
    });

    it('should not error when releasing non-reserved path', () => {
      expect(() => cacheManager.releasePath('non-existent.md')).not.toThrow();
    });
  });

  describe('File Event Notifications', () => {
    it('should handle file deletion notification', () => {
      const path = 'deleted-file.md';

      // Setup: file exists with content and is reserved
      cacheManager.setHadBody(path, true);
      cacheManager.reservePath(path);

      // Delete file
      cacheManager.notifyFileDeleted(path);

      // Should clear all traces of the file
      expect(cacheManager.hadBody(path)).toBe(false);
      expect(cacheManager.isPathReserved(path)).toBe(false);
    });

    it('should handle file rename notification', () => {
      const oldPath = 'old-name.md';
      const newPath = 'new-name.md';

      // Setup: old file exists with content
      cacheManager.setHadBody(oldPath, true);

      // Rename file
      cacheManager.notifyFileRenamed(oldPath, newPath);

      // The body presence record moves to the new path
      expect(cacheManager.hadBody(oldPath)).toBe(false);
      expect(cacheManager.hadBody(newPath)).toBe(true);

      // Old path should be released, new path reserved
      expect(cacheManager.isPathReserved(oldPath)).toBe(false);
      expect(cacheManager.isPathReserved(newPath)).toBe(true);
    });

    it('should handle rename when file has no cached content', () => {
      const oldPath = 'old.md';
      const newPath = 'new.md';

      // Rename without prior content
      expect(() =>
        cacheManager.notifyFileRenamed(oldPath, newPath)
      ).not.toThrow();

      // New path should still be reserved
      expect(cacheManager.isPathReserved(newPath)).toBe(true);
    });
  });

  describe('Dispose', () => {
    it('should clear all caches on dispose', () => {
      cacheManager.setHadBody('file1.md', true);
      cacheManager.reservePath('reserved1.md');

      cacheManager.dispose();

      expect(cacheManager.hadBody('file1.md')).toBe(false);
      expect(cacheManager.isPathReserved('reserved1.md')).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty strings as paths', () => {
      cacheManager.reservePath('');
      expect(cacheManager.isPathReserved('')).toBe(true);

      cacheManager.setHadBody('', true);
      expect(cacheManager.hadBody('')).toBe(true);
    });

    it('should handle paths with special characters', () => {
      const path = 'folder/[special] (file) #2.md';

      cacheManager.reservePath(path);
      expect(cacheManager.isPathReserved(path)).toBe(true);

      cacheManager.setHadBody(path, true);
      expect(cacheManager.hadBody(path)).toBe(true);
    });

    it('should handle very long paths', () => {
      const longPath = 'a/'.repeat(100) + 'file.md';

      cacheManager.reservePath(longPath);
      expect(cacheManager.isPathReserved(longPath)).toBe(true);

      cacheManager.setHadBody(longPath, true);
      expect(cacheManager.hadBody(longPath)).toBe(true);
    });

    it('should handle concurrent operations on same file', () => {
      const path = 'test.md';

      cacheManager.setHadBody(path, true);
      cacheManager.reservePath(path);
      cacheManager.setHadBody(path, false);
      cacheManager.setHadBody(path, true);

      expect(cacheManager.hadBody(path)).toBe(true);
      expect(cacheManager.isPathReserved(path)).toBe(true);
    });
  });
});
