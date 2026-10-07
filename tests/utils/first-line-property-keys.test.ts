import { describe, it, expect } from 'vitest';
import {
  hasFirstLinePropertyName,
  parseFirstLinePropertyKeys,
} from '../../src/utils/first-line-property-keys';
import { createTestSettings } from '../testUtils';

describe('first-line-property-keys', () => {
  describe('parseFirstLinePropertyKeys', () => {
    it('gives no keys for a blank name', () => {
      expect(parseFirstLinePropertyKeys('')).toEqual([]);
    });

    it('gives no keys for whitespace and commas alone', () => {
      expect(parseFirstLinePropertyKeys(' , ,')).toEqual([]);
    });

    it('trims each name and drops empty entries', () => {
      expect(parseFirstLinePropertyKeys('a, b ,')).toEqual(['a', 'b']);
    });
  });

  describe('hasFirstLinePropertyName', () => {
    it('is false for a blank name', () => {
      expect(
        hasFirstLinePropertyName(
          createTestSettings({ firstLineProperty: { propertyKey: '' } })
        )
      ).toBe(false);
    });

    it('is false for a name made only of commas', () => {
      expect(
        hasFirstLinePropertyName(
          createTestSettings({ firstLineProperty: { propertyKey: ', ,' } })
        )
      ).toBe(false);
    });

    it('is true once the field holds a name', () => {
      expect(
        hasFirstLinePropertyName(
          createTestSettings({ firstLineProperty: { propertyKey: 'aliases' } })
        )
      ).toBe(true);
    });
  });
});
