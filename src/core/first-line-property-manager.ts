import { TFile, MarkdownView, getFrontMatterInfo, parseYaml } from 'obsidian';
import { ExclusionOverrides, PluginSettings } from '../types';
import { verboseLog, verboseLogger } from '../utils';
import { shouldProcessFile } from '../utils/file-exclusions';
import { frontmatterHasDisableProperty } from '../utils/disable-property';
import {
  extractTitle,
  applyTitleCase,
  isUntitledName,
} from '../utils/title-extraction';
import {
  TitleSource,
  findTitleSource,
  lineSourceFromText,
} from '../utils/title-source';
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
import { applyCustomReplacementRules } from '../utils/custom-replacement-rules';
import { truncateWithEllipsis } from '../utils/string-processing';
import FirstLineIsTitle from '../../main';

const ZWSP = '\u200B';

/** Check if a value is the plugin-written first line property value (exactly wrapped by ZWSP markers) */
function isFirstLinePropertyValue(value: unknown): boolean {
  return (
    typeof value === 'string' && value.startsWith(ZWSP) && value.endsWith(ZWSP)
  );
}

/**
 * Whether a property already holds what `writeFirstLinePropertyValue` would leave in it, so the write can be skipped.
 * @param existingValues - The property's values as a list
 * @param value - Value without its markers
 * @param placeLast - Whether the plugin's value belongs at the end
 */
function holdsWrittenValue(
  existingValues: unknown[],
  value: string,
  placeLast: boolean
): boolean {
  const pluginValues = existingValues.filter(isFirstLinePropertyValue);
  // The write keeps a plain copy of the value the user wrote and drops every plugin value beside it, a stale one included
  if (existingValues.includes(value)) {
    return pluginValues.length === 0;
  }
  return (
    pluginValues.length === 1 &&
    pluginValues[0] === ZWSP + value + ZWSP &&
    (!placeLast ||
      isFirstLinePropertyValue(existingValues[existingValues.length - 1]))
  );
}

/** A property's raw value as a list: no value is an empty list, a single value a list of one. */
function toValueList(raw: unknown): unknown[] {
  if (raw === null || raw === undefined || raw === '') {
    return [];
  }
  return Array.isArray(raw) ? [...(raw as unknown[])] : [raw];
}

/** A note's properties block, parsed once per first line property pass */
type ParsedPropertiesBlock =
  | { state: 'absent' }
  | { state: 'parsed'; frontmatter: Record<string, unknown> | null }
  | { state: 'malformed' };

/**
 * Parse the properties block at the top of a note's text.
 * @param content - Note text
 * @returns `absent` without a block, `malformed` when its YAML does not parse, otherwise the parsed value, which is null for an empty block
 */
