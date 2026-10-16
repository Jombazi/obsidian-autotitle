/**
 * Tests for `TagSuggest`, the suggester in the Excluded tags dialog, and
 * `FolderSuggest`, the one in the Excluded files dialog. The base suggester
 * mock declares its methods as instance fields, so each is called through the
 * real prototype.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderMatches } from 'obsidian';
import { AbstractInputSuggest, App, TFolder } from './mockObsidian';
import { FolderSuggest, TagSuggest } from '../src/suggests';

// The shared mock has no `renderMatches`; a recording stand-in, since the highlight itself is Obsidian's
vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mockObsidian')>()),
  renderMatches: vi.fn(),
}));

// The shared mock records `onSelect` without keeping the callback; Obsidian's own `selectSuggestion`, which the suggesters run first, calls the callback `onSelect` registered
Object.assign(AbstractInputSuggest.prototype, {
  selectSuggestion(this: AbstractInputSuggest, value: unknown, evt: unknown) {
    vi.mocked(this.onSelect).mock.lastCall?.[0]?.(value, evt);
  },
});

function buildSuggest(
  vaultTags: string[],
  currentExclusions: string[] = []
): {
  suggest: TagSuggest;
  inputEl: HTMLInputElement;
  onSelect: ReturnType<typeof vi.fn>;
  getTags: ReturnType<typeof vi.fn>;
} {
  const app = new App();
  const getTags = vi.fn(() =>
    Object.fromEntries(vaultTags.map((tag) => [tag, 1]))
  );
  // The mock cache has no `getTags`, the undocumented tag-to-count map `obsidian-ex.d.ts` declares
  (
    app.metadataCache as unknown as { getTags: () => Record<string, number> }
  ).getTags = getTags;
  const inputEl = document.createElement('input');
  const onSelect = vi.fn();
  const suggest = new TagSuggest(app, inputEl, onSelect, currentExclusions);
  return { suggest, inputEl, onSelect, getTags };
}

/** The suggested rows, with the `+ <typed>` row as `null`. */
function suggestionsFor(suggest: TagSuggest, query: string): (string | null)[] {
  return TagSuggest.prototype.getSuggestions.call(suggest, query);
}

