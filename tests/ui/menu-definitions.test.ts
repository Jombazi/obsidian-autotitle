/**
 * Tests for MenuDefinitions visibility rules
 *
 * Focus: which of the three items each menu config renders. The disable/enable
 * pair is mutually exclusive - exactly one of the two is offered at a time - and
 * for folders and tags the exclusion strategy inverts which one that is.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Menu as ObsidianMenu } from 'obsidian';
import { Menu, TFile, TFolder } from '../mockObsidian';
import { MenuDefinitions } from '../../src/ui/menu-definitions';
import { MenuConfig, MenuRenderer } from '../../src/ui/menu-config';
import { ContextMenuManager } from '../../src/ui/context-menus';
import {
  DeepPartial,
  EXCLUSION_STRATEGY,
  ExclusionStrategy,
  PluginSettings,
} from '../../src/types';
import { captureMenuItems, createTestSettings } from '../testUtils';

// Icons stand in for item identity: each item in a Flit menu config sets a
// distinct one, and unlike the titles they don't move with the locale.
const PUT_FIRST_LINE_IN_TITLE = 'file-type-corner';
const DISABLE_RENAMING = 'pen-off';
const ENABLE_RENAMING = 'file-pen';

const ICON_FOR_OFFER = {
  disable: DISABLE_RENAMING,
  enable: ENABLE_RENAMING,
} as const;

// Folders and tags share this table: the strategy decides whether being on the
// exclusion list means "renaming is off here" or "renaming is on here", which
// flips which half of the disable/enable pair the menu offers.
// `renames` is false where the rules spare nothing under the folder or tag, which hides the rename command too.
const PAIR_CASES = [
  {
    strategy: EXCLUSION_STRATEGY.ONLY_EXCLUDE,
    listed: false,
    offer: 'disable',
    renames: true,
  },
  {
    strategy: EXCLUSION_STRATEGY.ONLY_EXCLUDE,
    listed: true,
    offer: 'enable',
    renames: false,
  },
  {
    strategy: EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT,
    listed: false,
    offer: 'enable',
    renames: false,
  },
  {
    strategy: EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT,
    listed: true,
    offer: 'disable',
    renames: true,
  },
] as const;

function createMockPlugin(settingsOverrides: DeepPartial<PluginSettings> = {}) {
  const plugin: any = {
    app: {
      metadataCache: {
        getFileCache: vi.fn(() => null),
        getTags: vi.fn(() => ({})),
      },
    },
    settings: createTestSettings(settingsOverrides),
  };
  return plugin;
}

/** The plugin's menu definitions, with the real manager's visibility checks rather than a stub: the folder and tag predicates delegate the strategy-dependent half of their decision to them. */
function definitionsFor(plugin: any): MenuDefinitions {
  return new MenuDefinitions(plugin, new ContextMenuManager(plugin));
}

/** The icons of the items this config renders for this context, in menu order. */
function renderedIcons<TContext>(
  config: MenuConfig<TContext>,
  context: TContext
): string[] {
  const menu = new Menu();
  new MenuRenderer().render(menu as unknown as ObsidianMenu, config, context);
  return captureMenuItems(menu.addItem).map((item) => item.icon);
}

