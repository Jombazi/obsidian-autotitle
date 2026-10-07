import {
  TFile,
  App,
  Platform,
  ViewWithFileEditor,
  getFrontMatterInfo,
} from 'obsidian';
import { PluginSettings, OSPreset } from './types';
import { CHAR_TO_SETTING_KEY } from './types/char-replacement';
import {
  excludedFileEntryKey,
  resolveCurrentFrontmatter,
} from './utils/file-exclusions';
import { t } from './i18n';
import { PropertyManager } from './core/property-manager';
import { findEmbeddedEditors } from './utils/embedded-editors';
import { renderInlineMarkup, InlineMarkupOptions } from './utils/inline-markup';
import { splitBlockPrefixes, BlockListKind } from './utils/block-prefixes';

// Re-export from modular utilities
export {
  filterNonEmpty,
  generateSafeLinkTarget,
  reverseSafeLinkTarget,
  processForbiddenChars,
} from './utils/string-processing';
export { deepMerge } from './utils/deep-merge';
export {
  normalizeTag,
  parseTagsFromYAML,
  stripFrontmatter,
  fileHasTargetTags,
} from './utils/tag-utils';
export {
  fileHasExcludedProperties,
  shouldProcessFile,
} from './utils/file-exclusions';

// Re-export from PropertyManager (wrapped to avoid unbound-method warning)
export const normalizePropertyValue = (value: unknown): unknown =>
  PropertyManager.normalizePropertyValue(value);

export function verboseLog(
  plugin: { settings: PluginSettings },
  message: string,
  data?: unknown
) {
  if (plugin.settings.core.debug) {
    if (data) {
      console.debug(message, data);
    } else {
      console.debug(message);
    }
  }
}

export function isValidHeading(line: string): boolean {
  return /^#{1,6}\s+.*/.test(line);
}

/**
 * Check if only frontmatter changed between two content versions.
 * Used to detect YAML-only edits and skip unnecessary alias updates.
 *
 * @param currentContent - Current file content
 * @param previousContent - Previous file content to compare against
 * @returns true if only frontmatter changed (body is identical), false if body changed
 */
export function isOnlyFrontmatterChanged(
  currentContent: string,
  previousContent: string
): boolean {
  const currentFrontmatterInfo = getFrontMatterInfo(currentContent);
  const previousFrontmatterInfo = getFrontMatterInfo(previousContent);

  const currentBody = currentContent.substring(
    currentFrontmatterInfo.contentStart
  );
  const previousBody = previousContent.substring(
    previousFrontmatterInfo.contentStart
  );

  return currentBody === previousBody;
}

export function detectOS(): OSPreset {
  if (Platform.isMacOS || Platform.isIosApp) {
    return 'macOS';
  }
  if (Platform.isWin) {
    return 'Windows';
  }
  // Android and Linux both fall under Linux category
  return 'Linux';
}

/**
 * Check if file is currently open in a Markdown leaf or being edited in a page preview or Canvas card
 * @param file - File to check
 * @param app - Obsidian App instance
 * @returns true if file is open in any editor
 */
export function isFileOpenInAnyEditor(file: TFile, app: App): boolean {
  const leaves = app.workspace.getLeavesOfType('markdown');

  // Check main workspace leaves
  for (const leaf of leaves) {
    // Cast to ViewWithFileEditor to access FileView/MarkdownView properties
    const view = leaf.view as ViewWithFileEditor;
    if (view?.file?.path === file.path) {
      return true;
    }
  }

  return findEmbeddedEditors(app, file).length > 0;
}

/**
 * Central gate for file modification eligibility.
 * Checks policy requirements and always-on safeguards.
 *
 * @param isManualCommand - true for manual commands, false for automatic operations
 * @returns {canModify: boolean, reason?: string}
 */
