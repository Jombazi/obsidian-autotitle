import type { ExcludedProperty } from '../types';

/** An exclusion entry is a regular expression when wrapped in slashes and longer than two characters, so `//` stays plain text. */
export function isPatternEntry(trimmedEntry: string): boolean {
  return (
    trimmedEntry.length > 2 &&
    trimmedEntry.startsWith('/') &&
    trimmedEntry.endsWith('/')
  );
}

/**
 * Compiles a pattern entry to match anywhere, ignoring case.
 * @param trimmedEntry - Entry for which `isPatternEntry` holds
 * @returns The expression, or null when it does not compile, so the entry is skipped as Obsidian skips a broken Excluded files regex; this includes a pattern iOS before 16.4 cannot compile, such as one with lookbehind
 */
export function compilePatternEntry(trimmedEntry: string): RegExp | null {
  try {
    return new RegExp(trimmedEntry.slice(1, -1), 'i');
  } catch {
    return null;
  }
}

/** Duplicate key for an Excluded files entry or either side of an Excluded properties rule: plain text folds case because it matches ignoring case, while a pattern keeps its case because folding would merge `/\d/` with `/\D/`. */
export function exclusionEntryKey(entry: string): string {
  const trimmedEntry = entry.trim();
  return isPatternEntry(trimmedEntry)
    ? trimmedEntry
    : trimmedEntry.toLowerCase();
}

/** Duplicate key for an Excluded properties rule, both sides through `exclusionEntryKey`, or null for a rule with a blank name. */
export function excludedPropertyEntryKey(
  property: ExcludedProperty
): string | null {
  const normalizedKey = exclusionEntryKey(property.key);
  // A value without a key can never match: every consumer filters on a non-blank key, so keeping it would render a live-looking rule that does nothing
  if (normalizedKey === '') {
    return null;
  }
  // JSON encoding keeps "a:b"/"" distinct from "a"/"b", which a ":" join collapses
  return JSON.stringify([normalizedKey, exclusionEntryKey(property.value)]);
}
