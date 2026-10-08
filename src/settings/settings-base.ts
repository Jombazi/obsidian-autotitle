import { App, Setting, SettingDefinitionRender, TFile } from 'obsidian';
import { PluginSettings, RenameOutcome } from '../types';
import { UNIVERSAL_FORBIDDEN_CHARS, WINDOWS_ANDROID_CHARS } from '../constants';
import { detectOS } from '../utils';
import { getCurrentLocale, t } from '../i18n';

export interface FirstLineIsTitlePlugin {
  app: App;
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  /**
   * Writes a timestamped settings backup at the vault root and resolves with its path,
   * or `null` when the write failed. Declared here because the import modal types the
   * plugin through this interface.
   */
  writeSettingsBackup(contents: string): Promise<string | null>;
  debugLog(settingName: string, value: unknown): void;
  editorLifecycle?: { initializeCheckingSystem(): void };
  renameEngine?: {
    processFile(
      file: TFile,
      noDelay: boolean,
      showNotices: boolean,
      providedContent?: string,
      isBatchOperation?: boolean,
      exclusionOverrides?: Record<string, boolean>
    ): Promise<RenameOutcome>;
  };
  propertyManager?: { ensurePropertyTypeIsCheckbox(): Promise<void> };
  updatePropertyVisibility?: () => void;
  getCurrentTimestamp?: () => string;
  outputAllSettings?: () => void;
  cacheManager?: {
    clearReservedPaths(): void;
  };
}

export function addForbiddenCharProtection(
  inputElement: HTMLInputElement,
  forceWindowsAndroidProtection: boolean = false
): void {
  inputElement.addEventListener('input', (e) => {
    const inputEl = e.target as HTMLInputElement;
    let value = inputEl.value;

    const universalForbidden = UNIVERSAL_FORBIDDEN_CHARS;
    const windowsAndroidForbidden = WINDOWS_ANDROID_CHARS;

    let forbiddenChars = [...universalForbidden];

    // Add Windows/Android chars if forced (for Windows/Android section) or if current OS requires it
    if (forceWindowsAndroidProtection) {
      forbiddenChars.push(...windowsAndroidForbidden);
    } else {
      const currentOS = detectOS();
      if (currentOS === 'Windows') {
        forbiddenChars.push(...windowsAndroidForbidden);
      }
    }

    let filteredValue = '';
    for (let i = 0; i < value.length; i++) {
      const char = value[i];

      // Special case for dot: forbidden only at start
      if (char === '.' && i === 0) {
        continue;
      }
      if (forbiddenChars.includes(char)) {
        continue;
      }

      filteredValue += char;
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

export interface SummaryRowOptions {
  /** Plain text: a list row's reconciliation key and its search text. */
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

/**
 * Wraps a UI label quoted in running text, the way settings descriptions refer
 * to controls elsewhere in the interface.
 *
 * Quotation marks rather than bold: bold competes with the row's own name for
 * attention, and Russian typography quotes where English would embolden — so
 * the two locales differ only in which pair of marks they use.
 */
export function quoteLabel(text: string): string {
  return getCurrentLocale() === 'ru' ? `«${text}»` : `“${text}”`;
}

/**
 * "Replaced with “…”" followed by `suffix`, with the replacement in a span that
 * keeps its whitespace as typed: a description collapses runs of spaces, so
 * `a  b` would otherwise read as `a b`.
 */
export function buildReplacedWithSummary(
  replacement: string,
  suffix: string
): DocumentFragment {
  // A sentinel splits the translated sentence around the replacement, so each locale keeps its own word order and quotes
  const [before, after = ''] = t(
    'settings.characterReplacements.summary.replacedWith',
    { replacement: '\u0000' }
  ).split('\u0000');
  return createFragment((frag) => {
    frag.appendText(before);
    frag.createSpan({ cls: 'flit-rule-text', text: replacement });
    frag.appendText(after + suffix);
  });
}

/**
 * Appends a UI label quoted per locale; see `quoteLabel`.
 */
export function appendEmphasis(
  parent: HTMLElement | DocumentFragment,
  localeKey: string
): void {
  parent.appendText(quoteLabel(t(localeKey)));
}

/**
 * Appends an already-resolved term quoted per locale; see `quoteLabel`. The
 * counterpart to `appendEmphasis` for text that is not itself a locale key.
 */
export function appendEmphasisedTerm(
  parent: HTMLElement | DocumentFragment,
  text: string
): void {
  parent.appendText(quoteLabel(text));
}

/**
 * Appends a sequence of bare newline-separated lines (no bullet markup),
 * joined with `<br>` rather than a `<ul>`/`<li>` list.
 */
export function appendLines(
  parent: HTMLElement | DocumentFragment,
  lines: Array<(target: HTMLElement | DocumentFragment) => void>
): void {
  lines.forEach((appendLine, index) => {
    appendLine(parent);
    if (index < lines.length - 1) parent.createEl('br');
  });
}

/**
 * Description-only row (no name, control, or action). The framework's item
 * filter keeps only definitions with a truthy `name`, `render`, `control`,
 * or `action` — `desc` alone doesn't count, so a bare `{ name: '', desc }`
 * item is silently dropped before rendering. The no-op `render` is never
 * called for its own sake; it exists only to satisfy the filter, since the
 * framework applies `desc` to the row before invoking `render`.
 */
export function buildDescRow(
  desc: string | DocumentFragment,
  options?: { visible?: () => boolean }
): SettingDefinitionRender {
  return {
    name: '',
    desc,
    searchable: false,
    visible: options?.visible,
    render: () => {},
  };
}

/** Class on a list group that shows a note above its first row; `styles.css` draws the note from `LIST_NOTE_ATTRIBUTE`. */
export const LIST_NOTE_CLASS = 'flit-list-note';

/** Attribute on a noted list's rows container holding the localized note; newlines in it break lines. */
export const LIST_NOTE_ATTRIBUTE = 'data-flit-note';

/**
 * Wraps a row of a list whose group carries `LIST_NOTE_CLASS` so that
 * rendering it puts `note` on the list's rows container.
 *
 * The note cannot be a row: a list shows its empty state only while it has no
 * rows, and a reorderable list's drag sorter re-inserts a dragged row by child
 * index, so any row at the top would end up below a row dragged there.
 */
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

/**
 * A single button to mount via `buildButtonRow`. `onClick` receives the
 * row's `Setting` instance for call sites that need it (e.g. resolving the
 * owner window for a popout-safe `window.open`). `destructive` gives the red
 * tint (`setDestructive()`) without the filled-CTA treatment — for secondary
 * destructive actions. A destructive *primary* action
 * (`setDestructive().setCta()`) has no call site yet, so this helper does
 * not expose `setCta()`.
 */
export interface ButtonRowButton {
  text: string;
  onClick: (setting: Setting) => void;
  destructive?: boolean;
}

/**
 * Builds the `render` callback for the "name + desc + button" row shape
 * hand-rolled across the settings tabs — one or more buttons and nothing
 * else. Callers still declare `name`/`desc`/`visible` on the surrounding
 * definition themselves; this only replaces the repeated
 * `addButton().setButtonText().onClick()` chain.
 */
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