export function canModifyFile(
  file: TFile,
  app: App,
  disableKey: string,
  disableValue: string,
  isManualCommand: boolean,
  hasActiveEditor?: boolean,
  content?: string
): { canModify: boolean; reason?: string } {
  // Check 1: Disable property (ALWAYS-ON SAFEGUARD #4), absolute blocker for all operations
  // Content first: the editor is ahead of the cache by up to Obsidian's autosave delay. The cache decides when content is absent or has no parseable frontmatter.
  const frontmatter = resolveCurrentFrontmatter(file, app, content);
  if (
    frontmatter &&
    frontmatterHasDisableProperty(frontmatter, disableKey, disableValue)
  ) {
    return { canModify: false, reason: 'disable property present' };
  }

  // Check 2: File open in editor (ALWAYS-ON SAFEGUARD #5 for automatic operations)
  // Prevents processing external/programmatic edits
  // Manual commands bypass this check
  if (!isManualCommand) {
    // If hasActiveEditor provided (from editor-change event), trust it
    // This includes both leaf editors and page preview or Canvas card editors
    if (hasActiveEditor !== undefined) {
      if (!hasActiveEditor) {
        return { canModify: false, reason: 'file not open in editor' };
      }
    } else {
      // Fallback: check for open editors using helper function
      if (!isFileOpenInAnyEditor(file, app)) {
        return { canModify: false, reason: 'file not open in editor' };
      }
    }
  }

  return { canModify: true };
}

// Functions moved to modular utils (re-exported above):
// - filterNonEmpty → utils/string-processing.ts
// - generateSafeLinkTarget → utils/string-processing.ts
// - normalizeTag → utils/tag-utils.ts
// - parseTagsFromYAML, stripFrontmatter → utils/tag-utils.ts
// - fileHasTargetTags → utils/tag-utils.ts
// - fileHasExcludedProperties → utils/file-exclusions.ts
// - shouldProcessFile → utils/file-exclusions.ts
// - deepMerge → utils/deep-merge.ts

