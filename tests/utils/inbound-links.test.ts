import { describe, it, expect, beforeEach } from 'vitest';
import { isLinkedFromAnyFile } from '../../src/utils/inbound-links';
import { createMockApp, createMockFile } from '../testUtils';
import { App, TFile } from '../mockObsidian';

describe('isLinkedFromAnyFile', () => {
  let app: App;
  let file: TFile;

  beforeEach(() => {
    app = createMockApp();
    file = createMockFile('Notes/Title.md');
  });

  it("is true when another note's links list the note", () => {
    app.metadataCache.resolvedLinks = {
      'Notes/Other.md': { 'Notes/Unrelated.md': 1 },
      'Notes/Source.md': { 'Notes/Title.md': 2 },
    };

    expect(isLinkedFromAnyFile(app, file)).toBe(true);
  });

  // A canvas's file cards appear as its links
  it("is true when a canvas's links list the note", () => {
    app.metadataCache.resolvedLinks = {
      'Boards/Board.canvas': { 'Notes/Title.md': 1 },
    };

    expect(isLinkedFromAnyFile(app, file)).toBe(true);
  });

  it('is false when no source lists the note', () => {
    app.metadataCache.resolvedLinks = {
      'Notes/Title.md': { 'Notes/Other.md': 1 },
      'Notes/Other.md': {},
    };

    expect(isLinkedFromAnyFile(app, file)).toBe(false);
  });
});
