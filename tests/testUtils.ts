/**
 * Test utilities and helper functions
 */

import { vi, type MockedFunction } from 'vitest';
import { TFile, TFolder, App, Setting } from './mockObsidian';
import { DeepPartial, PluginSettings } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/constants';
import { deepMerge } from '../src/utils/deep-merge';

/**
 * Create a mock TFile for testing
 */
export function createMockFile(path: string = 'test.md'): TFile {
  return new TFile(path);
}

/**
 * Create a mock TFolder for testing
 */
export function createMockFolder(path: string = 'test-folder'): TFolder {
  return new TFolder(path);
}

/**
 * Create a mock App instance for testing
 */
export function createMockApp(): App {
  return new App();
}

/**
 * Create test settings with optional overrides
 */
export function createTestSettings(
  overrides: DeepPartial<PluginSettings> = {}
): PluginSettings {
  // deepMerge deep-clones its defaults, so no nested branch (exclusions, core, ...) ever
  // aliases DEFAULT_SETTINGS — one test mutating settings.exclusions.excludedFiles
  // cannot leak into another. Overrides merge per leaf, so a caller can name a single
  // key without restating its siblings.
  return deepMerge(DEFAULT_SETTINGS, overrides);
}

/**
 * Create a TFile with specific properties
 */
export function createFileWithProperties(
  path: string,
  basename: string,
  extension: string = 'md'
): TFile {
  const file = new TFile(path);
  file.basename = basename;
  file.extension = extension;
  file.name = `${basename}.${extension}`;
  return file;
}

/**
 * Mock file content for testing
 */
export const mockFileContent = {
  simple: 'Simple Title\n\nBody content',
  withMarkdown: '# Heading Title\n\nBody with **bold** and *italic*',
  withForbiddenChars: 'Title/with:forbidden*chars\n\nBody',
  withFrontmatter:
    '---\ntitle: Frontmatter Title\n---\n\nFirst Line Title\n\nBody',
  empty: '',
  onlyWhitespace: '   \n\n  \t  \n',
  multiline: 'First Line\nSecond Line\nThird Line',
  withHeading: '## Heading 2\n\nContent below',
  withCode: '`inline code` in title\n\nBody',
  withLinks: '[[Internal Link]] in title\n\nBody',
  withTags: '#tag in title\n\nBody',
};

// Lives in mockObsidian.ts, which uses it as `getFrontMatterInfo`'s default; re-exported so suites keep importing it from here without an import cycle.
export { splitFrontMatter } from './mockObsidian';

/**
 * Make an editor show `text` through every read the plugin makes: the whole note
 * (`getValue`) and the line-by-line reads of the title walk (`lineCount`, `getLine`),
 * split the way CodeMirror splits a document.
 */
export function stubEditorText(
  editor: { getValue: unknown; lineCount: unknown; getLine: unknown },
  text: string
): void {
  const lines = text.split(/\r\n|\r|\n/);
  editor.getValue = vi.fn(() => text);
  editor.lineCount = vi.fn(() => lines.length);
  editor.getLine = vi.fn((line: number) => lines[line] ?? '');
}

/** Lets awaited saves, deferred focus timers and confirmation buttons' async clicks settle; real timers only, since a fake-timer suite never reaches the timeout. */
export function flush(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Clicks the extra button a row drew with `icon`, such as `lucide-pen-line` for Edit or `lucide-trash-2` for Delete. */
export function clickExtraButton(setting: Setting, icon: string): void {
  const button = setting.components.find(
    (component) => component.setIcon.mock.calls[0]?.[0] === icon
  );
  (button.onClick.mock.calls[0][0] as () => void)();
}

/** Types into a real input the way the browser reports it: the value, then a bubbling `input` event. */
export function typeInto(inputEl: HTMLInputElement, value: string): void {
  inputEl.value = value;
  inputEl.dispatchEvent(new window.Event('input', { bubbles: true }));
}

/** Presses Enter in an input; `isComposing` marks the Enter that confirms an IME composition. */
export function pressEnter(
  inputEl: HTMLInputElement,
  isComposing = false
): void {
  inputEl.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', isComposing })
  );
}

type EntryEditModalModule = typeof import('../src/modals/entry-edit-modal');

/** The entry dialog module with its dialog recording every instance in `openedModals`, for a `vi.mock` factory to return; the base Modal mock declares `onOpen` as an instance field, so a test opens a recorded instance through the real prototype. */
export function withRecordedEntryEditModals(
  actual: EntryEditModalModule,
  openedModals: unknown[]
): EntryEditModalModule {
  class RecordingEntryEditModal<
    V extends Record<string, string | boolean>,
  > extends actual.EntryEditModal<V> {
    constructor(
      ...args: ConstructorParameters<typeof actual.EntryEditModal<V>>
    ) {
      super(...args);
      openedModals.push(this);
    }
  }
  return { ...actual, EntryEditModal: RecordingEntryEditModal };
}

