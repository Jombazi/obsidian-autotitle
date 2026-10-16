import { Menu, MenuItem } from 'obsidian';

/**
 * Declarative Menu Configuration System
 *
 * Replaces imperative menu building with declarative configuration objects.
 * Benefits:
 * - Reduces code duplication
 * - Easier to maintain and test
 * - Clear separation of menu structure from rendering logic
 * - Self-documenting menu definitions
 */

/** One menu item, typed on the context its menu is rendered with, so a predicate or action cannot read the wrong context. */
export interface MenuItemConfig<TContext = unknown> {
  /** Read by no renderer; kept optional for configs that label their items. */
  id?: string;
  title: string | ((context: TContext) => string);
  icon: string;
  visible: (context: TContext) => boolean;
  onClick: (context: TContext) => void | Promise<void>;
}

export interface MenuConfig<TContext = unknown> {
  items: MenuItemConfig<TContext>[];
}

/**
 * Renders menu items from declarative configuration
 */
export class MenuRenderer {
  /**
   * Render menu items from configuration.
   *
   * Never add a separator before these items. Obsidian buckets section-less menu
   * items — every plugin that skips setSection() — into one group, and buckets
   * separators there too, so injecting one splits that shared group and strands
   * our items in a section of their own.
   *
   * @param menu Obsidian Menu instance
   * @param config Menu configuration
   * @param context Context object passed to visibility/onClick functions
   */
  render<TContext>(
    menu: Menu,
    config: MenuConfig<TContext>,
    context: TContext
  ): void {
    this.renderItems(
      (cb) => {
        menu.addItem(cb);
      },
      this.getVisibleItems(config, context),
      context
    );
  }

  /**
   * Render menu items via a bare addItem callback (e.g. a third-party plugin's
   * menu API that doesn't expose the full Obsidian Menu, only addItem).
   */
  renderToAddItem<TContext>(
    addItem: (cb: (item: MenuItem) => void) => void,
    config: MenuConfig<TContext>,
    context: TContext
  ): void {
    this.renderItems(addItem, this.getVisibleItems(config, context), context);
  }

  private getVisibleItems<TContext>(
    config: MenuConfig<TContext>,
    context: TContext
  ): MenuItemConfig<TContext>[] {
    return config.items.filter((item) => item.visible(context));
  }

  private renderItems<TContext>(
    addItem: (cb: (item: MenuItem) => void) => void,
    visibleItems: MenuItemConfig<TContext>[],
    context: TContext
  ): void {
    for (const itemConfig of visibleItems) {
      addItem((item) => {
        const title =
          typeof itemConfig.title === 'function'
            ? itemConfig.title(context)
            : itemConfig.title;

        item
          .setTitle(title)
          .setIcon(itemConfig.icon)
          .onClick(async () => {
            try {
              await itemConfig.onClick(context);
            } catch (error) {
              console.error('FLIT: menu action failed', error);
            }
          });
      });
    }
  }
}