export function hasDisablePropertyInFile(
  file: TFile,
  app: App,
  disableKey: string,
  disableValue: string
): boolean {
  try {
    // Use Obsidian's metadata cache to read frontmatter (already parsed YAML)
    const metadata = app.metadataCache.getFileCache(file);
    const frontmatter = metadata?.frontmatter;

    if (!frontmatter) return false;

    return frontmatterHasDisableProperty(frontmatter, disableKey, disableValue);
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

// Reading view's rendering of the line is the reference: every transform here aims to yield the text Reading view shows, and a divergence from it is a bug.
export function extractTitle(
  line: string,
  settings: PluginSettings,
  options?: { skipMarkupStripping?: boolean }
): string {
  const skipMarkupStripping = options?.skipMarkupStripping ?? false;
  const originalLine = line;

  // Check if original line is a valid list (0-3 spaces indent, not 4+ which is code block)
  // Task lists are checked first to prevent overlap with unordered/ordered detection
  // Per CommonMark: tabs expand to next multiple of 4, so any tab in indent = code block
  const indentStr = line.match(/^(\s*)/)?.[1] ?? '';
  const isCodeBlockIndent = indentStr.includes('\t') || indentStr.length >= 4;
  const isOriginallyTaskList =
    /^\s*(?:[-+*]|\d+[.)]) \[.\] /.test(line) && !isCodeBlockIndent;
  const isOriginallyUnorderedList =
    !isOriginallyTaskList && /^\s*[-+*] /.test(line) && !isCodeBlockIndent;
  const isOriginallyOrderedList =
    !isOriginallyTaskList && /^\s*\d+[.)] /.test(line) && !isCodeBlockIndent;

  // Check if line is only a list marker (before trim removes trailing space)
  // Uses space character class (not \s) to exclude tabs, which are code blocks per CommonMark
  if (!skipMarkupStripping) {
    if (
      settings.markupStripping.stripMarkupSettings.taskLists &&
      /^ {0,3}(?:[-+*]|\d+[.)]) \[.\] $/.test(line)
    ) {
      return t('untitled');
    }
    if (
      settings.markupStripping.stripMarkupSettings.unorderedLists &&
      /^ {0,3}[-+*] $/.test(line)
    ) {
      return t('untitled');
    }
    if (
      settings.markupStripping.stripMarkupSettings.orderedLists &&
      /^ {0,3}\d+[.)] $/.test(line)
    ) {
      return t('untitled');
    }
  }

  line = line.trim();

  // Remove template placeholder if enabled
  if (!skipMarkupStripping && settings.markupStripping.stripTemplaterSyntax) {
    line = line.replace(/<%\s*tp\.file\.cursor\(\)\s*%>/, '').trim();
    if (line === '<%*') {
      return t('untitled');
    }
  }

  // Check if original line (before trim) starts with valid heading - before any processing
  const isHeading = isValidHeading(originalLine);

  // Check for empty heading (only hash marks with optional spaces, nothing preceding)
  // Empty heading must: start at line beginning (no preceding chars), have 1-6 hashes, end with optional spaces
  const isEmptyHeading = /^#{1,6}\s*$/.test(originalLine);
  if (isEmptyHeading) {
    return t('untitled');
  }

  // Escapes, decoded character references, code spans, math, bare URLs and wikilinks are hidden behind placeholders so the passes below leave their text as Reading view shows it; every other backslash stays in the line for `processForbiddenChars` to replace or drop.
  const protectedTexts = new Map<string, string>();
  let placeholderCounter = 0;

  // Check for placeholder collision (extremely rare - user would need to type exact Unicode chars)
  const hasPlaceholderCollision = line.includes('⸢FLITESC');
  const protect = (text: string): string => {
    if (hasPlaceholderCollision || text === '') return text;
    const placeholder = `⸢FLITESC${placeholderCounter++}⸥`;
    protectedTexts.set(placeholder, text);
    return placeholder;
  };

  // Runs before inline parsing, which would otherwise read a multi-line fence as one code span.
  if (
    !skipMarkupStripping &&
    settings.markupStripping.stripMarkupSettings.codeBlocks
  ) {
    // Check if only ``` (empty code block) - return Untitled
    // Don't use multiline flag - we want to match entire string, not just first line
    if (/^\s*```\s*$/.test(line)) {
      return t('untitled');
    }

    // Match lines with optional leading whitespace followed by ```
    // Capture everything after ``` opener line
    const codeBlockMatch = /^\s*```(?!`)[^\n]*\n([\s\S]+)/m.exec(line);
    if (codeBlockMatch) {
      const content = codeBlockMatch[1];
      // Extract first non-empty line from code block content
      const contentLines = content.split('\n');
      let foundLine = false;
      for (const contentLine of contentLines) {
        const trimmed = contentLine.trim();
        if (trimmed !== '' && !trimmed.startsWith('```')) {
          line = contentLine;
          foundLine = true;
          break;
        }
      }
      // If only found ``` inside (both first and second line are ```), return Untitled
      if (!foundLine) {
        return t('untitled');
      }
    }
  }

  const stripMarkupSettings = settings.markupStripping.stripMarkupSettings;
  const stripBlock = (enabled: boolean): boolean =>
    !skipMarkupStripping && enabled;

  // The original line's indentation decides whether its own list marker or heading counts; prefixes nested after it need no such check.
  let firstListKind: BlockListKind | undefined;
  if (isOriginallyTaskList) firstListKind = 'task';
  else if (isOriginallyUnorderedList) firstListKind = 'unordered';
  else if (isOriginallyOrderedList) firstListKind = 'ordered';
  const blockPrefixes = splitBlockPrefixes(line, firstListKind, isHeading, {
    callouts: stripBlock(stripMarkupSettings.callouts),
    quote: stripBlock(stripMarkupSettings.quote),
    task: stripBlock(stripMarkupSettings.taskLists),
    unordered: stripBlock(stripMarkupSettings.unorderedLists),
    ordered: stripBlock(stripMarkupSettings.orderedLists),
    headings: stripBlock(stripMarkupSettings.headings),
  });
  line = blockPrefixes.content;

  // Inline markup is parsed even when stripping is skipped, so escapes resolve the same way and every construct keeps its delimiters.
  const stripInline = !skipMarkupStripping;
  // Comment toggles cover Obsidian's %%…%% only — HTML comments are stripped by the htmlTags toggle instead.
  let commentHandling: InlineMarkupOptions['comments'] = 'keep';
  if (stripInline && settings.markupStripping.stripCommentsEntirely) {
    commentHandling = 'remove';
  } else if (stripInline && stripMarkupSettings.comments) {
    commentHandling = 'unwrap';
  }
  line =
    blockPrefixes.keptPrefix +
    renderInlineMarkup(line, {
      bold: stripInline && stripMarkupSettings.bold,
      italic: stripInline && stripMarkupSettings.italic,
      strikethrough: stripInline && stripMarkupSettings.strikethrough,
      highlight: stripInline && stripMarkupSettings.highlight,
      code: stripInline && stripMarkupSettings.code,
      wikilinks: stripInline && stripMarkupSettings.wikilinks,
      math: stripInline && settings.markupStripping.stripInlineMathMarkup,
      comments: commentHandling,
      protect,
    });

  if (!skipMarkupStripping) {
    if (settings.markupStripping.stripMarkupSettings.htmlTags) {
      // Runs once, outside the capped pass loop below, so a pathological tag input can't cause the cap to skip it.
      line = line.replace(/<!--[\s\S]*?-->/g, '');

      // Each pass unwraps one nesting level. Capped so a pathological line cannot stall
      // the rename on the editor's critical path; leftover tags are preferable to a hang.
      const maxTagUnwrapPasses = 50;
      let previousLine = '';
      let passes = 0;
      while (line !== previousLine && passes < maxTagUnwrapPasses) {
        previousLine = line;
        passes++;
        line = line.replace(
          /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>(.*?)<\/\1>/g,
          '$2'
        );
      }
    }

    // Strip footnote markup
    if (settings.markupStripping.stripMarkupSettings.footnotes) {
      // Strip [^1] style footnotes (but not if followed by colon)
      line = line.replace(/\[\^[^\]]+\](?!:)/g, '');
      // Strip ^[note] style footnotes (but not if followed by colon)
      line = line.replace(/\^\[[^\]]+\](?!:)/g, '');
    }
  }

  // Handle regular embedded image links
  if (
    !skipMarkupStripping &&
    settings.markupStripping.stripMarkupSettings.markdownLinks
  ) {
    const regularEmbedRegex = /!\[(.*?)\]\((.*?)\)/g;
    line = line.replace(
      regularEmbedRegex,
      (_match: string, displayText: string) => displayText
    );
  }

  // Check for empty links that should result in "Untitled"
  // If entire line is just empty links (regular or image), return "Untitled"
  const onlyEmptyLinksRegex = /^(\s*!?\[\]\([^)]*\)\s*)+$/;
  if (onlyEmptyLinksRegex.test(line)) {
    return t('untitled');
  }

  // Handle regular Markdown links (only if strip Markdown link markup is enabled)
  if (
    !skipMarkupStripping &&
    settings.markupStripping.stripMarkupSettings.markdownLinks
  ) {
    const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    line = line.replace(markdownLinkRegex, (_: string, title: string) => title);

    // Remove empty links (but keep surrounding text)
    // This handles cases like "test [](smile.md)" -> "test"
    line = line.replace(/!?\[\]\([^)]*\)/g, '').trim();
  }

  // Restore protected text - only if any was protected
  if (protectedTexts.size > 0) {
    // Build regex for efficient single-pass restoration
    const pattern = new RegExp(
      Array.from(protectedTexts.keys()).join('|'),
      'g'
    );
    line = line.replace(pattern, (match) => protectedTexts.get(match) ?? match);
  }

  // Final check: if line is empty or only whitespace after all processing
  if (line.trim() === '') {
    return t('untitled');
  }

  // Apply title case transformation
  switch (settings.core.titleCase) {
    case 'uppercase':
      line = line.toUpperCase();
      break;
    case 'lowercase':
      line = line.toLowerCase();
      break;
    // "preserve" - no change
  }

  return line;
}

