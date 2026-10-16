/**
 * Tests for detectTagFromEditor and detectTagFromDOM
 *
 * Focus: the editor's tag is whatever Obsidian indexed for the note, so tags in
 * any script count whole, and text Obsidian does not treat as a tag (`#1`, a
 * URL's anchor, `#` in code) is never offered, because it is absent from the cache.
 * In the tag pane, a nested tag's row shows only its last segment, so the whole
 * name has to be read from the row's hidden parent prefix as well.
 */

import { describe, it, expect } from 'vitest';
import type { MarkdownView, TagCache } from 'obsidian';
import {
  detectTagFromDOM,
  detectTagFromEditor,
} from '../../src/utils/tag-detection';

/** A cache entry for `tag` written at `col` on `line`, positioned as Obsidian indexes it */
function tagAt(tag: string, line: number, col: number): TagCache {
  return {
    tag,
    position: {
      start: { line, col, offset: 0 },
      end: { line, col: col + tag.length, offset: 0 },
    },
  };
}

/** A view on a note whose editor holds `lines` and whose cache holds `tags` (`undefined` for no cache) */
function viewWith(
  lines: string[],
  tags: TagCache[] | undefined,
  { hasFile = true }: { hasFile?: boolean } = {}
): MarkdownView {
  return {
    file: hasFile ? { path: 'Note.md' } : null,
    editor: { getLine: (line: number) => lines[line] ?? '' },
    app: {
      metadataCache: {
        getFileCache: () => (tags === undefined ? null : { tags }),
      },
    },
  } as unknown as MarkdownView;
}

describe('detectTagFromEditor', () => {
  it.each([
    ['Cyrillic', '#тег'],
    ['accented', '#café'],
    ['hyphen plus Cyrillic', '#tag-заметки'],
  ])('should return a whole %s tag', (_, tag) => {
    const view = viewWith([`See ${tag} here`], [tagAt(tag, 0, 4)]);

    expect(detectTagFromEditor(view, { line: 0, ch: 6 })).toEqual({
      tagName: tag.slice(1),
      location: 'editor',
    });
  });

  it('should return nothing for a digits-only hashtag, which Obsidian does not index', () => {
    const view = viewWith(['Item #1 and #real'], [tagAt('#real', 0, 12)]);

    expect(detectTagFromEditor(view, { line: 0, ch: 6 })).toBeNull();
  });

  it('should return the tag with the cursor at its start', () => {
    const view = viewWith(['See #tag here'], [tagAt('#tag', 0, 4)]);

    expect(detectTagFromEditor(view, { line: 0, ch: 4 })?.tagName).toBe('tag');
  });

  it('should return the tag with the cursor at its end', () => {
    const view = viewWith(['See #tag here'], [tagAt('#tag', 0, 4)]);

    expect(detectTagFromEditor(view, { line: 0, ch: 8 })?.tagName).toBe('tag');
  });

  it('should return nothing with the cursor just outside the tag', () => {
    const view = viewWith(['See #tag here'], [tagAt('#tag', 0, 4)]);

    expect(detectTagFromEditor(view, { line: 0, ch: 3 })).toBeNull();
    expect(detectTagFromEditor(view, { line: 0, ch: 9 })).toBeNull();
  });

  it('should return nothing for a tag on another line', () => {
    const view = viewWith(['See #tag here', 'Other'], [tagAt('#tag', 0, 4)]);

    expect(detectTagFromEditor(view, { line: 1, ch: 5 })).toBeNull();
  });

  it('should return nothing when the note has no cache', () => {
    const view = viewWith(['See #tag here'], undefined);

    expect(detectTagFromEditor(view, { line: 0, ch: 5 })).toBeNull();
  });

  it('should return nothing when the view has no file', () => {
    const view = viewWith(['See #tag here'], [tagAt('#tag', 0, 4)], {
      hasFile: false,
    });

    expect(detectTagFromEditor(view, { line: 0, ch: 5 })).toBeNull();
  });

  it('should return nothing when unsaved edits moved other text under the indexed position', () => {
    const view = viewWith(['New line typed above'], [tagAt('#tag', 0, 4)]);

    expect(detectTagFromEditor(view, { line: 0, ch: 5 })).toBeNull();
  });
});

/** A tag pane row for `tag`, built as Obsidian 1.14.4 builds one: the parent path and the last segment in two spans, then the note count. */
function tagPaneRow(tag: string, count: number): HTMLElement {
  const selfEl = document.createElement('div');
  selfEl.className = 'tree-item-self tag-pane-tag';
  const innerEl = selfEl.appendChild(document.createElement('div'));
  innerEl.className = 'tree-item-inner';
  const textEl = innerEl.appendChild(document.createElement('div'));
  textEl.className = 'tree-item-inner-text';
  const lastSegment = tag.split('/').pop() ?? tag;
  const parentEl = textEl.appendChild(document.createElement('span'));
  parentEl.className = 'tag-pane-tag-parent';
  parentEl.textContent = tag.slice(0, tag.length - lastSegment.length);
  const segmentEl = textEl.appendChild(document.createElement('span'));
  segmentEl.className = 'tree-item-inner-text';
  segmentEl.textContent = lastSegment;
  const countEl = selfEl.appendChild(document.createElement('div'));
  countEl.className = 'tree-item-flair-outer';
  countEl.textContent = String(count);
  return selfEl;
}

describe('detectTagFromDOM', () => {
  it('should return the whole name of a nested tag right-clicked on its last segment', () => {
    const row = tagPaneRow('project/alpha', 3);
    const segmentEl = row.querySelector<HTMLElement>(
      'span.tree-item-inner-text'
    )!;

    expect(detectTagFromDOM(segmentEl)).toEqual({
      tagName: 'project/alpha',
      location: 'tag-pane',
    });
  });

  it('should return a top-level tag, leaving out the note count', () => {
    const row = tagPaneRow('inbox', 12);

    expect(detectTagFromDOM(row)).toEqual({
      tagName: 'inbox',
      location: 'tag-pane',
    });
  });

  it('should return a tag pill in the tags property without its #', () => {
    const property = document.createElement('div');
    property.className = 'metadata-property';
    property.setAttribute('data-property-key', 'tags');
    const pill = property.appendChild(document.createElement('div'));
    pill.className = 'multi-select-pill';
    pill.textContent = '#project/alpha';

    expect(detectTagFromDOM(pill)).toEqual({
      tagName: 'project/alpha',
      location: 'yaml',
    });
  });

  it('should return nothing for an element that is no tag', () => {
    expect(detectTagFromDOM(document.createElement('div'))).toBeNull();
  });
});