describe('MenuDefinitions', () => {
  describe('getFileMenuConfig', () => {
    const file = new TFile('Notes/note.md');

    function iconsFor(plugin: any): string[] {
      return renderedIcons(definitionsFor(plugin).getFileMenuConfig(), {
        file,
      });
    }

    /** Stubs the metadata cache so the note carries the disable-renaming property at `value`, or none. */
    function stubDisableRenamingProperty(plugin: any, value: unknown): void {
      plugin.app.metadataCache.getFileCache.mockReturnValue({
        frontmatter:
          value === undefined
            ? { tags: ['inbox'] }
            : { [plugin.settings.exclusions.disableRenamingKey]: value },
      });
    }

    it('should render nothing when note commands are off', () => {
      const plugin = createMockPlugin({ core: { enableFileCommands: false } });
      stubDisableRenamingProperty(plugin, undefined);

      expect(iconsFor(plugin)).toEqual([]);
    });

    it('should offer disable when the note has no properties at all', () => {
      const plugin = createMockPlugin();
      plugin.app.metadataCache.getFileCache.mockReturnValue({});

      expect(iconsFor(plugin)).toEqual([
        PUT_FIRST_LINE_IN_TITLE,
        DISABLE_RENAMING,
      ]);
    });

    it('should offer disable when the properties lack the key', () => {
      const plugin = createMockPlugin();
      stubDisableRenamingProperty(plugin, undefined);

      expect(iconsFor(plugin)).toEqual([
        PUT_FIRST_LINE_IN_TITLE,
        DISABLE_RENAMING,
      ]);
    });

    it('should offer enable when the value matches, ignoring case', () => {
      const plugin = createMockPlugin({
        exclusions: { disableRenamingValue: 'true' },
      });
      stubDisableRenamingProperty(plugin, 'TRUE');

      expect(iconsFor(plugin)).toEqual([
        PUT_FIRST_LINE_IN_TITLE,
        ENABLE_RENAMING,
      ]);
    });

    it('should offer disable when the value is something else', () => {
      const plugin = createMockPlugin({
        exclusions: { disableRenamingValue: 'true' },
      });
      stubDisableRenamingProperty(plugin, 'false');

      expect(iconsFor(plugin)).toEqual([
        PUT_FIRST_LINE_IN_TITLE,
        DISABLE_RENAMING,
      ]);
    });

    it.each([
      ['no cache at all', null],
      ['a cache with no properties', {}],
      ['properties without the key', { frontmatter: { tags: ['inbox'] } }],
      ['the key set to the matching value', { frontmatter: { flit: 'true' } }],
      ['the key set in another case', { frontmatter: { flit: 'True' } }],
      ['the key set to another value', { frontmatter: { flit: 'no' } }],
      ['the key set to a boolean', { frontmatter: { flit: true } }],
    ])(
      'should offer exactly one of disable/enable given %s',
      (_label, cache) => {
        const plugin = createMockPlugin({
          exclusions: {
            disableRenamingKey: 'flit',
            disableRenamingValue: 'true',
          },
        });
        plugin.app.metadataCache.getFileCache.mockReturnValue(cache);

        const pair = iconsFor(plugin).filter(
          (icon) => icon === DISABLE_RENAMING || icon === ENABLE_RENAMING
        );

        expect(pair).toHaveLength(1);
      }
    );
  });

  describe('file menu disable and enable', () => {
    it.each([
      [DISABLE_RENAMING, true],
      [ENABLE_RENAMING, false],
    ])(
      'hands the note to the shared toggle from the %s item',
      async (icon, disabled) => {
        const plugin = createMockPlugin();
        plugin.setRenamingDisabledForNote = vi
          .fn()
          .mockResolvedValue(undefined);
        const file = new TFile('Notes/note.md');

        const item = definitionsFor(plugin)
          .getFileMenuConfig()
          .items.find((candidate) => candidate.icon === icon);
        await item?.onClick({ file });

        expect(plugin.setRenamingDisabledForNote).toHaveBeenCalledWith(
          file,
          disabled
        );
      }
    );
  });

  describe('getFolderMenuConfig', () => {
    const folder = new TFolder('Notes');

    function iconsFor(plugin: any): string[] {
      return renderedIcons(definitionsFor(plugin).getFolderMenuConfig(), {
        folder,
      });
    }

    it('should render nothing when folder commands are off', () => {
      const plugin = createMockPlugin({
        core: { enableFolderCommands: false },
      });

      expect(iconsFor(plugin)).toEqual([]);
    });

    // Each expectation names both items in menu order, so it also asserts the
    // other half of the pair stayed hidden.
    it.each(PAIR_CASES)(
      'should offer only the $offer command under $strategy when the folder is listed: $listed',
      ({ strategy, listed, offer, renames }) => {
        const plugin = createMockPlugin({
          exclusions: {
            fileScopeStrategy: strategy,
            excludedFiles: listed ? [`${folder.path}/`] : [],
          },
        });

        expect(iconsFor(plugin)).toEqual([
          ...(renames ? [PUT_FIRST_LINE_IN_TITLE] : []),
          ICON_FOR_OFFER[offer],
        ]);
      }
    );

    it('should keep the rename command for an unlisted folder whose subfolder the rules spare', () => {
      const plugin = createMockPlugin({
        exclusions: {
          fileScopeStrategy: EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT,
          excludedFiles: ['Notes/Work/'],
        },
      });

      expect(iconsFor(plugin)).toEqual([
        PUT_FIRST_LINE_IN_TITLE,
        ENABLE_RENAMING,
      ]);
    });

    // Obsidian's explorer hands the vault root to the folder menu on a blank-area right-click
    it.each([
      EXCLUSION_STRATEGY.ONLY_EXCLUDE,
      EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT,
    ])(
      'should offer neither half of the pair for the vault root under %s',
      (strategy) => {
        const plugin = createMockPlugin({
          exclusions: { fileScopeStrategy: strategy, excludedFiles: ['/'] },
        });

        const icons = renderedIcons(
          definitionsFor(plugin).getFolderMenuConfig(),
          { folder: new TFolder('/') }
        );

        expect(icons).toEqual([PUT_FIRST_LINE_IN_TITLE]);
      }
    );
  });

  describe('shouldShowDisableMenuForFolder', () => {
    function showsDisable(
      excludedFiles: string[],
      strategy: ExclusionStrategy = EXCLUSION_STRATEGY.ONLY_EXCLUDE
    ): boolean {
      const plugin = createMockPlugin({
        exclusions: { fileScopeStrategy: strategy, excludedFiles },
      });
      return new ContextMenuManager(plugin).shouldShowDisableMenuForFolder(
        'Notes'
      );
    }

    it("matches the folder's own entry regardless of case", () => {
      expect(showsDisable(['notes/'])).toBe(false);
      expect(
        showsDisable(['NOTES/'], EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT)
      ).toBe(true);
    });

    it("does not count a slash-less prefix entry as the folder's own", () => {
      expect(showsDisable(['Notes'])).toBe(true);
      expect(
        showsDisable(['Notes'], EXCLUSION_STRATEGY.EXCLUDE_ALL_EXCEPT)
      ).toBe(false);
    });
  });

  describe('getTagMenuConfig', () => {
    const tagName = 'project';

    function iconsFor(plugin: any): string[] {
      return renderedIcons(definitionsFor(plugin).getTagMenuConfig(), {
        tagName,
      });
    }

    it('should render nothing when tag commands are off', () => {
      const plugin = createMockPlugin({ core: { enableTagCommands: false } });

      expect(iconsFor(plugin)).toEqual([]);
    });

    it.each(PAIR_CASES)(
      'should offer only the $offer command under $strategy when the tag is listed: $listed',
      ({ strategy, listed, offer, renames }) => {
        // The stored list carries the leading '#'; the context does not.
        const plugin = createMockPlugin({
          exclusions: {
            tagScopeStrategy: strategy,
            excludedTags: listed ? [`#${tagName}`] : [],
          },
        });

        expect(iconsFor(plugin)).toEqual([
          ...(renames ? [PUT_FIRST_LINE_IN_TITLE] : []),
          ICON_FOR_OFFER[offer],
        ]);
      }
    );

    it('should keep the rename command for an excluded tag whose subtag the rules spare', () => {
      const plugin = createMockPlugin({
        exclusions: {
          tagScopeStrategy: EXCLUSION_STRATEGY.ONLY_EXCLUDE,
          excludedTags: [`#${tagName}`],
          matchSubtags: false,
        },
      });
      plugin.app.metadataCache.getTags.mockReturnValue({
        [`#${tagName}`]: 2,
        [`#${tagName}/alpha`]: 1,
      });

      expect(iconsFor(plugin)).toEqual([
        PUT_FIRST_LINE_IN_TITLE,
        ENABLE_RENAMING,
      ]);
    });
  });
});