/**
 * Finds the title source line from content lines
 * Handles special cases like card links, code blocks, Markdown tables, HRs, math blocks
 *
 * @param contentLines Array of content lines (without frontmatter)
 * @param settings Plugin settings
 * @param plugin Optional plugin instance for verbose logging
 * @returns The title source line to use for filename
 */
export function findTitleSourceLine(
  contentLines: string[],
  settings: PluginSettings,
  plugin?: { settings: PluginSettings }
): string {
  // HR pattern: same char (*, -, _) 3+ times with optional regular spaces between
  const hrPattern =
    /^ *(?:(\*)(?: *\1){2,}|(-)(?: *\2){2,}|(_)(?: *\3){2,}) *$/;

  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];
    const trimmedLine = line.trim();

    // Skip empty lines
    if (trimmedLine === '') {
      continue;
    }

    // Check for table - use "Table" as title if stripTableMarkup is enabled
    if (
      settings.markupStripping.stripTableMarkup &&
      trimmedLine.includes('|')
    ) {
      if (i + 1 < contentLines.length) {
        const secondLine = contentLines[i + 1];
        // Reject if separator contains escaped pipes or hyphens
        if (!secondLine.includes('\\|') && !secondLine.includes('\\-')) {
          const separatorPattern = /^\s*:?-{2,}:?\s*$/;
          const trimmedSeparator = secondLine
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '');
          const cells = trimmedSeparator.split('|');
          const isValidSeparator =
            cells.length >= 1 &&
            cells.every((cell) => separatorPattern.test(cell));
          if (isValidSeparator) {
            if (plugin) {
              verboseLog(
                plugin,
                `Table detected, using "${t('table')}" as title`
              );
            }
            return t('table');
          }
        }
      }
    }

    // Check for math block delimiter - skip $$ lines to find content after
    if (
      settings.markupStripping.stripMathBlockMarkup &&
      trimmedLine.startsWith('$$')
    ) {
      if (plugin) {
        verboseLog(plugin, `Math block delimiter detected, skipping line`);
      }
      continue;
    }

    // Check for HR - skip if enabled
    if (
      settings.markupStripping.stripHorizontalRuleMarkup &&
      hrPattern.test(line)
    ) {
      if (plugin) {
        verboseLog(plugin, `Horizontal rule detected, skipping line`);
      }
      continue;
    }

    // Check for code fences
    if (trimmedLine.startsWith('```')) {
      // Handle mermaid diagrams
      if (
        settings.markupStripping.detectDiagrams &&
        trimmedLine === '```mermaid'
      ) {
        if (plugin) {
          verboseLog(
            plugin,
            `Mermaid diagram detected, using "${t('diagram')}" as title`
          );
        }
        return t('diagram');
      }

      // Handle card links
      const cardLinkMatch = trimmedLine.match(/^```(embed|cardlink)$/);
      if (settings.markupStripping.grabTitleFromCardLink && cardLinkMatch) {
        const maxLinesToCheck = 20;
        for (
          let j = i + 1;
          j < Math.min(contentLines.length, i + maxLinesToCheck);
          j++
        ) {
          const cardLine = contentLines[j].trim();
          if (cardLine === '') continue;
          if (cardLine.toLowerCase().startsWith('title:')) {
            let title = cardLine.substring(cardLine.indexOf(':') + 1).trim();
            if (
              (title.startsWith('"') && title.endsWith('"')) ||
              (title.startsWith("'") && title.endsWith("'"))
            ) {
              title = title.substring(1, title.length - 1);
            }
            if (plugin) {
              verboseLog(plugin, `Found ${cardLinkMatch[1]} card link`, {
                title,
              });
            }
            return title;
          }
          if (cardLine.startsWith('```')) {
            if (plugin) {
              verboseLog(
                plugin,
                `Card link has no title, using ${t('untitled')}`
              );
            }
            return t('untitled');
          }
        }
        return t('untitled');
      }

      // Regular code fence - always skip past it to find real content
      if (plugin) {
        verboseLog(plugin, `Code fence detected, skipping line`);
      }
      continue;
    }

    // This is a valid content line
    return line;
  }

  return t('untitled');
}

