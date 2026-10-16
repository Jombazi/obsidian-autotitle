/**
 * Guards the locale files against silent drift.
 *
 * `t()` returns the key path itself on a miss, so a renamed or mistyped key
 * ships a button labeled `settings.other.foo.bar` while every other test still
 * passes. Nothing else in the suite would catch it. The reverse check keeps
 * strings nothing reads any more from piling up in both locale files.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { App, getLanguage } from './mockObsidian';
import { initI18n } from '../src/i18n';
import { buildMarkupStrippingPage } from '../src/settings/markup-stripping';
import type { FirstLineIsTitlePlugin } from '../src/settings/settings-base';
import { DEFAULT_SETTINGS } from '../src/constants';
import {
  PRIMARY_CHAR_KEYS,
  WINDOWS_ANDROID_CHAR_KEYS,
} from '../src/types/char-replacement';

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
    // Russian has a third plural category ("few") that English has no slot for; `tp` and `tpSplit` in src/i18n.ts read these. A category is not always a leaf — `tpSplit` groups carry `.before`/`.noun`/`.after` beneath it.
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
    // Each character's label is keyed by its setting key
    const assembled = [...PRIMARY_CHAR_KEYS, ...WINDOWS_ANDROID_CHAR_KEYS].map(
      (key) => `settings.characterReplacements.characters.${key}`
    );

    const body = /CHAR_NOTE_KEYS[^{]*\{([\s\S]*?)\};/.exec(
      read('src/settings/character-replacements.ts')
    )?.[1];
    expect(body, 'CHAR_NOTE_KEYS not found').toBeDefined();
    for (const [, value] of body!.matchAll(/:\s*'(\w+)'/g)) {
      assembled.push(`settings.characterReplacements.characters.${value}`);
    }

    // An empty list means a source pattern above stopped matching, not that every key resolves.
    expect(assembled.length).toBeGreaterThan(14);
    expect(assembled.filter((key) => !enKeySet.has(key))).toEqual([]);
  });

  it('reads every English key somewhere in source', () => {
    const literals = new Set<string>();
    const namespacePrefixes = new Set<string>();
    for (const file of [
      ...sourceFiles(join(ROOT, 'src')),
      join(ROOT, 'main.ts'),
    ]) {
      const source = readFileSync(file, 'utf-8');
      for (const [, literal] of source.matchAll(/['"]([\w.]+)['"]/g)) {
        literals.add(literal);
      }
      // A key built at runtime, such as `settings.markupStripping.${toggle.id}.name`, counts every key under its static prefix as read
      for (const [, prefix] of source.matchAll(/`([\w.]+\.)\$\{/g)) {
        namespacePrefixes.add(prefix);
      }
    }
    // The leaves `tp` and `tpSplit` pick beneath a group key the source names
    const pluralLeaf = /^(?:one|few|many)(?:\.(?:before|noun|after))?$/;
    const isRead = (key: string): boolean => {
      if (literals.has(key)) return true;
      for (const prefix of namespacePrefixes) {
        if (key.startsWith(prefix)) return true;
      }
      const lastDot = key.search(/\.(?:one|few|many)(?:\.\w+)?$/);
      return (
        lastDot !== -1 &&
        literals.has(key.slice(0, lastDot)) &&
        pluralLeaf.test(key.slice(lastDot + 1))
      );
    };

    // An empty set means the literal pattern above stopped matching, not that every key is read.
    expect(literals.size).toBeGreaterThan(100);
    expect(leafPaths(en).filter((key) => !isRead(key))).toEqual([]);
  });

  describe('Markup stripping page', () => {
    afterEach(() => {
      vi.mocked(getLanguage).mockReturnValue('en');
      initI18n();
    });

    // Its names, examples and stand-in titles are all addressed by keys built at runtime, so the page is rendered instead: a missing key reads back as its own path, an unfilled placeholder as `{{name}}`
    it.each(['en', 'ru'])(
      'renders every name and description in %s',
      (locale) => {
        vi.mocked(getLanguage).mockReturnValue(locale);
        initI18n();
        const plugin = {
          app: new App(),
          settings: structuredClone(DEFAULT_SETTINGS),
        } as unknown as FirstLineIsTitlePlugin;
        const texts = (buildMarkupStrippingPage(plugin).items ?? []).flatMap(
          (item) => {
            const { name, desc } = item as {
              name?: string;
              desc?: string | DocumentFragment;
            };
            if (!name) return [];
            return [
              name,
              typeof desc === 'string' ? desc : (desc?.textContent ?? ''),
            ];
          }
        );

        expect(texts.length).toBeGreaterThan(40);
        expect(
          texts.filter((text) => text === '' || /settings\.|\{\{/.test(text))
        ).toEqual([]);
      }
    );
  });
});

describe('Russian spelling', () => {
  // ё only where е would change the meaning; list each such word here with the reason
  const MEANING_CHANGING_YO_WORDS: string[] = [];

  it('writes е for ё except in words where е would change the meaning', () => {
    const text = readFileSync(join(ROOT, 'locale', 'ru.json'), 'utf-8');
    const yoWords = text.match(/[А-Яа-яЁё]*[Ёё][А-Яа-яЁё]*/g) ?? [];
    expect(
      yoWords.filter((word) => !MEANING_CHANGING_YO_WORDS.includes(word))
    ).toEqual([]);
  });
});