describe('TagSuggest', () => {
  describe('suggestions', () => {
    it('leaves out tags the other rows already exclude, however they were written', () => {
      // Folded the way the rename run matches tags: no `#`, any case
      const { suggest } = buildSuggest(
        ['#Project', '#draft', '#archive'],
        ['project', '#ARCHIVE', '']
      );

      expect(suggestionsFor(suggest, '')).toEqual(['#draft']);
    });

    it("leaves the cap of ten rows to Obsidian's own limit", () => {
      const vaultTags = Array.from({ length: 12 }, (_, i) => `#work${i}`);
      const { suggest } = buildSuggest([...vaultTags, '#home']);

      expect(suggestionsFor(suggest, '')).toEqual([...vaultTags, '#home']);
      expect(suggestionsFor(suggest, 'WORK')).toEqual([null, ...vaultTags]);
      expect(suggest.limit).toBe(10);
    });

    it('matches the query anywhere in the tag, ignoring case', () => {
      const { suggest } = buildSuggest(['#reading/books', '#Books', '#music']);

      expect(suggestionsFor(suggest, 'book')).toEqual([
        null,
        '#reading/books',
        '#Books',
      ]);
    });

    // Enter takes the first row, and a pick saves at once, so the first row must be the tag typed
    it('puts the listed tag equal to the query first, "#" and case aside, the other matches after it in vault order', () => {
      const { suggest } = buildSuggest(['#aliquam', '#Aliqua', '#aliqua/x']);

      expect(suggestionsFor(suggest, 'aliqua')).toEqual([
        '#Aliqua',
        '#aliquam',
        '#aliqua/x',
      ]);
      expect(suggestionsFor(suggest, '#ALIQUA')).toEqual([
        '#Aliqua',
        '#aliquam',
        '#aliqua/x',
      ]);
    });

    it('puts the typed-text row first when no listed tag equals the query', () => {
      const { suggest } = buildSuggest(['#drafts', '#music']);

      expect(suggestionsFor(suggest, 'draft')).toEqual([null, '#drafts']);
      expect(suggestionsFor(suggest, 'zzz')).toEqual([null]);
    });

    it('offers no typed-text row for an empty query', () => {
      const { suggest } = buildSuggest(['#draft']);

      expect(suggestionsFor(suggest, '')).toEqual(['#draft']);
    });

    it('renders the typed-text row as `+` followed by the typed text', () => {
      const { suggest } = buildSuggest([]);
      vi.mocked(suggest.getValue).mockReturnValue('draft');
      const rowEl = document.createElement('div');
      // jsdom has no `setText`, Obsidian's text setter
      rowEl.setText = (text: string | DocumentFragment) => {
        rowEl.textContent = typeof text === 'string' ? text : text.textContent;
      };

      TagSuggest.prototype.renderSuggestion.call(suggest, null, rowEl);

      expect(rowEl.textContent).toBe('+ draft');
    });

    it('still offers a tag that another row covers only by a pattern', () => {
      const { suggest } = buildSuggest(['#draft', '#/x/'], ['/^draft/', '/x/']);

      expect(suggestionsFor(suggest, '')).toEqual(['#draft', '#/x/']);
    });

    // Obsidian preselects the first suggestion, so Enter would replace the pattern being typed
    it.each(['/', '/draft', ' /draft'])(
      'offers nothing while a pattern is typed: %j',
      (query) => {
        const { suggest } = buildSuggest(['#projects/draft', '#draft']);

        expect(suggestionsFor(suggest, query)).toEqual([]);
      }
    );
  });

  describe('selection', () => {
    it('hands the tag to the dialog, then fills the field without reporting a change', () => {
      const { suggest, inputEl, onSelect } = buildSuggest(['#project']);
      const reportedValues: string[] = [];
      inputEl.addEventListener('input', () =>
        reportedValues.push(inputEl.value)
      );

      TagSuggest.prototype.selectSuggestion.call(
        suggest,
        '#project',
        new window.KeyboardEvent('keydown', { key: 'Enter' })
      );

      expect(onSelect).toHaveBeenCalledWith('#project', expect.anything());
      expect(suggest.setValue).toHaveBeenCalledWith('#project');
      expect(vi.mocked(onSelect).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(suggest.setValue).mock.invocationCallOrder[0]
      );
      expect(reportedValues).toEqual([]);
      expect(suggest.close).toHaveBeenCalledTimes(1);
    });

    it('hands the typed-text row to the dialog as `null`, leaving the typed text in place', () => {
      const { suggest, inputEl, onSelect } = buildSuggest(['#drafts']);
      inputEl.value = 'draft';

      TagSuggest.prototype.selectSuggestion.call(
        suggest,
        null,
        new window.KeyboardEvent('keydown', { key: 'Enter' })
      );

      expect(onSelect).toHaveBeenCalledWith(null, expect.anything());
      expect(inputEl.value).toBe('draft');
      expect(suggest.setValue).not.toHaveBeenCalled();
      expect(suggest.close).toHaveBeenCalledTimes(1);
    });
  });

  // Reading the vault's tags walks every note's cache, so it happens once per focus, not per keystroke
  describe('tag list', () => {
    it('reads the vault tags once for every query of a focus', () => {
      const { suggest, getTags } = buildSuggest(['#project', '#draft']);

      suggestionsFor(suggest, '');
      suggestionsFor(suggest, 'p');
      suggestionsFor(suggest, 'pr');
      suggestionsFor(suggest, 'zzz');

      expect(getTags).toHaveBeenCalledTimes(1);
    });

    it('reads them again once the field loses focus', () => {
      const { suggest, inputEl, getTags } = buildSuggest(['#project']);

      suggestionsFor(suggest, 'p');
      inputEl.dispatchEvent(new window.FocusEvent('blur'));
      suggestionsFor(suggest, 'p');

      expect(getTags).toHaveBeenCalledTimes(2);
    });

    it('reads them again after a pick', () => {
      const { suggest, getTags } = buildSuggest(['#project']);

      suggestionsFor(suggest, 'p');
      TagSuggest.prototype.selectSuggestion.call(
        suggest,
        '#project',
        new window.KeyboardEvent('keydown', { key: 'Enter' })
      );
      suggestionsFor(suggest, 'p');

      expect(getTags).toHaveBeenCalledTimes(2);
    });
  });
});

