import {
  TFile,
  CachedMetadata,
  getAllTags,
  getFrontMatterInfo,
  parseFrontMatterTags,
} from 'obsidian';
import FirstLineIsTitlePlugin from '../../main';
import { TIMING } from '../constants/timing';
import { verboseLog, verboseLogger } from '../utils';
import {
  shouldProcessFile,
  fileHasTargetTags,
  hasPropertyTargets,
  hasTagTargets,
  isListedPropertyKey,
} from '../utils/file-exclusions';
import { EXCLUSION_STRATEGY } from '../types';
import type { TitleCursorPlacement } from '../operations/file-operations';
import {
  fileRegexMatches,
  folderTemplateMatches,
  hasBodyForTemplater,
  isFileRegexEnabled,
  isFolderTemplatesEnabled,
  isInTemplateFolder,
  isInTemplaterIgnoredFolder,
  isOnlyCursorPlaceholders,
  isTemplaterOn,
  isTemplaterTriggerOn,
  templaterJumpedToCursor,
  templaterWroteFile,
  waitForTemplaterEvent,
} from './templater-integration';

/**
 * Context information for file creation decisions
 */
export interface FileCreationContext {
  initialContent: string;
  pluginLoadTime: number;
}

/**
 * Actions to perform based on decision tree evaluation
 */
export interface FileCreationActions {
  shouldMoveCursor: boolean;
  shouldInsertTitle: boolean;
  placeCursorAtEnd: boolean;
  /** Where title insertion leaves the cursor; the delayed cursor pass `shouldMoveCursor` schedules runs only when insertion placed none */
  titleCursor: TitleCursorPlacement;
  /** Text the decision judged, and title insertion starts from: the creation snapshot, or the note as Templater left it after templater-event:Y */
  judgedContent: string;
  /** True only after template-wrote-file:Y: the title goes into the file, since the view still shows older text, and the cursor waits for the view to reload it */
  viewLagsFile: boolean;
  decisionPath: string; // e.g., "feature-enabled:Y → … → folder-template-matches:Y → templater-event:Y → template-wrote-file:N → template-excluded:N → path-excluded-after-template:N → template-cursor:N → features:title → content-below-yaml:N"
}

/** Decision-tree node names, recorded into `decisionPath`. Names rather than numbers: nothing
 * outside this file decodes them, and numbering decayed into gaps and letter suffixes as nodes
 * were inserted. */
type DecisionNode =
  | 'feature-enabled'
  | 'path-excluded'
  | 'content-excluded'
  | 'templater-enabled'
  | 'templater-trigger'
  | 'in-template-folder'
  | 'in-ignored-folder'
  | 'body-not-empty'
  | 'folder-templates-mode'
  | 'folder-template-matches'
  | 'regex-templates-mode'
  | 'regex-template-matches'
  | 'templater-event'
  | 'template-wrote-file'
  | 'template-excluded'
  | 'path-excluded-after-template'
  | 'template-cursor'
  | 'features'
  | 'content-below-yaml'
  | 'cursor-at-end';

type DecisionOutcome = 'Y' | 'N' | 'title' | 'cursor' | 'both';

/** The settings hub's mapping of the enabled features, before a template's own cursor is taken into account */
interface SettingsHubPlan {
  shouldInsertTitle: boolean;
  shouldMoveCursor: boolean;
  placeCursorAtEnd: boolean;
  /** What the plan resolves to, for the decision-path log line */
  resolution: string;
}

/** The `<node>:<outcome>` breadcrumbs of one `determineActions` call; per call rather than on the instance, because the Templater wait lets creations overlap */
type DecisionTrail = string[];

