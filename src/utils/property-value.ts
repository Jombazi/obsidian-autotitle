import { PluginSettings } from '../types';

/** Coerce a value typed into settings to the type its text spells, ignoring case and surrounding whitespace, as the rename-blocking property is written. */
export function parsePropertyValue(value: string): string | number | boolean {
  // Try to parse as boolean
  const lowerValue = value.toLowerCase().trim();
  if (lowerValue === 'true') return true;
  if (lowerValue === 'false') return false;

  // Try to parse as number
  if (!isNaN(Number(value)) && value.trim() !== '') {
    return Number(value);
  }

  // Return as string
  return value;
}

/**
 * Coerce a property value read from a note to the type its text spells, the read-side counterpart of `parsePropertyValue`.
 * Case-sensitive, unlike `parsePropertyValue`: readers that compare values fold case afterwards.
 * @param value - Value as read, of any type
 * @returns `true`, `false`, `null` or a number for a string spelling one, otherwise the value unchanged
 */
export function normalizePropertyValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value !== '' && !isNaN(Number(value))) {
    return Number(value);
  }
  return value;
}

/**
 * Adds or removes the disable-renaming property on a note's frontmatter.
 * Centralized so every caller (single-note commands, the bulk modal, and the
 * file context menu) writes the same coerced type - the key is registered as
 * a checkbox property, and writing the raw settings string there is
 * YAML-inconsistent even though read-side normalization still detects it.
 * @param renamingDisabled - True adds the property, turning renaming off for the note; false removes it
 */
export function setRenamingDisabledInFrontmatter(
  frontmatter: Record<string, unknown>,
  settings: PluginSettings,
  renamingDisabled: boolean
): void {
  const { disableRenamingKey, disableRenamingValue } = settings.exclusions;

  // Keys fold case like frontmatterHasDisableProperty, so a variant such as `No Rename` is removed rather than left beside a second key.
  const foldedDisableRenamingKey = disableRenamingKey.toLowerCase();
  for (const key of Object.keys(frontmatter)) {
    if (
      key !== disableRenamingKey &&
      key.toLowerCase() === foldedDisableRenamingKey
    ) {
      delete frontmatter[key];
    }
  }

  if (renamingDisabled) {
    frontmatter[disableRenamingKey] = parsePropertyValue(disableRenamingValue);
  } else {
    delete frontmatter[disableRenamingKey];
  }
}
