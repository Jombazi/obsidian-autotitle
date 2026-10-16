/** Guards the notice copy rules `showNotice` documents, for every `notifications.*` string in both locales: a one-sentence notice ends without a period, a notice of two or more sentences ends with one, and a progress notice keeps its "..."; a quoted name takes curly quotes in English and straight quotes in Russian, and a #tag is never quoted. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = resolve(__dirname, '..');

/** Every string under `notifications`, plural forms included, keyed by its dot path. */
function notificationStrings(locale: string): [string, string][] {
  const parsed = JSON.parse(
    readFileSync(join(ROOT, 'locale', `${locale}.json`), 'utf-8')
  ) as { notifications: Record<string, unknown> };
  const strings: [string, string][] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') strings.push([path, node]);
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(parsed.notifications, 'notifications');
  return strings;
}

/** A sentence boundary is end punctuation followed by whitespace and more text. */
function isMultiSentence(text: string): boolean {
  return /[.!?]\s+\S/.test(text);
}

const LOCALES = ['en', 'ru'] as const;

describe('notice copy', () => {
  describe.each(LOCALES)('%s', (locale) => {
    const strings = notificationStrings(locale);

    it.each(strings)('%s ends as its sentence count requires', (_, text) => {
      if (/(\.\.\.|…)$/.test(text)) return;
      if (isMultiSentence(text)) {
        expect(text.endsWith('.')).toBe(true);
      } else {
        expect(text.endsWith('.')).toBe(false);
      }
    });

    it.each(strings)('%s quotes names in the locale style', (_, text) => {
      const forbidden = locale === 'en' ? /"|«|»/ : /“|”|«|»/;
      expect(text).not.toMatch(forbidden);
    });

    it.each(strings)('%s never quotes a tag', (_, text) => {
      expect(text).not.toMatch(/["“«]\{\{tag\}\}/);
    });
  });
});
