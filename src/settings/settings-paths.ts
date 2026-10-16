/** Dot-path accessors for the declarative settings API. Obsidian's `control` definitions address one settings key each, and the default `PluginSettingTab` implementation only reaches top-level properties. This plugin's settings are nested under feature sub-objects (`core.*`, `exclusions.*`, …), so every `control.key` is a dot-path walked by these helpers via the tab's `getControlValue`/`setControlValue` overrides. */

import { PluginSettings } from '../types';

type UnknownRecord = Record<string, unknown>;

/** The dot path of every leaf of `T`, a leaf being any value that is not a plain object; arrays count as leaves, since no control addresses one element. */
export type LeafPath<T> = {
  [K in keyof T & string]: T[K] extends readonly unknown[]
    ? K
    : T[K] extends object
      ? `${K}.${LeafPath<T[K]>}`
      : K;
}[keyof T & string];

/** A settings key as a `control` addresses it, so a misspelled key fails to compile instead of rendering a control bound to nothing. */
export type SettingPath = LeafPath<PluginSettings>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object';
}

/** Reads a dot-path (e.g., `core.renameOnSave`), returning undefined if any segment is missing rather than throwing; `settings` is any object because the walk tolerates a partial one. */
export function getPath(settings: object, path: SettingPath): unknown {
  let cursor: unknown = settings;
  for (const part of path.split('.')) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/** Writes a dot-path, creating a missing or non-object parent rather than throwing. A guard, not a migration path: `loadSettings` merges stored data over `DEFAULT_SETTINGS`, so every parent a control writes through already exists. */
export function setPath(
  settings: object,
  path: SettingPath,
  value: unknown
): void {
  const parts = path.split('.');
  const last = parts.pop();
  if (last === undefined) return;

  let cursor = settings as UnknownRecord;
  for (const part of parts) {
    const next = cursor[part];
    if (!isRecord(next)) {
      const created: UnknownRecord = {};
      cursor[part] = created;
      cursor = created;
    } else {
      cursor = next;
    }
  }
  cursor[last] = value;
}
