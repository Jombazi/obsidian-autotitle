import { TFile, App } from 'obsidian';
import { PluginSettings } from '../types';
import { resolveCurrentFrontmatter } from './file-exclusions';
import { normalizePropertyValue } from './property-value';
import { isFileOpenInAnyEditor } from './editor-checks';

/** Why `canModifyFile` refused a note */
export type ModifyRefusalReason = 'disable-property' | 'not-open-in-editor';

/** `canModifyFile`'s verdict */
export type ModifyVerdict =
  { canModify: true } | { canModify: false; reason: ModifyRefusalReason };

/** How `canModifyFile` was reached */
export interface ModifyCheckOptions {
  /** True for manual commands, which only the rename-blocking property stops */
  isManualCommand: boolean;
  /** Whether an editor shows the note, as the editor-change event reports it; undefined looks for one */
  hasActiveEditor?: boolean;
  /** Note text to read the rename-blocking property from, ahead of the cache */
  content?: string;
}

/**
 * Central gate for file modification eligibility: the rename-blocking property, then, for automatic operations, an open editor.
 * @param file - Note to check
 * @param app - Obsidian App instance
 * @param settings - Plugin settings holding the rename-blocking property's key and value
 * @param options - How the check was reached, and the text to read
 */
export function canModifyFile(
  file: TFile,
  app: App,
  settings: PluginSettings,
  options: ModifyCheckOptions
): ModifyVerdict {
  const { disableRenamingKey, disableRenamingValue } = settings.exclusions;
  // Check 1: the rename-blocking property blocks every operation, manual commands included
  // Content first: the editor is ahead of the cache by up to Obsidian's autosave delay. The cache decides when content is absent or has no parseable frontmatter.
  const frontmatter = resolveCurrentFrontmatter(file, app, options.content);
  if (
    frontmatter &&
    frontmatterHasDisableProperty(
      frontmatter,
      disableRenamingKey,
      disableRenamingValue
    )
  ) {
    return { canModify: false, reason: 'disable-property' };
  }

  // Check 2: automatic operations need the note open in an editor, so external and programmatic edits are not processed
  // Manual commands bypass this check
  if (!options.isManualCommand) {
    // A reported editor is trusted, a page preview's or Canvas card's included; without a report the leaves and embeds are searched
    const isOpenInEditor =
      options.hasActiveEditor ?? isFileOpenInAnyEditor(file, app);
    if (!isOpenInEditor) {
      return { canModify: false, reason: 'not-open-in-editor' };
    }
  }

  return { canModify: true };
}

/** True when the metadata cache holds the rename-blocking property for `file`. */
export function hasDisablePropertyInFile(
  file: TFile,
  app: App,
  settings: PluginSettings
): boolean {
  try {
    // Use Obsidian's metadata cache to read frontmatter (already parsed YAML)
    const metadata = app.metadataCache.getFileCache(file);
    const frontmatter = metadata?.frontmatter;

    if (!frontmatter) return false;

    return frontmatterHasDisableProperty(
      frontmatter,
      settings.exclusions.disableRenamingKey,
      settings.exclusions.disableRenamingValue
    );
  } catch {
    return false;
  }
}

/** Folds a property value for the disable-property comparison: number-like strings normalize first, so `"01"` meets `1`, then case folds, so `"True"` meets `true`. */
function foldDisablePropertyValue(value: unknown): string {
  return String(normalizePropertyValue(value)).toLowerCase();
}

/** The one disable-property matcher behind the rename engine, the file menu and the command palette, so the three cannot disagree about a note. */
export function frontmatterHasDisableProperty(
  frontmatter: Record<string, unknown>,
  disableKey: string,
  disableValue: string
): boolean {
  const foldedDisableKey = disableKey.toLowerCase();
  const foldedDisableValue = foldDisablePropertyValue(disableValue);

  // An empty property never matches, not even a configured value of `null`.
  const matchesDisableValue = (value: unknown): boolean =>
    value !== null &&
    value !== undefined &&
    foldDisablePropertyValue(value) === foldedDisableValue;

  // Every case variant of the key counts, so the verdict never depends on which variant comes first in the properties.
  return Object.entries(frontmatter).some(
    ([key, value]) =>
      key.toLowerCase() === foldedDisableKey &&
      (Array.isArray(value)
        ? value.some(matchesDisableValue)
        : matchesDisableValue(value))
  );
}

/** True when no case variant of the disable key is left or every one is exactly `false`, so a half-typed value such as `tru` never counts as switched off. */
export function disablePropertyIsOff(
  frontmatter: Record<string, unknown> | undefined,
  disableKey: string
): boolean {
  if (!frontmatter) return true;
  const foldedDisableKey = disableKey.toLowerCase();
  return Object.entries(frontmatter).every(
    ([key, value]) => key.toLowerCase() !== foldedDisableKey || value === false
  );
}
