/**
 * Character replacement configuration.
 * Unified nested structure for char replacement settings.
 */

export interface CharReplacementConfig {
  /** The string to replace the character with */
  replacement: string;
  /** Whether this replacement is enabled */
  enabled: boolean;
  /** Trim whitespace to the left of this character */
  trimLeft: boolean;
  /** Trim whitespace to the right of this character */
  trimRight: boolean;
}

export interface CharReplacements {
  slash: CharReplacementConfig;
  colon: CharReplacementConfig;
  asterisk: CharReplacementConfig;
  question: CharReplacementConfig;
  lessThan: CharReplacementConfig;
  greaterThan: CharReplacementConfig;
  quote: CharReplacementConfig;
  pipe: CharReplacementConfig;
  hash: CharReplacementConfig;
  leftBracket: CharReplacementConfig;
  rightBracket: CharReplacementConfig;
  caret: CharReplacementConfig;
  backslash: CharReplacementConfig;
  dot: CharReplacementConfig;
}

/**
 * Character keys used in replacement config
 */
export type CharKey = keyof CharReplacements;

/**
 * Maps each replaceable character to its {@link CharReplacements} key.
 *
 * Sole source of the char↔key pairing: it was previously re-encoded in four places
 * (two reversal loops, a lookup table and a switch), which is how they drifted apart.
 * Iteration order is significant to the reversal loops, since one replacement string
 * can be a substring of another.
 */
export const CHAR_TO_SETTING_KEY: Record<string, CharKey> = {
  '/': 'slash',
  ':': 'colon',
  '*': 'asterisk',
  '?': 'question',
  '<': 'lessThan',
  '>': 'greaterThan',
  '"': 'quote',
  '|': 'pipe',
  '#': 'hash',
  '[': 'leftBracket',
  ']': 'rightBracket',
  '^': 'caret',
  '\\': 'backslash',
  '.': 'dot',
};

/** The character each key stands for, inverted from {@link CHAR_TO_SETTING_KEY} so the pairing is written once; the cast holds because that map lists every key. */
export const SETTING_KEY_TO_CHAR = Object.fromEntries(
  Object.entries(CHAR_TO_SETTING_KEY).map(([char, key]) => [key, char])
) as Record<CharKey, string>;

/**
 * Characters replaced on all operating systems, in settings display order: those forbidden everywhere, plus the dot, which is forbidden only at the start of a name.
 * Shared so the forbidden-character lists and the settings page agree on membership.
 */
export const PRIMARY_CHAR_KEYS: CharKey[] = [
  'leftBracket',
  'rightBracket',
  'hash',
  'caret',
  'pipe',
  'backslash',
  'slash',
  'colon',
  'dot',
];

/**
 * Characters forbidden only on Windows and Android, in settings display order.
 * Disjoint from {@link PRIMARY_CHAR_KEYS}.
 */
export const WINDOWS_ANDROID_CHAR_KEYS: CharKey[] = [
  'asterisk',
  'quote',
  'lessThan',
  'greaterThan',
  'question',
];
