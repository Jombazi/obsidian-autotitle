import { describe, it, expect } from 'vitest';
import { getPath, setPath } from '../../src/settings/settings-paths';

describe('settings-paths', () => {
  describe('getPath', () => {
    it('reads a top-level key', () => {
      expect(getPath({ dataSchemaVersion: 4 }, 'dataSchemaVersion')).toBe(4);
    });

    it('reads a nested dot-path', () => {
      expect(
        getPath({ core: { renameOnSave: true } }, 'core.renameOnSave')
      ).toBe(true);
    });

    it('reads a deeply nested dot-path', () => {
      const settings = {
        markupStripping: { stripMarkupSettings: { bold: false } },
      };
      expect(
        getPath(settings, 'markupStripping.stripMarkupSettings.bold')
      ).toBe(false);
    });

    it('returns undefined for a missing leaf', () => {
      expect(getPath({ core: {} }, 'core.renameOnSave')).toBeUndefined();
    });

    it('returns undefined when an intermediate segment is missing', () => {
      expect(getPath({}, 'core.renameOnSave')).toBeUndefined();
    });

    it('returns undefined rather than throwing when a segment is a primitive', () => {
      expect(getPath({ core: 5 }, 'core.renameOnSave')).toBeUndefined();
    });

    it('returns undefined when a segment is null', () => {
      expect(getPath({ core: null }, 'core.renameOnSave')).toBeUndefined();
    });

    it('preserves falsy leaf values', () => {
      expect(getPath({ core: { debug: false } }, 'core.debug')).toBe(false);
      expect(getPath({ core: { charCount: 0 } }, 'core.charCount')).toBe(0);
      expect(
        getPath(
          { core: { debugEnabledTimestamp: '' } },
          'core.debugEnabledTimestamp'
        )
      ).toBe('');
    });
  });

  describe('setPath', () => {
    it('writes a top-level key', () => {
      const settings: Record<string, unknown> = {};
      setPath(settings, 'dataSchemaVersion', 4);
      expect(settings.dataSchemaVersion).toBe(4);
    });

    it('writes a nested dot-path', () => {
      const settings: Record<string, unknown> = {
        core: { renameOnSave: false },
      };
      setPath(settings, 'core.renameOnSave', true);
      expect((settings.core as Record<string, unknown>).renameOnSave).toBe(
        true
      );
    });

    it('creates missing intermediate objects', () => {
      const settings: Record<string, unknown> = {};
      setPath(settings, 'markupStripping.stripMarkupSettings.bold', true);
      expect(
        getPath(settings, 'markupStripping.stripMarkupSettings.bold')
      ).toBe(true);
    });

    it('replaces a primitive intermediate rather than throwing', () => {
      const settings: Record<string, unknown> = { core: 5 };
      setPath(settings, 'core.debug', true);
      expect(getPath(settings, 'core.debug')).toBe(true);
    });

    it('replaces a null intermediate', () => {
      const settings: Record<string, unknown> = { core: null };
      setPath(settings, 'core.debug', true);
      expect(getPath(settings, 'core.debug')).toBe(true);
    });

    it('leaves sibling keys untouched', () => {
      const settings: Record<string, unknown> = {
        core: { debug: false, charCount: 2 },
        exclusions: { matchSubtags: true },
      };
      setPath(settings, 'core.debug', true);
      expect(settings).toEqual({
        core: { debug: true, charCount: 2 },
        exclusions: { matchSubtags: true },
      });
    });

    it('round-trips with getPath', () => {
      const settings: Record<string, unknown> = {};
      setPath(settings, 'exclusions.excludedFiles', ['x']);
      expect(getPath(settings, 'exclusions.excludedFiles')).toEqual(['x']);
    });
  });
});