type ExclusionEntryModalModule =
  typeof import('../src/modals/exclusion-entry-modal');
type ExclusionEntryModal = InstanceType<
  ExclusionEntryModalModule['ExclusionEntryModal']
>;

/** The exclusion entry dialog module with its dialog recording every instance in `openedModals`, for a `vi.mock` factory to return; open a recorded instance with `openLatestExclusionEntryDialog`. */
export function withRecordedExclusionEntryModals(
  actual: ExclusionEntryModalModule,
  openedModals: unknown[]
): ExclusionEntryModalModule {
  class RecordingExclusionEntryModal extends actual.ExclusionEntryModal {
    constructor(
      ...args: ConstructorParameters<typeof actual.ExclusionEntryModal>
    ) {
      super(...args);
      openedModals.push(this);
    }
  }
  return { ...actual, ExclusionEntryModal: RecordingExclusionEntryModal };
}

/** An exclusion entry dialog opened by `openLatestExclusionEntryDialog`. */
export interface OpenedExclusionEntryDialog {
  modal: ExclusionEntryModal;
  /** One per field, in field order. */
  inputs: HTMLInputElement[];
  labels: string[];
  helps: string[];
  buttonContainer: HTMLElement | null;
  doneButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  /** The close then submit button phones put in the header. */
  headerButtons: HTMLElement[];
}

/** Opens the most recently recorded exclusion entry dialog inside a connected dialog element, so focus can be observed; through the class's own `onOpen`, which the base Modal mock's `onOpen` instance field shadows. */
export function openLatestExclusionEntryDialog(
  openedModals: unknown[]
): OpenedExclusionEntryDialog {
  const modal = openedModals[openedModals.length - 1] as ExclusionEntryModal;
  // The mock leaves the title detached, while Obsidian nests it in the header that phones add their buttons to
  modal.modalEl.createDiv('modal-header').appendChild(modal.titleEl);
  document.body.appendChild(modal.modalEl);
  modal.modalEl.appendChild(modal.contentEl);
  (Object.getPrototypeOf(modal) as { onOpen(): void }).onOpen.call(modal);
  const fieldEls = Array.from(
    modal.contentEl.querySelectorAll<HTMLElement>('p.form-field')
  );
  const buttons = modal.modalEl.querySelectorAll<HTMLButtonElement>(
    '.modal-button-container button'
  );
  return {
    modal,
    inputs: fieldEls.map(
      (fieldEl) => fieldEl.querySelector('input') as HTMLInputElement
    ),
    labels: fieldEls.map(
      (fieldEl) => fieldEl.querySelector('label')?.textContent ?? ''
    ),
    helps: fieldEls.map(
      (fieldEl) => fieldEl.querySelector('.form-field-help')?.textContent ?? ''
    ),
    buttonContainer: modal.modalEl.querySelector('.modal-button-container'),
    doneButton: buttons[0],
    cancelButton: buttons[1],
    headerButtons: Array.from(
      modal.modalEl.querySelectorAll<HTMLElement>(
        '.modal-header .modal-header-button'
      )
    ),
  };
}

/** What a rendered menu item asked its MenuItem for. */
export interface CapturedMenuItem {
  title: string;
  icon: string;
  click: () => void | Promise<void>;
}

/**
 * Read back the items a menu rendered, in menu order.
 *
 * Obsidian's Menu keeps its MenuItem instances private and so does the mock, so
 * the only way to see what an item was configured with is to replay the recorded
 * callback against a stand-in. Safe because menu callbacks only describe an item
 * - they never act on the menu itself.
 *
 * @param addItem The `addItem` spy the menu recorded the callbacks on
 */
export function captureMenuItems(addItem: {
  mock: { calls: unknown[][] };
}): CapturedMenuItem[] {
  return addItem.mock.calls.map((call) => {
    const configure = call[0] as (item: unknown) => void;

    const captured: CapturedMenuItem = {
      title: '',
      icon: '',
      click: () => {},
    };

    const standInItem = {
      setTitle: (title: string) => {
        captured.title = title;
        return standInItem;
      },
      setIcon: (icon: string) => {
        captured.icon = icon;
        return standInItem;
      },
      onClick: (handler: () => void | Promise<void>) => {
        captured.click = handler;
        return standInItem;
      },
    };

    configure(standInItem);
    return captured;
  });
}

/**
 * Create a spy function that can be used to track calls
 */
export function createSpy<
  T extends (...args: any[]) => any,
>(): MockedFunction<T> {
  return vi.fn() as MockedFunction<T>;
}

/**
 * Assert that a value is defined (not null or undefined)
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message?: string
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message || 'Value is null or undefined');
  }
}