function parsePropertiesBlock(content: string): ParsedPropertiesBlock {
  const frontmatterInfo = getFrontMatterInfo(content);
  if (!frontmatterInfo.exists) {
    return { state: 'absent' };
  }
  try {
    const parsed = parseYaml(frontmatterInfo.frontmatter) as unknown;
    return {
      state: 'parsed',
      frontmatter:
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : null,
    };
  } catch {
    return { state: 'malformed' };
  }
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
   * reaches `writeFrontMatter()`, which saves the active view and reads the note to accomplish nothing.
   */
  private hasNoFirstLineProperty(): boolean {
    return !hasFirstLinePropertyName(this.settings);
  }

  /**
   * Bring the first line property in line with the note's title source: write its value, or remove the plugin's value when the source yields none.
   * @param file - Note to update
   * @param providedContent - Note text to read the line from, ahead of the editor and the file
   * @param target - Editor to write into, or null to write the file
   * @param exclusionOverrides - Exclusion rules to ignore, as the manual rename command passes them; the rename-blocking property is never overridden
   * @returns True when the property holds the value after the call, false when it was removed or skipped
   */
  async updateFirstLinePropertyIfNeeded(
    file: TFile,
    providedContent?: string,
    target?: SourceEditorTarget | null,
    exclusionOverrides?: ExclusionOverrides
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

      // Read once, ahead of every check, so the disable-property check and the update judge the same text
      const content = await readFileContent(this.plugin, file, {
        providedContent,
        providedEditor: target?.editor,
      });

      if (!content || content.trim() === '') {
        return false;
      }

      // Parsed once: the disable-property check and the existing-value check both read it
      const propertiesBlock = parsePropertiesBlock(content);

      // Check disable property FIRST - this cannot be overridden by any command
      // Content first: the editor is ahead of the cache by up to Obsidian's autosave delay. The cache decides when content has no parseable frontmatter, failing closed as resolveCurrentFrontmatter does.
      const frontmatterForDisableCheck =
        propertiesBlock.state === 'parsed' && propertiesBlock.frontmatter
          ? propertiesBlock.frontmatter
          : this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (
        frontmatterHasDisableProperty(
          frontmatterForDisableCheck ?? {},
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

      // The same walk the rename reads, so both agree on where the properties block ends and which block the title comes from (card links, code blocks, tables); read before the exclusion check, which, as the rename's does, reads tags typed into it ahead of the metadata cache
      const titleSource = findTitleSource(
        lineSourceFromText(content),
        this.settings,
        verboseLogger(this.plugin)
      );

      // Only text whose tags Obsidian will index passes, so a tag in code, a card link's title or after an HTML comment block never excludes the note
      if (
        !shouldProcessFile(file, this.settings, this.app, {
          exclusionOverrides,
          log: verboseLogger(this.plugin),
          titleLine: titleSource?.tagsIndexed ? titleSource.text : undefined,
        })
      ) {
        return false;
      }

      if (titleSource === null) {
        await this.removeFirstLinePropertyValuesFromFile(file, target ?? null);
        return false;
      }

      // Frontmatter from fresh editor content instead of stale cache
      // This prevents race conditions where cache hasn't updated yet during YAML edits
      if (propertiesBlock.state === 'malformed') {
        // YAML is malformed (e.g., user is mid-typing) - skip first line property update until valid
        verboseLog(
          this.plugin,
          `Skipping first line property update - malformed YAML in ${file.path}`
        );
        return false;
      }
      const frontmatter =
        propertiesBlock.state === 'parsed' ? propertiesBlock.frontmatter : null;

      const value = this.computeFirstLinePropertyValue(titleSource);
      if (value === null) {
        verboseLog(
          this.plugin,
          `Removing first line property values - no meaningful value in: ${titleSource.text}`
        );
        await this.removeFirstLinePropertyValuesFromFile(file, target ?? null);
        return false;
      }

      // Compares the value that would be written, so the setting's "first line and title are identical" means what the property would show.
      const titleToCompare = file.basename.trim();
      if (
        this.settings.firstLineProperty.addOnlyIfTitleDiffers &&
        value.trim() === titleToCompare
      ) {
        verboseLog(
          this.plugin,
          `Removing first line property values - value matches the title: "${value}" = "${titleToCompare}"`
        );
        await this.removeFirstLinePropertyValuesFromFile(file, target ?? null);
        return false;
      }

      const allPropertiesHoldValue = this.getFirstLinePropertyKeys().every(
        (firstLinePropertyKey) =>
          holdsWrittenValue(
            toValueList(frontmatter?.[firstLinePropertyKey]),
            value,
            this.settings.firstLineProperty.placeLast
          )
      );

      if (allPropertiesHoldValue) {
        verboseLog(
          this.plugin,
          `File ${file.path} already has correct first line property value in all properties`
        );
        return true;
      }

      try {
        verboseLog(
          this.plugin,
          `Adding first line property to ${file.path} - no correct value found`
        );
        await this.writeFirstLinePropertyValue(file, value, target ?? null);
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

  /**
   * The value the first line property should hold for a title source, the single pipeline both the "already correct" check and the write read.
   * @param titleSource - Where the title comes from
   * @returns The value without its markers, or null when the source yields no value worth holding
   */
  private computeFirstLinePropertyValue(
    titleSource: TitleSource
  ): string | null {
    const titleSourceText = titleSource.text;
    // Code is shown as typed, but its indentation would land in the property as a quoted scalar.
    let value = titleSource.raw ? titleSourceText.trim() : titleSourceText;
    if (
      this.settings.markupStripping.applyCustomReplacementsInFirstLineProperty
    ) {
      value = applyCustomReplacementRules(
        value,
        this.settings.customReplacements.rules
      );
    }
    // Code and a callout's default title skip markup stripping; title case still applies, as extractTitle applies it last.
    value = titleSource.raw
      ? applyTitleCase(value, this.settings)
      : extractTitle(value, this.settings, {
          skipMarkupStripping:
            !this.settings.markupStripping.stripMarkupInFirstLineProperty,
        });
    if (this.settings.firstLineProperty.truncate) {
      value = truncateWithEllipsis(value, this.settings.core.charCount);
    }

    // An empty, whitespace-only or ellipsis-only value (from extreme truncation) carries nothing worth showing.
    if (value.trim() === '' || value.trim() === '…') {
      return null;
    }

    // Prevent "Untitled" or "Untitled n" values UNLESS the title source is literally that.
    // Markup that reduces to nothing yields "Untitled": empty headings (`#`), empty list markers (`- `), template syntax (`<% tp.file.cursor() %>`).
    // A synthetic source (lineIndex -1) spelling Untitled is the walk's own fallback, never a line the note holds.
    const sourceIsLiterallyUntitled =
      titleSource.lineIndex >= 0 && isUntitledName(titleSourceText.trim());
    if (isUntitledName(value.trim()) && !sourceIsLiterallyUntitled) {
      return null;
    }

    return value;
  }

  /**
   * Write the value into every first line property, keeping the user's own values.
   * @param file - Note to write
   * @param value - Value without its markers
   * @param target - Editor to write into, or null to write the file
   */
  private async writeFirstLinePropertyValue(
    file: TFile,
    value: string,
    target: SourceEditorTarget | null
  ): Promise<void> {
    try {
      const markedValue = ZWSP + value + ZWSP;
      const firstLinePropertyKeys = this.getFirstLinePropertyKeys();
      // With no properties block yet the callback receives `{}` and creates each property holding the value alone.
      const written = await this.writeFrontMatter(
        file,
        (frontmatter: Record<string, unknown>) => {
          for (const firstLinePropertyKey of firstLinePropertyKeys) {
            const existingValues = toValueList(
              frontmatter[firstLinePropertyKey]
            );
            const existingPluginIndex = existingValues.findIndex(
              isFirstLinePropertyValue
            );
            const userValues = existingValues.filter(
              (existing) =>
                !isFirstLinePropertyValue(existing) && existing !== ''
            );

            // The user already holds the value unmarked, so the plugin's own copy would only duplicate it.
            if (!userValues.includes(value)) {
              if (
                existingPluginIndex === -1 ||
                this.settings.firstLineProperty.placeLast
              ) {
                userValues.push(markedValue);
              } else {
                userValues.splice(existingPluginIndex, 0, markedValue);
              }
            }
            this.storeValues(frontmatter, firstLinePropertyKey, userValues);
          }
        },
        target
      );

      if (written) {
        verboseLog(
          this.plugin,
          `Updated first line property \`${value}\` in ${file.path}`
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

  /**
   * Store a property's values in the shape Obsidian shows them.
   * @param frontmatter - Parsed properties, changed in place
   * @param key - Property to store
   * @param values - Values the property should hold
   */
  private storeValues(
    frontmatter: Record<string, unknown>,
    key: string,
    values: unknown[]
  ): void {
    if (values.length === 0) {
      if (this.settings.firstLineProperty.keepEmptyProperty) {
        frontmatter[key] = null;
      } else {
        delete frontmatter[key];
      }
      return;
    }
    // 'aliases' is Obsidian's own list property, so it stays a list even with one value; other properties take one value inline.
    frontmatter[key] =
      values.length === 1 && key !== 'aliases' ? values[0] : values;
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

          for (const firstLinePropertyKey of firstLinePropertyKeys) {
            const existingValues = toValueList(
              frontmatter[firstLinePropertyKey]
            );
            // A property holding no plugin value keeps its exact value, an empty one the user wrote included.
            if (!existingValues.some(isFirstLinePropertyValue)) {
              continue;
            }
            this.storeValues(
              frontmatter,
              firstLinePropertyKey,
              existingValues.filter(
                (existing) =>
                  !isFirstLinePropertyValue(existing) && existing !== ''
              )
            );
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
   * @param mutate - Changes the parsed properties in place; runs once on a copy to detect a no-op, and again inside the file write
   * @param target - Editor showing the note, or null to write the file
   * @returns False when nothing was written: the editor or file already held the result, or the file is gone
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

    // Read after the save, so the no-op check compares against the text the user sees; marked pending only past it, so only a note a write is reaching is marked.
    const text = await this.app.vault.read(currentFile);
    if (applyFrontMatterChange(text, mutate) === text) {
      verboseLog(
        this.plugin,
        `Skipping properties write - already holds the result: ${file.path}`
      );
      return false;
    }

    // Read by the save handlers, which leave the update this write triggers alone
    this.plugin.fileStateManager.markPendingMetadataUpdate(currentFile.path);
    await this.app.fileManager.processFrontMatter(currentFile, mutate);
    return true;
  }
}
