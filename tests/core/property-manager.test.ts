import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PropertyManager } from '../../src/core/property-manager';
import { createTestSettings } from '../testUtils';
import { PluginSettings } from '../../src/types';
import type FirstLineIsTitle from '../../main';

describe('PropertyManager.ensurePropertyTypeIsCheckbox', () => {
  let settings: PluginSettings;
  let assignedWidgets: Map<string, string>;
  let metadataTypeManager: {
    getAssignedWidget: ReturnType<typeof vi.fn>;
    setType: ReturnType<typeof vi.fn>;
  };
  let propertyManager: PropertyManager;

  beforeEach(() => {
    settings = createTestSettings();
    settings.exclusions.disableRenamingKey = 'no rename';
    settings.exclusions.disableRenamingValue = 'true';

    // Keys fold case, as Obsidian's registry does
    assignedWidgets = new Map();
    metadataTypeManager = {
      getAssignedWidget: vi.fn(
        (name: string) => assignedWidgets.get(name.toLowerCase()) ?? null
      ),
      setType: vi.fn(async (name: string, widget: string) => {
        assignedWidgets.set(name.toLowerCase(), widget);
      }),
    };

    propertyManager = new PropertyManager({
      app: { metadataTypeManager },
      settings,
    } as unknown as FirstLineIsTitle);
  });

  it('should register a property with no type as a checkbox', async () => {
    await propertyManager.ensurePropertyTypeIsCheckbox();

    expect(metadataTypeManager.setType).toHaveBeenCalledWith(
      'no rename',
      'checkbox'
    );
    expect(assignedWidgets.get('no rename')).toBe('checkbox');
  });

  it('should change another type to a checkbox', async () => {
    assignedWidgets.set('no rename', 'text');

    await propertyManager.ensurePropertyTypeIsCheckbox();

    expect(metadataTypeManager.setType).toHaveBeenCalledWith(
      'no rename',
      'checkbox'
    );
  });

  it('should leave the other properties’ types alone', async () => {
    assignedWidgets.set('status', 'text');
    assignedWidgets.set('due', 'date');

    await propertyManager.ensurePropertyTypeIsCheckbox();

    expect(metadataTypeManager.setType).toHaveBeenCalledTimes(1);
    expect(assignedWidgets.get('status')).toBe('text');
    expect(assignedWidgets.get('due')).toBe('date');
  });

  it('should not save again when the property is already a checkbox', async () => {
    assignedWidgets.set('no rename', 'checkbox');

    await propertyManager.ensurePropertyTypeIsCheckbox();

    expect(metadataTypeManager.setType).not.toHaveBeenCalled();
  });

  it('should read a checkbox registered under another case of the key', async () => {
    settings.exclusions.disableRenamingKey = 'No Rename';
    assignedWidgets.set('no rename', 'checkbox');

    await propertyManager.ensurePropertyTypeIsCheckbox();

    expect(metadataTypeManager.setType).not.toHaveBeenCalled();
  });

  it('should register a false value as a checkbox too', async () => {
    settings.exclusions.disableRenamingValue = 'false';

    await propertyManager.ensurePropertyTypeIsCheckbox();

    expect(metadataTypeManager.setType).toHaveBeenCalledWith(
      'no rename',
      'checkbox'
    );
  });

  // The write stores `True` as a boolean, so the type has to match it
  it.each(['True', ' FALSE '])(
    'should register a %s value as a checkbox, as the write coerces it',
    async (value) => {
      settings.exclusions.disableRenamingValue = value;

      await propertyManager.ensurePropertyTypeIsCheckbox();

      expect(metadataTypeManager.setType).toHaveBeenCalledWith(
        'no rename',
        'checkbox'
      );
    }
  );

  it('should leave the type alone when the value is not true or false', async () => {
    settings.exclusions.disableRenamingValue = 'yes';

    await propertyManager.ensurePropertyTypeIsCheckbox();

    expect(metadataTypeManager.getAssignedWidget).not.toHaveBeenCalled();
    expect(metadataTypeManager.setType).not.toHaveBeenCalled();
  });

  it('should do nothing without a property name', async () => {
    settings.exclusions.disableRenamingKey = '';

    await propertyManager.ensurePropertyTypeIsCheckbox();

    expect(metadataTypeManager.setType).not.toHaveBeenCalled();
  });

  it('should resolve and log when Obsidian fails to save the type', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    metadataTypeManager.setType.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      propertyManager.ensurePropertyTypeIsCheckbox()
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