/**
 * Coordinates file creation behavior: decides whether to move the cursor and/or
 * insert a title when a note is created.
 *
 * Consulted only for a note an editor shows within the creation handler's wait (`TIMING.NEW_NOTE_VIEW_WAIT_MS`), one already shown, or one created while a canvas is active: a note created in the background gets no actions at all, by user decision.
 *
 * The node names below are the sole definition of the tree — they are not
 * shorthand for an external diagram — and they are load-bearing: every branch
 * appends `<node>:<outcome>` to `decisionPath`, which is what debug reports are
 * read against. Renaming a node invalidates every previously captured path.
 *
 * Gates, in order (each falls through to the next unless it returns):
 * - feature-enabled: Either feature enabled? No → do nothing.
 * - path-excluded: Path matched by the Excluded files rules? Yes → do nothing.
 * - content-excluded: Tag/property/disable-renaming excluded, judged on real-time content? Yes → do nothing.
 * - templater-enabled: Templater loaded? No → settings hub.
 * - templater-trigger: Templater's trigger on file creation on? No → settings hub.
 * - in-template-folder: Path holds Templater's template folder, as Templater tests it? Yes → settings hub.
 * - in-ignored-folder: Path starts with a folder Templater ignores on creation? Yes → settings hub.
 * - body-not-empty: Creation snapshot holds any text below its properties, whitespace included? Yes → settings hub.
 * - folder-templates-mode: Folder templates on? Yes → folder-template-matches, else regex-templates-mode.
 * - folder-template-matches: A folder template matches this path? Yes → Templater wait, No → settings hub.
 * - regex-templates-mode: File regex templates on? No → settings hub.
 * - regex-template-matches: A file regex matches this path? Yes → Templater wait, No → settings hub.
 * - templater-event: Templater event arrived within the timeout? No → settings hub.
 * - template-wrote-file: Templater wrote the file rather than the editor, the note not being its active file? Yes → the event's text is judged instead of the view's, and the title goes in through the file.
 * - template-excluded: Template carries an excluded tag/property, judged on Obsidian's parse of the judged text? Yes → do nothing.
 * - path-excluded-after-template: Path excluded once the template has run? Yes → do nothing.
 * - template-cursor: Template placed the cursor itself (Templater's jump removed a cursor placeholder from the note)? Both → settings hub, Yes leaving the cursor where the template put it. Always N after template-wrote-file:Y.
 *
 * The Templater gates mirror the checks Templater's own creation handler makes before it applies a new-note template, so a note Templater will fill always waits for it, and a note it will not fill is never held for the timeout.
 *
 * Settings hub (features, cursor-at-end, content-below-yaml) then maps the
 * enabled features onto the final actions: `features:title`, `features:cursor`
 * or `features:both`, with `content-below-yaml` checking for existing content
 * below the YAML, a body of only Templater cursor placeholders counting as none,
 * and `cursor-at-end` reading "Place cursor at line end".
 * After templater-event:Y the hub judges the note as Templater left it, not the creation snapshot.
 */
export class FileCreationCoordinator {
  private plugin: FirstLineIsTitlePlugin;

  constructor(plugin: FirstLineIsTitlePlugin) {
    this.plugin = plugin;
  }

