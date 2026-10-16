import {
  TFile,
  TFolder,
  App,
  CachedMetadata,
  getFrontMatterInfo,
  normalizePath,
  parseFrontMatterTags,
  parseYaml,
} from 'obsidian';
import {
  DebugLogger,
  EXCLUSION_STRATEGY,
  ExcludedProperty,
  ExclusionList,
  ExclusionOverrides,
  ExclusionStrategy,
  PluginSettings,
} from '../types';
import { filterNonEmpty } from './string-processing';
import {
  isBlankTagEntry,
  normalizeTag,
  tagKey,
  tagMatchesTargetTag,
} from './tag-utils';
import {
  compilePatternEntry,
  exclusionEntryKey,
  isPatternEntry,
} from './exclusion-pattern';
// The one import from the tokenizer, which imports nothing back, so no cycle forms
import { inlineTags } from './inline-markup';

/** Same metacharacter set as Obsidian's own escape for Excluded files entries. */
const REGEX_METACHARACTERS = /[.?*+^$[\]\\(){}|-]/g;

/** Escape `text` to match itself literally inside a regular expression; not for `u`-flag patterns, which reject the escaped `-`. */
export function escapeRegExp(text: string): string {
  return text.replace(REGEX_METACHARACTERS, '\\$&');
}

/**
 * Remember the last result of `derive`, keyed on its input's content because settings arrays are changed in place, so every note an exclusion check reads, twice per note in the bulk dialog's preview and run, no longer rebuilds the same rules.
 * @param derive - Pure function of a settings list
 * @returns `derive`, recomputed only when the list's content changes
 */
function memoizeByContent<Input, Output>(
  derive: (input: Input) => Output
): (input: Input) => Output {
  let last: { key: string; output: Output } | undefined;
  return (input) => {
    const key = JSON.stringify(input);
    if (last?.key !== key) {
      last = { key, output: derive(input) };
    }
    return last.output;
  };
}

const compileExcludedFileFiltersOnce = memoizeByContent(
  (entries: string[]): readonly RegExp[] => {
    const filters: RegExp[] = [];
    for (const entry of entries) {
      const trimmedEntry = entry.trim();
      if (trimmedEntry === '') continue;
      if (isPatternEntry(trimmedEntry)) {
        const filter = compilePatternEntry(trimmedEntry);
        // Obsidian skips an entry whose regex does not compile, so it neither excludes nor spares anything here either
        if (filter) filters.push(filter);
      } else {
        filters.push(new RegExp('^' + escapeRegExp(trimmedEntry), 'i'));
      }
    }
    return filters;
  }
);

/** Mirrors Obsidian's own Excluded files: a regex entry matches anywhere in the path, any other entry is a path prefix, both ignoring case. */
export function compileExcludedFileFilters(
  entries: string[]
): readonly RegExp[] {
  return compileExcludedFileFiltersOnce(entries);
}

/** Excluded tags entries split by kind for matching */
interface TagRules {
  /** Plain entries as `tagKey` match keys */
  plainKeys: string[];
  /** Pattern entries, compiled */
  patterns: RegExp[];
}

/** Excluded tags entries compiled for matching, blank entries and patterns that do not compile dropped, so `hasTagTargets` counts exactly what `fileHasTargetTags` reads */
const compileTagRules = memoizeByContent((entries: string[]): TagRules => {
  const rules: TagRules = { plainKeys: [], patterns: [] };
  for (const entry of entries) {
    if (isBlankTagEntry(entry)) continue;
    const trimmedEntry = entry.trim();
    if (!isPatternEntry(trimmedEntry)) {
      rules.plainKeys.push(tagKey(trimmedEntry));
      continue;
    }
    const pattern = compilePatternEntry(trimmedEntry);
    if (pattern) rules.patterns.push(pattern);
  }
  return rules;
});

/** A tag name followed by each of its ancestors, longest first: `a/b/c` gives `a/b/c`, `a/b`, `a`. */
function tagAndAncestors(tagName: string): string[] {
  const names = [tagName];
  for (
    let end = tagName.lastIndexOf('/');
    end > 0;
    end = tagName.lastIndexOf('/', end - 1)
  ) {
    names.push(tagName.slice(0, end));
  }
  return names;
}

