import { describe, it, expect, beforeEach } from 'vitest';
import {
  filterNonEmpty,
  normalizeLineBreaks,
  processForbiddenChars,
  generateSafeLinkTarget,
  reverseSafeLinkTarget,
  truncateWithEllipsis,
  resolveFileNameChar,
} from '../../src/utils/string-processing';
import { createTestSettings } from '../testUtils';
import { PluginSettings } from '../../src/types';
import {
  UNIVERSAL_FORBIDDEN_CHARS,
  WINDOWS_ANDROID_CHARS,
} from '../../src/constants';

describe('string-processing', () => {
  describe('filterNonEmpty', () => {
    it('should filter out empty strings', () => {
      const input = ['hello', '', 'world', ''];
      const result = filterNonEmpty(input);
      expect(result).toEqual(['hello', 'world']);
    });

    it('should filter out whitespace-only strings', () => {
      const input = ['hello', '   ', 'world', '\t\n', 'test'];
      const result = filterNonEmpty(input);
      expect(result).toEqual(['hello', 'world', 'test']);
    });

    it('should keep strings with content even if they have whitespace', () => {
      const input = ['  hello  ', '  world  '];
      const result = filterNonEmpty(input);
      expect(result).toEqual(['  hello  ', '  world  ']);
    });

    it('should return empty array when all strings are empty', () => {
      const input = ['', '  ', '\t', '\n'];
      const result = filterNonEmpty(input);
      expect(result).toEqual([]);
    });

    it('should handle empty array input', () => {
      const result = filterNonEmpty([]);
      expect(result).toEqual([]);
    });
  });

  describe('normalizeLineBreaks', () => {
    it('turns CRLF and lone CR line breaks into LF', () => {
      expect(normalizeLineBreaks('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    });

    it('leaves LF text unchanged', () => {
      expect(normalizeLineBreaks('---\na: b\n---\n')).toBe('---\na: b\n---\n');
    });
  });

  describe('processForbiddenChars', () => {
    let settings: PluginSettings;

    beforeEach(() => {
      settings = createTestSettings({
        characterReplacements: {
          enableForbiddenCharReplacements: true,
          charReplacements: {
            slash: {
              enabled: true,
              replacement: '-',
              trimLeft: false,
              trimRight: false,
            },
            colon: {
              enabled: true,
              replacement: '-',
              trimLeft: false,
              trimRight: false,
            },
            pipe: {
              enabled: true,
              replacement: '-',
              trimLeft: false,
              trimRight: false,
            },
            backslash: {
              enabled: true,
              replacement: '-',
              trimLeft: false,
              trimRight: false,
            },
            hash: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            leftBracket: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            rightBracket: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            caret: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            asterisk: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            question: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            lessThan: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            greaterThan: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            quote: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            dot: {
              enabled: false,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
          },
        },
      });
    });

    it('should replace forward slash with configured replacement', () => {
      const result = processForbiddenChars('hello/world', settings);
      expect(result).toBe('hello-world');
    });

    it('should replace colon with configured replacement', () => {
      const result = processForbiddenChars('hello:world', settings);
      expect(result).toBe('hello-world');
    });

    it('should replace backslash with configured replacement', () => {
      const result = processForbiddenChars('hello\\world', settings);
      expect(result).toBe('hello-world');
    });

    it('should strip characters when replacement is empty', () => {
      const result = processForbiddenChars('hello#world', settings);
      expect(result).toBe('helloworld');
    });

    it('should handle multiple forbidden characters', () => {
      const result = processForbiddenChars('hello/world:test#foo', settings);
      expect(result).toBe('hello-world-testfoo');
    });

    it('should not replace characters when master toggle is off', () => {
      settings.characterReplacements.enableForbiddenCharReplacements = false;
      const result = processForbiddenChars('hello/world:test', settings);
      expect(result).toBe('helloworldtest'); // Strips forbidden chars
    });

    it('should not replace character when individual toggle is off', () => {
      settings.characterReplacements.charReplacements.slash.enabled = false;
      const result = processForbiddenChars('hello/world', settings);
      expect(result).toBe('helloworld'); // Strips slash instead of replacing
    });

    it('should trim whitespace around result', () => {
      const result = processForbiddenChars('  hello/world  ', settings);
      expect(result).toBe('hello-world');
    });

    it('should collapse multiple spaces into single space', () => {
      const result = processForbiddenChars('hello    world', settings);
      expect(result).toBe('hello world');
    });

    it('should handle dots at the beginning (leading dots forbidden)', () => {
      const result = processForbiddenChars('.hello', settings);
      expect(result).toBe('hello');
    });

    // The leading whitespace is trimmed afterwards, which would leave the dot first
    it('should strip a dot that only whitespace precedes', () => {
      expect(processForbiddenChars('  .hello', settings)).toBe('hello');
    });

    it('should keep dots in middle when dot replacement disabled', () => {
      const result = processForbiddenChars('hello.world', settings);
      expect(result).toBe('hello.world');
    });

    it('should replace dots when dot replacement enabled', () => {
      settings.characterReplacements.charReplacements.dot.enabled = true;
      settings.characterReplacements.charReplacements.dot.replacement = '-';
      const result = processForbiddenChars('hello.world', settings);
      expect(result).toBe('hello-world');
    });

    it('should trim spaces before a replaced dot when its trimLeft is on', () => {
      settings.characterReplacements.charReplacements.dot.enabled = true;
      settings.characterReplacements.charReplacements.dot.replacement = '-';
      settings.characterReplacements.charReplacements.dot.trimLeft = true;
      const result = processForbiddenChars('hello .world', settings);
      expect(result).toBe('hello-world');
    });

    it('should handle trimLeft option for replacements', () => {
      settings.characterReplacements.charReplacements.slash.trimLeft = true;
      const result = processForbiddenChars('hello /world', settings);
      expect(result).toBe('hello-world'); // Trims space before slash
    });

    it('should handle trimRight option for replacements', () => {
      settings.characterReplacements.charReplacements.slash.trimRight = true;
      const result = processForbiddenChars('hello/ world', settings);
      expect(result).toBe('hello-world'); // Trims space after slash
    });

    it('should respect maxLength option', () => {
      const result = processForbiddenChars(
        'hello world this is a long title',
        settings,
        {
          maxLength: 15,
        }
      );
      expect(result.length).toBeLessThanOrEqual(15);
      expect(result).toContain('…');
    });

    it('should keep a title exactly maxLength long', () => {
      expect(
        processForbiddenChars('0123456789', settings, { maxLength: 10 })
      ).toBe('0123456789');
    });

    it('should truncate a title one past maxLength to maxLength', () => {
      const result = processForbiddenChars('0123456789A', settings, {
        maxLength: 10,
      });

      expect(result).toBe('012345678…');
      expect(result).toHaveLength(10);
    });

    it('should count the length after collapsing whitespace', () => {
      expect(
        processForbiddenChars('01234   56789', settings, { maxLength: 11 })
      ).toBe('01234 56789');
    });

    it('should replace Windows/Android characters unconditionally', () => {
      settings.characterReplacements.charReplacements.asterisk.enabled = true;
      settings.characterReplacements.charReplacements.asterisk.replacement =
        '-';
      const result = processForbiddenChars('hello*world', settings);
      expect(result).toBe('hello-world');
    });

    it('should not replace Windows/Android character when its individual toggle is off', () => {
      settings.characterReplacements.charReplacements.asterisk.enabled = false;
      settings.characterReplacements.charReplacements.asterisk.replacement =
        '-';
      const result = processForbiddenChars('hello*world', settings);
      expect(result).toBe('helloworld'); // Strips asterisk instead of replacing
    });

    it('should handle empty string input', () => {
      const result = processForbiddenChars('', settings);
      expect(result).toBe('');
    });

    it('should handle string with only forbidden characters', () => {
      const result = processForbiddenChars('//::##', settings);
      expect(result).toBe('----'); // Slashes and colons replaced, hashes stripped
    });

    it('should handle complex real-world title', () => {
      const result = processForbiddenChars(
        'Meeting Notes: 2024/01/15 [Draft]',
        settings
      );
      expect(result).toBe('Meeting Notes- 2024-01-15 Draft');
    });
  });

  describe('forbidden character sets', () => {
    it('should list the characters forbidden on every OS, without the dot', () => {
      expect([...UNIVERSAL_FORBIDDEN_CHARS].sort()).toEqual(
        ['/', ':', '|', '\\', '#', '[', ']', '^'].sort()
      );
    });

    it('should list the characters forbidden only on Windows and Android', () => {
      expect([...WINDOWS_ANDROID_CHARS].sort()).toEqual(
        ['*', '?', '<', '>', '"'].sort()
      );
    });
  });

  describe('resolveFileNameChar', () => {
    it('should drop every forbidden character without replacement settings', () => {
      for (const char of [
        ...UNIVERSAL_FORBIDDEN_CHARS,
        ...WINDOWS_ANDROID_CHARS,
      ]) {
        expect(resolveFileNameChar(char, false, null)).toEqual({
          kind: 'drop',
        });
      }
    });

    it('should drop a dot only at the start of a name without replacement settings', () => {
      expect(resolveFileNameChar('.', true, null)).toEqual({ kind: 'drop' });
      expect(resolveFileNameChar('.', false, null)).toEqual({ kind: 'keep' });
    });

    it('should keep a character that is not forbidden', () => {
      expect(resolveFileNameChar('a', true, null)).toEqual({ kind: 'keep' });
    });
  });

  describe('truncateWithEllipsis', () => {
    it('should keep text exactly maxLength long', () => {
      expect(truncateWithEllipsis('abcde', 5)).toBe('abcde');
    });

    it('should truncate text one past maxLength to maxLength', () => {
      const result = truncateWithEllipsis('abcdef', 5);

      expect(result).toBe('abcd…');
      expect(result).toHaveLength(5);
    });

    it('should trim whitespace before the ellipsis', () => {
      expect(truncateWithEllipsis('abc def', 5)).toBe('abc…');
    });

    it('should not split an emoji at the cut', () => {
      // The cut at 3 code units falls between the two halves of the rocket's surrogate pair.
      const result = truncateWithEllipsis('ab\u{1F680}cd', 4);

      expect(result).toBe('ab…');
    });

    it('should keep an emoji that ends before the cut', () => {
      expect(truncateWithEllipsis('\u{1F680}abcd', 4)).toBe('\u{1F680}a…');
    });
  });

  describe('generateSafeLinkTarget', () => {
    let settings: PluginSettings;

    beforeEach(() => {
      settings = createTestSettings({
        characterReplacements: {
          enableForbiddenCharReplacements: true,
          charReplacements: {
            slash: {
              enabled: true,
              replacement: '-',
              trimLeft: false,
              trimRight: false,
            },
            colon: {
              enabled: true,
              replacement: '-',
              trimLeft: false,
              trimRight: false,
            },
            pipe: {
              enabled: true,
              replacement: '-',
              trimLeft: false,
              trimRight: false,
            },
            backslash: {
              enabled: true,
              replacement: '-',
              trimLeft: false,
              trimRight: false,
            },
            hash: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            leftBracket: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            rightBracket: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            caret: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            asterisk: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            question: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            lessThan: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            greaterThan: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            quote: {
              enabled: true,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
            dot: {
              enabled: false,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
          },
        },
      });
    });

    it('should generate safe link target by processing forbidden chars', () => {
      const result = generateSafeLinkTarget(
        'Title/With:Forbidden|Chars',
        settings
      );
      expect(result).toBe('Title-With-Forbidden-Chars');
    });

    it('should handle text with brackets', () => {
      const result = generateSafeLinkTarget('Title [Draft]', settings);
      expect(result).toBe('Title Draft');
    });
  });

  describe('reverseSafeLinkTarget', () => {
    let settings: PluginSettings;

    beforeEach(() => {
      settings = createTestSettings({
        characterReplacements: {
          enableForbiddenCharReplacements: true,
          charReplacements: {
            slash: {
              enabled: true,
              replacement: '-',
              trimLeft: false,
              trimRight: false,
            },
            colon: {
              enabled: true,
              replacement: ':',
              trimLeft: false,
              trimRight: false,
            },
            pipe: {
              enabled: true,
              replacement: '|',
              trimLeft: false,
              trimRight: false,
            },
            backslash: {
              enabled: true,
              replacement: '\\',
              trimLeft: false,
              trimRight: false,
            },
            hash: {
              enabled: true,
              replacement: '#',
              trimLeft: false,
              trimRight: false,
            },
            leftBracket: {
              enabled: true,
              replacement: '[',
              trimLeft: false,
              trimRight: false,
            },
            rightBracket: {
              enabled: true,
              replacement: ']',
              trimLeft: false,
              trimRight: false,
            },
            caret: {
              enabled: true,
              replacement: '^',
              trimLeft: false,
              trimRight: false,
            },
            asterisk: {
              enabled: true,
              replacement: '*',
              trimLeft: false,
              trimRight: false,
            },
            question: {
              enabled: true,
              replacement: '?',
              trimLeft: false,
              trimRight: false,
            },
            lessThan: {
              enabled: true,
              replacement: '<',
              trimLeft: false,
              trimRight: false,
            },
            greaterThan: {
              enabled: true,
              replacement: '>',
              trimLeft: false,
              trimRight: false,
            },
            quote: {
              enabled: true,
              replacement: '"',
              trimLeft: false,
              trimRight: false,
            },
            dot: {
              enabled: false,
              replacement: '',
              trimLeft: false,
              trimRight: false,
            },
          },
        },
      });
    });

    it('should reverse slash replacement', () => {
      const result = reverseSafeLinkTarget('Title-With-Dashes', settings);
      expect(result).toBe('Title/With/Dashes');
    });

    it('should reverse colon replacement', () => {
      const result = reverseSafeLinkTarget('Meeting Notes: 2024', settings);
      expect(result).toBe('Meeting Notes: 2024');
    });

    // Nothing tells which character a shared string stood for, so link targets leave it as title insertion does
    it('should leave a replacement shared by two characters as it is', () => {
      settings.characterReplacements.charReplacements.colon.replacement = '-';
      const result = reverseSafeLinkTarget('Title-With-Dashes', settings);
      expect(result).toBe('Title-With-Dashes');
    });

    it('should count the dot toward a shared replacement', () => {
      settings.characterReplacements.charReplacements.dot = {
        enabled: true,
        replacement: '-',
        trimLeft: false,
        trimRight: false,
      };
      const result = reverseSafeLinkTarget('Title-With-Dashes', settings);
      expect(result).toBe('Title-With-Dashes');
    });

    it('should not reverse the dot replacement', () => {
      settings.characterReplacements.charReplacements.dot = {
        enabled: true,
        replacement: '․',
        trimLeft: false,
        trimRight: false,
      };
      const result = reverseSafeLinkTarget('v1․2', settings);
      expect(result).toBe('v1․2');
    });

    it('should not reverse when master toggle is off', () => {
      settings.characterReplacements.enableForbiddenCharReplacements = false;
      const result = reverseSafeLinkTarget('Title-With-Dashes', settings);
      expect(result).toBe('Title-With-Dashes');
    });

    it('should not reverse when individual toggle is off', () => {
      settings.characterReplacements.charReplacements.slash.enabled = false;
      const result = reverseSafeLinkTarget('Title-With-Dashes', settings);
      expect(result).toBe('Title-With-Dashes');
    });

    it('should reverse Windows/Android characters unconditionally', () => {
      settings.characterReplacements.charReplacements.asterisk.replacement =
        'STAR';
      const result = reverseSafeLinkTarget('TitleSTARBold', settings);
      expect(result).toBe('Title*Bold');
    });

    it('should not reverse Windows/Android character when its individual toggle is off', () => {
      settings.characterReplacements.charReplacements.asterisk.enabled = false;
      settings.characterReplacements.charReplacements.asterisk.replacement =
        'STAR';
      const result = reverseSafeLinkTarget('TitleSTARBold', settings);
      expect(result).toBe('TitleSTARBold');
    });

    it('should handle empty replacement (no reverse needed)', () => {
      settings.characterReplacements.charReplacements.hash.replacement = '';
      const result = reverseSafeLinkTarget('TitleWithoutHash', settings);
      expect(result).toBe('TitleWithoutHash');
    });

    it('should handle empty string', () => {
      const result = reverseSafeLinkTarget('', settings);
      expect(result).toBe('');
    });
  });
});