// Punctuation binds to the character before it, so no space is restored in front of it
const PUNCTUATION_AFTER_REPLACEMENT = ',.?;:!"\'»«¡¿‽';

/**
 * Substitute every occurrence of a replacement string with its original character,
 * restoring the whitespace that `trimLeft`/`trimRight` removed during replacement.
 */
function restoreWithTrimmedSpacing(
  text: string,
  replacementChar: string,
  originalChar: string,
  trimLeft: boolean,
  trimRight: boolean
): string {
  if (!trimLeft && !trimRight) {
    return text.replaceAll(replacementChar, originalChar);
  }

  let result = '';
  let searchFrom = 0;
  let index = text.indexOf(replacementChar, searchFrom);

  while (index !== -1) {
    result += text.substring(searchFrom, index);

    let restored = trimLeft ? ' ' + originalChar : originalChar;
    if (trimRight) {
      // Empty when the match ends the string; `includes('')` is true, so no trailing space is added
      const charToRight = text.substring(
        index + replacementChar.length,
        index + replacementChar.length + 1
      );
      if (!PUNCTUATION_AFTER_REPLACEMENT.includes(charToRight)) {
        restored += ' ';
      }
    }

    result += restored;
    searchFrom = index + replacementChar.length;
    index = text.indexOf(replacementChar, searchFrom);
  }

  return result + text.substring(searchFrom);
}