/** An Excluded properties rule folded for matching */
interface FoldedPropertyRule {
  /** Key, trimmed and case-folded; unused when `keyPattern` is set */
  key: string;
  /** The key written as a pattern, tested against each frontmatter key as written */
  keyPattern: RegExp | null;
  /** True for a plain `tags` key, whose value is stored without its "#" */
  isTagsRule: boolean;
  /** True when the rule names a key alone, which matches whatever value it holds */
  isKeyOnly: boolean;
  /** Value, trimmed, case-folded and, for a `tags` rule, without its "#"; unused when `valuePattern` is set */
  value: string;
  /** The value written as a pattern, tested against each folded note value */
  valuePattern: RegExp | null;
}

/** Excluded properties rules folded for matching, keyless rules and rules with a side that does not compile dropped */
const foldPropertyRules = memoizeByContent(
  (rules: ExcludedProperty[]): FoldedPropertyRule[] =>
    rules.flatMap((rule): FoldedPropertyRule[] => {
      const trimmedKey = rule.key.trim();
      if (trimmedKey === '') return [];
      const trimmedValue = rule.value.trim();
      const keyPattern = isPatternEntry(trimmedKey)
        ? compilePatternEntry(trimmedKey)
        : null;
      const valuePattern = isPatternEntry(trimmedValue)
        ? compilePatternEntry(trimmedValue)
        : null;
      // A side that does not compile could match nothing, so the whole rule goes, as a broken Excluded files regex does
      if (isPatternEntry(trimmedKey) && !keyPattern) return [];
      if (isPatternEntry(trimmedValue) && !valuePattern) return [];

      const key = trimmedKey.toLowerCase();
      const isTagsRule = !keyPattern && key === 'tags';
      const rawValue = trimmedValue.toLowerCase();
      return [
        {
          key,
          keyPattern,
          isTagsRule,
          isKeyOnly: rawValue === '',
          value: isTagsRule ? normalizeTag(rawValue) : rawValue,
          valuePattern,
        },
      ];
    })
);

/** The `hasTargets` half of the property strategy: is any property rule live? */
export function hasPropertyTargets(settings: PluginSettings): boolean {
  return foldPropertyRules(settings.exclusions.excludedProperties).length > 0;
}

/** True when a live Excluded properties rule names `key`, by its plain name ignoring case or by a name pattern, whatever value it asks for. */
export function isListedPropertyKey(
  key: string,
  settings: PluginSettings
): boolean {
  const foldedKey = key.toLowerCase();
  return foldPropertyRules(settings.exclusions.excludedProperties).some(
    (rule) =>
      rule.keyPattern ? rule.keyPattern.test(key) : rule.key === foldedKey
  );
}

/** Supplies the frontmatter the tag and property detectors read, resolved on first need */
type FrontmatterResolver = () => Record<string, unknown> | null;

/**
 * One frontmatter resolution shared by the tag and property detectors, run only when one of them needs it, so a check with no live tag or property rule parses nothing and one with both parses once.
 * @param file - Note being checked
 * @param app - Obsidian App instance
 * @param content - Note text to read the properties from, ahead of the cache
 */