  /**
   * Main orchestrator - evaluates decision tree and returns actions to perform
   */
  async determineActions(
    file: TFile,
    context: FileCreationContext
  ): Promise<FileCreationActions> {
    const trail: DecisionTrail = [];
    const snapshot = context.initialContent;

    // feature-enabled: Is either feature enabled?
    const featuresEnabled = this.isFeatureEnabled();
    if (featuresEnabled === 'neither') {
      this.recordDecisionAndLogOutcome(
        trail,
        'feature-enabled',
        'N',
        'Do nothing (both features disabled)'
      );
      return this.noActions(trail, snapshot);
    }
    this.recordDecision(trail, 'feature-enabled', 'Y');

    // path-excluded runs before content-excluded because a path test is far cheaper than the content gate, which parses YAML and reads the metadata cache
    // path-excluded: Is the path excluded?
    if (this.isPathExcluded(file)) {
      this.recordDecisionAndLogOutcome(
        trail,
        'path-excluded',
        'Y',
        'Do nothing (path excluded)'
      );
      return this.noActions(trail, snapshot);
    }
    this.recordDecision(trail, 'path-excluded', 'N');

    // content-excluded: Is file excluded by tag/property/disable-renaming (content-based, real-time)?
    if (this.isContentExcluded(file, snapshot)) {
      this.recordDecisionAndLogOutcome(
        trail,
        'content-excluded',
        'Y',
        'Do nothing (tag/property/disable-renaming excluded)'
      );
      return this.noActions(trail, snapshot);
    }
    this.recordDecision(trail, 'content-excluded', 'N');

    // The Templater gates run whatever the exclusion settings: a template's setSelection lands after an unwaited title insertion and leaves the cursor at the start of the title line
    // templater-enabled: Is Templater enabled?
    if (!isTemplaterOn(this.plugin.app)) {
      this.recordDecision(trail, 'templater-enabled', 'N');
      return this.proceedToSettingsHub(snapshot, trail);
    }
    this.recordDecision(trail, 'templater-enabled', 'Y');

    // templater-trigger: Is Templater trigger on file creation enabled?
    if (!isTemplaterTriggerOn(this.plugin.app)) {
      this.recordDecision(trail, 'templater-trigger', 'N');
      return this.proceedToSettingsHub(snapshot, trail);
    }
    this.recordDecision(trail, 'templater-trigger', 'Y');

    // in-template-folder: Does path match Template folder location?
    if (isInTemplateFolder(this.plugin.app, file)) {
      this.recordDecision(trail, 'in-template-folder', 'Y');
      return this.proceedToSettingsHub(snapshot, trail);
    }
    this.recordDecision(trail, 'in-template-folder', 'N');

    // in-ignored-folder: Does Templater ignore new notes in this folder?
    if (isInTemplaterIgnoredFolder(this.plugin.app, file)) {
      this.recordDecision(trail, 'in-ignored-folder', 'Y');
      return this.proceedToSettingsHub(snapshot, trail);
    }
    this.recordDecision(trail, 'in-ignored-folder', 'N');

    // body-not-empty: Does the note already hold text Templater would keep?
    if (hasBodyForTemplater(snapshot)) {
      this.recordDecision(trail, 'body-not-empty', 'Y');
      return this.proceedToSettingsHub(snapshot, trail);
    }
    this.recordDecision(trail, 'body-not-empty', 'N');

    // folder-templates-mode: Is the trigger mode set to folder templates?
    if (isFolderTemplatesEnabled(this.plugin.app)) {
      this.recordDecision(trail, 'folder-templates-mode', 'Y');

      // folder-template-matches: Do any Folder fields match current path?
      if (folderTemplateMatches(this.plugin.app, file)) {
        this.recordDecision(trail, 'folder-template-matches', 'Y');
        // Wait for Templater event (templater-event)
        return await this.handleTemplaterEvent(file, snapshot, trail);
      }
      this.recordDecision(trail, 'folder-template-matches', 'N');
      // folder-template-matches:N skips regex-templates-mode: once folder templates are on, Templater resolves the folder template and never falls back to a file regex, so there is nothing left to match
      return this.proceedToSettingsHub(snapshot, trail);
    }
    this.recordDecision(trail, 'folder-templates-mode', 'N');

    // regex-templates-mode: Is the trigger mode set to file regex templates? (only reached if folder-templates-mode:N)
    if (isFileRegexEnabled(this.plugin.app)) {
      this.recordDecision(trail, 'regex-templates-mode', 'Y');

      // regex-template-matches: Do any File regex fields match?
      if (fileRegexMatches(this.plugin.app, file)) {
        this.recordDecision(trail, 'regex-template-matches', 'Y');
        // Wait for Templater event (templater-event)
        return await this.handleTemplaterEvent(file, snapshot, trail);
      }
      this.recordDecision(trail, 'regex-template-matches', 'N');
    } else {
      this.recordDecision(trail, 'regex-templates-mode', 'N');
    }

    // No Templater template matched - proceed to settings hub
    return this.proceedToSettingsHub(snapshot, trail);
  }

