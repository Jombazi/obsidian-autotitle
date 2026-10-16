import { PluginSettings } from '../types';

/**
 * Splits the comma-separated first line property names into trimmed, non-empty keys.
 *
 * A blank setting yields an empty array rather than falling back to `aliases`: the field is stored exactly as typed, so blank means the user asked for no first line property at all.
 */
export function parseFirstLinePropertyKeys(propertyKey: string): string[] {
  return propertyKey
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

/** True when the property name field holds at least one name, which is what turns the first line property on. */
export function hasFirstLinePropertyName(
  settings: Pick<PluginSettings, 'firstLineProperty'>
): boolean {
  return (
    parseFirstLinePropertyKeys(settings.firstLineProperty.propertyKey).length >
    0
  );
}
