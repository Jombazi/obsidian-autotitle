// These mirror Templater 2.26.0's `on_file_creation` and `write_template_to_file`, so a Templater change is fixed in one place
import {
  App,
  EventRef,
  MarkdownView,
  TFile,
  getFrontMatterInfo,
  normalizePath,
} from 'obsidian';
import { TIMING } from '../constants/timing';
import type { DebugLogger } from '../types';

/** What `tp.file.cursor()` renders to, matched as Templater's cursor jumper matches it (Templater 2.26.0) minus the named group, which an ES6 target rejects; global, for counting */
export const TEMPLATER_CURSOR_PLACEHOLDER =
  /<%\s*tp\.file\.cursor\((?:-?[0-9]+(?:\.[0-9]+)?)?\)\s*%>/g;

/** Count the cursor placeholders in a text; `String.match` with a global pattern resets its `lastIndex`, so the shared pattern carries no state between calls */
export function countCursorPlaceholders(text: string): number {
  return text.match(TEMPLATER_CURSOR_PLACEHOLDER)?.length ?? 0;
}

/**
 * Extended Workspace interface with custom events
 */
interface WorkspaceWithCustomEvents {
  on(
    name: 'templater:new-note-from-template',
    callback: (data: Record<string, unknown>) => void
  ): EventRef;
  offref(ref: EventRef): void;
}

/**
 * Templater's settings object, or undefined when Templater isn't loaded.
 */
export function getTemplaterSettings(
  app: App
): Record<string, unknown> | undefined {
  const templater = app.plugins.plugins['templater-obsidian'] as
    Record<string, unknown> | undefined;
  return templater?.settings as Record<string, unknown> | undefined;
}

/** Templater's template-matching mode. Replaced the `enable_folder_templates` and
 * `enable_file_templates` booleans, which its settings migration deletes — reading those returns
 * `undefined` on every current install, silently. Independent of the device-local trigger gate:
 * this picks WHICH templates apply, not WHETHER Templater fires. */
export function templaterTriggerMode(app: App): 'folder' | 'regex' | 'none' {
  const mode = getTemplaterSettings(app)?.trigger_on_file_creation_mode;
  return mode === 'folder' || mode === 'regex' ? mode : 'none';
}

/**
 * templater-enabled: Check if Templater plugin is installed and enabled
 */
export function isTemplaterOn(app: App): boolean {
  return 'templater-obsidian' in app.plugins.plugins;
}

/**
 * templater-trigger: Check if Templater's "Trigger on new file creation" is enabled
 */
export function isTemplaterTriggerOn(app: App): boolean {
  // Device-local, NOT in `plugin.settings`: Templater moved this out of the synced settings so
  // that syncing a vault cannot arm code execution on a device the user has not trusted. It
  // gates `on_file_creation` ahead of the mode, so the mode alone does not mean Templater fires.
  const local = app.loadLocalStorage('templater-local-settings') as Record<
    string,
    unknown
  > | null;
  return local?.trigger_on_file_creation === true;
}

/**
 * in-template-folder: Check if file path matches Templater's template folder location
 */
export function isInTemplateFolder(app: App, file: TFile): boolean {
  const templatesFolder = getTemplaterSettings(app)?.templates_folder;
  if (typeof templatesFolder !== 'string') return false;

  // Mirrors Templater's creation handler: a substring test on the normalized folder, not a prefix test, so `Archive/Templates/x.md` counts too; an empty setting normalizes to the root `/`, which skips nothing
  const normalizedFolder = normalizePath(templatesFolder);
  return file.path.includes(normalizedFolder) && normalizedFolder !== '/';
}

/**
 * in-ignored-folder: Check if Templater's "Ignore folders on new file creation" lists a folder this path starts with
 */
export function isInTemplaterIgnoredFolder(app: App, file: TFile): boolean {
  const ignoredFolders = getTemplaterSettings(app)?.ignore_folders_on_creation;
  if (!Array.isArray(ignoredFolders)) return false;

  // Mirrors Templater's creation handler: a plain prefix test on each normalized entry, so `Inbox` also covers `Inbox2/`
  return (ignoredFolders as unknown[]).some((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('folder' in entry) ||
      typeof entry.folder !== 'string'
    ) {
      return false;
    }
    const normalizedFolder = normalizePath(entry.folder);
    return file.path.startsWith(normalizedFolder) && normalizedFolder !== '';
  });
}

/**
 * body-not-empty: Check whether the note holds any text below its properties, as Templater measures it before choosing a new-note template
 */
export function hasBodyForTemplater(content: string): boolean {
  // Mirrors Templater's creation handler: raw length past the properties, so even a lone line break counts and makes Templater run its overwrite commands instead of a new-note template
  return content.length - getFrontMatterInfo(content).contentStart > 0;
}

/**
 * folder-templates-mode: Check if Templater's trigger mode is set to folder templates
 */
export function isFolderTemplatesEnabled(app: App): boolean {
  return templaterTriggerMode(app) === 'folder';
}

/**
 * folder-template-matches: Check if any Templater folder template matches current path
 * Uses Templater's walk-up algorithm (deepest match wins)
 */