  /**
   * templater-event, template-wrote-file, template-excluded, path-excluded-after-template, template-cursor: Wait for the template, then judge the note it left
   * @param snapshot - The creation snapshot, judged instead when no event arrives
   */
  private async handleTemplaterEvent(
    file: TFile,
    snapshot: string,
    trail: DecisionTrail
  ): Promise<FileCreationActions> {
    // templater-event: Wait for Templater event
    const templateOutput = await waitForTemplaterEvent(
      this.plugin.app,
      file,
      TIMING.TEMPLATER_EVENT_TIMEOUT_MS,
      file.stat.ctime,
      verboseLogger(this.plugin)
    );

    if (templateOutput === null) {
      this.recordDecision(trail, 'templater-event', 'N');
      return this.proceedToSettingsHub(snapshot, trail);
    }
    this.recordDecision(trail, 'templater-event', 'Y');

    // template-wrote-file: Did Templater write the file rather than the editor showing the note?
    const viewLagsFile = templaterWroteFile(this.plugin.app, file);
    this.recordDecision(trail, 'template-wrote-file', viewLagsFile ? 'Y' : 'N');

    // Read before the metadata parse below awaits, so the placeholder count sees the note as Templater's jumper left it; never after a file write, whose view still shows the text from before it
    const noteAfterTemplate = viewLagsFile
      ? null
      : this.readNoteAfterTemplate(file);
    // After a file write the event carries the merged note; otherwise the creation snapshot stands in when no view shows the note any more
    const judgedContent = viewLagsFile
      ? templateOutput
      : (noteAfterTemplate ?? snapshot);

    // template-excluded: Does template have excluded tag/property?
    const templateMetadata = await this.parseTemplateMetadata(
      file,
      judgedContent
    );
    if (this.templateHasExclusions(file, templateMetadata)) {
      this.recordDecisionAndLogOutcome(
        trail,
        'template-excluded',
        'Y',
        'Do nothing (template has exclusions)'
      );
      return this.noActions(trail, judgedContent, viewLagsFile);
    }
    this.recordDecision(trail, 'template-excluded', 'N');

    // path-excluded-after-template: Templater can rename or move the note across an entry during the templater-event wait, so the path that path-excluded cleared may no longer be the file's.
    // Not folded into template-excluded:Y: captured debug paths have to keep telling the two causes apart. The mirror case — excluded at creation, cleared by the template — is deliberately not re-opened, since path-excluded returns before the wait ever starts.
    if (this.isPathExcluded(file)) {
      this.recordDecisionAndLogOutcome(
        trail,
        'path-excluded-after-template',
        'Y',
        'Do nothing (path excluded after template)'
      );
      return this.noActions(trail, judgedContent, viewLagsFile);
    }
    this.recordDecision(trail, 'path-excluded-after-template', 'N');

    // template-cursor: Did the template put the cursor in place itself?
    // Not counted after a file write: Templater's jumper runs only for its active file, which the note was not
    const templateCursor =
      !viewLagsFile &&
      this.templatePlacedCursor(templateOutput, noteAfterTemplate);
    this.recordDecision(trail, 'template-cursor', templateCursor ? 'Y' : 'N');

    return this.proceedToSettingsHub(
      judgedContent,
      trail,
      templateCursor,
      viewLagsFile
    );
  }

  /**
   * features, content-below-yaml, cursor-at-end: Process settings hub and determine final actions
   * @param content - Text the hub judges, which title insertion then starts from
   * @param templateCursor - True when the template placed the cursor itself, so no FLIT cursor move overrides it
   * @param viewLagsFile - True after template-wrote-file:Y
   */
  private proceedToSettingsHub(
    content: string,
    trail: DecisionTrail,
    templateCursor = false,
    viewLagsFile = false
  ): FileCreationActions {
    const plan = this.planFromSettings(content, trail);
    const cursorEndsOnTitleLine =
      plan.shouldMoveCursor && plan.placeCursorAtEnd;

    if (!templateCursor) {
      this.logOutcome(trail, plan.resolution);
      return {
        shouldMoveCursor: plan.shouldMoveCursor,
        shouldInsertTitle: plan.shouldInsertTitle,
        placeCursorAtEnd: plan.placeCursorAtEnd,
        // Title insertion places the cursor itself only where the delayed pass would put it at the line end anyway, which then skips
        titleCursor: cursorEndsOnTitleLine ? 'line-end' : 'none',
        judgedContent: content,
        viewLagsFile,
        decisionPath: this.pathString(trail),
      };
    }

    // The title decision stands; only the cursor moves are dropped, so a plan without one keeps its own resolution
    this.logOutcome(
      trail,
      plan.shouldMoveCursor
        ? `${plan.shouldInsertTitle ? 'Insert title' : 'Do nothing'} (cursor left where the template put it)`
        : plan.resolution
    );
    return {
      shouldMoveCursor: false,
      shouldInsertTitle: plan.shouldInsertTitle,
      placeCursorAtEnd: false,
      // A template cursor where the title goes is moved to the title line end only where FLIT's own placement would have put it there; otherwise it stays where CodeMirror maps it
      titleCursor: cursorEndsOnTitleLine ? 'keep-template-cursor' : 'none',
      judgedContent: content,
      viewLagsFile,
      decisionPath: this.pathString(trail),
    };
  }

