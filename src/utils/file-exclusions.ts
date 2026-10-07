import {
  TFile,
  TFolder,
  App,
  getFrontMatterInfo,
  normalizePath,
  parseYaml,
} from 'obsidian';
import {
  EXCLUSION_STRATEGY,
  ExclusionStrategy,
  PluginSettings,
} from '../types';
import { filterNonEmpty } from './string-processing';
import {
  fileHasTargetTags,
  normalizeTag,
  tagMatchesTargetTag,
} from './tag-utils';

/** Same metacharacter set as Obsidian's own escape for Excluded files entries. */
const REGEX_METACHARACTERS = /[.?*+^$[\]\\(){}|-]/g;

/** An Excluded files entry is a regular expression when wrapped in slashes and longer than two characters, so `//` stays a plain prefix. */
function isRegexFileEntry(trimmedEntry: string): boolean {
  return (
    trimmedEntry.length > 2 &&
    trimmedEntry.startsWith('/') &&
    trimmedEntry.endsWith('/')
  );
}

/** Mirrors Obsidian's own Excluded files: a regex entry matches anywhere in the path, any other entry is a path prefix, both ignoring case. */
export function compileExcludedFileFilters(entries: string[]): RegExp[] {
  const filters: RegExp[] = [];
  for (const entry of entries) {
    const trimmedEntry = entry.trim();
    if (trimmedEntry === '') continue;
    try {
      filters.push(
        isRegexFileEntry(trimmedEntry)
          ? new RegExp(trimmedEntry.slice(1, -1), 'i')
          : new RegExp(
              '^' + trimmedEntry.replace(REGEX_METACHARACTERS, '\\$&'),
              'i'
            )
      );
    } catch {
      // Obsidian skips an entry whose regex does not compile, so it neither excludes nor spares anything here either
    }
  }
  return filters;
}

/** Tested against the full vault path, as Obsidian tests its own Excluded files. */
export function isPathExcludedByFileRules(
  path: string,
  settings: PluginSettings
): boolean {
  const filters = compileExcludedFileFilters(settings.exclusions.excludedFiles);
  return shouldExcludeUnderStrategy(
    filters.some((filter) => filter.test(path)),
    filters.length > 0,
    settings.exclusions.fileScopeStrategy
  );
}

/** Duplicate key for an Excluded files entry: plain entries fold case because they match ignoring it, while regex entries keep it because folding would merge `/\d/` with `/\D/`. */
export function excludedFileEntryKey(entry: string): string {
  const trimmedEntry = entry.trim();
  return isRegexFileEntry(trimmedEntry)
    ? trimmedEntry
    : trimmedEntry.toLowerCase();
}

/** True when `entries` already holds `entry`, under the same duplicate rule as `normalizeExclusionLists`. */
export function hasExcludedFileEntry(
  entries: string[],
  entry: string
): boolean {
  const key = excludedFileEntryKey(entry);
  return entries.some((existing) => excludedFileEntryKey(existing) === key);
}

/** The entry Obsidian's own "Add exclusion" dialog writes for a picked folder; normalizePath also strips the slashes a user-typed folder setting may carry. */
export function folderExclusionEntry(folderPath: string): string {
  return normalizePath(folderPath) + '/';
}

/** The `hasTargets` half of the tag strategy: is any tag rule live? */
function hasTagTargets(settings: PluginSettings): boolean {
  return settings.exclusions.excludedTags.some((tag) => tag.trim() !== '');
}

/** Judged from the entries only, never from notes, because the context menu asks on every right-click; answers false wherever a regex or a partial entry makes the answer depend on individual notes. */
export function isFolderFullyExcludedByFileRules(
  folder: TFolder,
  settings: PluginSettings
): boolean {
  const entries = settings.exclusions.excludedFiles;
  // Every note path in the folder starts with this, and no other note path does
  const foldedPrefix = folder.isRoot() ? '' : `${folder.path}/`.toLowerCase();
  const trimmedEntries = filterNonEmpty(entries).map((entry) => entry.trim());
  const foldedPlainEntries = trimmedEntries
    .filter((entry) => !isRegexFileEntry(entry))
    .map((entry) => entry.toLowerCase());

  if (
    settings.exclusions.fileScopeStrategy === EXCLUSION_STRATEGY.ONLY_EXCLUDE
  ) {
    // A regex can match only some of the folder's notes, so only a plain entry covering the whole folder proves it
    return (
      foldedPrefix !== '' &&
      foldedPlainEntries.some((entry) => foldedPrefix.startsWith(entry))
    );
  }

  // "Exclude all except..." with no live entry spares nothing
  if (compileExcludedFileFilters(entries).length === 0) return true;
  if (trimmedEntries.some(isRegexFileEntry)) return false;
  // An entry that covers the folder spares all of it, and one inside it spares some
  return !foldedPlainEntries.some(
    (entry) => entry.startsWith(foldedPrefix) || foldedPrefix.startsWith(entry)
  );
}

