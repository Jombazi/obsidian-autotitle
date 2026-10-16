import { describe, it, expect } from 'vitest';
import {
  applyCustomReplacementRules,
  customReplacementMatchKey,
} from '../../src/utils/custom-replacement-rules';
import { CustomReplacement } from '../../src/types';

function rule(overrides: Partial<CustomReplacement>): CustomReplacement {
  return {
    searchText: '',
    replaceText: '',
    onlyAtStart: false,
    onlyWholeLine: false,
    ...overrides,
  };
}

describe('applyCustomReplacementRules', () => {
  it('replaces every occurrence by default', () => {
    expect(
      applyCustomReplacementRules('bar and bar', [
        rule({ searchText: 'bar', replaceText: 'baz' }),
      ])
    ).toBe('baz and baz');
  });

  it('skips a rule with empty search text', () => {
    expect(
      applyCustomReplacementRules('Title', [rule({ replaceText: 'X' })])
    ).toBe('Title');
  });

  it('replaces only at the start when the rule says so', () => {
    const atStart = rule({
      searchText: 'TODO ',
      replaceText: 'Done ',
      onlyAtStart: true,
    });

    expect(applyCustomReplacementRules('TODO TODO item', [atStart])).toBe(
      'Done TODO item'
    );
    expect(applyCustomReplacementRules('item TODO ', [atStart])).toBe(
      'item TODO '
    );
  });

  it('replaces the whole line only when it matches, ignoring surrounding whitespace', () => {
    const wholeLine = rule({
      searchText: 'Draft',
      replaceText: 'Final',
      onlyWholeLine: true,
    });

    expect(applyCustomReplacementRules('  Draft ', [wholeLine])).toBe('Final');
    expect(applyCustomReplacementRules('Draft notes', [wholeLine])).toBe(
      'Draft notes'
    );
  });

  it('keeps `$&` and `$$` in the replacement text literal', () => {
    expect(
      applyCustomReplacementRules('price', [
        rule({ searchText: 'price', replaceText: '$& $$' }),
      ])
    ).toBe('$& $$');
  });

  it('runs rules in order, each on the previous result', () => {
    expect(
      applyCustomReplacementRules('a', [
        rule({ searchText: 'a', replaceText: 'b' }),
        rule({ searchText: 'b', replaceText: 'c' }),
      ])
    ).toBe('c');
  });
});

describe('customReplacementMatchKey', () => {
  it('ignores what a rule replaces its text with', () => {
    expect(
      customReplacementMatchKey(rule({ searchText: 'a', replaceText: 'b' }))
    ).toBe(
      customReplacementMatchKey(rule({ searchText: 'a', replaceText: 'c' }))
    );
  });

  it('keeps each match option apart', () => {
    const keys = [
      rule({ searchText: 'a' }),
      rule({ searchText: 'a', onlyAtStart: true }),
      rule({ searchText: 'a', onlyWholeLine: true }),
    ].map(customReplacementMatchKey);

    expect(new Set(keys).size).toBe(3);
  });

  it('trims a whole-line rule, whose text the engine compares trimmed', () => {
    expect(
      customReplacementMatchKey(
        rule({ searchText: ' a ', onlyWholeLine: true })
      )
    ).toBe(
      customReplacementMatchKey(rule({ searchText: 'a', onlyWholeLine: true }))
    );
  });

  it('keeps the spaces of a rule that matches anywhere or at the start', () => {
    expect(customReplacementMatchKey(rule({ searchText: ' a ' }))).not.toBe(
      customReplacementMatchKey(rule({ searchText: 'a' }))
    );
    expect(
      customReplacementMatchKey(rule({ searchText: 'a ', onlyAtStart: true }))
    ).not.toBe(
      customReplacementMatchKey(rule({ searchText: 'a', onlyAtStart: true }))
    );
  });

  it('keys a rule with both options as whole-line, the only branch the engine takes for it', () => {
    expect(
      customReplacementMatchKey(
        rule({ searchText: 'a', onlyAtStart: true, onlyWholeLine: true })
      )
    ).toBe(
      customReplacementMatchKey(rule({ searchText: 'a', onlyWholeLine: true }))
    );
  });
});