  /**
   * features, content-below-yaml, cursor-at-end: Map the enabled features onto actions, recording each node without logging
   * @param content - Text judged for content below the properties
   */
  private planFromSettings(
    content: string,
    trail: DecisionTrail
  ): SettingsHubPlan {
    const featuresEnabled = this.isFeatureEnabled();

    if (featuresEnabled === 'title') {
      // Title only
      this.recordDecision(trail, 'features', 'title');

      // content-below-yaml: Has content below YAML?
      if (this.hasContentBelowYaml(content)) {
        this.recordDecision(trail, 'content-below-yaml', 'Y');
        return {
          shouldMoveCursor: false,
          shouldInsertTitle: false,
          placeCursorAtEnd: false,
          resolution: 'Do nothing (has content)',
        };
      }
      this.recordDecision(trail, 'content-below-yaml', 'N');
      return {
        shouldMoveCursor: false,
        shouldInsertTitle: true,
        placeCursorAtEnd: false,
        resolution: 'Insert title',
      };
    } else if (featuresEnabled === 'cursor') {
      // Cursor only
      this.recordDecision(trail, 'features', 'cursor');

      // cursor-at-end: Is Place cursor at line end ON?
      if (this.isPlaceCursorAtEndEnabled()) {
        this.recordDecision(trail, 'cursor-at-end', 'Y');
        return {
          shouldMoveCursor: true,
          shouldInsertTitle: false,
          placeCursorAtEnd: true,
          resolution: 'Move cursor + Place at end',
        };
      } else {
        this.recordDecision(trail, 'cursor-at-end', 'N');
        return {
          shouldMoveCursor: true,
          shouldInsertTitle: false,
          placeCursorAtEnd: false,
          resolution: 'Move cursor',
        };
      }
    } else {
      // Both features enabled
      this.recordDecision(trail, 'features', 'both');

      // cursor-at-end: Is Place cursor at line end ON?
      if (this.isPlaceCursorAtEndEnabled()) {
        this.recordDecision(trail, 'cursor-at-end', 'Y');

        // content-below-yaml: Has content below YAML?
        if (this.hasContentBelowYaml(content)) {
          this.recordDecision(trail, 'content-below-yaml', 'Y');
          return {
            shouldMoveCursor: true,
            shouldInsertTitle: false,
            placeCursorAtEnd: true,
            resolution: 'Move cursor + Place at end',
          };
        } else {
          this.recordDecision(trail, 'content-below-yaml', 'N');
          return {
            shouldMoveCursor: true,
            shouldInsertTitle: true,
            placeCursorAtEnd: true,
            resolution: 'Insert title + Move cursor + Place at end',
          };
        }
      } else {
        this.recordDecision(trail, 'cursor-at-end', 'N');
        return {
          shouldMoveCursor: true,
          shouldInsertTitle: true,
          placeCursorAtEnd: false,
          resolution: 'Insert title + Move cursor',
        };
      }
    }
  }

  // ============================================================================
  // Decision Node Implementations (Private Methods)
  // ============================================================================

  /**
   * feature-enabled: Check which features are enabled
   */
  private isFeatureEnabled(): 'both' | 'cursor' | 'title' | 'neither' {
    const moveCursor = this.plugin.settings.core.moveCursorToFirstLine;
    const insertTitle = this.plugin.settings.core.insertTitle;

    if (moveCursor && insertTitle) return 'both';
    if (moveCursor) return 'cursor';
    if (insertTitle) return 'title';
    return 'neither';
  }