function memoizedFrontmatterResolver(
  file: TFile,
  app: App,
  content?: string
): FrontmatterResolver {
  let resolved: { frontmatter: Record<string, unknown> | null } | undefined;
  return () => {
    resolved ??= {
      frontmatter: resolveCurrentFrontmatter(file, app, content),
    };
    return resolved.frontmatter;
  };
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

/** True when `entries` already holds `entry`, under the same duplicate rule as `normalizeExclusionLists`. */
export function hasExcludedFileEntry(
  entries: string[],
  entry: string
): boolean {
  const key = exclusionEntryKey(entry);
  return entries.some((existing) => exclusionEntryKey(existing) === key);
}

/** A plain Excluded files entry without its leading slashes, because vault paths never start with one: `/Templates` would match nothing, and a lone `/` would exclude every note under "Exclude all except listed"; a pattern keeps its slashes. */
export function stripExcludedFileLeadingSlashes(trimmedEntry: string): string {
  return isPatternEntry(trimmedEntry)
    ? trimmedEntry
    : trimmedEntry.replace(/^\/+/, '').trimStart();
}

/** The entry Obsidian's own "Add exclusion" dialog writes for a picked folder; normalizePath also strips the slashes a user-typed folder setting may carry. */
export function folderExclusionEntry(folderPath: string): string {
  return normalizePath(folderPath) + '/';
}

/** The `hasTargets` half of the tag strategy: is any tag rule live? */
export function hasTagTargets(settings: PluginSettings): boolean {
  const { plainKeys, patterns } = compileTagRules(
    settings.exclusions.excludedTags
  );
  return plainKeys.length > 0 || patterns.length > 0;
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
    .filter((entry) => !isPatternEntry(entry))
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
  if (trimmedEntries.some(isPatternEntry)) return false;
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

  // Plain entries only: the tag menus ignore patterns, so a tag only a pattern covers keeps its action, the conservative answer
  const { plainKeys } = compileTagRules(settings.exclusions.excludedTags);
  const isCoveredByRule = (foldedTag: string): boolean =>
    plainKeys.some((foldedTargetTag) =>
      tagMatchesTargetTag(foldedTag, foldedTargetTag, matchSubtags)
    );

  // getTags() counts a parent for every subtag, so the tree cannot show whether any note carries the tag itself; an uncovered tag keeps the action
  const foldedTag = tagKey(tagName);
  if (!isCoveredByRule(foldedTag)) return false;
  // Under subtag matching a rule covering the tag covers every subtag too, so the tag tree is only consulted without it
  if (matchSubtags) return true;

  // getTags() walks every note's cache, which is why it is reached only when subtag matching is off and the tag itself is listed
  return Object.keys(app.metadataCache.getTags()).every((vaultTag) => {
    const foldedVaultTag = tagKey(vaultTag);
    return (
      !foldedVaultTag.startsWith(`${foldedTag}/`) ||
      isCoveredByRule(foldedVaultTag)
    );
  });
}

/**
 * Resolve the frontmatter to evaluate exclusions and the rename-blocking property against.
 *
 * Fails closed: content without parseable frontmatter (a properties block mid-edit, or text
 * from an editor that holds less than the whole note) falls back to the metadata cache rather
 * than concluding "no properties" and renaming a protected file. A genuinely empty new note
 * has no cached frontmatter either, so the creation path still sees the live content.
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

/** Where an exclusion check reads a note's properties from, when not the metadata cache alone. */
export interface FrontmatterSourceOptions {
  /** Note text for real-time checking, ahead of the metadata cache */
  content?: string;
  /** Shared resolution of the frontmatter, used instead of resolving it from `content` */
  resolveFrontmatter?: FrontmatterResolver;
}

/**
 * Check if file has any of the excluded properties
 * @param options Where the properties are read from; the metadata cache when omitted
 */
export function fileHasExcludedProperties(
  file: TFile,
  settings: PluginSettings,
  app: App,
  options: FrontmatterSourceOptions = {}
): boolean {
  const { content, resolveFrontmatter } = options;
  const propertyRules = foldPropertyRules(
    settings.exclusions.excludedProperties
  );
  if (propertyRules.length === 0) return false;

  const frontmatter = resolveFrontmatter
    ? resolveFrontmatter()
    : resolveCurrentFrontmatter(file, app, content);
  if (!frontmatter) return false;

  // Property matching folds case, so resolve each configured key against the frontmatter's own casing
  const frontmatterKeys = Object.keys(frontmatter);
  const frontmatterKeysByFoldedCase = new Map<string, string>();
  for (const key of frontmatterKeys) {
    const foldedKey = key.toLowerCase();
    if (!frontmatterKeysByFoldedCase.has(foldedKey)) {
      frontmatterKeysByFoldedCase.set(foldedKey, key);
    }
  }

  for (const propertyRule of propertyRules) {
    const { keyPattern } = propertyRule;
    let matchedKeys: string[];
    if (keyPattern) {
      matchedKeys = frontmatterKeys.filter((key) => keyPattern.test(key));
    } else {
      const matchedKey = frontmatterKeysByFoldedCase.get(propertyRule.key);
      matchedKeys = matchedKey === undefined ? [] : [matchedKey];
    }

    for (const matchedKey of matchedKeys) {
      // A valueless rule matches the key alone, so this is tested on the value before tag folding
      if (propertyRule.isKeyOnly) {
        return true;
      }
      if (
        frontmatterValueMatchesRule(
          frontmatter[matchedKey],
          matchedKey,
          propertyRule
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Does a frontmatter value, or any item of a list value, match the rule's value?
 * @param frontmatterValue - Value the note holds under `matchedKey`
 * @param matchedKey - Frontmatter key as written in the note
 * @param propertyRule - Rule with a value, plain or pattern
 */
function frontmatterValueMatchesRule(
  frontmatterValue: unknown,
  matchedKey: string,
  propertyRule: FoldedPropertyRule
): boolean {
  // `tags` values are written with or without the leading "#" interchangeably, so both sides drop it whichever way the rule names the key; without this, `{key: 'tags', value: 'foo'}` fails to match a note tagged `#foo` and the exclusion silently fails open
  const isTagsKey = matchedKey.toLowerCase() === 'tags';
  const foldValue = (value: unknown): string => {
    const folded = String(value).toLowerCase();
    return isTagsKey ? normalizeTag(folded) : folded;
  };
  // A plain `tags` rule already stores its value without the "#"; a key pattern reaching `tags` drops it here
  const ruleValue =
    isTagsKey && !propertyRule.isTagsRule
      ? normalizeTag(propertyRule.value)
      : propertyRule.value;
  const { valuePattern } = propertyRule;
  const matchesValue = (value: unknown): boolean =>
    valuePattern
      ? valuePattern.test(foldValue(value))
      : foldValue(value) === ruleValue;

  if (Array.isArray(frontmatterValue)) {
    return frontmatterValue.some(matchesValue);
  }
  return frontmatterValue != null && matchesValue(frontmatterValue);
}

/** What `fileHasTargetTags` reads beside the settings and the file's cache */
export interface TargetTagCheckOptions extends FrontmatterSourceOptions {
  /** The title source's text as it stands, whose tags count before Obsidian indexes them */
  titleLine?: string;
  /** Parsed metadata of the text being judged, read instead of the file's cache for body tags and, unless `resolveFrontmatter` is given, property tags */
  metadata?: CachedMetadata;
}

/**
 * Check if file has any of the target tags
 * Supports frontmatter and inline tags based on settings
 * @param file The file to check
 * @param settings Plugin settings containing tag list and strategy
 * @param app The Obsidian app instance
 * @param options The note text, a shared frontmatter resolution, the title line and parsed metadata, each read ahead of the file's cache
 * @returns true if file has any of the target tags
 */
export function fileHasTargetTags(
  file: TFile,
  settings: PluginSettings,
  app: App,
  options: TargetTagCheckOptions = {}
): boolean {
  const { content, resolveFrontmatter, titleLine, metadata } = options;
  const { plainKeys, patterns } = compileTagRules(
    settings.exclusions.excludedTags
  );
  if (plainKeys.length === 0 && patterns.length === 0) return false;

  const { tagMatchingMode, matchSubtags } = settings.exclusions;
  const isTargetTag = (fileTag: string): boolean => {
    const fileTagKey = tagKey(fileTag);
    if (
      plainKeys.some((targetTagKey) =>
        tagMatchesTargetTag(fileTagKey, targetTagKey, matchSubtags)
      )
    ) {
      return true;
    }
    if (patterns.length === 0) return false;
    // Patterns are tested against the tag without its "#", and under Match subtags against each ancestor too, so `/^draft$/` covers `#draft/2024` as a plain `draft` entry does
    const tagName = normalizeTag(fileTag.trim());
    const candidateNames = matchSubtags ? tagAndAncestors(tagName) : [tagName];
    return patterns.some((pattern) =>
      candidateNames.some((name) => pattern.test(name))
    );
  };

  // Given metadata stands in for the file's cache, so a text the cache has not indexed yet is judged on its own tags
  const resolveTagFrontmatter: FrontmatterResolver =
    resolveFrontmatter ??
    (metadata
      ? () => metadata.frontmatter ?? null
      : () => resolveCurrentFrontmatter(file, app, content));

  if (tagMatchingMode !== 'In note body only') {
    // Read as Obsidian reads them: any case of the `tags` key, strings only, so a number is no tag
    const frontmatterTags = parseFrontMatterTags(resolveTagFrontmatter()) ?? [];
    if (frontmatterTags.some(isTargetTag)) return true;
  }

  if (tagMatchingMode !== 'In Properties only') {
    // Obsidian's own parse (the given metadata, or the cache), not the content, so tag-like text in code blocks is not read as a tag; its `tags` holds body tags only, never frontmatter ones
    const bodyTags =
      (metadata ?? app.metadataCache.getFileCache(file))?.tags ?? [];
    if (bodyTags.some((tagCache) => isTargetTag(tagCache.tag))) return true;
    // The cache trails typing by a re-index, so a tag just typed into the title line would rename the note on every keystroke until then
    if (titleLine !== undefined && inlineTags(titleLine).some(isTargetTag)) {
      return true;
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

/** What `shouldProcessFile` and `findExcludingList` read beside the settings, and where they report */
interface ExclusionCheckOptions {
  /** Note text for real-time checking, ahead of the metadata cache */
  content?: string;
  /** Exclusion lists to skip */
  exclusionOverrides?: ExclusionOverrides;
  /** Receives the exclusion reasons */
  log?: DebugLogger;
  /** The title source's text as it stands, for tags typed into it that Obsidian has not indexed yet; none for code, which holds no tags */
  titleLine?: string;
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
 * @param options The note text, exclusion lists to skip, the logger and the title line
 * @returns true if the file should be processed, false otherwise
 */
export function shouldProcessFile(
  file: TFile,
  settings: PluginSettings,
  app: App,
  options: ExclusionCheckOptions = {}
): boolean {
  return findExcludingList(file, settings, app, options) === null;
}

/**
 * The exclusion list that keeps `file` from being processed, under the same verdicts as `shouldProcessFile`.
 * @param file The file to check
 * @param settings Plugin settings containing each list's strategy and its excluded files, tags and properties
 * @param app The Obsidian app instance
 * @param options The note text, exclusion lists to skip, the logger and the title line
 * @returns The first excluding list in path, tag, property order, or null when the file should be processed
 */
export function findExcludingList(
  file: TFile,
  settings: PluginSettings,
  app: App,
  options: ExclusionCheckOptions = {}
): ExclusionList | null {
  const { content, exclusionOverrides, log, titleLine } = options;
  // Apply strategy for each exclusion type independently, respecting overrides.
  // Each detector is called inside its branch, not hoisted: the single-note command passes all three overrides, and the tag and property detectors walk the metadata cache.
  const resolveFrontmatter = memoizedFrontmatterResolver(file, app, content);
  const shouldExcludeFromFiles = exclusionOverrides?.ignoreExcludedFiles
    ? false
    : isPathExcludedByFileRules(file.path, settings);

  const shouldExcludeFromTags = exclusionOverrides?.ignoreExcludedTags
    ? false
    : shouldExcludeUnderStrategy(
        fileHasTargetTags(file, settings, app, {
          content,
          resolveFrontmatter,
          titleLine,
        }),
        hasTagTargets(settings),
        settings.exclusions.tagScopeStrategy
      );

  const shouldExcludeFromProperties =
    exclusionOverrides?.ignoreExcludedProperties
      ? false
      : shouldExcludeUnderStrategy(
          fileHasExcludedProperties(file, settings, app, {
            content,
            resolveFrontmatter,
          }),
          hasPropertyTargets(settings),
          settings.exclusions.propertyScopeStrategy
        );

  if (log) {
    const reasons: string[] = [];
    if (shouldExcludeFromFiles)
      reasons.push(`files (${settings.exclusions.fileScopeStrategy})`);
    if (shouldExcludeFromTags)
      reasons.push(`tags (${settings.exclusions.tagScopeStrategy})`);
    if (shouldExcludeFromProperties)
      reasons.push(`properties (${settings.exclusions.propertyScopeStrategy})`);

    if (reasons.length > 0) {
      log(`File excluded by ${reasons.join(', ')}: ${file.path}`);
    }
  }

  // A file is excluded when ANY list excludes it; when several do, the manual command's notice names the first in this order
  if (shouldExcludeFromFiles) return 'files';
  if (shouldExcludeFromTags) return 'tags';
  if (shouldExcludeFromProperties) return 'properties';
  return null;
}