export function folderTemplateMatches(app: App, file: TFile): boolean {
  const folderTemplates = getTemplaterSettings(app)?.folder_templates;
  if (!Array.isArray(folderTemplates)) return false;

  let folder = file.parent;
  while (folder) {
    const match = (folderTemplates as unknown[]).find(
      (ft: unknown) =>
        ft &&
        typeof ft === 'object' &&
        'folder' in ft &&
        ft.folder === folder!.path
    );
    if (
      match &&
      typeof match === 'object' &&
      'template' in match &&
      match.template
    ) {
      return true;
    }
    folder = folder.parent;
  }

  return false;
}

/**
 * regex-templates-mode: Check if Templater's trigger mode is set to file regex templates
 */
export function isFileRegexEnabled(app: App): boolean {
  return templaterTriggerMode(app) === 'regex';
}

/**
 * regex-template-matches: Check if any Templater file regex matches current path
 */
export function fileRegexMatches(app: App, file: TFile): boolean {
  const fileTemplates = getTemplaterSettings(app)?.file_templates;
  if (!Array.isArray(fileTemplates)) return false;

  for (const ft of fileTemplates as unknown[]) {
    if (!ft || typeof ft !== 'object') continue;
    try {
      const regex =
        'regex' in ft && typeof ft.regex === 'string'
          ? new RegExp(ft.regex)
          : null;
      if (regex && regex.test(file.path)) {
        return true;
      }
    } catch {
      // Invalid regex - skip
      continue;
    }
  }

  return false;
}

/**
 * templater-event: Wait for Templater event with timeout
 * @param file - The file to wait for
 * @param timeoutMs - Timeout in milliseconds after ctime
 * @param ctime - File creation time (milliseconds since epoch)
 * @param log - Receives the wait's progress
 * @returns The template output the event carries, empty when it carries none, or null when no event arrived in time
 */
export function waitForTemplaterEvent(
  app: App,
  file: TFile,
  timeoutMs: number,
  ctime: number,
  log: DebugLogger
): Promise<string | null> {
  return new Promise((resolve) => {
    let eventFired = false;

    // Calculate how much time has already passed since ctime
    const now = Date.now();
    const elapsed = now - ctime;
    const remainingTime = Math.max(0, timeoutMs - elapsed);

    log(
      `Templater event: ${elapsed}ms elapsed since ctime, ${remainingTime}ms remaining for: ${file.path}`
    );

    // If already past timeout, return immediately
    if (remainingTime === 0) {
      log(
        `Templater event timeout already passed (${timeoutMs}ms after ctime) for: ${file.path}`
      );
      resolve(null);
      return;
    }

    const timeout = window.setTimeout(() => {
      if (!eventFired) {
        log(
          `Templater event timeout (${timeoutMs}ms after ctime) for: ${file.path}`
        );
        resolve(null);
      }
    }, remainingTime);

    // Listen for Templater event
    const eventRef = (app.workspace as unknown as WorkspaceWithCustomEvents).on(
      'templater:new-note-from-template',
      (data: Record<string, unknown>) => {
        if (
          data.file &&
          typeof data.file === 'object' &&
          'path' in data.file &&
          data.file.path === file.path
        ) {
          eventFired = true;
          window.clearTimeout(timeout);
          app.workspace.offref(eventRef);
          log(`Templater event fired for: ${file.path}`);
          resolve(typeof data.content === 'string' ? data.content : '');
        }
      }
    );

    // Clean up event listener if timeout occurs
    // Must outlast the resolve timer above, hence the grace period on top of the same remainingTime
    window.setTimeout(() => {
      if (!eventFired) {
        app.workspace.offref(eventRef);
      }
    }, remainingTime + TIMING.TEMPLATER_EVENT_CLEANUP_GRACE_MS);
  });
}

/**
 * template-wrote-file: Check whether Templater wrote the note's file rather than the editor showing it, as `write_template_to_file` chooses
 */
export function templaterWroteFile(app: App, file: TFile): boolean {
  // Templater writes the editor only for its active file and otherwise uses `vault.process`, so the event's content is then the note's text while its view still shows the old text. Templater reads the whole condition before parsing the template, about 110 ms before the event in the editor branch (measured). A tab switch in that window reads Y for an editor write, which is harmless: the title then goes through the file into a view that is current.
  const templaterActiveFile =
    app.workspace.activeEditor?.file ?? app.workspace.getActiveFile();
  const writesEditor =
    templaterActiveFile?.path === file.path &&
    !!app.workspace.activeEditor?.editor &&
    !!app.workspace.getActiveViewOfType(MarkdownView);
  return !writesEditor;
}

/**
 * template-cursor: Check whether Templater's jump to a cursor placeholder happened, from the placeholders the note lost
 * @param templateOutput - The text the event carries: the parsed template, or the merged note when Templater wrote the file rather than the editor
 * @param noteAfterTemplate - The note as the view shows it after the event
 */
export function templaterJumpedToCursor(
  templateOutput: string,
  noteAfterTemplate: string
): boolean {
  // Templater's jumper runs synchronously right after the event, only with "Automatic jump to cursor" on and the note the active file, and deletes the placeholders it jumps to; one it did not jump to, or left for a later jump (`tp.file.cursor(2)`), stays, so only a drop in the count means a jump
  return (
    countCursorPlaceholders(noteAfterTemplate) <
    countCursorPlaceholders(templateOutput)
  );
}