  /**
   * path-excluded, path-excluded-after-template: Check the Excluded files rules, the same ones the rename path enforces
   */
  private isPathExcluded(file: TFile): boolean {
    // Path-only overrides on the shared gate: a local matcher drifted from it before
    return !shouldProcessFile(file, this.plugin.settings, this.plugin.app, {
      exclusionOverrides: {
        ignoreExcludedTags: true,
        ignoreExcludedProperties: true,
      },
      log: verboseLogger(this.plugin),
    });
  }

  /**
   * content-excluded: Check tag/property/disable-renaming exclusion using real-time content.
   * Runs the same evaluation the rename path runs, so the title is inserted and the cursor
   * moved exactly when renaming is allowed for this file, and not otherwise.
   */
  private isContentExcluded(file: TFile, initialContent: string): boolean {
    return this.plugin.fileOperations.isFileExcludedForCursorPositioning(
      file,
      initialContent,
      // path-excluded already ran this same path check through this same gate: an optimization, not a semantic difference
      { ignoreExcludedFiles: true }
    );
  }

  /**
   * Read the note as Templater left it, for every gate after templater-event:Y
   * @returns The text the view showing the note holds, or null when none shows it any more
   */
  private readNoteAfterTemplate(file: TFile): string | null {
    // No view hint: the wait can outlast the leaf the creation handler resolved
    const view = this.plugin.fileOperations.resolveMarkdownViewForFile(
      file,
      null
    );
    return view ? view.getViewData() : null;
  }

  /**
   * template-cursor: Check whether Templater's jump to a cursor placeholder happened
   * @param templateOutput - The text the event carries: the parsed template, or the merged note when Templater wrote the file rather than the editor
   * @param noteAfterTemplate - The note as the view shows it after the event, or null when no view shows it
   */
  private templatePlacedCursor(
    templateOutput: string,
    noteAfterTemplate: string | null
  ): boolean {
    // The jumper needs the note in an editor, so with no view it cannot have run
    if (noteAfterTemplate === null) return false;
    return templaterJumpedToCursor(templateOutput, noteAfterTemplate);
  }

  /**
   * template-excluded: Parse the judged text's metadata as the metadata cache parses a note
   * @param judgedContent - Text template-excluded judges
   * @returns The parsed metadata, or the file's cache when the parse fails
   */
  private async parseTemplateMetadata(
    file: TFile,
    judgedContent: string
  ): Promise<CachedMetadata | null> {
    // The file's cache has not indexed the template at the event: it fills 4–7 ms later (measured)
    const metadata = await this.plugin.app.metadataCache.computeMetadataAsync(
      new TextEncoder().encode(judgedContent).buffer
    );
    if (metadata) return metadata;
    // Undefined only on a metadata worker error; empty text resolves `{}`, which is judged as it stands
    verboseLog(
      this.plugin,
      `Template metadata parse failed for ${file.path}, judging the metadata cache instead`
    );
    return this.plugin.app.metadataCache.getFileCache(file);
  }

  /**
   * template-excluded: Check if template itself has excluded tags/properties.
   * Re-checks after Templater expansion, which can add tags or properties the file did not carry at content-excluded.
   * @param metadata - The judged text's metadata, from `parseTemplateMetadata`
   */
  private templateHasExclusions(
    file: TFile,
    metadata: CachedMetadata | null
  ): boolean {
    try {
      const frontmatter = metadata?.frontmatter;
      const exclusions = this.plugin.settings.exclusions;

      if (hasTagTargets(this.plugin.settings)) {
        const hasListedTag = fileHasTargetTags(
          file,
          this.plugin.settings,
          this.plugin.app,
          { metadata: metadata ?? undefined }
        );

        if (
          exclusions.tagScopeStrategy === EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT
        ) {
          // Whitelist mode: a template that carries tags but none of the listed ones is excluded
          if (this.templateHasAnyTagInScope(metadata) && !hasListedTag) {
            return true;
          }
        } else if (hasListedTag) {
          return true;
        }
      }

      if (hasPropertyTargets(this.plugin.settings) && frontmatter) {
        const allPropKeys = Object.keys(frontmatter);
        // template-excluded gates on the property key alone, by plain name or name pattern; configured values are not part of the template rule
        const hasListedProp = allPropKeys.some((key) =>
          isListedPropertyKey(key, this.plugin.settings)
        );

        if (
          exclusions.propertyScopeStrategy ===
          EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT
        ) {
          // Whitelist mode: a template that carries properties but none of the listed ones is excluded
          if (allPropKeys.length > 0 && !hasListedProp) {
            return true;
          }
        } else if (hasListedProp) {
          return true;
        }
      }

      return false;
    } catch (error) {
      verboseLog(this.plugin, `Error checking template exclusions: ${error}`);
      return false;
    }
  }