/** Judged from the rules and the tag tree, never from notes, because the context menu asks on every right-click; answers false wherever the answer depends on individual notes, so a caller only hides an action it can prove empty. */
export function isTagFullyExcludedByTagRules(
  tagName: string,
  settings: PluginSettings,
  app: App
): boolean {
  const { tagScopeStrategy, tagMatchingMode, matchSubtags } =
    settings.exclusions;
  const hasTargets = hasTagTargets(settings);

  if (tagScopeStrategy !== EXCLUSION_STRATEGY.ONLY_EXCLUDE) {
    // "Exclude all except..." spares a note for any listed tag it carries, which only the note can tell; an empty list spares none
    return !hasTargets;
  }
  if (!hasTargets) return false;
  // A mode that reads one tag source spares notes carrying the tag only in the other source, which only the note can tell
  if (tagMatchingMode !== 'In Properties and note body') return false;

  const foldedTargetTags = filterNonEmpty(settings.exclusions.excludedTags).map(
    (tag) => normalizeTag(tag).toLowerCase()
  );
  const isCoveredByRule = (foldedTag: string): boolean =>
    foldedTargetTags.some((foldedTargetTag) =>
      tagMatchesTargetTag(foldedTag, foldedTargetTag, matchSubtags)
    );

  // getTags() counts a parent for every subtag, so the tree cannot show whether any note carries the tag itself; an uncovered tag keeps the action
  const foldedTag = normalizeTag(tagName).toLowerCase();
  if (!isCoveredByRule(foldedTag)) return false;
  // Under subtag matching a rule covering the tag covers every subtag too, so the tag tree is only consulted without it
  if (matchSubtags) return true;

  // getTags() walks every note's cache, which is why it is reached only when subtag matching is off and the tag itself is listed
  return Object.keys(app.metadataCache.getTags()).every((vaultTag) => {
    const foldedVaultTag = normalizeTag(vaultTag).toLowerCase();
    return (
      !foldedVaultTag.startsWith(`${foldedTag}/`) ||
      isCoveredByRule(foldedVaultTag)
    );
  });
}

/**
 * Resolve the frontmatter to evaluate exclusions and the rename-blocking property against.
 *
 * Fails closed: callers can hand over partial editor content (rename-engine passes only the
 * footnote text when a footnote definition is edited), so content without parseable
 * frontmatter falls back to the metadata cache rather than concluding "no properties" and
 * renaming a protected file. A genuinely empty new note has no cached frontmatter either,
 * so the creation path still sees the live content.
 */
