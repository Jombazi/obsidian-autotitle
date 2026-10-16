import { DeepPartial } from '../types';

/**
 * Deep merge two objects recursively
 * Arrays and primitives from source override defaults
 * Nested objects are merged recursively
 *
 * @param defaults The default object (will not be mutated)
 * @param source The source object with overrides (will not be mutated)
 * @returns A new object with merged values
 */
// `NoInfer` pins T to the defaults: without it a `Partial<PluginSettings>` source drags
// the inferred T down to `Partial<PluginSettings>`, and the return type loses its keys.
export function deepMerge<T>(defaults: T, source: DeepPartial<NoInfer<T>>): T {
  // Primitive defaults are values, not shared objects, so they can be returned as is
  if (!defaults || typeof defaults !== 'object') return defaults;

  // Create a deep copy of defaults to avoid mutation
  const result = JSON.parse(JSON.stringify(defaults)) as T;
  // The copy even with nothing to merge: callers mutate the result, and handing back `defaults` itself would let that reach the shared object
  if (!source || typeof source !== 'object') return result;
  // Use Record for dynamic key access
  const resultRecord = result as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;

  // Merge properties from source
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;

    const sourceValue = sourceRecord[key];
    const defaultValue = resultRecord[key];

    // If source value is null/undefined, skip it (keep default)
    if (sourceValue === null || sourceValue === undefined) continue;

    // If default value doesn't exist, use source value
    if (defaultValue === null || defaultValue === undefined) {
      resultRecord[key] = sourceValue;
      continue;
    }

    // Handle arrays: replace entirely (don't merge items)
    if (Array.isArray(sourceValue)) {
      resultRecord[key] = JSON.parse(JSON.stringify(sourceValue));
      continue;
    }

    // Handle objects: merge recursively
    if (
      typeof sourceValue === 'object' &&
      typeof defaultValue === 'object' &&
      !Array.isArray(defaultValue)
    ) {
      resultRecord[key] = deepMerge(defaultValue, sourceValue);
      continue;
    }

    // Handle primitives: override with source value
    resultRecord[key] = sourceValue;
  }

  return result;
}
