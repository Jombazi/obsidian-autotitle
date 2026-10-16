import { DebugLogger, PluginSettings } from '../types';
import {
  CHAR_TO_SETTING_KEY,
  CharReplacementConfig,
} from '../types/char-replacement';
import { UNIVERSAL_FORBIDDEN_CHARS, WINDOWS_ANDROID_CHARS } from '../constants';

/**
 * Filter out empty/whitespace-only strings from array
 * Common utility for filtering settings arrays
 */
export function filterNonEmpty(items: string[]): string[] {
  return items.filter((item) => item.trim() !== '');
}

/**
 * Convert CRLF and lone CR line breaks to LF.
 * @param text - Text to convert
 * @returns The text with LF line breaks only
 */
export function normalizeLineBreaks(text: string): string {
  // A view reports CRLF text with LF line breaks while `vault.read` returns the bytes (measured)
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Shorten text to at most `maxLength` UTF-16 code units, ending in an ellipsis when it was cut.
 * @param text - Text to shorten
 * @param maxLength - Longest result allowed, the ellipsis included
 * @returns The text unchanged when it fits, otherwise its start without trailing whitespace plus `…`
 */
export function truncateWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  let cutIndex = Math.max(0, maxLength - 1);
  // A cut between the two halves of a surrogate pair would leave a lone half, which renders as a replacement character.
  const lastKeptCode = text.charCodeAt(cutIndex - 1);
  if (cutIndex > 0 && lastKeptCode >= 0xd800 && lastKeptCode <= 0xdbff) {
    cutIndex -= 1;
  }
  return text.slice(0, cutIndex).trimEnd() + '…';
}

/** Built once; both sets apply whatever OS the plugin runs on. */
const FORBIDDEN_CHARS: ReadonlySet<string> = new Set([
  ...UNIVERSAL_FORBIDDEN_CHARS,
  ...WINDOWS_ANDROID_CHARS,
]);

/** What one character becomes in a name */
export type FileNameCharOutcome =
  | { kind: 'keep' }
  | { kind: 'drop' }
  | { kind: 'replace'; config: CharReplacementConfig };

/**
 * Decide what one character becomes in a name: the single rule for every forbidden character and the dot.
 * @param char - Character to judge
 * @param atNameStart - True when nothing but whitespace precedes it in the name, where a dot without a replacement is forbidden too
 * @param characterReplacements - Replacement settings, or null to only remove what is forbidden
 * @returns `replace` with its enabled, non-empty replacement; `drop` for a forbidden character or leading dot without one, or one whose replacement is empty; otherwise `keep`
 */
export function resolveFileNameChar(
  char: string,
  atNameStart: boolean,
  characterReplacements: PluginSettings['characterReplacements'] | null
): FileNameCharOutcome {
  const isDot = char === '.';
  if (!isDot && !FORBIDDEN_CHARS.has(char)) {
    return { kind: 'keep' };
  }
  const config = characterReplacements?.enableForbiddenCharReplacements
    ? characterReplacements.charReplacements[CHAR_TO_SETTING_KEY[char]]
    : undefined;
  if (config?.enabled) {
    // An empty replacement removes the character wherever it stands, a dot included
    return config.replacement === ''
      ? { kind: 'drop' }
      : { kind: 'replace', config };
  }
  return isDot && !atNameStart ? { kind: 'keep' } : { kind: 'drop' };
}

/**
 * Process forbidden characters in text according to settings
 * This is the shared logic used by both rename engine and link target generation
 */
export function processForbiddenChars(
  text: string,
  settings: PluginSettings,
  options?: { maxLength?: number }
): string {
  let result = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    // Whitespace before the first kept character is trimmed below, so a dot after only whitespace still starts the name
    const outcome = resolveFileNameChar(
      char,
      result.trim() === '',
      settings.characterReplacements
    );
    if (outcome.kind === 'keep') {
      result += char;
      continue;
    }
    if (outcome.kind === 'drop') {
      continue;
    }

    const { config } = outcome;
    if (config.trimLeft) {
      result = result.trimEnd();
    }
    if (config.trimRight) {
      while (i + 1 < text.length && /\s/.test(text[i + 1])) {
        i++;
      }
    }
    result += config.replacement;
  }

  result = result.trim().replace(/\s+/g, ' ');

  // Last, so the limit counts the title as it will be named: after replacements and whitespace collapsing.
  if (options?.maxLength) {
    result = truncateWithEllipsis(result, options.maxLength);
  }

  return result;
}

/**
 * Generates a safe internal link target from text
 * Applies character replacements based on settings
 */
export function generateSafeLinkTarget(
  text: string,
  settings: PluginSettings
): string {
  return processForbiddenChars(text, settings);
}

// Punctuation binds to the character before it, so no space is restored in front of it
const PUNCTUATION_AFTER_REPLACEMENT = ',.?;:!"\'»«¡¿‽';

// An opening bracket binds to the text after it and a closing one to the text before it, so each gets back only the space on its outer side: the trim flags record that whitespace may have been removed, not on which side a bracket had it.
const OPENING_BRACKETS = '[';
const CLOSING_BRACKETS = ']';

/**
 * Substitute every occurrence of a replacement string with its original character,
 * restoring the whitespace that `trimLeft`/`trimRight` removed during replacement.
 * A side gets a space only when its flag is set and a character other than whitespace sits there, and on the right only when that character is no punctuation.
 */
