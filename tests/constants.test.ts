/**
 * Pins the shipped defaults.
 *
 * Every other test clones DEFAULT_SETTINGS as a fixture base, so a changed
 * default alters behaviour for every new install without moving a single
 * assertion. These are meant to fail loudly on a deliberate change — that is
 * the point of them.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/constants';

describe('shipped defaults', () => {
  it('renames automatically out of the box', () => {
    expect(DEFAULT_SETTINGS.core.renameAutomatically).toBe(true);
  });

  it('inserts the title into new notes and moves the cursor there', () => {
    // Both were off historically; turning them on changes what happens on
    // every note creation, including for users upgrading without a stored value.
    expect(DEFAULT_SETTINGS.core.insertTitle).toBe(true);
    expect(DEFAULT_SETTINGS.core.moveCursorToFirstLine).toBe(true);
  });

  it('formats the inserted title as a heading', () => {
    // Every New notes setting ships on, so a new note's inserted title starts with `# ` out of the box
    expect(DEFAULT_SETTINGS.core.formatAsHeading).toBe(true);
  });

  it('leaves forbidden-character replacement off', () => {
    // It rewrites characters in every title, so a new install keeps titles as typed until the user opts in
    expect(
      DEFAULT_SETTINGS.characterReplacements.enableForbiddenCharReplacements
    ).toBe(false);
  });

  it('replaces every character once Character replacements is turned on', () => {
    // A forbidden character whose switch is off is removed rather than kept, so a character shipped off would vanish from new users' file names
    const { charReplacements } = DEFAULT_SETTINGS.characterReplacements;
    expect(Object.keys(charReplacements)).toHaveLength(14);
    for (const config of Object.values(charReplacements)) {
      expect(config.enabled).toBe(true);
    }
  });

  it('ships no custom replacement rules, since every rule that exists applies', () => {
    expect(DEFAULT_SETTINGS.customReplacements.rules).toEqual([]);
  });

  it('leaves the first line property off by shipping a blank property name', () => {
    expect(DEFAULT_SETTINGS.firstLineProperty.propertyKey).toBe('');
  });

  it('ships the first line property options a first enable used to set', () => {
    expect(DEFAULT_SETTINGS.firstLineProperty.keepEmptyProperty).toBe(true);
    expect(
      DEFAULT_SETTINGS.markupStripping.stripMarkupInFirstLineProperty
    ).toBe(true);
    expect(
      DEFAULT_SETTINGS.markupStripping
        .applyCustomReplacementsInFirstLineProperty
    ).toBe(true);
  });

  it('does not delay or throttle note processing by default', () => {
    expect(DEFAULT_SETTINGS.core.newNoteDelay).toBe(0);
    expect(DEFAULT_SETTINGS.core.checkInterval).toBe(0);
  });

  it('keeps rename-on-focus off, since it is gated behind automatic renaming', () => {
    expect(DEFAULT_SETTINGS.core.renameOnFocus).toBe(false);
  });
});
