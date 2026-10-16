import type { Editor } from 'obsidian';
import { CharReplacements } from './types/char-replacement';

export interface CustomReplacement {
  searchText: string;
  replaceText: string;
  onlyAtStart: boolean;
  onlyWholeLine: boolean;
}

/** Writes a debug line while debug mode is on, for helpers that take settings rather than the plugin; `verboseLogger` builds one. */
export type DebugLogger = (message: string, data?: unknown) => void;

export interface ExcludedProperty {
  key: string;
  value: string;
}

export interface TitleRegionCache {
  firstNonEmptyLine: string;
  titleSourceLine: string;
  // Part of the key: deleting a fence line can leave the text unchanged while it stops being code.
  raw: boolean;
  lastUpdated: number;
}

/** Every outcome `RenameEngine.processFile` can report. */
export type RenameOutcomeReason =
  | 'renamed'
  | 'no-rename-needed'
  | 'empty-content-retained'
  | 'already-processing'
  | 'error'
  | 'excluded'
  | 'file-not-found'
  | 'global-rate-limited'
  | 'max-conflicts-exceeded'
  | 'not-heading'
  | 'not-markdown'
  | 'not-open-in-editor'
  | 'property-disabled'
  | 'read-error'
  | 'recently-renamed'
  | 'self-referential'
  | 'time-rate-limited';

// `reason` is required, not optional: the first line property gate in `processFile` matches on it, and the
// successful-rename path used to omit it, so the gate silently skipped the one outcome that
// renames a file. Requiring it makes any future drift a compile error.
export interface RenameOutcome {
  success: boolean;
  reason: RenameOutcomeReason;
}

/** Exclusion lists a check skips; an omitted key keeps its list. Nothing skips the rename-blocking property. */
export interface ExclusionOverrides {
  /** Skip the Excluded files rules */
  ignoreExcludedFiles?: boolean;
  /** Skip the Excluded tags rules */
  ignoreExcludedTags?: boolean;
  /** Skip the Excluded properties rules */
  ignoreExcludedProperties?: boolean;
}

/** An exclusion list that can keep a note from being processed: Excluded files, Excluded tags or Excluded properties. */
export type ExclusionList = 'files' | 'tags' | 'properties';

/** Skips every exclusion list, as "Put first line in title" does. */
export const IGNORE_ALL_EXCLUSIONS: Readonly<ExclusionOverrides> = {
  ignoreExcludedFiles: true,
  ignoreExcludedTags: true,
  ignoreExcludedProperties: true,
};

/** How a `RenameEngine.processFile` pass was started, and what its caller already holds. Every key is optional; omitted, the pass is an automatic one that reads the note itself. */
export interface ProcessFileOptions {
  /** A command or menu item the user ran: it shows notices, searches every editor for the note's text, and needs no open editor */
  isManualCommand?: boolean;
  /** Note text the caller already read, used instead of reading the note */
  providedContent?: string;
  /** One note of a bulk run, which reports on its own: no per-note notices, and no global rate limit */
  isBatchOperation?: boolean;
  /** Exclusion lists the pass skips, for the rename and the first line property alike */
  exclusionOverrides?: ExclusionOverrides;
  /** Whether an editor shows the note, as the caller knows it; undefined looks for one */
  hasActiveEditor?: boolean;
  /** Editor the text comes from, which the first line property is written into */
  editor?: Editor;
}

// Each string-union setting derives its type from a value list, so the import and load validation in `transfer.ts` checks against the same values the type allows.
export const NOTIFICATION_MODES = [
  'Always',
  'On title change',
  'Never',
] as const;
export type NotificationMode = (typeof NOTIFICATION_MODES)[number];
export const TITLE_CASES = ['preserve', 'uppercase', 'lowercase'] as const;
export type TitleCase = (typeof TITLE_CASES)[number];
/**
 * Canonical exclusion-strategy values. Persisted verbatim in data.json and used as
 * settings-dropdown option keys — the literal text, including the trailing three-period
 * ellipsis, must never change or every existing user's exclusion strategy silently resets.
 */
export const EXCLUSION_STRATEGY = {
  ONLY_EXCLUDE: 'Only exclude...',
  EXCLUDE_ALL_EXCEPT: 'Exclude all except...',
} as const;
export type ExclusionStrategy =
  (typeof EXCLUSION_STRATEGY)[keyof typeof EXCLUSION_STRATEGY];
export const TAG_MATCHING_MODES = [
  'In Properties and note body',
  'In Properties only',
  'In note body only',
] as const;
export type TagMatchingMode = (typeof TAG_MATCHING_MODES)[number];
export const CONTENT_READ_METHODS = ['Editor', 'Cache', 'File'] as const;
export type ContentReadMethod = (typeof CONTENT_READ_METHODS)[number];

