/**
 * Guards the locale files against silent drift.
 *
 * `t()` returns the key path itself on a miss, so a renamed or mistyped key
 * ships a button labelled `settings.other.foo.bar` while every other test still
 * passes. Nothing else in the suite would catch it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(__dirname, '..');

function loadLocale(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(ROOT, 'locale', `${name}.json`), 'utf-8')
  );
}

/** Flattens a nested locale object to dotted leaf paths. */
function leafPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(
    ([key, value]) => leafPaths(value, prefix ? `${prefix}.${key}` : key)
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.d.ts') ? [full] : [];
  });
}

const en = loadLocale('en');
const ru = loadLocale('ru');

describe('locale parity', () => {
  it('has no English key missing from Russian', () => {
    const ruKeys = new Set(leafPaths(ru));
    expect(leafPaths(en).filter((key) => !ruKeys.has(key))).toEqual([]);
  });

  it('has no extra Russian key beyond the plural categories English lacks', () => {
    const enKeys = new Set(leafPaths(en));
    const extra = leafPaths(ru).filter((key) => !enKeys.has(key));
    // Russian has a third plural category ("few") that English has no slot for;
    // `getPluralForm` in src/i18n.ts consumes these. A category is not always a
    // leaf — `tpSplit` groups carry `.before`/`.noun`/`.after` beneath it.
    expect(extra.filter((key) => !/(^|\.)few(\.|$)/.test(key))).toEqual([]);
  });
});

describe('locale key resolution', () => {
  it('resolves every translation key referenced in source', () => {
    const enKeys = leafPaths(en);
    const enKeySet = new Set(enKeys);
    const missing: string[] = [];

    for (const file of [
      ...sourceFiles(join(ROOT, 'src')),
      join(ROOT, 'main.ts'),
    ]) {
      const source = readFileSync(file, 'utf-8');
      // Static literals only — dynamically built keys cannot be checked here.
      for (const [, key] of source.matchAll(
        /\b(?:t|tp|tpSplit)\(\s*'([a-zA-Z0-9_.]+)'/g
      )) {
        // `tp`/`tpSplit` address a group and let the count pick the leaf below
        // it, so a key resolves if it is a leaf OR names a subtree.
        const resolves =
          enKeySet.has(key) ||
          enKeys.some((leaf) => leaf.startsWith(`${key}.`));
        if (!resolves) missing.push(`${key} (${file.slice(ROOT.length + 1)})`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('resolves every key-shaped literal handed to a helper that calls t()', () => {
    const enKeys = leafPaths(en);
    const missing: string[] = [];

    for (const file of [
      ...sourceFiles(join(ROOT, 'src')),
      join(ROOT, 'main.ts'),
    ]) {
      const source = readFileSync(file, 'utf-8');
      for (const [, key] of source.matchAll(
        /'((?:settings|notifications|commands|modals|menu)\.[\w.]+)'/g
      )) {
        if (
          !enKeys.some((leaf) => leaf === key || leaf.startsWith(`${key}.`))
        ) {
          missing.push(`${key} (${file.slice(ROOT.length + 1)})`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('resolves every key the settings builders assemble at runtime', () => {
    const enKeySet = new Set(leafPaths(en));
    const read = (path: string) => readFileSync(join(ROOT, path), 'utf-8');
    const assembled: string[] = [];

    for (const [, descKey, labelKey] of read(
      'src/settings/first-line-property.ts'
    ).matchAll(/buildLabelReferenceDescription\(\s*'([\w.]+)',\s*'(\w+)'/g)) {
      assembled.push(
        `${descKey}.part1`,
        `${descKey}.${labelKey}`,
        `${descKey}.part2`
      );
    }

    const characterReplacements = read(
      'src/settings/character-replacements.ts'
    );
    for (const mapName of ['CHAR_LABEL_KEYS', 'CHAR_NOTE_KEYS']) {
      const body = new RegExp(`${mapName}[^{]*\\{([\\s\\S]*?)\\};`).exec(
        characterReplacements
      )?.[1];
      expect(body, `${mapName} not found`).toBeDefined();
      for (const [, value] of body!.matchAll(/:\s*'(\w+)'/g)) {
        assembled.push(`settings.characterReplacements.characters.${value}`);
      }
    }

    for (const [, id] of read('src/settings/markup-stripping.ts').matchAll(
      /\bid:\s*'(\w+)'/g
    )) {
      assembled.push(`settings.markupStripping.${id}.name`);
    }

    // An empty list means a source pattern above stopped matching, not that every key resolves.
    expect(assembled.length).toBeGreaterThan(30);
    expect(assembled.filter((key) => !enKeySet.has(key))).toEqual([]);
  });
});