  /**
   * template-excluded whitelist half: does the template carry any tags at all, within the configured scope?
   * getAllTags combines frontmatter and inline tags; cache.tags is inline-only, so the narrower
   * scopes have to be read from their own source rather than filtered out of the combined list.
   */
  private templateHasAnyTagInScope(cache: CachedMetadata | null): boolean {
    if (!cache) return false;

    const mode = this.plugin.settings.exclusions.tagMatchingMode;
    if (mode === 'In note body only') {
      return (cache.tags?.length ?? 0) > 0;
    }
    if (mode === 'In Properties only') {
      return (parseFrontMatterTags(cache.frontmatter) ?? []).length > 0;
    }
    return (getAllTags(cache)?.length ?? 0) > 0;
  }

  /**
   * content-below-yaml: Check if file has content below YAML (excluding bare heading syntax and a body of only Templater cursor placeholders)
   */
  private hasContentBelowYaml(content: string): boolean {
    const fmInfo = getFrontMatterInfo(content);
    const contentBelowYaml = content.substring(fmInfo.contentStart).trim();
    const isBareHeading = /^#{1,6}\s*$/.test(contentBelowYaml);

    // A cursor placeholder is Templater's transient marker, not note content, so a body of only placeholders counts as none whatever "Strip Templater markup" says
    return !isOnlyCursorPlaceholders(contentBelowYaml) && !isBareHeading;
  }

  /**
   * cursor-at-end: Check if "Place cursor at line end" setting is enabled
   */
  private isPlaceCursorAtEndEnabled(): boolean {
    return this.plugin.settings.core.placeCursorAtLineEnd === true;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Helper to return no-action result
   * @param judgedContent - Text the decision judged
   * @param viewLagsFile - True after template-wrote-file:Y
   */
  private noActions(
    trail: DecisionTrail,
    judgedContent: string,
    viewLagsFile = false
  ): FileCreationActions {
    return {
      shouldMoveCursor: false,
      shouldInsertTitle: false,
      placeCursorAtEnd: false,
      titleCursor: 'none',
      judgedContent,
      viewLagsFile,
      decisionPath: this.pathString(trail),
    };
  }

  /**
   * Append a decision node result to the breadcrumb. Silent by design: the
   * intermediate gates are only meaningful as part of a full path.
   */
  private recordDecision(
    trail: DecisionTrail,
    node: DecisionNode,
    outcome: DecisionOutcome
  ): void {
    trail.push(`${node}:${outcome}`);
  }

  /**
   * Append a decision node result and log the path it resolved to. Reserved for
   * branches that settle the outcome, so one file creation logs one line.
   */
  private recordDecisionAndLogOutcome(
    trail: DecisionTrail,
    node: DecisionNode,
    outcome: DecisionOutcome,
    resolution: string
  ): void {
    this.recordDecision(trail, node, outcome);
    this.logOutcome(trail, resolution);
  }

  /**
   * Log the path a creation resolved to. Called once per file creation, by the branch that settles it.
   */
  private logOutcome(trail: DecisionTrail, resolution: string): void {
    verboseLog(
      this.plugin,
      `[FileCreation] Decision path: ${this.pathString(trail)} → ${resolution}`
    );
  }

  /**
   * Join a decision trail into the `decisionPath` string
   */
  private pathString(trail: DecisionTrail): string {
    return trail.join(' → ');
  }
}
