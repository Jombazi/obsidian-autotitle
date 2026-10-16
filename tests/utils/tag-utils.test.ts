import { describe, it, expect } from 'vitest';
import {
  normalizeTag,
  tagKey,
  excludedTagEntryKey,
  isBlankTagEntry,
  hasExcludedTagEntry,
  hasDuplicateTagEntry,
} from '../../src/utils/tag-utils';

describe('tag-utils', () => {
  describe('normalizeTag', () => {
    it('should remove leading # from tag', () => {
      expect(normalizeTag('#tag')).toBe('tag');
    });

    it('should leave tag without # unchanged', () => {
      expect(normalizeTag('tag')).toBe('tag');
    });

    it('should handle nested tags with #', () => {
      expect(normalizeTag('#work/project')).toBe('work/project');
    });

    it('should handle nested tags without #', () => {
      expect(normalizeTag('work/project')).toBe('work/project');
    });

    it('should handle empty string', () => {
      expect(normalizeTag('')).toBe('');
    });

    it('should handle tag with multiple # characters', () => {
      expect(normalizeTag('##tag')).toBe('#tag');
    });

    it('should handle tag with spaces', () => {
      expect(normalizeTag('#my tag')).toBe('my tag');
    });

    it('should handle special characters', () => {
      expect(normalizeTag('#tag-with_special.chars')).toBe(
        'tag-with_special.chars'
      );
    });
  });

  describe('tagKey', () => {
    it('should give one key to a tag with and without its "#"', () => {
      expect(tagKey('#project')).toBe(tagKey('project'));
    });

    it('should fold case', () => {
      expect(tagKey('#Project/Alpha')).toBe('#project/alpha');
    });

    it('should trim before dropping the "#"', () => {
      expect(tagKey('  #project ')).toBe('#project');
    });

    it('should read a slash-wrapped tag as a tag, never as a pattern', () => {
      expect(tagKey('#/X/')).toBe('#/x/');
    });
  });

  describe('excludedTagEntryKey', () => {
    it('should fold a plain entry as a tag', () => {
      expect(excludedTagEntryKey(' Project ')).toBe(tagKey('#project'));
    });

    it("should keep a pattern entry's case, so patterns differing only by case stay apart", () => {
      expect(excludedTagEntryKey(' /\\D/ ')).toBe('/\\D/');
      expect(excludedTagEntryKey('/\\d/')).not.toBe(
        excludedTagEntryKey('/\\D/')
      );
    });

    // Obsidian accepts a tag written `#/x/`, so one shared key would let the tag stand for the pattern
    it('should never give a pattern entry the key of a tag', () => {
      expect(tagKey('#/x/')).not.toBe(excludedTagEntryKey('/x/'));
    });
  });

  describe('isBlankTagEntry', () => {
    it.each(['', '   ', '#', ' # '])('should treat %j as blank', (entry) => {
      expect(isBlankTagEntry(entry)).toBe(true);
    });

    it.each(['project', '#project', '/x/'])(
      'should not treat %j as blank',
      (entry) => {
        expect(isBlankTagEntry(entry)).toBe(false);
      }
    );
  });

  describe('hasExcludedTagEntry', () => {
    it('should find an entry written without the "#" the menu adds', () => {
      expect(hasExcludedTagEntry(['project'], '#project')).toBe(true);
    });

    it('should find an entry written in another case', () => {
      expect(hasExcludedTagEntry(['#Project'], 'project')).toBe(true);
    });

    it('should not treat a parent entry as holding its subtag', () => {
      expect(hasExcludedTagEntry(['#project'], '#project/alpha')).toBe(false);
    });

    it('should report an empty list as not holding the tag', () => {
      expect(hasExcludedTagEntry([], '#project')).toBe(false);
    });

    it('should not treat a pattern entry as holding the tag it is written like', () => {
      expect(hasExcludedTagEntry(['/x/'], '#/x/')).toBe(false);
    });
  });

  describe('hasDuplicateTagEntry', () => {
    it('should find a plain entry written with or without "#", in any case', () => {
      expect(hasDuplicateTagEntry(['project'], '#Project')).toBe(true);
      expect(hasDuplicateTagEntry(['#PROJECT'], 'project')).toBe(true);
    });

    it('should count a pattern entry, unlike the tag menus', () => {
      expect(hasDuplicateTagEntry(['/^draft/'], '/^draft/')).toBe(true);
    });

    it('should keep patterns that differ only in case apart', () => {
      expect(hasDuplicateTagEntry(['/\\d/'], '/\\D/')).toBe(false);
    });

    it('should not take a pattern for the tag it is written like', () => {
      expect(hasDuplicateTagEntry(['/x/'], '#/x/')).toBe(false);
    });

    it('should not treat a parent entry as holding its subtag', () => {
      expect(hasDuplicateTagEntry(['project'], 'project/alpha')).toBe(false);
    });
  });
});
