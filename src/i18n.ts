import { getLanguage } from 'obsidian';
import enTranslations from '../locale/en.json';
import ruTranslations from '../locale/ru.json';
// Russian copy writes е for ё except where е would change the meaning, and quotes with straight "…", the style Obsidian's own Russian text uses most; notice punctuation rules sit at `showNotice`

type TranslationVariables = Record<string, string | number>;

/** The plural categories the locale files use; English has no `few`. */
type PluralCategory = 'one' | 'few' | 'many';

const state = {
  availableTranslations: {
    en: enTranslations,
    ru: ruTranslations,
  } as Record<string, Record<string, unknown>>,
  translations: enTranslations,
  currentLocale: 'en',
};

/**
 * Initialize i18n system
 */
export function initI18n(): void {
  // Get locale from Obsidian's API (requires minAppVersion: 1.8.0)
  state.currentLocale = getLanguage();

  // Normalize locale (e.g., 'ru-RU' -> 'ru', 'en-US' -> 'en')
  state.currentLocale = state.currentLocale.split('-')[0].toLowerCase();

  // Load translations
  if (state.availableTranslations[state.currentLocale]) {
    state.translations = state.availableTranslations[
      state.currentLocale
    ] as typeof enTranslations;
  } else {
    // Fallback to English if locale not available
    state.currentLocale = 'en';
    state.translations = state.availableTranslations[
      'en'
    ] as typeof enTranslations;
  }
}

/** The node a dot-separated key path names in the current locale, or `undefined` when the path leaves the tree. */
function resolveKeyPath(keyPath: string): unknown {
  let node: unknown = state.translations;
  for (const key of keyPath.split('.')) {
    if (typeof node !== 'object' || node === null || !(key in node)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Fills every `{{name}}` placeholder that `variables` has a value for, leaving the others as written. */
export function interpolate(
  template: string,
  variables?: TranslationVariables
): string {
  if (!variables) return template;
  // One pass with a replacer function: a replacement string would expand `$&` and `$$` in values containing `$`, and a later variable could rewrite a placeholder an earlier value brought in
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name)
      ? String(variables[name])
      : placeholder
  );
}

/** The plural category `count` takes in the current locale. */
function getPluralCategory(count: number): PluralCategory {
  if (state.currentLocale !== 'ru') return count === 1 ? 'one' : 'many';

  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'one';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
  return 'many';
}

/** The member of a plural group that `count` selects, falling back to `many` where a group leaves a category out. */
function selectPluralForm(group: unknown, count: number): unknown {
  if (typeof group !== 'object' || group === null) return undefined;
  const forms = group as Partial<Record<PluralCategory, unknown>>;
  return forms[getPluralCategory(count)] ?? forms.many;
}

/**
 * Get translated string by key path
 * @param keyPath - Dot-separated key path (e.g., 'commands.putFirstLineInTitle')
 * @param variables - Optional object with variables to replace (e.g., { filename: 'test.md' })
 * @returns Translated string, or the key path when it names no string
 */
export function t(keyPath: string, variables?: TranslationVariables): string {
  const value = resolveKeyPath(keyPath);
  return interpolate(typeof value === 'string' ? value : keyPath, variables);
}

/**
 * Get current locale
 */
export function getCurrentLocale(): string {
  return state.currentLocale;
}

/**
 * Translates a plural group, picking the form `count` takes in the current locale.
 * @param keyPath - Dot-separated key path to a group of `one`/`few`/`many` strings (e.g., 'commands.putFirstLineInTitleNNotes'); a plain string is used as is
 * @param count - Selects the form and fills `{{count}}`
 * @param variables - Fill the group's other placeholders
 * @returns The translated string, or the key path when it names neither a string nor a group
 */
export function tp(
  keyPath: string,
  count: number,
  variables?: TranslationVariables
): string {
  const value = resolveKeyPath(keyPath);
  const form =
    typeof value === 'string' ? value : selectPluralForm(value, count);
  return interpolate(typeof form === 'string' ? form : keyPath, {
    ...variables,
    count,
  });
}

/**
 * Translates a plural group into parts, so the caller can style the counted noun.
 * @param keyPath - Dot-separated key path to a group whose forms hold `before`, `noun` and `after` (e.g., 'modals.renameNNotes')
 * @param count - Selects the form
 * @returns The parts of the selected form, or the key path as `before` when it names no such group
 */
export function tpSplit(
  keyPath: string,
  count: number
): { before: string; noun: string; after: string } {
  const form = selectPluralForm(resolveKeyPath(keyPath), count);
  if (typeof form !== 'object' || form === null) {
    return { before: keyPath, noun: '', after: '' };
  }
  const {
    before = '',
    noun = '',
    after = '',
  } = form as Partial<Record<'before' | 'noun' | 'after', string>>;
  return { before, noun, after };
}
