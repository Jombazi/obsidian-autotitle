import { verboseLog } from '../utils';
import { parsePropertyValue } from '../utils/property-value';
import FirstLineIsTitle from '../../main';

/** The two members of Obsidian's undocumented property type registry this class calls, both matching the key ignoring case (Obsidian 1.14.4) */
interface MetadataTypeManager {
  getAssignedWidget(propertyName: string): string | null;
  setType(propertyName: string, widget: string): Promise<void>;
}

/**
 * PropertyManager
 *
 * Registers the rename-blocking property as a checkbox in Obsidian's property types.
 */
export class PropertyManager {
  private plugin: FirstLineIsTitle;

  constructor(plugin: FirstLineIsTitle) {
    this.plugin = plugin;
  }

  get app() {
    return this.plugin.app;
  }

  get settings() {
    return this.plugin.settings;
  }

  /** Cast once here: the published typings omit the registry, and `src/obsidian-ex.d.ts` does not declare it either. */
  private get metadataTypeManager(): MetadataTypeManager {
    return (this.app as unknown as { metadataTypeManager: MetadataTypeManager })
      .metadataTypeManager;
  }

  /**
   * Ensure property type is set to checkbox in Obsidian's property types
   * Call this when "Disable renaming" commands are executed
   *
   * This ensures the property type is always checkbox when the property value is boolean,
   * regardless of what type it was before or if it existed at all.
   */
  async ensurePropertyTypeIsCheckbox(): Promise<void> {
    const propertyKey = this.settings.exclusions.disableRenamingKey;
    const propertyValue = this.settings.exclusions.disableRenamingValue;

    if (!propertyKey) return;

    // Judged as the write coerces it, so a value such as `True`, stored as a boolean, gets the checkbox too
    if (typeof parsePropertyValue(propertyValue) !== 'boolean') {
      verboseLog(
        this.plugin,
        `Property "${propertyKey}" value is not boolean (${propertyValue}), skipping type update`
      );
      return;
    }

    if (
      this.metadataTypeManager.getAssignedWidget(propertyKey) === 'checkbox'
    ) {
      return;
    }

    // Through Obsidian's registry, which updates its in-memory map and types.json together: a read-modify-write of the file loses a type Obsidian saves in between, and replaces a malformed file with this one entry.
    try {
      await this.metadataTypeManager.setType(propertyKey, 'checkbox');
      verboseLog(
        this.plugin,
        `Property "${propertyKey}" set to checkbox for disable renaming command`
      );
    } catch (error) {
      // The property write that follows does not depend on its type, so a failed save only loses the checkbox display
      console.error('Failed to set the property type to checkbox:', error);
    }
  }
}
