/**
 * Tests for the shared settings row helpers. `buildButtonRow` builds the "name + desc + button" row shape used across the settings sections; the page-level builders that consume it (`other.ts`, `general.ts`) are exercised through their own test files, and this file pins the helper's own contract — single/multiple buttons, the destructive flag, and that `onClick` receives the row's `Setting` instance. `addRestoreDefaultButton` is the restore button the exclusions, first line property and entry dialog rows share. `showNotice` is the tinted notice, with an optional duration for one that stays up. `buildDescRow` is the description-only row that hides itself and leaves its note on the rows container.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as mockObsidian from '../mockObsidian';
import {
  addRestoreDefaultButton,
  buildButtonRow,
  buildDescRow,
  LIST_NOTE_ATTRIBUTE,
  showNotice,
} from '../../src/settings/settings-base';

/**
 * Fake `Setting` that records every `addButton()` call, in the order made,
 * without pulling in a real Obsidian `Setting`.
 */
function fakeSetting() {
  interface CapturedButton {
    text: string;
    destructive: boolean;
    clickHandler?: () => void;
  }
  const buttons: CapturedButton[] = [];
  const setting = {
    addButton(cb: (b: unknown) => unknown) {
      const record: CapturedButton = { text: '', destructive: false };
      const button = {
        setButtonText(value: string) {
          record.text = value;
          return button;
        },
        setDestructive() {
          record.destructive = true;
          return button;
        },
        onClick(handler: () => void) {
          record.clickHandler = handler;
          return button;
        },
      };
      cb(button);
      buttons.push(record);
      return setting;
    },
  };
  return { setting, buttons };
}

describe('buildButtonRow', () => {
  it('mounts a single button with its text and click handler', () => {
    const onClick = vi.fn();
    const { setting, buttons } = fakeSetting();

    buildButtonRow({ text: 'Do it', onClick })(setting as never);

    expect(buttons).toHaveLength(1);
    expect(buttons[0].text).toBe('Do it');

    buttons[0].clickHandler?.();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("passes the row's Setting instance through to onClick", () => {
    const onClick = vi.fn();
    const { setting, buttons } = fakeSetting();

    buildButtonRow({ text: 'Do it', onClick })(setting as never);
    buttons[0].clickHandler?.();

    // Call sites like the Help/Send feedback rows resolve the owner window
    // from `setting.settingEl`, so the exact instance has to reach them.
    expect(onClick).toHaveBeenCalledWith(setting);
  });

  it('mounts multiple buttons on one row, in order', () => {
    const { setting, buttons } = fakeSetting();

    buildButtonRow([
      { text: 'Import', onClick: () => {} },
      { text: 'Export', onClick: () => {} },
    ])(setting as never);

    expect(buttons.map((b) => b.text)).toEqual(['Import', 'Export']);
  });

  it('applies setDestructive() only when requested', () => {
    const { setting, buttons } = fakeSetting();

    buildButtonRow({ text: 'Clear', onClick: () => {}, destructive: true })(
      setting as never
    );

    expect(buttons[0].destructive).toBe(true);
  });

  it('leaves setDestructive() uncalled by default', () => {
    const { setting, buttons } = fakeSetting();

    buildButtonRow({ text: 'Save', onClick: () => {} })(setting as never);

    expect(buttons[0].destructive).toBe(false);
  });
});

describe('addRestoreDefaultButton', () => {
  /** Mounts the button in a fresh container, returning it with its dimming function and click spy. */
  function mountRestoreButton() {
    const containerEl = document.createElement('div');
    const restoreDefault = vi.fn();
    const setDimmed = addRestoreDefaultButton(containerEl, restoreDefault);
    const button = containerEl.querySelector<HTMLElement>(
      '.extra-setting-button'
    )!;
    return { button, setDimmed, restoreDefault };
  }

  it('mounts a "Restore default" button that restores on click', () => {
    const { button, restoreDefault } = mountRestoreButton();

    expect(button.getAttribute('data-icon')).toBe('rotate-ccw');
    expect(button.getAttribute('aria-label')).toBe('Restore default');
    button.click();
    expect(restoreDefault).toHaveBeenCalledTimes(1);
  });

  it('dims through aria-disabled and stays clickable while dimmed', () => {
    const { button, setDimmed, restoreDefault } = mountRestoreButton();

    setDimmed(true);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();
    expect(restoreDefault).toHaveBeenCalledTimes(1);

    setDimmed(false);
    expect(button.getAttribute('aria-disabled')).toBe('false');
  });
});

describe('buildDescRow', () => {
  /** Renders the row inside a rows container, returning both and the render's cleanup. */
  function renderDescRow(desc: string) {
    const rowsEl = document.createElement('div');
    const setting = new mockObsidian.Setting(rowsEl);
    const cleanup = buildDescRow(desc).render(setting as never, {} as never);
    return { rowsEl, rowEl: setting.settingEl, cleanup };
  }

  it('hides its row and leaves the note on the rows container', () => {
    const { rowsEl, rowEl } = renderDescRow('First line\nSecond line');

    expect(rowEl.classList.contains('flit-desc-row')).toBe(true);
    expect(rowsEl.getAttribute(LIST_NOTE_ATTRIBUTE)).toBe(
      'First line\nSecond line'
    );
  });

  // Obsidian runs the cleanup before it re-renders a reused row and when it drops the row
  it('takes the class and the note back on cleanup', () => {
    const { rowsEl, rowEl, cleanup } = renderDescRow('Note');

    (cleanup as () => void)();

    expect(rowEl.classList.contains('flit-desc-row')).toBe(false);
    expect(rowsEl.hasAttribute(LIST_NOTE_ATTRIBUTE)).toBe(false);
  });
});

describe('showNotice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Shows a notice, returning the duration `Notice` was given and the classes on its container. */
  function captureNotice(...args: Parameters<typeof showNotice>) {
    const containerEl = document.createElement('div');
    const NoticeSpy = vi
      .spyOn(mockObsidian, 'Notice')
      // A regular function, not an arrow: the source calls `new Notice(...)`
      .mockImplementation(function () {
        return { containerEl } as never;
      } as never);
    showNotice(...args);
    return {
      duration: NoticeSpy.mock.calls[0][1],
      classes: containerEl.className,
    };
  }

  it("leaves the duration to Obsidian's default when none is given", () => {
    expect(captureNotice('Saved', 'success')).toEqual({
      duration: undefined,
      classes: 'mod-success',
    });
  });

  it('passes a duration through, tinted the same', () => {
    expect(captureNotice('Failed', 'warning', 0)).toEqual({
      duration: 0,
      classes: 'mod-warning',
    });
  });
});
