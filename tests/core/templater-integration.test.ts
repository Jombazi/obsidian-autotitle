import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App, MarkdownView, TFile, TFolder } from '../mockObsidian';
import { createMockFile, createMockFolder } from '../testUtils';
import {
  countCursorPlaceholders,
  fileRegexMatches,
  folderTemplateMatches,
  hasBodyForTemplater,
  isInTemplateFolder,
  isInTemplaterIgnoredFolder,
  isOnlyCursorPlaceholders,
  templaterJumpedToCursor,
  templaterWroteFile,
} from '../../src/core/templater-integration';

describe('templater-integration', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new App();
  });

  /** Installs Templater with `settings` as its synced settings */
  function installTemplater(settings: Record<string, unknown>) {
    app.plugins.plugins['templater-obsidian'] = { settings };
  }

  /** A folder chain from the vault root down to `path`, each folder's parent set */
  function folderChain(path: string): TFolder {
    let parent: TFolder | null = null;
    let folder: TFolder | null = null;
    const segments = path.split('/');
    for (let depth = 1; depth <= segments.length; depth++) {
      folder = createMockFolder(segments.slice(0, depth).join('/'));
      folder.parent = parent;
      parent = folder;
    }
    return folder!;
  }

  /** A note in `folderPath`, with its folder chain */
  function noteIn(folderPath: string, name = 'note.md'): TFile {
    const file = createMockFile(`${folderPath}/${name}`);
    file.parent = folderChain(folderPath);
    return file;
  }

  describe('countCursorPlaceholders', () => {
    it.each([
      { text: '', count: 0 },
      { text: '<% tp.file.cursor() %>', count: 1 },
      { text: '<%tp.file.cursor(1)%> and <% tp.file.cursor(2) %>', count: 2 },
      { text: '<% tp.file.cursor(-1.5) %>', count: 1 },
      { text: '<% tp.file.cursor(a) %>', count: 0 },
      { text: '<% tp.file.title %>', count: 0 },
    ])('counts $count in "$text"', ({ text, count }) => {
      expect(countCursorPlaceholders(text)).toBe(count);
    });

    // The shared pattern is global, so a stateful match would skip the first placeholder on the next call
    it('counts the same on every call', () => {
      const text = '<% tp.file.cursor() %>';

      expect(countCursorPlaceholders(text)).toBe(1);
      expect(countCursorPlaceholders(text)).toBe(1);
    });
  });

  describe('isOnlyCursorPlaceholders', () => {
    it.each([
      { text: '', only: true },
      { text: ' \n\t\n', only: true },
      { text: '<% tp.file.cursor() %>\n', only: true },
      {
        text: '\n<%tp.file.cursor(1)%>\n\n<% tp.file.cursor(2) %>\n',
        only: true,
      },
      { text: '<% tp.file.cursor() %>\nNotes', only: false },
      { text: 'Notes: <% tp.file.cursor() %>', only: false },
      { text: '<% tp.file.title %>', only: false },
    ])('reads $text as only placeholders: $only', ({ text, only }) => {
      expect(isOnlyCursorPlaceholders(text)).toBe(only);
    });

    // The shared pattern is global, so a stateful match would leave a placeholder behind on the next call
    it('answers the same on every call', () => {
      const text = '<% tp.file.cursor() %>';

      expect(isOnlyCursorPlaceholders(text)).toBe(true);
      expect(isOnlyCursorPlaceholders(text)).toBe(true);
    });
  });

  describe('templaterJumpedToCursor', () => {
    it('reads a drop in the placeholder count as a jump', () => {
      expect(templaterJumpedToCursor('<% tp.file.cursor() %>', 'jumped')).toBe(
        true
      );
    });

    it('reads a kept placeholder as no jump', () => {
      expect(
        templaterJumpedToCursor(
          '<% tp.file.cursor() %>',
          '<% tp.file.cursor() %>'
        )
      ).toBe(false);
    });
  });

  describe('isInTemplateFolder', () => {
    // Templater tests the normalized folder as a substring of the path, not a prefix
    it('matches the templates folder anywhere in the path', () => {
      installTemplater({ templates_folder: 'Templates' });

      expect(isInTemplateFolder(app, noteIn('Templates'))).toBe(true);
      expect(isInTemplateFolder(app, noteIn('Archive/Templates'))).toBe(true);
      expect(isInTemplateFolder(app, noteIn('Notes'))).toBe(false);
    });

    it('never treats the vault root as the templates folder', () => {
      installTemplater({ templates_folder: '/' });

      expect(isInTemplateFolder(app, noteIn('Notes'))).toBe(false);
    });

    it('matches nothing without a templates folder setting', () => {
      installTemplater({});

      expect(isInTemplateFolder(app, noteIn('Templates'))).toBe(false);
    });
  });

  describe('isInTemplaterIgnoredFolder', () => {
    // A plain prefix test on each normalized entry
    it('matches a path an entry prefixes, a sibling sharing the prefix included', () => {
      installTemplater({ ignore_folders_on_creation: [{ folder: 'Inbox' }] });

      expect(isInTemplaterIgnoredFolder(app, noteIn('Inbox'))).toBe(true);
      expect(isInTemplaterIgnoredFolder(app, noteIn('Inbox2'))).toBe(true);
      expect(isInTemplaterIgnoredFolder(app, noteIn('Notes/Inbox'))).toBe(
        false
      );
    });

    it('skips empty and malformed entries', () => {
      installTemplater({
        ignore_folders_on_creation: [
          { folder: '' },
          null,
          { folder: 3 },
          'Inbox',
        ],
      });

      expect(isInTemplaterIgnoredFolder(app, noteIn('Inbox'))).toBe(false);
    });
  });

  describe('hasBodyForTemplater', () => {
    it.each([
      { content: '', hasBody: false },
      { content: '---\na: b\n---\n', hasBody: false },
      { content: '---\na: b\n---\n\n', hasBody: true },
      { content: '\n', hasBody: true },
      { content: 'Text', hasBody: true },
    ])('reads $hasBody for $content', ({ content, hasBody }) => {
      expect(hasBodyForTemplater(content)).toBe(hasBody);
    });
  });

  describe('folderTemplateMatches', () => {
    it('walks up from the note to the deepest folder with a template', () => {
      installTemplater({
        folder_templates: [{ folder: 'Projects', template: 'Templates/p.md' }],
      });

      expect(folderTemplateMatches(app, noteIn('Projects/Alpha/Notes'))).toBe(
        true
      );
    });

    it('matches the vault root entry for any note', () => {
      installTemplater({
        folder_templates: [{ folder: '/', template: 'Templates/root.md' }],
      });
      const file = noteIn('Notes');
      // The vault root folder's path is `/`
      file.parent!.parent = createMockFolder('/');

      expect(folderTemplateMatches(app, file)).toBe(true);
    });

    it('ignores an entry with no template chosen', () => {
      installTemplater({
        folder_templates: [{ folder: 'Projects', template: '' }],
      });

      expect(folderTemplateMatches(app, noteIn('Projects'))).toBe(false);
    });

    it('matches nothing outside every listed folder', () => {
      installTemplater({
        folder_templates: [{ folder: 'Projects', template: 'Templates/p.md' }],
      });

      expect(folderTemplateMatches(app, noteIn('Notes'))).toBe(false);
    });
  });

  describe('fileRegexMatches', () => {
    it('matches the full path against each entry', () => {
      installTemplater({
        file_templates: [
          { regex: '^Daily/\\d{4}', template: 'Templates/d.md' },
        ],
      });

      expect(fileRegexMatches(app, noteIn('Daily', '2026-10-16.md'))).toBe(
        true
      );
      expect(fileRegexMatches(app, noteIn('Notes', '2026-10-16.md'))).toBe(
        false
      );
    });

    it('skips an entry whose regex does not compile', () => {
      installTemplater({
        file_templates: [
          { regex: '(', template: 'Templates/broken.md' },
          { regex: 'Notes/', template: 'Templates/n.md' },
        ],
      });

      expect(fileRegexMatches(app, noteIn('Notes'))).toBe(true);
    });
  });

  describe('templaterWroteFile', () => {
    let file: TFile;

    // Templater's editor-branch condition in full: the note its active file, an active editor, and an active Markdown view
    beforeEach(() => {
      file = noteIn('Notes');
      app.workspace.activeEditor = {
        file,
        editor: {},
      } as unknown as typeof app.workspace.activeEditor;
      app.workspace.getActiveFile = vi.fn().mockReturnValue(file);
      app.workspace.getActiveViewOfType = vi
        .fn()
        .mockReturnValue(new MarkdownView(app));
    });

    it('reads an editor write when the whole condition holds', () => {
      expect(templaterWroteFile(app, file)).toBe(false);
    });

    it('reads a file write when the active editor shows another note', () => {
      app.workspace.activeEditor = {
        file: noteIn('Notes', 'other.md'),
        editor: {},
      } as unknown as typeof app.workspace.activeEditor;

      expect(templaterWroteFile(app, file)).toBe(true);
    });

    // Templater falls back to the active file only when the active editor has no file
    it('takes the active file when the active editor has none', () => {
      app.workspace.activeEditor = {
        file: null,
        editor: {},
      } as unknown as typeof app.workspace.activeEditor;

      expect(templaterWroteFile(app, file)).toBe(false);

      app.workspace.getActiveFile = vi
        .fn()
        .mockReturnValue(noteIn('Notes', 'other.md'));

      expect(templaterWroteFile(app, file)).toBe(true);
    });

    it('reads a file write with no active editor', () => {
      app.workspace.activeEditor = null;

      expect(templaterWroteFile(app, file)).toBe(true);
    });

    it('reads a file write when the active editor has no editor', () => {
      app.workspace.activeEditor = {
        file,
      } as unknown as typeof app.workspace.activeEditor;

      expect(templaterWroteFile(app, file)).toBe(true);
    });

    it('reads a file write with no active Markdown view', () => {
      app.workspace.getActiveViewOfType = vi.fn().mockReturnValue(null);

      expect(templaterWroteFile(app, file)).toBe(true);
    });
  });
});
