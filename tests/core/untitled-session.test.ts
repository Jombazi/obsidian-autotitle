import { describe, it, expect, beforeEach } from 'vitest';
import { UntitledSession } from '../../src/core/untitled-session';
import { TFile } from '../mockObsidian';

/** Simulate Obsidian renaming a file in place (same TFile object). */
function renameInPlace(file: TFile, newPath: string): void {
  file.path = newPath;
  file.basename =
    newPath
      .replace(/\.[^/.]+$/, '')
      .split('/')
      .pop() || '';
  file.name = newPath.split('/').pop() || '';
}

describe('UntitledSession', () => {
  let session: UntitledSession;

  beforeEach(() => {
    session = new UntitledSession();
  });

  describe('isUntitledName', () => {
    it.each(['Untitled', 'Untitled 1', 'Untitled 23'])('matches %s', (name) => {
      expect(session.isUntitledName(name)).toBe(true);
    });

    it.each([
      'Untitled note',
      'My Untitled',
      'Untitled 0',
      'Untitled 01',
      'untitled',
      'Shopping',
    ])('does not match %s', (name) => {
      expect(session.isUntitledName(name)).toBe(false);
    });
  });

  it('allows a new Untitled note opened in the editor', () => {
    const note = new TFile('Untitled.md');
    session.onFileOpen(note);
    expect(session.canAutoRename(note, note)).toBe(true);
  });

  it('never allows a note you named yourself', () => {
    const note = new TFile('A/Shopping list.md');
    session.onFileOpen(note);
    expect(session.canAutoRename(note, note)).toBe(false);
  });

  it('keeps renaming while you write the first line', () => {
    const note = new TFile('Untitled.md');
    session.onFileOpen(note);
    renameInPlace(note, 'Gro.md');
    expect(session.canAutoRename(note, note)).toBe(true);
    renameInPlace(note, 'Groceries.md');
    expect(session.canAutoRename(note, note)).toBe(true);
  });

  it('stops after you leave the note, and stays stopped when reopened', () => {
    const note = new TFile('Untitled.md');
    const other = new TFile('Other.md');
    session.onFileOpen(note);
    renameInPlace(note, 'Groceries.md');

    session.onFileOpen(other);
    expect(session.canAutoRename(note, other)).toBe(false);

    session.onFileOpen(note);
    expect(session.canAutoRename(note, note)).toBe(false);
  });

  it('keeps a note with a queued rename eligible until the queue runs', () => {
    const note = new TFile('Untitled.md');
    const other = new TFile('Other.md');
    session.onFileOpen(note);

    session.onFileOpen(other, (f) => f === note);
    expect(session.canAutoRename(note, other)).toBe(true);

    session.onFileOpen(other, () => false);
    expect(session.canAutoRename(note, other)).toBe(false);
  });

  it('allows a brand-new active Untitled note before file-open fires', () => {
    const note = new TFile('Untitled 2.md');
    expect(session.canAutoRename(note, note)).toBe(true);
    renameInPlace(note, 'Idea.md');
    expect(session.canAutoRename(note, note)).toBe(true);
  });

  it('does not allow a background Untitled note that is not open', () => {
    const note = new TFile('X/Untitled.md');
    expect(session.canAutoRename(note, null)).toBe(false);
  });

  it('ignores non-markdown files', () => {
    const canvas = new TFile('Untitled.canvas');
    session.onFileOpen(canvas);
    expect(session.canAutoRename(canvas, null)).toBe(false);
  });
});