function restoreWithTrimmedSpacing(
  text: string,
  replacementChar: string,
  originalChar: string,
  trimLeft: boolean,
  trimRight: boolean
): string {
  if (!trimLeft && !trimRight) {
    return text.replaceAll(replacementChar, originalChar);
  }

  const restoreLeft = trimLeft && !CLOSING_BRACKETS.includes(originalChar);
  const restoreRight = trimRight && !OPENING_BRACKETS.includes(originalChar);
  const takesSpace = (character: string): boolean =>
    character !== '' && !/\s/.test(character);

  let result = '';
  let searchFrom = 0;
  let index = text.indexOf(replacementChar, searchFrom);

  while (index !== -1) {
    result += text.substring(searchFrom, index);

    let restored = originalChar;
    // The text before this match is already in `result`, earlier matches restored
    if (restoreLeft && takesSpace(result.slice(-1))) {
      restored = ' ' + restored;
    }
    const charToRight = text.charAt(index + replacementChar.length);
    if (
      restoreRight &&
      takesSpace(charToRight) &&
      !PUNCTUATION_AFTER_REPLACEMENT.includes(charToRight)
    ) {
      restored += ' ';
    }

    result += restored;
    searchFrom = index + replacementChar.length;
    index = text.indexOf(replacementChar, searchFrom);
  }

  return result + text.substring(searchFrom);
}

/** How one reversal walk runs */
export interface ReplacementReversal {
  /** The toggle gating the walk: title conversion for inserted titles, forbidden-character replacement for link targets */
  enabled: boolean;
  /** Whether the dot's replacement is reversed too */
  reverseDot: boolean;
  /** Re-insert the spaces that `trimLeft`/`trimRight` removed */
  restoreTrimmedSpacing?: boolean;
  /** Receives the walk's debug lines */
  log?: (message: string) => void;
}

/**
 * Turn each enabled replacement in `text` back into its character: the one reversal behind inserted titles and link targets.
 * A replacement string shared by two enabled characters is left as it is, since nothing tells which character it stood for. The dot counts toward sharing even where it is not reversed, because the forward pass encodes it.
 * @param text - Text to reverse
 * @param settings - Plugin settings holding the replacements
 * @param reversal - Gate, dot handling, spacing and logging for this walk
 * @returns The text with every unambiguous replacement reversed
 */
export function reverseReplacements(
  text: string,
  settings: PluginSettings,
  reversal: ReplacementReversal
): string {
  if (!reversal.enabled) {
    return text;
  }

  const { charReplacements } = settings.characterReplacements;
  const enabledEntries = Object.entries(CHAR_TO_SETTING_KEY).filter(
    ([, settingKey]) =>
      charReplacements[settingKey].enabled &&
      charReplacements[settingKey].replacement !== ''
  );
  const usesByReplacement = new Map<string, number>();
  for (const [, settingKey] of enabledEntries) {
    const { replacement } = charReplacements[settingKey];
    usesByReplacement.set(
      replacement,
      (usesByReplacement.get(replacement) ?? 0) + 1
    );
  }

  reversal.log?.(
    `[CHAR-REVERSAL] "${text}" with replacements: [${enabledEntries
      .map(
        ([, settingKey]) =>
          `${settingKey}="${charReplacements[settingKey].replacement}"`
      )
      .join(', ')}]`
  );

  let result = text;
  for (const [originalChar, settingKey] of enabledEntries) {
    if (settingKey === 'dot' && !reversal.reverseDot) {
      continue;
    }
    const config = charReplacements[settingKey];
    const uses = usesByReplacement.get(config.replacement) ?? 0;
    if (uses > 1) {
      reversal.log?.(
        `[CHAR-REVERSAL] Skipping "${config.replacement}" → "${originalChar}" (shared by ${uses} characters)`
      );
      continue;
    }
    result = reversal.restoreTrimmedSpacing
      ? restoreWithTrimmedSpacing(
          result,
          config.replacement,
          originalChar,
          config.trimLeft,
          config.trimRight
        )
      : result.replaceAll(config.replacement, originalChar);
  }

  if (result !== text) {
    reversal.log?.(`[CHAR-REVERSAL] Result: "${text}" → "${result}"`);
  }

  return result;
}

/**
 * Reverses forbidden character replacements in text
 * Converts safe characters back to original forbidden characters
 */
export function reverseSafeLinkTarget(
  text: string,
  settings: PluginSettings
): string {
  return reverseReplacements(text, settings, {
    enabled: settings.characterReplacements.enableForbiddenCharReplacements,
    // `generateSafeLinkTarget` encodes a dot only where `processForbiddenChars` replaces one, so reversing `․` here would turn it into `.` in targets never encoded from a dot.
    reverseDot: false,
  });
}

/**
 * Reverse forbidden character replacements in a string, whenever the Character replacements master toggle is on. "Convert replacement characters" is not consulted here: it governs only the title inserted on note creation, so that caller checks it before calling.
 * @param text - The text to process
 * @param settings - Plugin settings containing character replacement configuration
 * @param log - Receives the reversal's debug lines
 * @param options.restoreTrimmedSpacing - Re-insert the spaces that `trimLeft`/`trimRight` removed. Opt-in because callers that echo a filename verbatim (the insert-filename command) must not gain spaces the filename never had.
 * @returns The text with replacements reversed to original characters
 */
export function reverseCharacterReplacements(
  text: string,
  settings: PluginSettings,
  log?: DebugLogger,
  options?: { restoreTrimmedSpacing?: boolean }
): string {
  return reverseReplacements(text, settings, {
    // With Character replacements off FLIT made no replacements, so there is nothing to reverse
    enabled: settings.characterReplacements.enableForbiddenCharReplacements,
    reverseDot: true,
    restoreTrimmedSpacing: options?.restoreTrimmedSpacing,
    log,
  });
}