export const PROPERTY_HIDING_OPTIONS = [
  'never',
  'always',
  'when_empty',
] as const;
export type PropertyHidingOption = (typeof PROPERTY_HIDING_OPTIONS)[number];

/**
 * Core plugin settings (General + Other tabs)
 */
export interface CoreSettings {
  // Rename behavior
  renameAutomatically: boolean;
  titleCase: TitleCase;
  renameOnFocus: boolean;
  renameOnSave: boolean;
  onlyRenameIfHeading: boolean;
  manualNotificationMode: NotificationMode;
  charCount: number;
  checkInterval: number;
  contentReadMethod: ContentReadMethod;

  // New file handling
  insertTitle: boolean;
  convertReplacementChars: boolean;
  formatAsHeading: boolean;
  moveCursorToFirstLine: boolean;
  placeCursorAtLineEnd: boolean;
  newNoteDelay: number;

  // UI visibility
  enableContextMenus: boolean;
  enableSearchCommands: boolean;

  // Context menu command groups
  enableFileCommands: boolean;
  enableFolderCommands: boolean;
  enableTagCommands: boolean;

  // Internal state and debugging
  debug: boolean;
  debugOutputFullContent: boolean;
  debugEnabledTimestamp: string;
  hasSetupExclusions: boolean;
}

/**
 * Exclusion and scoping settings
 */
export interface ExclusionSettings {
  fileScopeStrategy: ExclusionStrategy;
  tagScopeStrategy: ExclusionStrategy;
  propertyScopeStrategy: ExclusionStrategy;
  excludedFiles: string[];
  excludedTags: string[];
  excludedProperties: ExcludedProperty[];
  tagMatchingMode: TagMatchingMode;
  matchSubtags: boolean;
  disableRenamingKey: string;
  disableRenamingValue: string;
}

/**
 * Character replacements settings (forbidden chars)
 */
export interface CharacterReplacementsSettings {
  enableForbiddenCharReplacements: boolean;
  charReplacements: CharReplacements;
}

/**
 * Custom replacements settings
 */
export interface CustomReplacementsSettings {
  rules: CustomReplacement[];
  applyAfterForbiddenChars: boolean;
}

/**
 * Markup stripping and content processing settings
 */
export interface MarkupStrippingSettings {
  stripMarkupSettings: {
    headings: boolean;
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    highlight: boolean;
    wikilinks: boolean;
    markdownLinks: boolean;
    quote: boolean;
    callouts: boolean;
    unorderedLists: boolean;
    orderedLists: boolean;
    taskLists: boolean;
    code: boolean;
    codeBlocks: boolean;
    footnotes: boolean;
    comments: boolean;
    htmlTags: boolean;
  };
  stripMarkupInFirstLineProperty: boolean;
  stripCommentsEntirely: boolean;
  stripTemplaterSyntax: boolean;
  stripTableMarkup: boolean;
  stripHorizontalRuleMarkup: boolean;
  stripInlineMathMarkup: boolean;
  stripMathBlockMarkup: boolean;
  detectDiagrams: boolean;
  grabTitleFromCardLink: boolean;
  applyCustomReplacementsInFirstLineProperty: boolean;
  applyCustomReplacementsAfterMarkupStripping: boolean;
}

/**
 * First line property settings
 */
export interface FirstLinePropertySettings {
  truncate: boolean;
  addOnlyIfTitleDiffers: boolean;
  propertyKey: string;
  hideProperty: PropertyHidingOption;
  hideInSidebar: boolean;
  keepEmptyProperty: boolean;
  placeLast: boolean;
}

/**
 * Structured plugin settings organized by feature
 */
export interface PluginSettings {
  /**
   * Schema version of the persisted data.json. Stored data whose version does not
   * match `CURRENT_DATA_SCHEMA_VERSION` is discarded and replaced with the defaults
   * rather than migrated key by key — see `loadSettings()` in `main.ts`.
   */
  dataSchemaVersion: number;
  core: CoreSettings;
  exclusions: ExclusionSettings;
  characterReplacements: CharacterReplacementsSettings;
  customReplacements: CustomReplacementsSettings;
  markupStripping: MarkupStrippingSettings;
  firstLineProperty: FirstLinePropertySettings;
}

/**
 * Recursive `Partial`. Settings are deeply nested, so a plain `Partial` would force a
 * caller overriding one leaf to restate every sibling key of the branch it lives in.
 *
 * The object branch must not be narrowed to `Record<string, unknown>`: interfaces carry
 * no implicit index signature, so `PluginSettings` would fail that check and the whole
 * type would collapse back to `T`.
 */
export type DeepPartial<T> = T extends unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
