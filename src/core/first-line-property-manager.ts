import { TFile, MarkdownView, getFrontMatterInfo, parseYaml } from 'obsidian';
import { PluginSettings } from '../types';
import {
  verboseLog,
  shouldProcessFile,
  extractTitle,
  frontmatterHasDisableProperty,
  findTitleSourceLine,
} from '../utils';
import { resolveCurrentFrontmatter } from '../utils/file-exclusions';
import { t } from '../i18n';
import { readFileContent } from '../utils/content-reader';
import {
  hasFirstLinePropertyName,
  parseFirstLinePropertyKeys,
} from '../utils/first-line-property-keys';
import {
  SourceEditorTarget,
  applyFrontMatterChange,
  replaceEditorText,
} from '../utils/frontmatter-edit';
import FirstLineIsTitle from '../../main';

const ZWSP = '\u200B';

/** Check if a value is the plugin-written first line property value (exactly wrapped by ZWSP markers) */
function isFirstLinePropertyValue(value: unknown): boolean {
  return (
    typeof value === 'string' && value.startsWith(ZWSP) && value.endsWith(ZWSP)
  );
}

/** Check if an error is ENOENT, which a rename raises mid-edit. Narrows `unknown` because the review bot's type check cannot resolve `NodeJS.ErrnoException`. */
function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export class FirstLinePropertyManager {
  constructor(private plugin: FirstLineIsTitle) {}

  get app() {
    return this.plugin.app;
  }

  get settings(): PluginSettings {
    return this.plugin.settings;
  }

  /**
   * Parse comma-separated first line property keys from settings.
   * Called multiple times per operation but not cached since:
   * - Property string is typically short ("aliases")
   * - Caching adds complexity without measurable benefit
   */
  private getFirstLinePropertyKeys(): string[] {
    return parseFirstLinePropertyKeys(
      this.settings.firstLineProperty.propertyKey
    );
  }

  /**
   * True when the first line property name setting resolves to no key at all, which is also what turns the first line property off.
   *
   * Every public entry point checks this before doing any work. Letting the
   * per-key loops iterate zero times is not enough: the surrounding code still
   * reaches `writeFrontMatter()`, which writes the note to accomplish nothing.
   */
  private hasNoFirstLineProperty(): boolean {
    return !hasFirstLinePropertyName(this.settings);
  }

  async updateFirstLinePropertyIfNeeded(
    file: TFile,
    providedContent?: string,
    targetTitle?: string,
    target?: SourceEditorTarget | null
  ): Promise<boolean> {
    // With no property to populate this call is a no-op. `false` matches every
    // other skip in this method — it means "no first line property update performed", not
    // "failed".
    if (this.hasNoFirstLineProperty()) {
      return false;
    }

    try {
      const currentFile = this.app.vault.getAbstractFileByPath(file.path);
      if (!currentFile || !(currentFile instanceof TFile)) {
        verboseLog(
          this.plugin,
          `Skipping first line property update - file no longer exists: ${file.path}`
        );
        return false;
      }

      file = currentFile;

      // Note: No lock check here - first line property manager is called from within processFile's lock
      // The lock is already acquired by the time we reach this point

      // Check disable property FIRST - this cannot be overridden by any command
      // Content first: the editor is ahead of the cache by up to Obsidian's autosave delay. The cache decides when content is absent or has no parseable frontmatter.
      if (
        frontmatterHasDisableProperty(
          resolveCurrentFrontmatter(
            file,
            this.app,
            providedContent ?? target?.editor.getValue()
          ) ?? {},
          this.settings.exclusions.disableRenamingKey,
          this.settings.exclusions.disableRenamingValue
        )
      ) {
        verboseLog(
          this.plugin,
          `Skipping first line property update - file has disable property: ${file.path}`
        );
        return false;
      }

      if (
        !shouldProcessFile(
          file,
          this.settings,
          this.app,
          undefined,
          undefined,
          this.plugin
        )
      ) {
        return false;
      }

      const content = await readFileContent(this.plugin, file, {
        providedContent,
        providedEditor: target?.editor,
      });

      if (!content || content.trim() === '') {
        return false;
      }

      const contentWithoutFrontmatter =
        this.plugin.renameEngine.stripFrontmatterFromContent(content, file);
      const lines = contentWithoutFrontmatter.split('\n');

      // Find first non-empty line (consistent with rename-engine.ts)
      let firstNonEmptyLine = '';
      for (const line of lines) {
        if (line.trim() !== '') {
          firstNonEmptyLine = line;
          break;
        }
      }

      if (!firstNonEmptyLine || firstNonEmptyLine.trim() === '') {
        await this.removeFirstLinePropertyValuesFromFile(file, target ?? null);
        return false;
      }

      // Determine titleSourceLine using shared utility function
      // This may differ from firstNonEmptyLine in special cases (card links, code blocks, tables)
      const titleSourceLine = findTitleSourceLine(
        lines,
        this.settings,
        this.plugin
      );

      // Parse frontmatter from fresh editor content instead of stale cache
      // This prevents race conditions where cache hasn't updated yet during YAML edits
      const frontmatterInfo = getFrontMatterInfo(content);
      let frontmatter: Record<string, unknown> | null = null;
      if (frontmatterInfo.exists) {
        try {
          frontmatter = parseYaml(frontmatterInfo.frontmatter) as Record<
            string,
            unknown
          > | null;
        } catch {
          // YAML is malformed (e.g., user is mid-typing) - skip first line property update until valid
          verboseLog(
            this.plugin,
            `Skipping first line property update - malformed YAML in ${file.path}`
          );
          return false;
        }
      }

      const processedTitleSource = extractTitle(titleSourceLine, this.settings);
      const titleToCompare =
        targetTitle !== undefined ? targetTitle.trim() : file.basename.trim();
      const processedLineMatchesFilename =
        processedTitleSource.trim() === titleToCompare;

      const shouldHaveFirstLineProperty =
        !this.settings.firstLineProperty.addOnlyIfTitleDiffers ||
        !processedLineMatchesFilename;

      if (!shouldHaveFirstLineProperty) {
        verboseLog(
          this.plugin,
          `Removing first line property values - first line matches filename: "${processedTitleSource}" = "${titleToCompare}"`
        );
        await this.removeFirstLinePropertyValuesFromFile(file, target ?? null);
        return false;
      }

      const firstLinePropertyKeys = this.getFirstLinePropertyKeys();
      let expectedValue = this.settings.markupStripping
        .stripMarkupInFirstLineProperty
        ? extractTitle(titleSourceLine, this.settings)
        : titleSourceLine;
      // Apply truncation if enabled (must match what addFirstLinePropertyToFile will produce)
      if (this.settings.firstLineProperty.truncate) {
        if (expectedValue.length > this.settings.core.charCount - 1) {
          expectedValue =
            expectedValue.slice(0, this.settings.core.charCount - 1).trimEnd() +
            '…';
        }
      }
      const expectedValueWithMarker = ZWSP + expectedValue + ZWSP;

      let allPropertiesHaveCorrectValue = true;
      let valueNeedsRepositioning = false;
      for (const firstLinePropertyKey of firstLinePropertyKeys) {
        let existingValues: string[] = [];
        const rawValue = frontmatter?.[firstLinePropertyKey];
        if (rawValue) {
          if (Array.isArray(rawValue)) {
            existingValues = [...(rawValue as string[])];
          } else {
            existingValues = [rawValue as string];
          }
        }

        const hasCorrectValue = existingValues.some(
          (value) =>
            value === expectedValueWithMarker || value === expectedValue
        );

        if (!hasCorrectValue) {
          allPropertiesHaveCorrectValue = false;
          break;
        }

        // Check if the value needs repositioning (placeLast ON but not last)
        if (
          this.settings.firstLineProperty.placeLast &&
          existingValues.length > 1
        ) {
          const lastValue = existingValues[existingValues.length - 1];
          const isFirstLinePropertyValueLast =
            isFirstLinePropertyValue(lastValue);
          if (!isFirstLinePropertyValueLast) {
            valueNeedsRepositioning = true;
          }
        }
      }

      if (allPropertiesHaveCorrectValue && !valueNeedsRepositioning) {
        verboseLog(
          this.plugin,
          `File ${file.path} already has correct first line property value in all properties`
        );
        return true;
      }

      // Note: Lock already acquired by processFile - the first line property update runs within that lock
      // No need to acquire separate lock here

      try {
        verboseLog(
          this.plugin,
          `Adding first line property to ${file.path} - no correct value found`
        );
        await this.addFirstLinePropertyToFile(
          file,
          titleSourceLine,
          titleToCompare,
          target ?? null
        );
        return true;
      } catch (error) {
        console.error('Error updating first line property:', error);
        return false;
      }
    } catch (error) {
      console.error('Error updating first line property:', error);
      return false;
    }
  }

  async addFirstLinePropertyToFile(
    file: TFile,
    originalFirstNonEmptyLine: string,
    newTitle: string,
    target: SourceEditorTarget | null = null
  ): Promise<void> {
    // No property to write the value into - skip before `writeFrontMatter()`
    // touches the note.
    if (this.hasNoFirstLineProperty()) {
      return;
    }

    try {
      // Validate file exists and get fresh reference from vault.
      // writeFrontMatter re-validates before its processFrontMatter call to guard
      // against file deletion during activeView.save().
      const currentFile = this.app.vault.getAbstractFileByPath(file.path);
      if (!currentFile || !(currentFile instanceof TFile)) {
        verboseLog(
          this.plugin,
          `Skipping first line property addition - file no longer exists: ${file.path}`
        );
        return;
      }
      file = currentFile;

      const firstNonEmptyLine = originalFirstNonEmptyLine;
      let firstLinePropertyProcessedLine = firstNonEmptyLine;

      // Apply custom replacements to the value if enabled
      if (
        this.settings.markupStripping.applyCustomReplacementsInFirstLineProperty
      ) {
        for (const replacement of this.settings.customReplacements.rules) {
          if (replacement.searchText === '') continue;

          let tempLine = firstLinePropertyProcessedLine;
          if (replacement.onlyWholeLine) {
            if (
              firstLinePropertyProcessedLine.trim() ===
              replacement.searchText.trim()
            ) {
              tempLine = replacement.replaceText;
            }
          } else if (replacement.onlyAtStart) {
            if (tempLine.startsWith(replacement.searchText)) {
              tempLine =
                replacement.replaceText +
                tempLine.slice(replacement.searchText.length);
            }
          } else {
            // Replacer function so `$&` and `$$` in the user's replacement text stay literal.
            tempLine = tempLine.replaceAll(
              replacement.searchText,
              () => replacement.replaceText
            );
          }
          firstLinePropertyProcessedLine = tempLine;
        }
      }

      // Process the value WITHOUT forbidden char replacements.
      // Use try/finally to guarantee settings restoration even if extractTitle throws.
      const originalCharReplacementSetting =
        this.settings.characterReplacements.enableForbiddenCharReplacements;

      let valueToAdd: string;
      try {
        this.settings.characterReplacements.enableForbiddenCharReplacements = false;
        valueToAdd = extractTitle(
          firstLinePropertyProcessedLine,
          this.settings,
          {
            skipMarkupStripping:
              !this.settings.markupStripping.stripMarkupInFirstLineProperty,
          }
        );
      } finally {
        this.settings.characterReplacements.enableForbiddenCharReplacements =
          originalCharReplacementSetting;
      }
      // Re-check value-matches-filename after custom replacements are applied.
      // The caller (updateFirstLinePropertyIfNeeded) checks this too, but the custom replacement
      // rules applied above can modify the value differently, so we must verify again.
      const targetTitle = newTitle.trim();
      const valueMatchesFilename = valueToAdd.trim() === targetTitle;
      const shouldAddFirstLineProperty =
        !this.settings.firstLineProperty.addOnlyIfTitleDiffers ||
        !valueMatchesFilename;

      if (!shouldAddFirstLineProperty) {
        verboseLog(
          this.plugin,
          `Removing first line property values and skipping add - value matches filename: \`${valueToAdd}\` = \`${targetTitle}\``
        );
        await this.removeFirstLinePropertyValuesFromFile(file, target);
        return;
      }

      // Apply truncation to the value if enabled
      if (this.settings.firstLineProperty.truncate) {
        if (valueToAdd.length > this.settings.core.charCount - 1) {
          valueToAdd =
            valueToAdd.slice(0, this.settings.core.charCount - 1).trimEnd() +
            '…';
        }
      }

      // If the value is empty, only whitespace, or just an ellipsis (from extreme truncation),
      // remove the first line property value instead - these provide no meaningful value.
      if (
        !valueToAdd ||
        valueToAdd.trim() === '' ||
        valueToAdd.trim() === '…'
      ) {
        verboseLog(
          this.plugin,
          `Removing first line property value - no meaningful content found`
        );
        await this.removeFirstLinePropertyValuesFromFile(file, target);
        return;
      }

      // Prevent "Untitled" or "Untitled n" values UNLESS first line is literally that.
      // Pattern matches: "Untitled", "Untitled 2", "Untitled 10", etc.
      // Pattern excludes: "Untitled 0", "Untitled 01" (via [1-9]) to match Obsidian's
      // auto-numbering which starts at 2 for duplicates.
      const untitledWord = t('untitled').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const untitledPattern = new RegExp(`^${untitledWord}(\\s+[1-9]\\d*)?$`);
      if (untitledPattern.test(valueToAdd.trim())) {
        // Check if original first non-empty line (before processing) was literally "Untitled" or "Untitled n"
        const originalFirstLineTrimmed = firstNonEmptyLine.trim();

        if (!untitledPattern.test(originalFirstLineTrimmed)) {
          // Extracted title is "Untitled" but first line is not literally "Untitled"
          // This happens when markup stripping results in empty content:
          // - Empty headings: `#`, `##`, etc.
          // - Empty list markers: `- `, `* `, `1. `, etc.
          // - Template syntax: `<%*`, `<% tp.file.cursor() %>`, etc.
          // Remove any stale first line property values since there's no valid content
          verboseLog(
            this.plugin,
            `Removing stale first line property values - extracted title is "Untitled" from markup: ${originalFirstLineTrimmed}`
          );
          await this.removeFirstLinePropertyValuesFromFile(file, target);
          return;
        }
      }

      // Mark the value with ZWSP for identification
      const markedValue = ZWSP + valueToAdd + ZWSP;
      const firstLinePropertyKeys = this.getFirstLinePropertyKeys();
      // With no properties block yet the callback receives `{}` and creates each property holding the value alone.
      const written = await this.writeFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          // Insert the value into all specified properties
          for (const firstLinePropertyKey of firstLinePropertyKeys) {
            // Check if property is 'aliases' - if yes, use current behavior
            if (firstLinePropertyKey === 'aliases') {
              let existingAliases: string[] = [];
              const rawAliases = frontmatter[firstLinePropertyKey];
              if (rawAliases) {
                if (Array.isArray(rawAliases)) {
                  existingAliases = [...(rawAliases as string[])];
                } else {
                  existingAliases = [rawAliases as string];
                }
              }

              // Find existing plugin value index (ZWSP-wrapped)
              const existingPluginIndex = existingAliases.findIndex((alias) =>
                isFirstLinePropertyValue(alias)
              );

              // Remove plugin values and empty strings
              const userAliases = existingAliases.filter(
                (alias) => !isFirstLinePropertyValue(alias) && alias !== ''
              );

              // Check if this exact value already exists (unmarked)
              if (!userAliases.includes(valueToAdd)) {
                if (existingPluginIndex === -1) {
                  // No existing plugin value - always add at end
                  userAliases.push(markedValue);
                } else if (this.settings.firstLineProperty.placeLast) {
                  // Has existing plugin value, placeLast ON - move to end
                  userAliases.push(markedValue);
                } else {
                  // Has existing plugin value, placeLast OFF - keep original position
                  userAliases.splice(existingPluginIndex, 0, markedValue);
                }
                frontmatter[firstLinePropertyKey] = userAliases;
              } else {
                // Value already exists unmarked - just keep user aliases
                if (userAliases.length === 0) {
                  if (this.settings.firstLineProperty.keepEmptyProperty) {
                    frontmatter[firstLinePropertyKey] = null;
                  } else {
                    delete frontmatter[firstLinePropertyKey];
                  }
                } else {
                  frontmatter[firstLinePropertyKey] = userAliases;
                }
              }
            } else {
              // New behavior for non-aliases properties
              const propertyExists = firstLinePropertyKey in frontmatter;

              const rawPropValue = frontmatter[firstLinePropertyKey];
              if (
                !propertyExists ||
                rawPropValue === null ||
                rawPropValue === undefined ||
                rawPropValue === ''
              ) {
                // Property doesn't exist or has no value - insert inline
                frontmatter[firstLinePropertyKey] = markedValue;
              } else {
                // Property has existing values
                let existingValues: string[] = [];
                if (Array.isArray(rawPropValue)) {
                  existingValues = [...(rawPropValue as string[])];
                } else {
                  existingValues = [rawPropValue as string];
                }

                // Find existing plugin value index (ZWSP-wrapped)
                const existingPluginIndex = existingValues.findIndex((value) =>
                  isFirstLinePropertyValue(value)
                );

                // Remove plugin values and empty strings
                const userValues = existingValues.filter(
                  (value) => !isFirstLinePropertyValue(value) && value !== ''
                );

                // Check if this exact value already exists (unmarked)
                if (!userValues.includes(valueToAdd)) {
                  if (userValues.length === 0) {
                    // No user values, just our value - insert inline
                    frontmatter[firstLinePropertyKey] = markedValue;
                  } else {
                    // Has user values - add plugin value
                    if (existingPluginIndex === -1) {
                      // No existing plugin value - always add at end
                      userValues.push(markedValue);
                    } else if (this.settings.firstLineProperty.placeLast) {
                      // Has existing plugin value, placeLast ON - move to end
                      userValues.push(markedValue);
                    } else {
                      // Has existing plugin value, placeLast OFF - keep position
                      userValues.splice(existingPluginIndex, 0, markedValue);
                    }
                    frontmatter[firstLinePropertyKey] = userValues;
                  }
                } else {
                  // Value already exists, just restore user values
                  if (userValues.length === 0) {
                    if (this.settings.firstLineProperty.keepEmptyProperty) {
                      frontmatter[firstLinePropertyKey] = null;
                    } else {
                      delete frontmatter[firstLinePropertyKey];
                    }
                  } else if (userValues.length === 1) {
                    frontmatter[firstLinePropertyKey] = userValues[0];
                  } else {
                    frontmatter[firstLinePropertyKey] = userValues;
                  }
                }
              }
            }
          }
        },
        target
      );

      if (written) {
        verboseLog(
          this.plugin,
          `Updated first line property \`${valueToAdd}\` in ${file.path}`
        );
      }
    } catch (error) {
      if (isFileNotFoundError(error)) {
        // File was renamed during operation - this is expected race condition, log as info
        verboseLog(
          this.plugin,
          `Skipping first line property addition - file was renamed during operation: ${file.path}`
        );
      } else {
        // Unexpected error, log it
        console.error(
          `Failed to add first line property to file ${file.path}:`,
          error
        );
      }
      // Don't throw - first line property addition failure shouldn't prevent the rename
    }
  }

  async removeFirstLinePropertyValuesFromFile(
    file: TFile,
    target: SourceEditorTarget | null = null
  ): Promise<void> {
    // No property to clean up - skip before `writeFrontMatter()` touches the
    // note. Values written under a key the user has since cleared or renamed
    // are left in place by design: the plugin stores no history of property
    // names it previously used, and acts only on the property currently named
    // in settings. Cleaning them up would mean writing to a property the user
    // has not authorized.
    if (this.hasNoFirstLineProperty()) {
      return;
    }

    try {
      // Validate file exists and get fresh reference from vault.
      // writeFrontMatter checks again before its processFrontMatter call, which
      // guards against file deletion during activeView.save().
      const currentFile = this.app.vault.getAbstractFileByPath(file.path);
      if (!currentFile || !(currentFile instanceof TFile)) {
        verboseLog(
          this.plugin,
          `Skipping first line property removal - file no longer exists: ${file.path}`
        );
        return;
      }
      file = currentFile;

      const written = await this.writeFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          const firstLinePropertyKeys = this.getFirstLinePropertyKeys();

          // Remove first line property values from all specified properties
          for (const firstLinePropertyKey of firstLinePropertyKeys) {
            if (!(firstLinePropertyKey in frontmatter)) {
              continue;
            }

            const propValue = frontmatter[firstLinePropertyKey];

            // Handle null/empty property
            if (
              propValue === null ||
              propValue === undefined ||
              propValue === ''
            ) {
              if (!this.settings.firstLineProperty.keepEmptyProperty) {
                delete frontmatter[firstLinePropertyKey];
              }
              continue;
            }

            let existingValues: string[] = [];

            // Normalize to array
            if (Array.isArray(propValue)) {
              existingValues = [...(propValue as string[])];
            } else {
              existingValues = [propValue as string];
            }

            // Filter out plugin values (marked with ZWSP) and empty strings
            const filteredValues = existingValues.filter(
              (value) => !isFirstLinePropertyValue(value) && value !== ''
            );

            // Update or remove the property based on remaining values
            if (filteredValues.length === 0) {
              if (!this.settings.firstLineProperty.keepEmptyProperty) {
                // Delete empty property completely
                delete frontmatter[firstLinePropertyKey];
              } else {
                // Keep empty property as null
                frontmatter[firstLinePropertyKey] = null;
              }
            } else if (
              filteredValues.length === 1 &&
              firstLinePropertyKey !== 'aliases'
            ) {
              // For non-aliases properties, convert back to single value if only one remains
              frontmatter[firstLinePropertyKey] = filteredValues[0];
            } else {
              // Keep as array for aliases or multiple values
              frontmatter[firstLinePropertyKey] = filteredValues;
            }
          }
        },
        target
      );

      if (written) {
        verboseLog(
          this.plugin,
          `Removed first line property values from ${file.path}`
        );
      }
    } catch (error) {
      if (isFileNotFoundError(error)) {
        // File was renamed during operation - this is expected race condition, log as info
        verboseLog(
          this.plugin,
          `Skipping first line property removal - file was renamed during operation: ${file.path}`
        );
      } else {
        // Unexpected error, log it
        console.error(
          `Failed to remove first line property values from ${file.path}:`,
          error
        );
      }
    }
  }

  /**
   * Change a note's properties in the editor the caller chose, or in the file.
   * @param file - Note to change
   * @param mutate - Changes the parsed properties in place
   * @param target - Editor showing the note, or null to write the file
   * @returns False when nothing was written: the editor already held the result, or the file is gone
   */
  private async writeFrontMatter(
    file: TFile,
    mutate: (frontmatter: Record<string, unknown>) => void,
    target: SourceEditorTarget | null
  ): Promise<boolean> {
    // A note open in an editor is changed in place, because a file write landing while the user types makes Obsidian merge and show "modified externally"; notes not open in one take the file write.
    if (target) {
      // Marks the change as the plugin's own, so the editor-change it fires does not start another rename pass
      this.plugin.fileStateManager.markEditorSyncing(file.path);
      let changed: boolean;
      try {
        changed = replaceEditorText(
          target.editor,
          applyFrontMatterChange(target.editor.getValue(), mutate)
        );
      } finally {
        this.plugin.fileStateManager.clearEditorSyncing(file.path);
      }
      if (changed) {
        target.requestSave?.();
      }
      return changed;
    }

    // Save any unsaved changes before modifying frontmatter
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file === file) {
      await activeView.save();
    }

    // Re-validate: file could be renamed/deleted during save() above
    const currentFile = this.app.vault.getAbstractFileByPath(file.path);
    if (!currentFile || !(currentFile instanceof TFile)) {
      verboseLog(
        this.plugin,
        `Skipping properties write - file no longer exists: ${file.path}`
      );
      return false;
    }

    // Mark file as having pending metadata cache update
    this.plugin.pendingMetadataUpdates.add(currentFile);
    await this.app.fileManager.processFrontMatter(currentFile, mutate);
    return true;
  }
}