export function resolveCurrentFrontmatter(
  file: TFile,
  app: App,
  content?: string
): Record<string, unknown> | null {
  if (content !== undefined) {
    const frontmatterInfo = getFrontMatterInfo(content);
    if (frontmatterInfo.exists) {
      try {
        const parsed = parseYaml(frontmatterInfo.frontmatter) as unknown;
        if (parsed && typeof parsed === 'object') {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed YAML - fall through to the cache
      }
    }
  }

  const cachedFrontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  return cachedFrontmatter ?? null;
}

/**
 * Check if file has any of the excluded properties
 * @param content Optional file content (string) for real-time checking
 */
export function fileHasExcludedProperties(
  file: TFile,
  settings: PluginSettings,
  app: App,
  content?: string
): boolean {
  const nonEmptyProperties = settings.exclusions.excludedProperties.filter(
    (prop) => prop.key.trim() !== ''
  );
  if (nonEmptyProperties.length === 0) return false;

  const frontmatter = resolveCurrentFrontmatter(file, app, content);
  if (!frontmatter) return false;

  // Property matching folds case, so resolve each configured key against the frontmatter's own casing
  const frontmatterKeysByFoldedCase = new Map<string, string>();
  for (const key of Object.keys(frontmatter)) {
    const foldedKey = key.toLowerCase();
    if (!frontmatterKeysByFoldedCase.has(foldedKey)) {
      frontmatterKeysByFoldedCase.set(foldedKey, key);
    }
  }

  for (const excludedProp of nonEmptyProperties) {
    const propKey = excludedProp.key.trim().toLowerCase();

    // A `tags` rule is written with or without the leading "#" interchangeably, so both
    // sides drop it. Without this, `{key: 'tags', value: 'foo'}` fails to match a note
    // tagged `#foo` and the exclusion silently fails open.
    const isTagsRule = propKey === 'tags';
    const foldValue = (value: unknown): string => {
      const folded = String(value).toLowerCase();
      return isTagsRule ? normalizeTag(folded) : folded;
    };

    const rawPropValue = excludedProp.value.trim().toLowerCase();

    const matchedKey = frontmatterKeysByFoldedCase.get(propKey);
    if (matchedKey !== undefined) {
      // A valueless rule matches the key alone, so this is tested before tag folding
      if (rawPropValue === '') {
        return true;
      }

      const propValue = isTagsRule ? normalizeTag(rawPropValue) : rawPropValue;
      const frontmatterValue: unknown = frontmatter[matchedKey];

      if (Array.isArray(frontmatterValue)) {
        if (frontmatterValue.some((val) => foldValue(val) === propValue)) {
          return true;
        }
      } else if (frontmatterValue != null) {
        if (foldValue(frontmatterValue) === propValue) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Applies one exclusion strategy to one detector's verdict.
 * Returns TRUE if the file should be EXCLUDED (don't process).
 *
 * - "Only exclude...": exclude what the list matches. An empty list excludes nothing.
 * - "Exclude all except...": exclude what the list does NOT match. An empty list excludes
 *   everything — there is no listed target to spare.
 *
 * Shared by every exclusion type so the inversion and the empty-list behaviour cannot drift
 * between sections. `hasTargets` must be computed with the same
 * filter its own detector applies: if it counts rules the detector ignores, "Exclude all
 * except..." excludes every file while no rule can ever match one.
 */
function shouldExcludeUnderStrategy(
  isTargeted: boolean,
  hasTargets: boolean,
  strategy: ExclusionStrategy
): boolean {
  if (strategy === EXCLUSION_STRATEGY.ONLY_EXCLUDE) {
    return hasTargets ? isTargeted : false;
  }
  return hasTargets ? !isTargeted : true;
}

/**
 * Determines whether a file should be processed based on the include/exclude strategy
 *
 * Logic summary:
 * - "Only exclude...": Process all files EXCEPT those matched by path, tag or property rules
 *   - If no targets specified: Process ALL files (default enabled)
 *   - If targets specified: Process files NOT in targets (traditional exclude)
 *
 * - "Exclude all except...": Process ONLY files matched by path, tag or property rules
 *   - If no targets specified: Process NO files (default disabled)
 *   - If targets specified: Process ONLY files in targets (include-only mode)
 *
 * @param file The file to check
 * @param settings Plugin settings containing each list's strategy and its excluded files, tags and properties
 * @param app The Obsidian app instance
 * @param content Optional file content (string) for real-time checking
 * @param exclusionOverrides Optional overrides to skip path/tag/property checks
 * @returns true if the file should be processed, false otherwise
 */
export function shouldProcessFile(
  file: TFile,
  settings: PluginSettings,
  app: App,
  content?: string,
  exclusionOverrides?: {
    ignoreFiles?: boolean;
    ignoreTag?: boolean;
    ignoreProperty?: boolean;
  },
  plugin?: { settings: PluginSettings }
): boolean {
  // Apply strategy for each exclusion type independently, respecting overrides.
  // Each detector is called inside its branch, not hoisted: the single-note command passes all three overrides, and the tag and property detectors walk the metadata cache.
  const shouldExcludeFromFiles = exclusionOverrides?.ignoreFiles
    ? false
    : isPathExcludedByFileRules(file.path, settings);

  const shouldExcludeFromTags = exclusionOverrides?.ignoreTag
    ? false
    : shouldExcludeUnderStrategy(
        fileHasTargetTags(file, settings, app, content),
        hasTagTargets(settings),
        settings.exclusions.tagScopeStrategy
      );

  const shouldExcludeFromProperties = exclusionOverrides?.ignoreProperty
    ? false
    : shouldExcludeUnderStrategy(
        fileHasExcludedProperties(file, settings, app, content),
        settings.exclusions.excludedProperties.some(
          (prop) => prop.key.trim() !== ''
        ),
        settings.exclusions.propertyScopeStrategy
      );

  // Log exclusion reasons if verbose logging enabled
  if (plugin?.settings.core.debug) {
    const reasons: string[] = [];
    if (shouldExcludeFromFiles)
      reasons.push(`files (${settings.exclusions.fileScopeStrategy})`);
    if (shouldExcludeFromTags)
      reasons.push(`tags (${settings.exclusions.tagScopeStrategy})`);
    if (shouldExcludeFromProperties)
      reasons.push(`properties (${settings.exclusions.propertyScopeStrategy})`);

    if (reasons.length > 0) {
      console.debug(`File excluded by ${reasons.join(', ')}: ${file.path}`);
    }
  }

  // A file should be processed if it doesn't meet the exclusion criteria for ANY exclusion type
  // OR logic: if ANY exclusion type says "exclude" (returns true), then we exclude
  return !(
    shouldExcludeFromFiles ||
    shouldExcludeFromTags ||
    shouldExcludeFromProperties
  );
}