function buildFolderSuggest(folderPaths: string[]): {
  suggest: FolderSuggest;
  inputEl: HTMLInputElement;
  onSelect: ReturnType<typeof vi.fn>;
  getAllFolders: ReturnType<typeof vi.fn>;
} {
  const app = new App();
  const getAllFolders = vi.fn((_includeRoot?: boolean) =>
    folderPaths.map((path) => new TFolder(path))
  );
  app.vault.getAllFolders = getAllFolders;
  const inputEl = document.createElement('input');
  const onSelect = vi.fn();
  const suggest = new FolderSuggest(app, inputEl, onSelect);
  return { suggest, inputEl, onSelect, getAllFolders };
}

/** The suggested rows as paths, with the `+ <typed>` row as `null`. */
function folderRowsFor(
  suggest: FolderSuggest,
  query: string
): (string | null)[] {
  return FolderSuggest.prototype.getSuggestions
    .call(suggest, query)
    .map((folder) => (folder === null ? null : folder.path));
}

describe('FolderSuggest', () => {
  describe('suggestions', () => {
    it('lists at most a hundred folders, in vault order, with no typed-text row, for an empty query', () => {
      const paths = Array.from({ length: 102 }, (_, i) => `Folder ${i}`);
      const { suggest } = buildFolderSuggest(paths);

      expect(folderRowsFor(suggest, '')).toEqual(paths.slice(0, 100));
    });

    it('matches the query characters in order, ignoring case, best match first, then the typed-text row', () => {
      const { suggest } = buildFolderSuggest([
        'Archive/Fixtures',
        'Notes',
        'Fuzzy/Text',
        'Fixtures',
      ]);

      expect(folderRowsFor(suggest, 'FXT')).toEqual([
        'Fixtures',
        'Archive/Fixtures',
        'Fuzzy/Text',
        null,
      ]);
    });

    it("appends the typed-text row after the hundred best matches, where Obsidian's own limit does not cut it", () => {
      const paths = Array.from({ length: 102 }, (_, i) => `Work ${i}`);
      const { suggest } = buildFolderSuggest(paths);

      const rows = folderRowsFor(suggest, 'work');

      expect(rows).toHaveLength(101);
      expect(rows.slice(0, 100).every((row) => row !== null)).toBe(true);
      expect(rows[100]).toBeNull();
      expect(suggest.limit).toBeGreaterThanOrEqual(rows.length);
    });

    it('offers only the typed-text row when no folder matches', () => {
      const { suggest } = buildFolderSuggest(['Notes', 'Archive']);

      expect(folderRowsFor(suggest, '/\\d+/')).toEqual([null]);
    });

    it('renders the typed-text row as `+` followed by the typed text', () => {
      const { suggest } = buildFolderSuggest([]);
      vi.mocked(suggest.getValue).mockReturnValue('/daily-.*/');
      const rowEl = document.createElement('div');
      // jsdom has no `setText`, Obsidian's text setter
      rowEl.setText = (text: string | DocumentFragment) => {
        rowEl.textContent = typeof text === 'string' ? text : text.textContent;
      };

      FolderSuggest.prototype.renderSuggestion.call(suggest, null, rowEl);

      expect(rowEl.textContent).toBe('+ /daily-.*/');
    });
  });

  describe('highlighting', () => {
    it("highlights a folder row's matched characters, as Obsidian's own folder suggestions do", () => {
      const { suggest } = buildFolderSuggest(['Archive/Fixtures', 'Notes']);
      const [folder] = FolderSuggest.prototype.getSuggestions.call(
        suggest,
        'fxt'
      );
      const rowEl = document.createElement('div');

      FolderSuggest.prototype.renderSuggestion.call(suggest, folder, rowEl);

      expect(vi.mocked(renderMatches)).toHaveBeenLastCalledWith(
        rowEl,
        'Archive/Fixtures',
        [
          [8, 9],
          [10, 12],
        ]
      );
    });

    it('highlights nothing in the rows listed before anything is typed', () => {
      const { suggest } = buildFolderSuggest(['Notes']);
      const [folder] = FolderSuggest.prototype.getSuggestions.call(suggest, '');
      const rowEl = document.createElement('div');

      FolderSuggest.prototype.renderSuggestion.call(suggest, folder, rowEl);

      expect(vi.mocked(renderMatches)).toHaveBeenLastCalledWith(
        rowEl,
        'Notes',
        null
      );
    });
  });

  // The folder list is read once per focus, not per keystroke
  describe('folder list', () => {
    it('reads the folders once for every query of a focus', () => {
      const { suggest, getAllFolders } = buildFolderSuggest(['Notes']);

      folderRowsFor(suggest, '');
      folderRowsFor(suggest, 'n');
      folderRowsFor(suggest, 'zz');

      expect(getAllFolders).toHaveBeenCalledTimes(1);
    });

    it('reads them again once the field loses focus', () => {
      const { suggest, inputEl, getAllFolders } = buildFolderSuggest(['Notes']);

      folderRowsFor(suggest, 'n');
      inputEl.dispatchEvent(new window.FocusEvent('blur'));
      folderRowsFor(suggest, 'n');

      expect(getAllFolders).toHaveBeenCalledTimes(2);
    });

    it('reads them again after a pick', () => {
      const { suggest, getAllFolders } = buildFolderSuggest(['Notes']);

      folderRowsFor(suggest, 'n');
      FolderSuggest.prototype.selectSuggestion.call(
        suggest,
        new TFolder('Notes'),
        new window.KeyboardEvent('keydown', { key: 'Enter' })
      );
      folderRowsFor(suggest, 'n');

      expect(getAllFolders).toHaveBeenCalledTimes(2);
    });
  });

  describe('selection', () => {
    it("hands a picked folder's path to the dialog, then fills the field with the entry it adds", () => {
      const { suggest, onSelect } = buildFolderSuggest(['Notes/Work']);

      FolderSuggest.prototype.selectSuggestion.call(
        suggest,
        new TFolder('Notes/Work'),
        new window.KeyboardEvent('keydown', { key: 'Enter' })
      );

      expect(onSelect).toHaveBeenCalledWith('Notes/Work');
      expect(suggest.setValue).toHaveBeenCalledWith('Notes/Work/');
      expect(suggest.close).toHaveBeenCalledTimes(1);
    });

    it('hands the typed-text row to the dialog as `null`, leaving the typed text in place', () => {
      const { suggest, inputEl, onSelect } = buildFolderSuggest(['Notes']);
      inputEl.value = 'Note';
      const reportedValues: string[] = [];
      inputEl.addEventListener('input', () =>
        reportedValues.push(inputEl.value)
      );

      FolderSuggest.prototype.selectSuggestion.call(
        suggest,
        null,
        new window.KeyboardEvent('keydown', { key: 'Enter' })
      );

      expect(onSelect).toHaveBeenCalledWith(null);
      expect(inputEl.value).toBe('Note');
      expect(suggest.setValue).not.toHaveBeenCalled();
      expect(reportedValues).toEqual([]);
      expect(suggest.close).toHaveBeenCalledTimes(1);
    });
  });
});
