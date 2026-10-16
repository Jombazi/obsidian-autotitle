import {
  App,
  ExtraButtonComponent,
  Notice,
  Setting,
  SettingDefinitionRender,
  TFile,
} from 'obsidian';
import { PluginSettings, ProcessFileOptions, RenameOutcome } from '../types';
import { resolveFileNameChar } from '../utils/string-processing';
import { isPatternEntry } from '../utils/exclusion-pattern';
import { getCurrentLocale, t } from '../i18n';

/** How long typing in a settings text field waits after the last keystroke before it saves or applies. */
export const TYPED_SETTING_DEBOUNCE_MS = 500;

export interface FirstLineIsTitlePlugin {
  app: App;
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  /** Replaces every setting with `next`, runs the side effects of whatever changed, and saves; resolves false, with the previous settings back in place, when the save fails. Takes ownership of `next`. */
  replaceSettings(next: PluginSettings): Promise<boolean>;
  /** Saves `TYPED_SETTING_DEBOUNCE_MS` after the last call; for text fields, which would otherwise write on every keystroke. */
  requestSaveSettings(): void;
  /** Writes a save `requestSaveSettings` still holds, at once. */
  flushSettingsSave(): void;
  /** Writes a timestamped settings backup at the vault root and resolves with its path, or `null` when the write failed. Declared here because the import modal types the plugin through this interface. */
  writeSettingsBackup(contents: string): Promise<string | null>;
  /** Writes a new timestamped settings file at the vault root and resolves with its path, rejecting with the last write error when none could be created. Declared here for the export modal, which saves there on mobile. */
  createSettingsFileAtVaultRoot(contents: string): Promise<string>;
  debugLog(settingName: string, value: unknown): void;
  renameEngine: {
    processFile(
      file: TFile,
      options?: ProcessFileOptions
    ): Promise<RenameOutcome>;
  };
  propertyManager: { ensurePropertyTypeIsCheckbox(): Promise<void> };
  updatePropertyVisibility(): void;
  getCurrentTimestamp(): string;
  outputAllSettings(): void;
  cacheManager: {
    clearReservedPaths(): void;
  };
}

/** Saves, showing a warning notice when the write fails; resolves whether it succeeded. */
export async function saveSettingsOrWarn(
  plugin: Pick<FirstLineIsTitlePlugin, 'saveSettings'>
): Promise<boolean> {
  try {
    await plugin.saveSettings();
    return true;
  } catch {
    showNotice(t('settings.errors.saveFailed'), 'warning');
    return false;
  }
}

/** A notice tinted the way Obsidian tints its own warnings and confirmations; `duration` is `Notice`'s own, so 0 keeps it up until dismissed and omitting it takes Obsidian's default. Notice copy, here and at every bare `new Notice`, in every locale: a one-sentence notice ends without a period, a notice of two or more sentences ends with one, and a progress notice keeps its "...". A quoted name takes curly “…” in English and straight "…" in Russian (the style Obsidian's own Russian text uses most), and a #tag is never quoted. */
export function showNotice(
  message: string,
  kind: 'warning' | 'success',
  duration?: number
): void {
  const notice = new Notice(message, duration);
  notice.containerEl.addClass(
    kind === 'warning' ? 'mod-warning' : 'mod-success'
  );
}

