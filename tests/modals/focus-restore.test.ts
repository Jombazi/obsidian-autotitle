/**
 * Tests for whether a FLIT dialog hands focus back to its opener on close,
 * decided from how the opener was focused when the dialog was built.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { App, Modal } from '../mockObsidian';
import { restoreFocusOnlyIfOpenedByKeyboard } from '../../src/modals/focus-restore';
import { focusOpener } from '../testUtils';

function restoresFocusAfterBuild(): boolean {
  const modal = new Modal(new App());
  restoreFocusOnlyIfOpenedByKeyboard(modal as never);
  return modal.shouldRestoreSelection;
}

describe('restoreFocusOnlyIfOpenedByKeyboard', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('restores focus when the opener was reached by keyboard', () => {
    focusOpener(true);

    expect(restoresFocusAfterBuild()).toBe(true);
  });

  it('leaves focus alone when the opener was tapped or clicked', () => {
    focusOpener(false);

    expect(restoresFocusAfterBuild()).toBe(false);
  });

  it('leaves focus alone when nothing is focused', () => {
    expect(document.activeElement).toBe(document.body);

    expect(restoresFocusAfterBuild()).toBe(false);
  });

  it('leaves focus alone when the document has no focused element at all', () => {
    vi.stubGlobal('activeDocument', { activeElement: null });

    expect(restoresFocusAfterBuild()).toBe(false);
  });

  it("reads the focused window's document, where a settings window's opener sits", () => {
    const openerEl = focusOpener(true);
    // The main document has nothing focused while the settings window holds the opener
    openerEl.blur();
    vi.stubGlobal('activeDocument', { activeElement: openerEl });

    expect(restoresFocusAfterBuild()).toBe(true);
  });
});
