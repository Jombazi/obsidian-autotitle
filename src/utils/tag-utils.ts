import { isPatternEntry } from './exclusion-pattern';

/**
 * Normalize tag by removing leading # if present
 * Ensures consistent tag comparison throughout the codebase
 */
export function normalizeTag(tag: string): string {
  return tag.startsWith('#') ? tag.slice(1) : tag;
}

/** Match key for a tag from a note, the tag pane or the editor, never read as a pattern: `project`, `#project` and `#Project` are one tag, since rules match ignoring the "#" and case. Always "#"-prefixed, so it can never equal a pattern entry's key, which starts with "/": Obsidian accepts a tag written `#/x/`. */
export function tagKey(tag: string): string {
  return '#' + normalizeTag(tag.trim()).toLowerCase();
}

/** Duplicate and membership key for an Excluded tags entry: a pattern keeps its text as typed, because folding case would merge `/\d/` with `/\D/`; any other entry folds as a tag through `tagKey`. */
export function excludedTagEntryKey(entry: string): string {
  const trimmedEntry = entry.trim();
  return isPatternEntry(trimmedEntry) ? trimmedEntry : tagKey(trimmedEntry);
}

/** A blank Excluded tags entry, a bare "#" included, names no tag and never counts. */
export function isBlankTagEntry(entry: string): boolean {
  return normalizeTag(entry.trim()) === '';
}

/** True when `entries` already holds `tag` as a plain entry; a pattern entry never counts, since the tag menus ignore patterns. */
export function hasExcludedTagEntry(entries: string[], tag: string): boolean {
  const key = tagKey(tag);
  return entries.some((existing) => excludedTagEntryKey(existing) === key);
}

/** The Excluded tags dialog's duplicate test: true when `entries` already holds an entry with `entry`'s key; unlike `hasExcludedTagEntry`, a pattern counts. */
export function hasDuplicateTagEntry(
  entries: string[],
  entry: string
): boolean {
  const key = excludedTagEntryKey(entry);
  return entries.some((existing) => excludedTagEntryKey(existing) === key);
}

/** One tag-rule match, shared by the rename run, the tag context menu and the tag rename dialog so they cannot disagree; both sides must arrive folded through `tagKey`. */
export function tagMatchesTargetTag(
  foldedTag: string,
  foldedTargetTag: string,
  matchSubtags: boolean
): boolean {
  return (
    foldedTag === foldedTargetTag ||
    (matchSubtags && foldedTag.startsWith(foldedTargetTag + '/'))
  );
}
