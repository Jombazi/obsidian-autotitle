import {
  AbstractInputSuggest,
  App,
  SearchResult,
  TFolder,
  prepareFuzzySearch,
  renderMatches,
  sortSearchResults,
} from 'obsidian';
import {
  excludedTagEntryKey,
  isBlankTagEntry,
  tagKey,
} from './utils/tag-utils';
import { folderExclusionEntry } from './utils/file-exclusions';

// As many folder rows as Obsidian's own folder suggestions list
const MAX_FOLDER_ROWS = 100;

// FLIT keeps its tag list short
const MAX_TAG_ROWS = 10;

/**
 * A suggester for one of FLIT's exclusion fields, which keeps what it lists from the first query of a focus until blur or a pick.
 * The cache is not cleared in close(): Obsidian calls close() on an empty result, so a query matching nothing would re-read the vault on every keystroke.
 */
abstract class CachedInputSuggest<T> extends AbstractInputSuggest<T> {
  constructor(app: App, inputEl: HTMLInputElement, onPick: (value: T) => void) {
    super(app, inputEl);
    this.onSelect(onPick);
    inputEl.addEventListener('blur', () => {
      this.clearCache();
    });
  }

  /** Drops what the suggester keeps between keystrokes. */
  protected abstract clearCache(): void;

  /** The text a pick leaves in the field, or null to leave the field as typed. */
  protected abstract textAfterPick(value: T): string | null;

  /** Overridden because Obsidian's own only runs the `onSelect` callback, leaving the field as typed and the list open. */
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
    super.selectSuggestion(value, evt);
    const text = this.textAfterPick(value);
    if (text !== null) this.setValue(text);
    this.close();
    this.clearCache();
  }
}

/** The `+ <typed>` row, drawn as Obsidian's own folder suggestions draw theirs. */
function renderTypedTextRow(el: HTMLElement, typedText: string): void {
  el.setText(`+ ${typedText}`);
}

/**
 * Folder suggestions for the Excluded files dialog, matched, ordered and highlighted as in Obsidian's own "Add exclusion" dialog (measured in Obsidian 1.14.4): listed on focus with the first preselected, so Enter picks it; fuzzy-matched and ordered best first; and, for a typed query, a trailing `+ <typed>` row.
 * A `null` suggestion is that trailing row, whose selection submits the typed text.
 * Both list up to 100 folders, but past that many matches Obsidian's own list drops the `+ <typed>` row, which FLIT keeps.
 */
export class FolderSuggest extends CachedInputSuggest<TFolder | null> {
  private cachedFolders: TFolder[] | null = null;
  // Each listed folder's fuzzy match, for highlighting; empty while the query is empty
  private matchesByFolder = new Map<TFolder, SearchResult>();

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    onSelectCallback: (folderPath: string | null) => void
  ) {
    super(app, inputEl, (folder) => {
      onSelectCallback(folder === null ? null : folder.path);
    });
    // Above the folder cap: Obsidian cuts the list to `limit` after this class builds it, which would drop the trailing `+ <typed>` row
    this.limit = MAX_FOLDER_ROWS + 1;
  }

  getSuggestions(query: string): (TFolder | null)[] {
    // Leaves out the vault root, as Obsidian's own folder suggestions in the Excluded files dialog do
    this.cachedFolders ??= this.app.vault.getAllFolders(false);
    const folders = this.cachedFolders;
    this.matchesByFolder.clear();

    if (!query) {
      return folders.slice(0, MAX_FOLDER_ROWS);
    }

    const matchPath = prepareFuzzySearch(query);
    const matches: { item: TFolder; match: SearchResult }[] = [];
    for (const folder of folders) {
      const match = matchPath(folder.path);
      if (match) matches.push({ item: folder, match });
    }
    sortSearchResults(matches);
    const shown = matches.slice(0, MAX_FOLDER_ROWS);
    for (const { item, match } of shown) this.matchesByFolder.set(item, match);
    // Appended after the cap, so the typed text is offered however many folders match
    return [...shown.map(({ item }) => item), null];
  }

  renderSuggestion(folder: TFolder | null, el: HTMLElement): void {
    if (folder === null) {
      renderTypedTextRow(el, this.getValue());
      return;
    }
    renderMatches(
      el,
      folder.path,
      this.matchesByFolder.get(folder)?.matches ?? null
    );
  }

  protected textAfterPick(folder: TFolder | null): string | null {
    // The entry a pick adds, as Obsidian's own dialog writes it into the field; the `+ <typed>` row leaves the typed text
    return folder === null ? null : folderExclusionEntry(folder.path);
  }

  protected clearCache(): void {
    this.cachedFolders = null;
  }
}

/**
 * Tag suggestions for the Excluded tags dialog, where a pick saves at once.
 * A `null` suggestion is a `+ <typed>` row, as in the folder dialog, whose selection submits the typed text. It comes first, unlike the folder dialog's trailing row, because Obsidian has no tag dialog to replicate and a pick here saves at once: Enter takes the preselected first row, so that row must be the tag typed, either a listed tag equal to it or the typed text itself.
 */
export class TagSuggest extends CachedInputSuggest<string | null> {
  // Keyed by excludedTagEntryKey, so an entry written `project` hides the vault's `#project`, while a pattern entry, never equal to a tag's key, hides nothing: the suggester ignores patterns, as the tag menus do
  private excludedTagKeys: Set<string>;
  // `getTags()` walks every note's cache
  private cachedTags: string[] | null = null;

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    onSelectCallback: (tag: string | null) => void,
    currentExclusions: string[] = []
  ) {
    super(app, inputEl, onSelectCallback);
    this.limit = MAX_TAG_ROWS;
    this.excludedTagKeys = new Set(
      currentExclusions
        .filter((entry) => !isBlankTagEntry(entry))
        .map(excludedTagEntryKey)
    );
  }

  getSuggestions(query: string): (string | null)[] {
    // A pattern being typed gets no suggestions: Obsidian preselects the first one, so Enter would replace the pattern with a nested tag containing the typed text
    if (query.trimStart().startsWith('/')) return [];

    this.cachedTags ??= Object.keys(this.app.metadataCache.getTags()).filter(
      (tag) => !this.excludedTagKeys.has(tagKey(tag))
    );
    const allTags = this.cachedTags;

    if (!query) return allTags;

    const lowerQuery = query.toLowerCase();
    const matches = allTags.filter((tag) =>
      tag.toLowerCase().includes(lowerQuery)
    );
    // `getTags()` lists in vault-walk order, so a longer tag such as `#aliquam` can precede the `#aliqua` typed
    const queryKey = tagKey(query);
    const exactIndex = matches.findIndex((tag) => tagKey(tag) === queryKey);
    if (exactIndex === -1) return [null, ...matches];
    return [
      matches[exactIndex],
      ...matches.filter((_, index) => index !== exactIndex),
    ];
  }

  renderSuggestion(tag: string | null, el: HTMLElement): void {
    if (tag === null) {
      renderTypedTextRow(el, this.getValue());
      return;
    }
    el.setText(tag);
  }

  protected textAfterPick(tag: string | null): string | null {
    // The `+ <typed>` row leaves the typed text
    return tag;
  }

  protected clearCache(): void {
    this.cachedTags = null;
  }
}
