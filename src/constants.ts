import { EXCLUSION_STRATEGY, PluginSettings } from './types';
import {
  PRIMARY_CHAR_KEYS,
  SETTING_KEY_TO_CHAR,
  WINDOWS_ANDROID_CHAR_KEYS,
} from './types/char-replacement';

/**
 * Schema version of the settings this build understands. Bump it whenever the stored
 * shape changes in a way that is not worth migrating: `loadSettings()` discards any
 * data.json carrying a different version and starts from `DEFAULT_SETTINGS`.
 */
export const CURRENT_DATA_SCHEMA_VERSION = 4;

export const DEFAULT_SETTINGS: PluginSettings = {
  dataSchemaVersion: CURRENT_DATA_SCHEMA_VERSION,
  core: {
    // Rename behavior
    renameAutomatically: true,
    titleCase: 'preserve',
    renameOnFocus: false,
    renameOnSave: false,
    onlyRenameIfHeading: false,
    manualNotificationMode: 'Always',
    charCount: 100,
    checkInterval: 0,
    contentReadMethod: 'Editor',

    // New file handling
    // On by default: a fresh install does nothing visible otherwise. Existing
    // users keep a stored `false` — main.ts merges loaded data over these, so
    // only keys absent from data.json pick up a changed default.
    insertTitle: true,
    convertReplacementChars: true,
    formatAsHeading: true,
    moveCursorToFirstLine: true,
    placeCursorAtLineEnd: true,
    newNoteDelay: 0,

    // UI visibility
    enableContextMenus: true,
    enableSearchCommands: true,

    // Context menu command groups
    enableFileCommands: true,
    enableFolderCommands: true,
    enableTagCommands: true,

    // Internal state and debugging
    debug: false,
    debugOutputFullContent: false,
    debugEnabledTimestamp: '',
    hasSetupExclusions: false,
  },
  exclusions: {
    fileScopeStrategy: EXCLUSION_STRATEGY.ONLY_EXCLUDE,
    tagScopeStrategy: EXCLUSION_STRATEGY.ONLY_EXCLUDE,
    propertyScopeStrategy: EXCLUSION_STRATEGY.ONLY_EXCLUDE,
    // Empty, not a seeded blank row: a stored list replaces the default wholesale, so a seeded entry would materialize a dead rule on every fresh install; the lists render their own empty state.
    excludedFiles: [],
    excludedTags: [],
    excludedProperties: [],
    tagMatchingMode: 'In Properties and note body',
    matchSubtags: true,
    disableRenamingKey: 'no rename',
    disableRenamingValue: 'true',
  },
  characterReplacements: {
    enableForbiddenCharReplacements: false,
    charReplacements: {
      slash: {
        replacement: ' ∕ ',
        enabled: true,
        trimLeft: false,
        trimRight: false,
      },
      colon: {
        replacement: '։',
        enabled: true,
        trimLeft: false,
        trimRight: false,
      },
      asterisk: {
        replacement: '∗',
        enabled: true,
        trimLeft: false,
        trimRight: false,
      },
      question: {
        replacement: '？',
        enabled: true,
        trimLeft: false,
        trimRight: true,
      },
      lessThan: {
        replacement: '‹',
        enabled: true,
        trimLeft: false,
        trimRight: false,
      },
      greaterThan: {
        replacement: '›',
        enabled: true,
        trimLeft: false,
        trimRight: false,
      },
      quote: {
        replacement: "''",
        enabled: true,
        trimLeft: false,
        trimRight: false,
      },
      pipe: {
        replacement: '❘',
        enabled: true,
        trimLeft: false,
        trimRight: false,
      },
      hash: {
        replacement: '＃',
        enabled: true,
        trimLeft: false,
        trimRight: false,
      },
      leftBracket: {
        replacement: '［',
        enabled: true,
        trimLeft: true,
        trimRight: true,
      },
      rightBracket: {
        replacement: '］',
        enabled: true,
        trimLeft: true,
        trimRight: true,
      },
      caret: {
        replacement: 'ˆ',
        enabled: true,
        trimLeft: false,
        trimRight: false,
      },
      backslash: {
        replacement: '⧵',
        enabled: true,
        trimLeft: false,
        trimRight: false,
      },
      dot: {
        replacement: '․',
        enabled: true,
        trimLeft: false,
        trimRight: false,
      },
    },
  },
  customReplacements: {
    rules: [],
    applyAfterForbiddenChars: false,
  },
  markupStripping: {
    stripMarkupSettings: {
      headings: true,
      bold: true,
      italic: true,
      strikethrough: true,
      highlight: true,
      wikilinks: true,
      markdownLinks: true,
      quote: true,
      callouts: true,
      unorderedLists: true,
      orderedLists: true,
      taskLists: true,
      code: true,
      codeBlocks: true,
      footnotes: true,
      comments: true,
      htmlTags: true,
    },
    stripMarkupInFirstLineProperty: true,
    stripCommentsEntirely: true,
    stripTemplaterSyntax: true,
    stripTableMarkup: true,
    stripHorizontalRuleMarkup: true,
    stripInlineMathMarkup: true,
    stripMathBlockMarkup: true,
    detectDiagrams: true,
    grabTitleFromCardLink: true,
    applyCustomReplacementsInFirstLineProperty: true,
    applyCustomReplacementsAfterMarkupStripping: false,
  },
  firstLineProperty: {
    truncate: false,
    addOnlyIfTitleDiffers: false,
    propertyKey: '',
    hideProperty: 'never' as const,
    hideInSidebar: false,
    keepEmptyProperty: true,
    placeLast: true,
  },
};

/** Characters no name may hold on any OS, derived from the settings keys so the two lists cannot drift; the dot is left out, since only a leading dot is forbidden. */
export const UNIVERSAL_FORBIDDEN_CHARS = PRIMARY_CHAR_KEYS.filter(
  (key) => key !== 'dot'
).map((key) => SETTING_KEY_TO_CHAR[key]);

/** Characters forbidden only on Windows and Android, derived from the settings keys. */
export const WINDOWS_ANDROID_CHARS = WINDOWS_ANDROID_CHAR_KEYS.map(
  (key) => SETTING_KEY_TO_CHAR[key]
);
