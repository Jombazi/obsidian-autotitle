import { PluginSettings } from '../types';
import {
  excludedPropertyEntryKey,
  exclusionEntryKey,
} from './exclusion-pattern';
import { excludedTagEntryKey, isBlankTagEntry } from './tag-utils';

/**
 * Drop blank entries and keep only the last of each duplicate.
 * @param entries - List to deduplicate
 * @param duplicateKey - Match key for an entry, or null for a blank entry, which is dropped
 * @returns The kept entries, in their original order
 */
function dedupeKeepingLast<Entry>(
  entries: Entry[],
  duplicateKey: (entry: Entry) => string | null
): Entry[] {
  const lastIndexByKey = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = duplicateKey(entry);
    if (key !== null) {
      lastIndexByKey.set(key, index);
    }
  });
  const keptIndices = new Set(lastIndexByKey.values());
  return entries.filter((_, index) => keptIndices.has(index));
}

/**
 * Normalizes the exclusion lists in plugin settings: drops blank entries, trims
 * entry text (preserving case), and deduplicates excluded files, tags and properties
 * Keeps the last occurrence of each duplicate (removes earlier ones)
 * Normalization rules:
 * - Excluded files: trimmed; paths case-insensitive, regular expressions exact
 * - Tags: case-insensitive, with or without the leading "#"; regular expressions exact
 * - Properties: both key and value must match (case-insensitive; regular expressions exact)
 *
 * @param settings - Plugin settings object to normalize
 * @returns true if any entries were removed or cleaned, false otherwise
 */
export function normalizeExclusionLists(settings: PluginSettings): boolean {
  const { exclusions } = settings;
  let hasChanges = false;
  const trimTracked = (text: string): string => {
    const trimmed = text.trim();
    if (trimmed !== text) {
      hasChanges = true;
    }
    return trimmed;
  };

  const excludedFiles = dedupeKeepingLast(exclusions.excludedFiles, (entry) => {
    const key = exclusionEntryKey(entry);
    return key === '' ? null : key;
  });
  // A bare "#" names no tag, so it drops out with the blank entries
  const excludedTags = dedupeKeepingLast(exclusions.excludedTags, (tag) =>
    isBlankTagEntry(tag) ? null : excludedTagEntryKey(tag)
  );
  const excludedProperties = dedupeKeepingLast(
    exclusions.excludedProperties,
    excludedPropertyEntryKey
  );

  if (
    excludedFiles.length !== exclusions.excludedFiles.length ||
    excludedTags.length !== exclusions.excludedTags.length ||
    excludedProperties.length !== exclusions.excludedProperties.length
  ) {
    hasChanges = true;
  }

  exclusions.excludedFiles = excludedFiles.map(trimTracked);
  exclusions.excludedTags = excludedTags.map(trimTracked);
  exclusions.excludedProperties = excludedProperties.map((prop) => ({
    key: trimTracked(prop.key),
    value: trimTracked(prop.value),
  }));

  return hasChanges;
}