/** Strips forbidden characters, and a leading dot, as they are typed, through the rule `processForbiddenChars` applies, so a field never accepts what a name refuses. */
export function addForbiddenCharProtection(
  inputElement: HTMLInputElement
): void {
  inputElement.addEventListener('input', (e) => {
    const inputEl = e.target as HTMLInputElement;
    const value = inputEl.value;

    let filteredValue = '';
    for (const char of value) {
      // No replacements: the field holds a replacement itself, so a forbidden character is only removed; a dot is forbidden where only whitespace precedes it, as in a name
      const outcome = resolveFileNameChar(
        char,
        filteredValue.trim() === '',
        null
      );
      if (outcome.kind === 'keep') {
        filteredValue += char;
      }
    }
    if (filteredValue !== value) {
      inputEl.value = filteredValue;
      const cursorPos = Math.min(
        inputEl.selectionStart || 0,
        filteredValue.length
      );
      inputEl.setSelectionRange(cursorPos, cursorPos);
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

/** Adds a row's Edit button, drawn as Obsidian's own Maps settings draw theirs. */
export function addEditButton(setting: Setting, editEntry: () => void): void {
  setting.addExtraButton((button) =>
    button
      .setIcon('lucide-pen-line')
      .setTooltip(t('settings.common.edit'))
      .onClick(editEntry)
  );
}

/** Adds a row's Delete button: a trash bin, as Obsidian's own Maps settings draw it, because the x that Obsidian 1.14.4 draws for a native list's `onDelete` cannot be changed. */
export function addDeleteButton(
  setting: Setting,
  deleteEntry: () => void
): void {
  setting.addExtraButton((button) =>
    button
      .setIcon('lucide-trash-2')
      .setTooltip(t('settings.common.delete'))
      .onClick(deleteEntry)
  );
}

/** Mounts a restore button in `containerEl`, the control Obsidian builds by itself only for `slider` and `color` rows; mount it before the field so it sits to the field's left, where Obsidian places its own. Returns the function that dims it while restoring would change nothing: through `aria-disabled`, as Obsidian's own, which leaves it clickable. */
export function addRestoreDefaultButton(
  containerEl: HTMLElement,
  restoreDefault: () => void
): (isAtDefault: boolean) => void {
  const button = new ExtraButtonComponent(containerEl)
    .setIcon('rotate-ccw')
    .setTooltip(t('settings.common.restoreDefault'))
    .onClick(restoreDefault);
  return (isAtDefault) => {
    button.extraSettingsEl.setAttribute('aria-disabled', String(isAtDefault));
  };
}

export interface SummaryRowOptions {
  /** Plain text: the row's search text, and its reconciliation key unless the definition also carries an `id`. */
  name: string;
  /** Display form of the name, for markup the plain `name` cannot carry; built per render because an inserted fragment empties. */
  buildNameFragment?: () => DocumentFragment;
  /** Built per render, for the same reason as `buildNameFragment`. */
  buildDesc?: () => string | DocumentFragment;
  /** User data stays out of the settings search index; static labels stay in it. */
  searchable: boolean;
  editEntry?: () => void;
  deleteEntry?: () => void;
}

/** A compact row summarizing one entry, its Edit and Delete buttons ahead of any drag handle a native list appends; callers close over the entry object, never its index, because a reorder moves entries without re-rendering. */
export function buildSummaryRow(
  options: SummaryRowOptions
): SettingDefinitionRender {
  const {
    name,
    buildNameFragment,
    buildDesc,
    searchable,
    editEntry,
    deleteEntry,
  } = options;
  return {
    name,
    searchable,
    render: (setting) => {
      // Runs after the renderer's own setName, so the fragment replaces the plain name on every rebuild
      if (buildNameFragment) setting.setName(buildNameFragment());
      const desc = buildDesc?.();
      if (desc) setting.setDesc(desc);
      if (editEntry) addEditButton(setting, editEntry);
      if (deleteEntry) addDeleteButton(setting, deleteEntry);
    },
  };
}

/** An exclusion entry as its row shows it: the text, then a `Regex` badge when it is a pattern. */
export function buildExclusionEntryFragment(text: string): DocumentFragment {
  return createFragment((frag) => {
    frag.appendText(text);
    if (isPatternEntry(text.trim())) {
      // The badge Obsidian's own list puts on a regex entry, in English in every language as Obsidian draws it
      frag.createSpan({ text: 'Regex', cls: 'flair mod-flat' });
    }
  });
}

/** Returns a list's row-key function: ids keyed by entry object, held in memory only. An edit, toggle, reorder or save mutates the same objects, so an entry keeps its id; only loading or replacing the settings (Clear settings, Import) hands out new objects, and every row rebuilds then. */
export function createRowIdRegistry<T extends object>(
  prefix: string
): (entry: T) => string {
  const rowIds = new WeakMap<T, string>();
  let nextRowId = 0;
  // Distinct even for two entries with identical text, which their names alone cannot tell apart
  return (entry) => {
    let id = rowIds.get(entry);
    if (id === undefined) {
      id = `${prefix}-${nextRowId++}`;
      rowIds.set(entry, id);
    }
    return id;
  };
}

/** Wraps a UI label quoted in running text, the way settings descriptions refer to controls elsewhere in the interface: pass `quoteLabel(t(labelKey))` as the value of the sentence's placeholder, reading the label from the string that names the control, so the two cannot drift apart. Quotation marks rather than bold: bold competes with the row's own name for attention. Russian takes straight quotes, the style Obsidian's own Russian text uses most (1.14.4: 59 straight spans, 21 «…», 19 “…”). */
export function quoteLabel(text: string): string {
  return getCurrentLocale() === 'ru' ? `"${text}"` : `“${text}”`;
}

/** "Replaced with “…”" followed by `suffix`, with the replacement in a span that keeps its whitespace as typed: a description collapses runs of spaces, so `a  b` would otherwise read as `a b`. */
export function buildReplacedWithSummary(
  replacement: string,
  suffix: string
): DocumentFragment {
  // A sentinel splits the translated sentence around the replacement, so each locale keeps its own word order and quotes
  const [before, after = ''] = t('settings.common.summary.replacedWith', {
    replacement: '\u0000',
  }).split('\u0000');
  return createFragment((frag) => {
    frag.appendText(before);
    frag.createSpan({ cls: 'flit-rule-text', text: replacement });
    frag.appendText(after + suffix);
  });
}

/** Appends a sequence of bare newline-separated lines (no bullet markup), joined with `<br>` rather than a `<ul>`/`<li>` list. */
export function appendLines(
  parent: HTMLElement | DocumentFragment,
  lines: Array<(target: HTMLElement | DocumentFragment) => void>
): void {
  lines.forEach((appendLine, index) => {
    appendLine(parent);
    if (index < lines.length - 1) parent.createEl('br');
  });
}

/** Class on a list group that shows a note above its first row; `styles.css` draws the note from `LIST_NOTE_ATTRIBUTE`. */
export const LIST_NOTE_CLASS = 'flit-list-note';

/** Attribute on a rows container holding the localized note drawn at the top of its box, put there by `withListNote` or `buildDescRow`; newlines in it break lines. */
export const LIST_NOTE_ATTRIBUTE = 'data-flit-note';

/** Wraps a row of a list whose group carries `LIST_NOTE_CLASS` so that rendering it puts `note` on the list's rows container. The note cannot be a row: a list shows its empty state only while it has no rows, and a reorderable list's drag sorter re-inserts a dragged row by child index, so any row at the top would end up below a row dragged there. */
export function withListNote(
  row: SettingDefinitionRender,
  note: string
): SettingDefinitionRender {
  return {
    ...row,
    render: (setting, group) => {
      const cleanup = row.render(setting, group);
      const rowsContainer = setting.settingEl.parentElement;
      // A new row is already in the rows container when it renders, though that container may not be in the document yet
      if (rowsContainer?.matches(`.${LIST_NOTE_CLASS} > .setting-items`)) {
        rowsContainer.setAttribute(LIST_NOTE_ATTRIBUTE, note);
      }
      return cleanup;
    },
  };
}

/** Class that hides a description-only row; `styles.css` draws the row's note on its box instead. */
const DESC_ROW_CLASS = 'flit-desc-row';

/** Description-only row: a note at the top of its box, in a description's look; newlines in `desc` break lines. The row hides itself so that Settings' keyboard navigation, which steps through shown rows only, skips it; its render puts `desc` on the rows container for `styles.css` to draw, as `withListNote` does for lists, and the note hides along with the row when `visible` hides it. The `render` also keeps the definition alive: the framework drops one with no truthy `name`, `render`, `control` or `action`. */
export function buildDescRow(
  desc: string,
  options?: { visible?: () => boolean }
): SettingDefinitionRender {
  return {
    name: '',
    searchable: false,
    visible: options?.visible,
    render: (setting) => {
      const { settingEl } = setting;
      // A new row is already in the rows container when it renders, and a reused one stays there
      const rowsContainer = settingEl.parentElement;
      settingEl.addClass(DESC_ROW_CLASS);
      rowsContainer?.setAttribute(LIST_NOTE_ATTRIBUTE, desc);
      // Runs before every re-render and when the row is dropped, so a reused row element or a box that lost its note keeps nothing stale
      return () => {
        settingEl.removeClass(DESC_ROW_CLASS);
        rowsContainer?.removeAttribute(LIST_NOTE_ATTRIBUTE);
      };
    },
  };
}

/** A single button to mount via `buildButtonRow`. `onClick` receives the row's `Setting` instance for call sites that need it (e.g., resolving the owner window for a popout-safe `window.open`). `destructive` gives the red tint (`setDestructive()`) without the filled-CTA treatment — for secondary destructive actions. A destructive *primary* action (`setDestructive().setCta()`) has no call site yet, so this helper does not expose `setCta()`. */
export interface ButtonRowButton {
  text: string;
  onClick: (setting: Setting) => void;
  destructive?: boolean;
}

/** Builds the `render` callback for the "name + desc + button" row shape hand-rolled across the settings tabs — one or more buttons and nothing else. Callers still declare `name`/`desc`/`visible` on the surrounding definition themselves; this only replaces the repeated `addButton().setButtonText().onClick()` chain. */
export function buildButtonRow(
  buttons: ButtonRowButton | ButtonRowButton[]
): (setting: Setting) => void {
  const buttonList = Array.isArray(buttons) ? buttons : [buttons];
  return (setting: Setting) => {
    buttonList.forEach(({ text, onClick, destructive }) => {
      setting.addButton((button) => {
        button.setButtonText(text);
        if (destructive) button.setDestructive();
        button.onClick(() => onClick(setting));
      });
    });
  };
}