/**
 * Reverse forbidden character replacements in a string
 * @param text - The text to process
 * @param settings - Plugin settings containing character replacement configuration
 * @param plugin - Optional plugin instance for verbose logging
 * @param options.restoreTrimmedSpacing - Re-insert the spaces that `trimLeft`/`trimRight` removed. Opt-in because callers that echo a filename verbatim (the insert-filename command) must not gain spaces the filename never had.
 * @returns The text with replacements reversed to original characters
 */
export function reverseCharacterReplacements(
  text: string,
  settings: PluginSettings,
  plugin?: { settings: PluginSettings },
  options?: { restoreTrimmedSpacing?: boolean }
): string {
  if (!settings.core.convertReplacementChars) {
    return text;
  }

  let result = text;

  // Find duplicate replacement strings (ambiguous - can't reverse)
  const replacementCounts = new Map<string, number>();
  const enabledReplacements: string[] = [];
  for (const settingKey of Object.values(CHAR_TO_SETTING_KEY)) {
    const replacement =
      settings.characterReplacements.charReplacements[settingKey];
    if (replacement.enabled && replacement.replacement) {
      replacementCounts.set(
        replacement.replacement,
        (replacementCounts.get(replacement.replacement) || 0) + 1
      );
      enabledReplacements.push(`${settingKey}="${replacement.replacement}"`);
    }
  }

  if (plugin) {
    verboseLog(
      plugin,
      `[CHAR-REVERSAL] "${text}" with replacements: [${enabledReplacements.join(', ')}]`
    );
  }

  // Reverse each enabled replacement using actual user settings
  for (const [originalChar, settingKey] of Object.entries(
    CHAR_TO_SETTING_KEY
  )) {
    const replacement =
      settings.characterReplacements.charReplacements[settingKey];
    if (replacement.enabled && replacement.replacement) {
      // Skip if this replacement string is used by multiple enabled characters (ambiguous)
      const count = replacementCounts.get(replacement.replacement) || 0;
      if (count > 1) {
        if (plugin) {
          verboseLog(
            plugin,
            `[CHAR-REVERSAL] Skipping "${replacement.replacement}" → "${originalChar}" (duplicate, count=${count})`
          );
        }
        continue;
      }
      result = options?.restoreTrimmedSpacing
        ? restoreWithTrimmedSpacing(
            result,
            replacement.replacement,
            originalChar,
            replacement.trimLeft,
            replacement.trimRight
          )
        : result.replaceAll(replacement.replacement, originalChar);
    }
  }

  if (plugin && result !== text) {
    verboseLog(plugin, `[CHAR-REVERSAL] Result: "${text}" → "${result}"`);
  }

  return result;
}

/**
 * Normalizes a tag for duplicate comparison
 * - Trims whitespace
 * - Converts to lowercase for case-insensitive comparison
 */
