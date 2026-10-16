import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initI18n,
  interpolate,
  t,
  getCurrentLocale,
  tp,
  tpSplit,
} from '../src/i18n';
import { getLanguage } from './mockObsidian';

describe('i18n', () => {
  beforeEach(() => {
    // Reset locale to English before each test
    vi.mocked(getLanguage).mockReturnValue('en');
    initI18n();
  });

  describe('initI18n', () => {
    it('should initialize with English locale by default', () => {
      initI18n();
      expect(getCurrentLocale()).toBe('en');
    });

    it('should initialize with Russian locale when moment returns ru', () => {
      vi.mocked(getLanguage).mockReturnValue('ru');
      initI18n();
      expect(getCurrentLocale()).toBe('ru');
    });

    it('should normalize locale codes (ru-RU -> ru)', () => {
      vi.mocked(getLanguage).mockReturnValue('ru-RU');
      initI18n();
      expect(getCurrentLocale()).toBe('ru');
    });

    it('should normalize locale codes (en-US -> en)', () => {
      vi.mocked(getLanguage).mockReturnValue('en-US');
      initI18n();
      expect(getCurrentLocale()).toBe('en');
    });

    it('should fallback to English for unsupported locales', () => {
      vi.mocked(getLanguage).mockReturnValue('fr-FR');
      initI18n();
      expect(getCurrentLocale()).toBe('en');
    });

    it('should lowercase locale codes', () => {
      vi.mocked(getLanguage).mockReturnValue('EN-US');
      initI18n();
      expect(getCurrentLocale()).toBe('en');
    });
  });

  describe('t (translate)', () => {
    it('should return the translation for an existing key', () => {
      expect(t('commands.putFirstLineInTitle')).toBe('Put first line in title');
    });

    it('should return the key path when the key does not exist', () => {
      expect(t('nonexistent.key')).toBe('nonexistent.key');
    });

    it('should return the key path when the key names a group rather than a string', () => {
      expect(t('settings.ruleCount')).toBe('settings.ruleCount');
    });

    it('should return the empty key path as it is', () => {
      expect(t('')).toBe('');
    });

    it('should replace variables in a found translation', () => {
      expect(t('notifications.renamedTo', { filename: 'test.md' })).toBe(
        'Renamed to “test.md”'
      );
    });

    it('should insert a variable containing $ patterns verbatim into a found translation', () => {
      expect(
        t('notifications.renamedTo', { filename: "Price $& tax $$ $` $' end" })
      ).toBe("Renamed to “Price $& tax $$ $` $' end”");
    });
  });

  describe('interpolate', () => {
    it('should handle multiple variables', () => {
      expect(
        interpolate('Hello {{name}}, you are {{age}} years old', {
          name: 'John',
          age: 25,
        })
      ).toBe('Hello John, you are 25 years old');
    });

    it('should insert a variable containing $ patterns verbatim', () => {
      expect(
        interpolate('File {{filename}}', { filename: 'Price $& tax $$' })
      ).toBe('File Price $& tax $$');
    });

    it('should replace every occurrence of a placeholder', () => {
      expect(interpolate('{{count}} of {{count}}', { count: 3 })).toBe(
        '3 of 3'
      );
    });

    it('should leave a placeholder that a variable value brings in as written', () => {
      expect(
        interpolate('{{first}}-{{second}}', {
          first: '{{second}}',
          second: 'x',
        })
      ).toBe('{{second}}-x');
    });

    it('should leave a placeholder with no variable as written', () => {
      expect(interpolate('Count: {{count}}', { other: 1 })).toBe(
        'Count: {{count}}'
      );
    });

    it('should handle numeric variables', () => {
      expect(interpolate('Count: {{count}}', { count: 42 })).toBe('Count: 42');
    });

    it('should not replace placeholders when no variables are given', () => {
      expect(interpolate('Text with {{var}}')).toBe('Text with {{var}}');
    });

    it('should handle an empty variable value', () => {
      expect(interpolate('Text {{empty}}', { empty: '' })).toBe('Text ');
    });

    it('should handle many variables', () => {
      expect(
        interpolate('{{var1}} {{var2}} {{var3}} {{var4}} {{var5}}', {
          var1: 'a',
          var2: 'b',
          var3: 'c',
          var4: 'd',
          var5: 'e',
        })
      ).toBe('a b c d e');
    });

    it('should handle variable names with underscores', () => {
      expect(interpolate('File: {{file_name}}', { file_name: 'test.md' })).toBe(
        'File: test.md'
      );
    });
  });

  describe('getCurrentLocale', () => {
    it('should return current locale', () => {
      expect(getCurrentLocale()).toBe('en');
    });

    it('should return updated locale after reinit', () => {
      vi.mocked(getLanguage).mockReturnValue('ru');
      initI18n();
      expect(getCurrentLocale()).toBe('ru');
    });
  });

  describe('tp (translate plural)', () => {
    it('picks the "one" form for 1 and "many" for every other count in English', () => {
      expect(
        [0, 1, 2, 5, 21].map((count) => tp('settings.ruleCount', count))
      ).toEqual(['0 rules', '1 rule', '2 rules', '5 rules', '21 rules']);
    });

    it("fills the group's other placeholders alongside the count", () => {
      expect(
        tp('notifications.renamedNotesWithNErrors', 1, {
          renamed: 3,
          total: 5,
        })
      ).toBe('Renamed 3/5 notes with 1 error. Check console for details.');
    });

    it('uses a plain string as is', () => {
      expect(tp('settings.exclusions.files.renamedWarning', 3)).toBe(
        t('settings.exclusions.files.renamedWarning')
      );
    });

    it('returns the key path for a missing key', () => {
      expect(tp('nonexistent.key', 3)).toBe('nonexistent.key');
    });

    it('keeps a decimal count as written', () => {
      expect(tp('settings.ruleCount', 2.7)).toBe('2.7 rules');
    });

    describe('Russian plural categories', () => {
      beforeEach(() => {
        vi.mocked(getLanguage).mockReturnValue('ru');
        initI18n();
      });

      it.each([
        [1, '1 правило'],
        [21, '21 правило'],
        [101, '101 правило'],
        [2, '2 правила'],
        [4, '4 правила'],
        [22, '22 правила'],
        [0, '0 правил'],
        [5, '5 правил'],
        [11, '11 правил'],
        [12, '12 правил'],
        [14, '14 правил'],
        [20, '20 правил'],
        [111, '111 правил'],
      ])('gives %i the right form', (count, expected) => {
        expect(tp('settings.ruleCount', count)).toBe(expected);
      });
    });
  });

  describe('tpSplit', () => {
    it('returns the parts of the selected form', () => {
      expect(tpSplit('modals.renameNNotes', 1)).toEqual({
        before: 'This will rename ',
        noun: 'note',
        after: '.',
      });
      expect(tpSplit('modals.renameNNotes', 2).noun).toBe('notes');
    });

    it('returns the key path as the first part for a missing key', () => {
      expect(tpSplit('nonexistent.key', 5)).toEqual({
        before: 'nonexistent.key',
        noun: '',
        after: '',
      });
    });
  });

  describe('bulk dialog and notice wording', () => {
    /** A dialog sentence the way the dialog assembles it, with the count and noun together. */
    const splitSentence = (keyPath: string, count: number): string => {
      const { before, noun, after } = tpSplit(keyPath, count);
      return `${before}${count} ${noun}${after}`;
    };

    const errorVariables = { renamed: 3, processed: 3, total: 30 };

    describe('English', () => {
      it.each([
        [
          'notifications.renamingNotes',
          'Renaming 1 note...',
          'Renaming 2 notes...',
        ],
        [
          'notifications.processingNotes',
          'Processing 1 note...',
          'Processing 2 notes...',
        ],
        [
          'notifications.disabledRenamingForNNotes',
          'Disabled renaming for 1 note',
          'Disabled renaming for 2 notes',
        ],
        [
          'notifications.enabledRenamingForNNotes',
          'Enabled renaming for 1 note',
          'Enabled renaming for 2 notes',
        ],
        [
          'notifications.renamedNotesWithNErrors',
          'Renamed 3/30 notes with 1 error. Check console for details.',
          'Renamed 3/30 notes with 2 errors. Check console for details.',
        ],
        [
          'notifications.processedNotesWithNErrors',
          'Processed 3/30 notes with 1 error. Check console for details.',
          'Processed 3/30 notes with 2 errors. Check console for details.',
        ],
        [
          'commands.putFirstLineInTitleNNotes',
          'Put first line in title (1 note)',
          'Put first line in title (2 notes)',
        ],
        [
          'commands.disableRenamingNFolders',
          'Disable renaming (1 folder)',
          'Disable renaming (2 folders)',
        ],
        [
          'notifications.enabledRenamingInNFolders',
          'Enabled renaming in 1 folder',
          'Enabled renaming in 2 folders',
        ],
        [
          'notifications.disabledRenamingInNFolders',
          'Disabled renaming in 1 folder',
          'Disabled renaming in 2 folders',
        ],
      ])('%s', (keyPath, one, many) => {
        expect(tp(keyPath, 1, errorVariables)).toBe(one);
        expect(tp(keyPath, 2, errorVariables)).toBe(many);
      });

      it.each([
        [
          'modals.renameNNotes',
          'This will rename 1 note.',
          'This will rename 2 notes.',
        ],
        ['modals.addPropertyToNNotes', ' to 1 note.', ' to 2 notes.'],
        ['modals.removePropertyFromNNotes', ' from 1 note.', ' from 2 notes.'],
      ])('%s', (keyPath, one, many) => {
        expect(splitSentence(keyPath, 1)).toBe(one);
        expect(splitSentence(keyPath, 2)).toBe(many);
      });
    });

    describe('Russian', () => {
      beforeEach(() => {
        vi.mocked(getLanguage).mockReturnValue('ru');
        initI18n();
      });

      // Counts 1, 2, 5 and 21 cover the "one", "few", "many" and "one again" categories; each group puts the noun in the case its sentence needs
      it.each([
        [
          'notifications.renamingNotes',
          [
            'Переименование 1 заметки...',
            'Переименование 2 заметок...',
            'Переименование 5 заметок...',
            'Переименование 21 заметки...',
          ],
        ],
        [
          'notifications.processingNotes',
          [
            'Обработка 1 заметки...',
            'Обработка 2 заметок...',
            'Обработка 5 заметок...',
            'Обработка 21 заметки...',
          ],
        ],
        [
          'notifications.disabledRenamingForNNotes',
          [
            'Переименование отключено для 1 заметки',
            'Переименование отключено для 2 заметок',
            'Переименование отключено для 5 заметок',
            'Переименование отключено для 21 заметки',
          ],
        ],
        [
          'notifications.enabledRenamingForNNotes',
          [
            'Переименование включено для 1 заметки',
            'Переименование включено для 2 заметок',
            'Переименование включено для 5 заметок',
            'Переименование включено для 21 заметки',
          ],
        ],
        [
          'notifications.renamedNotesWithNErrors',
          [
            'Переименовано 3/30 заметок с 1 ошибкой. Проверьте консоль для подробностей.',
            'Переименовано 3/30 заметок с 2 ошибками. Проверьте консоль для подробностей.',
            'Переименовано 3/30 заметок с 5 ошибками. Проверьте консоль для подробностей.',
            'Переименовано 3/30 заметок с 21 ошибкой. Проверьте консоль для подробностей.',
          ],
        ],
        [
          'notifications.processedNotesWithNErrors',
          [
            'Обработано 3/30 заметок с 1 ошибкой. Проверьте консоль для подробностей.',
            'Обработано 3/30 заметок с 2 ошибками. Проверьте консоль для подробностей.',
            'Обработано 3/30 заметок с 5 ошибками. Проверьте консоль для подробностей.',
            'Обработано 3/30 заметок с 21 ошибкой. Проверьте консоль для подробностей.',
          ],
        ],
        [
          'commands.putFirstLineInTitleNNotes',
          [
            'Поместить первую строку в название (1 заметка)',
            'Поместить первую строку в название (2 заметки)',
            'Поместить первую строку в название (5 заметок)',
            'Поместить первую строку в название (21 заметка)',
          ],
        ],
        [
          'commands.enableRenamingNFolders',
          [
            'Включить переименование (1 папка)',
            'Включить переименование (2 папки)',
            'Включить переименование (5 папок)',
            'Включить переименование (21 папка)',
          ],
        ],
        [
          'notifications.enabledRenamingInNFolders',
          [
            'Переименование включено в 1 папке',
            'Переименование включено в 2 папках',
            'Переименование включено в 5 папках',
            'Переименование включено в 21 папке',
          ],
        ],
        [
          'notifications.disabledRenamingInNFolders',
          [
            'Переименование отключено в 1 папке',
            'Переименование отключено в 2 папках',
            'Переименование отключено в 5 папках',
            'Переименование отключено в 21 папке',
          ],
        ],
      ])('%s', (keyPath, expected) => {
        expect(
          [1, 2, 5, 21].map((count) => tp(keyPath, count, errorVariables))
        ).toEqual(expected);
      });

      it.each([
        [
          'modals.renameNNotes',
          [
            'Будет переименована 1 заметка.',
            'Будут переименованы 2 заметки.',
            'Будет переименовано 5 заметок.',
            'Будет переименована 21 заметка.',
          ],
        ],
        [
          'modals.addPropertyToNNotes',
          [
            ' будет добавлено в 1 заметку.',
            ' будет добавлено в 2 заметки.',
            ' будет добавлено в 5 заметок.',
            ' будет добавлено в 21 заметку.',
          ],
        ],
        [
          'modals.removePropertyFromNNotes',
          [
            ' будет удалено из 1 заметки.',
            ' будет удалено из 2 заметок.',
            ' будет удалено из 5 заметок.',
            ' будет удалено из 21 заметки.',
          ],
        ],
      ])('%s', (keyPath, expected) => {
        expect(
          [1, 2, 5, 21].map((count) => splitSentence(keyPath, count))
        ).toEqual(expected);
      });
    });
  });

  describe('edge cases', () => {
    it('should return the key path for very deep nesting that leaves the tree', () => {
      expect(t('level1.level2.level3.level4.level5.level6')).toBe(
        'level1.level2.level3.level4.level5.level6'
      );
    });

    it('should handle Russian locale switching', () => {
      vi.mocked(getLanguage).mockReturnValue('en');
      initI18n();
      expect(getCurrentLocale()).toBe('en');

      vi.mocked(getLanguage).mockReturnValue('ru');
      initI18n();
      expect(getCurrentLocale()).toBe('ru');

      vi.mocked(getLanguage).mockReturnValue('en');
      initI18n();
      expect(getCurrentLocale()).toBe('en');
    });

    it('should handle negative counts in plural forms', () => {
      expect(tp('settings.ruleCount', -1)).toBe('-1 rules');
    });

    it('should handle very large counts in plural forms', () => {
      expect(tp('settings.ruleCount', 999999)).toBe('999999 rules');
    });
  });
});
