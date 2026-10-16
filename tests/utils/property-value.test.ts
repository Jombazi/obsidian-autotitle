import { describe, it, expect } from 'vitest';
import { setRenamingDisabledInFrontmatter } from '../../src/utils/property-value';
import { createTestSettings } from '../testUtils';

describe('property-value', () => {
  describe('setRenamingDisabledInFrontmatter', () => {
    it('should remove the exact key when enabling', () => {
      const frontmatter: Record<string, unknown> = {
        title: 'x',
        'no rename': true,
      };

      setRenamingDisabledInFrontmatter(
        frontmatter,
        createTestSettings(),
        false
      );

      expect(frontmatter).toStrictEqual({ title: 'x' });
    });

    it('should remove a key that differs only in case when enabling', () => {
      const frontmatter: Record<string, unknown> = { 'No Rename': true };

      setRenamingDisabledInFrontmatter(
        frontmatter,
        createTestSettings(),
        false
      );

      expect(frontmatter).toStrictEqual({});
    });

    it('should remove the exact key and a case variant at once when enabling', () => {
      const frontmatter: Record<string, unknown> = {
        'no rename': true,
        'NO RENAME': true,
      };

      setRenamingDisabledInFrontmatter(
        frontmatter,
        createTestSettings(),
        false
      );

      expect(frontmatter).toStrictEqual({});
    });

    it('should write boolean true in place and keep key order when disabling', () => {
      const frontmatter: Record<string, unknown> = {
        title: 'x',
        'no rename': false,
        tags: [],
      };

      setRenamingDisabledInFrontmatter(frontmatter, createTestSettings(), true);

      expect(frontmatter['no rename']).toBe(true);
      expect(Object.keys(frontmatter)).toEqual(['title', 'no rename', 'tags']);
    });

    it('should replace a case variant with the configured key when disabling', () => {
      const frontmatter: Record<string, unknown> = { 'No Rename': false };

      setRenamingDisabledInFrontmatter(frontmatter, createTestSettings(), true);

      expect(frontmatter).toStrictEqual({ 'no rename': true });
    });

    it('should write a configured value that is not a boolean as a string when disabling', () => {
      const frontmatter: Record<string, unknown> = {};
      const settings = createTestSettings({
        exclusions: { disableRenamingValue: 'yes' },
      });

      setRenamingDisabledInFrontmatter(frontmatter, settings, true);

      expect(frontmatter).toStrictEqual({ 'no rename': 'yes' });
    });
  });
});