function normalizeTagName(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Cleans a tag for storage (preserves case)
 * - Trims whitespace
 */
function cleanTag(tag: string): string {
  return tag.trim();
}

/**
 * Normalizes a property key or value for duplicate comparison
 * - Trims whitespace
 * - Converts to lowercase for case-insensitive comparison
 */
function normalizePropertyText(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Cleans a property key or value for storage (preserves case)
 * - Trims whitespace
 */
function cleanPropertyText(text: string): string {
  return text.trim();
}

/**
 * Normalizes the exclusion lists in plugin settings: drops blank entries, cleans
 * entry text, and deduplicates excluded files, tags and properties
 * Keeps the last occurrence of each duplicate (removes earlier ones)
 * Normalization rules:
 * - Excluded files: trimmed; paths case-insensitive, regular expressions exact
 * - Tags: case-insensitive
 * - Properties: both key and value must match (case-insensitive)
 *
 * @param settings - Plugin settings object to normalize
 * @returns true if any entries were removed or cleaned, false otherwise
 */
export function normalizeExclusionLists(settings: PluginSettings): boolean {
  let hasChanges = false;

  // Deduplicate excluded files
  // Each list is read through `?? []`: this also runs on settings imported from a file,
  // which can omit any list entirely despite what the types promise
  const excludedFiles = settings.exclusions.excludedFiles ?? [];
  const originalFileCount = excludedFiles.length;
  const fileEntryMap = new Map<string, number>(); // duplicate key -> last index

  excludedFiles.forEach((entry, index) => {
    const key = excludedFileEntryKey(entry);
    if (key !== '') {
      fileEntryMap.set(key, index);
    }
  });

  // Blank entries are never recorded in fileEntryMap, so they drop out here
  const keepFileIndices = new Set(fileEntryMap.values());
  settings.exclusions.excludedFiles = excludedFiles.filter((_, index) =>
    keepFileIndices.has(index)
  );

  if (settings.exclusions.excludedFiles.length !== originalFileCount) {
    hasChanges = true;
  }

  // Trim entries, preserving case
  settings.exclusions.excludedFiles = settings.exclusions.excludedFiles.map(
    (entry) => {
      const trimmed = entry.trim();
      if (trimmed !== entry) {
        hasChanges = true;
      }
      return trimmed;
    }
  );

  // Deduplicate tags
  const excludedTags = settings.exclusions.excludedTags ?? [];
  const originalTagCount = excludedTags.length;
  const tagMap = new Map<string, number>(); // normalized -> last index

  excludedTags.forEach((tag, index) => {
    const normalized = normalizeTagName(tag);
    if (normalized !== '') {
      tagMap.set(normalized, index);
    }
  });

  // Blank entries are never recorded in tagMap, so they drop out here
  const keepTagIndices = new Set(tagMap.values());
  settings.exclusions.excludedTags = excludedTags.filter((_, index) =>
    keepTagIndices.has(index)
  );

  if (settings.exclusions.excludedTags.length !== originalTagCount) {
    hasChanges = true;
  }

  // Clean tags (trim whitespace, preserve case)
  settings.exclusions.excludedTags = settings.exclusions.excludedTags.map(
    (tag) => {
      const cleaned = cleanTag(tag);
      if (cleaned !== tag) {
        hasChanges = true;
      }
      return cleaned;
    }
  );

  // Deduplicate properties (both key AND value must match)
  const excludedProperties = settings.exclusions.excludedProperties ?? [];
  const originalPropertyCount = excludedProperties.length;
  const propertyMap = new Map<string, number>(); // [key, value] -> last index

  excludedProperties.forEach((prop, index) => {
    const normalizedKey = normalizePropertyText(prop.key);
    const normalizedValue = normalizePropertyText(prop.value);
    // A value without a key can never match: every consumer filters on a non-blank key,
    // so keeping it would render a live-looking rule that does nothing
    if (normalizedKey !== '') {
      // JSON encoding keeps "a:b"/"" distinct from "a"/"b", which a ":" join collapses
      const composite = JSON.stringify([normalizedKey, normalizedValue]);
      propertyMap.set(composite, index);
    }
  });

  // Entries with a blank key are never recorded in propertyMap, so they drop out here
  const keepPropertyIndices = new Set(propertyMap.values());
  settings.exclusions.excludedProperties = excludedProperties.filter(
    (_, index) => keepPropertyIndices.has(index)
  );

  if (settings.exclusions.excludedProperties.length !== originalPropertyCount) {
    hasChanges = true;
  }

  // Clean property keys and values (trim whitespace, preserve case)
  settings.exclusions.excludedProperties =
    settings.exclusions.excludedProperties.map((prop) => {
      const cleanedKey = cleanPropertyText(prop.key);
      const cleanedValue = cleanPropertyText(prop.value);
      if (cleanedKey !== prop.key || cleanedValue !== prop.value) {
        hasChanges = true;
      }
      return { key: cleanedKey, value: cleanedValue };
    });

  return hasChanges;
}
