import { describe, it, expect } from 'vitest';
import { excludedPropertyEntryKey } from '../../src/utils/exclusion-pattern';

describe('excludedPropertyEntryKey', () => {
  it('folds the case of a plain name and value', () => {
    expect(excludedPropertyEntryKey({ key: 'Status', value: 'DONE' })).toBe(
      excludedPropertyEntryKey({ key: 'status', value: 'done' })
    );
  });

  it('keeps the case of a pattern on either side', () => {
    expect(excludedPropertyEntryKey({ key: '/\\d/', value: '' })).not.toBe(
      excludedPropertyEntryKey({ key: '/\\D/', value: '' })
    );
    expect(excludedPropertyEntryKey({ key: 'n', value: '/\\d/' })).not.toBe(
      excludedPropertyEntryKey({ key: 'n', value: '/\\D/' })
    );
  });

  it('ignores the whitespace around each side', () => {
    expect(excludedPropertyEntryKey({ key: ' status ', value: ' done ' })).toBe(
      excludedPropertyEntryKey({ key: 'status', value: 'done' })
    );
  });

  it('keeps a name with a colon apart from the name and value it would join into', () => {
    expect(excludedPropertyEntryKey({ key: 'a:b', value: '' })).not.toBe(
      excludedPropertyEntryKey({ key: 'a', value: 'b' })
    );
  });

  it('keeps a blank value apart from a filled one', () => {
    expect(excludedPropertyEntryKey({ key: 'status', value: '' })).not.toBe(
      excludedPropertyEntryKey({ key: 'status', value: 'done' })
    );
  });

  it('gives a rule with a blank name no key', () => {
    expect(excludedPropertyEntryKey({ key: '  ', value: 'done' })).toBeNull();
  });
});
