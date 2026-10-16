import { normalizePath } from 'obsidian';
import { verboseLog } from '../utils';
import {
  folderExclusionEntry,
  hasExcludedFileEntry,
} from '../utils/file-exclusions';
import { FirstLineIsTitlePlugin } from '../settings/settings-base';

/**
 * PluginInitializer
 *
 * Runs the one-time setup a fresh install gets: auto-detected exclusions for template folders and Excalidraw files.
 */
export class PluginInitializer {
  constructor(private plugin: FirstLineIsTitlePlugin) {}

  get settings() {
    return this.plugin.settings;
  }

  /**
   * Check and setup exclusions on first plugin load
   * Auto-detects and excludes template folders and Excalidraw files
   */
  async checkFirstTimeExclusionsSetup(): Promise<void> {
    // Skip if already done
    if (this.settings.core.hasSetupExclusions) {
      return;
    }

    // Check if Excalidraw plugin is installed and enabled
    const excalidrawPlugin = this.plugin.app.plugins.getPlugin(
      'obsidian-excalidraw-plugin'
    ) as { _loaded?: boolean } | null;
    if (excalidrawPlugin && excalidrawPlugin._loaded) {
      // Check if excalidraw-plugin property already exists
      const hasExcalidrawProperty =
        this.settings.exclusions.excludedProperties.some(
          (prop) => prop.key === 'excalidraw-plugin' && prop.value === 'parsed'
        );

      if (!hasExcalidrawProperty) {
        // Add Excalidraw exclusion
        this.settings.exclusions.excludedProperties.push({
          key: 'excalidraw-plugin',
          value: 'parsed',
        });
        await this.plugin.saveSettings();
      }
    }

    // Check for Templates and Templater folders
    verboseLog(
      this.plugin,
      'Checking for template plugin folders to auto-exclude'
    );
    const adapter = this.plugin.app.vault.adapter;
    const configDir = this.plugin.app.vault.configDir;
    verboseLog(this.plugin, 'Vault config directory is:', configDir);
    let templatesFolder: string | null = null;
    let templaterFolder: string | null = null;

    // A missing or malformed config file just means the feature is unused, so
    // every read degrades to null rather than aborting the whole setup pass.
    const readJsonConfig = async (
      path: string
    ): Promise<Record<string, unknown> | null> => {
      verboseLog(this.plugin, 'Reading configuration from:', path);
      try {
        return JSON.parse(await adapter.read(path)) as Record<string, unknown>;
      } catch (error) {
        // Interpolated rather than passed as data: catch variables type as
        // `any` here (no strict mode), which trips no-unsafe-assignment when
        // spread into an object literal.
        verboseLog(
          this.plugin,
          `Could not read configuration from: ${path} — ${error}`
        );
        return null;
      }
    };

    // Check Templater plugin
    verboseLog(this.plugin, 'Checking for Templater community plugin');
    const templaterPlugin = this.plugin.app.plugins.getPlugin(
      'templater-obsidian'
    ) as { _loaded?: boolean } | null;
    verboseLog(this.plugin, 'Templater plugin found:', {
      found: !!templaterPlugin,
      loaded: templaterPlugin?._loaded,
    });

    // templates.json is fetched unconditionally so all three reads overlap;
    // one extra small read beats serializing them behind the enabled check.
    const [corePlugins, templatesConfig, templaterConfig] = await Promise.all([
      readJsonConfig(`${configDir}/core-plugins.json`),
      readJsonConfig(`${configDir}/templates.json`),
      templaterPlugin?._loaded
        ? readJsonConfig(`${configDir}/plugins/templater-obsidian/data.json`)
        : Promise.resolve(null),
    ]);

    // Check core Templates plugin - only if enabled
    verboseLog(
      this.plugin,
      'Core Templates plugin enabled status:',
      corePlugins?.templates
    );
    if (corePlugins?.templates === true) {
      templatesFolder = (templatesConfig?.folder as string) ?? null;
      verboseLog(
        this.plugin,
        'Core Templates folder configured as:',
        templatesFolder
      );
    } else {
      verboseLog(this.plugin, 'Core Templates plugin is disabled, skipping');
    }

    if (templaterPlugin?._loaded) {
      templaterFolder = (templaterConfig?.templates_folder as string) ?? null;
      verboseLog(
        this.plugin,
        'Templater folder configured as:',
        templaterFolder
      );
    } else {
      verboseLog(this.plugin, 'Templater plugin not loaded, skipping');
    }

    // Collect folders to add
    const foldersToAdd: string[] = [];

    if (templatesFolder && templatesFolder.trim() !== '') {
      foldersToAdd.push(templatesFolder);
      verboseLog(
        this.plugin,
        'Queued core Templates folder for exclusion:',
        templatesFolder
      );
    } else {
      verboseLog(this.plugin, 'No valid core Templates folder to add');
    }

    // Only add templater folder if it differs from templates folder
    if (templaterFolder && templaterFolder.trim() !== '') {
      if (templaterFolder !== templatesFolder) {
        foldersToAdd.push(templaterFolder);
        verboseLog(
          this.plugin,
          'Queued Templater folder for exclusion:',
          templaterFolder
        );
      } else {
        verboseLog(
          this.plugin,
          'Templater folder matches core Templates folder (' +
            templaterFolder +
            '), will not add duplicate'
        );
      }
    } else {
      verboseLog(this.plugin, 'No valid Templater folder to add');
    }

    verboseLog(
      this.plugin,
      'Total folders to add to exclusions:',
      foldersToAdd
    );
    verboseLog(
      this.plugin,
      'Current excluded files before processing:',
      this.settings.exclusions.excludedFiles
    );

    // Add folders if they don't already exist
    for (const folder of foldersToAdd) {
      // The vault root has no entry of its own, as in Obsidian's Excluded files, where `//` matches nothing
      if (normalizePath(folder) === '/') {
        verboseLog(this.plugin, 'Template folder is the vault root, skipping');
        continue;
      }
      // The form toggleFolderExclusion writes; normalizing first keeps a user-typed `Templates/` or `/Templates` from becoming `Templates//`
      const folderEntry = folderExclusionEntry(folder);

      if (
        !hasExcludedFileEntry(
          this.settings.exclusions.excludedFiles,
          folderEntry
        )
      ) {
        this.settings.exclusions.excludedFiles.push(folderEntry);
        verboseLog(
          this.plugin,
          'Successfully added folder to exclusions:',
          folderEntry
        );
      } else {
        verboseLog(
          this.plugin,
          'Folder already in exclusions list, skipping:',
          folder
        );
      }
    }

    // Save if any folders were added
    if (foldersToAdd.length > 0) {
      await this.plugin.saveSettings();
      verboseLog(
        this.plugin,
        'Saved settings after adding template folders to exclusions'
      );
    } else {
      verboseLog(this.plugin, 'No folders were added, skipping settings save');
    }
    verboseLog(
      this.plugin,
      'Final excluded files after processing:',
      this.settings.exclusions.excludedFiles
    );

    // Mark as setup complete
    this.settings.core.hasSetupExclusions = true;
    await this.plugin.saveSettings();
  }
}
