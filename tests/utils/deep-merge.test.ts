/**
 * Tests for `deepMerge`, which test fixtures build settings with. Its result is
 * mutated in place, so it must never share an object with its defaults.
 */

import { describe, it, expect } from 'vitest';
import { deepMerge } from '../../src/utils/deep-merge';

interface Shape {
  name: string;
  nested: { count: number; flag: boolean };
  list: string[];
}

function defaults(): Shape {
  return { name: 'default', nested: { count: 1, flag: false }, list: ['a'] };
}

describe('deepMerge', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])(
    'returns a copy of the defaults, not the defaults, for a %s source',
    (_, source) => {
      const base = defaults();

      const merged = deepMerge(base, source as never);

      expect(merged).toEqual(base);
      expect(merged).not.toBe(base);
      expect(merged.nested).not.toBe(base.nested);
      expect(merged.list).not.toBe(base.list);
    }
  );

  it('leaves the defaults untouched when the result is mutated', () => {
    const base = defaults();

    const merged = deepMerge(base, undefined as never);
    merged.nested.count = 99;
    merged.list.push('b');

    expect(base).toEqual(defaults());
  });

  it('overrides a nested leaf and keeps its siblings', () => {
    const merged = deepMerge(defaults(), { nested: { count: 5 } });

    expect(merged.nested).toEqual({ count: 5, flag: false });
  });

  it('replaces an array whole rather than merging its items', () => {
    const merged = deepMerge(defaults(), { list: ['x', 'y'] });

    expect(merged.list).toEqual(['x', 'y']);
  });

  it('keeps the default for a null or undefined leaf', () => {
    const merged = deepMerge(defaults(), {
      name: null as never,
      nested: { count: undefined },
    });

    expect(merged.name).toBe('default');
    expect(merged.nested.count).toBe(1);
  });

  it('does not alias an array from the source', () => {
    const source = { list: ['x'] };

    const merged = deepMerge(defaults(), source);
    merged.list.push('y');

    expect(source.list).toEqual(['x']);
  });
});
