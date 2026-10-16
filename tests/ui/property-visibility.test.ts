/**
 * Tests for PropertyVisibility
 *
 * Focus: which properties and containers hiding hides in each mode and context,
 * one observer per window (main and pop-outs), no setup for a blank property
 * name, and no pass for mutations that cannot touch a property.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { PropertyVisibility } from '../../src/ui/property-visibility';
import { DeepPartial, PluginSettings } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/constants';
import { deepMerge } from '../../src/utils/deep-merge';

/** Each leaf only needs the document its view sits in */
interface LeafStub {
  view: { containerEl: { ownerDocument: Document } };
}

function createMockPlugin(
  settingsOverrides: DeepPartial<PluginSettings> = {},
  leaves: LeafStub[] = []
) {
  return {
    settings: deepMerge(DEFAULT_SETTINGS, settingsOverrides),
    app: {
      workspace: {
        on: vi.fn(),
        iterateAllLeaves: vi.fn((callback: (leaf: LeafStub) => void) => {
          leaves.forEach(callback);
        }),
      },
    },
    registerEvent: vi.fn(),
  } as any;
}

function leafIn(doc: Document): LeafStub {
  return { view: { containerEl: { ownerDocument: doc } } };
}

/** Hands back the callback the constructor registered for a workspace event */
function workspaceHandler(
  plugin: any,
  name: 'window-open' | 'window-close'
): (workspaceWindow: unknown, win: { document: Document }) => void {
  const registration = plugin.app.workspace.on.mock.calls.find(
    (call: unknown[]) => call[0] === name
  );
  if (!registration) throw new Error(`${name} handler was not registered`);
  return registration[1];
}

interface MarkupOptions {
  doc?: Document;
  keys?: string[];
  /** Property values by key; a key left out renders an empty value */
  values?: Record<string, string>;
  /** Wraps the properties in a leaf of this view type, e.g. `file-properties` for the sidebar */
  leafType?: string;
}

/**
 * Builds the DOM shape Obsidian renders for properties. Two properties by
 * default, so hiding one takes the individual-property branch rather than the
 * hide-the-whole-container branch reserved for a lone property.
 */
function renderPropertiesMarkup({
  doc = document,
  keys = ['aliases', 'tags'],
  values = { aliases: 'Alias', tags: 'tag' },
  leafType,
}: MarkupOptions = {}): HTMLElement {
  const container = doc.createElement('div');
  container.className = 'metadata-container';

  const properties = doc.createElement('div');
  properties.className = 'metadata-properties';
  container.appendChild(properties);

  for (const key of keys) {
    properties.appendChild(createPropertyEl(doc, key, values[key]));
  }

  if (leafType) {
    const leafContent = doc.createElement('div');
    leafContent.className = 'workspace-leaf-content';
    leafContent.setAttribute('data-type', leafType);
    leafContent.appendChild(container);
    doc.body.appendChild(leafContent);
  } else {
    doc.body.appendChild(container);
  }
  return container;
}

function createPropertyEl(
  doc: Document,
  key: string,
  value?: string
): HTMLElement {
  const property = doc.createElement('div');
  property.className = 'metadata-property';
  property.setAttribute('data-property-key', key);

  const valueEl = doc.createElement('div');
  valueEl.className = 'metadata-property-value';
  if (value) {
    const input = doc.createElement('div');
    input.className = 'metadata-input-longtext';
    input.textContent = value;
    valueEl.appendChild(input);
  }
  property.appendChild(valueEl);
  return property;
}

function propertyEl(key = 'aliases', doc: Document = document): HTMLElement {
  for (const el of Array.from(
    doc.querySelectorAll<HTMLElement>('[data-property-key]')
  )) {
    if (el.getAttribute('data-property-key') === key) return el;
  }
  throw new Error(`property element ${key} missing`);
}

function isHidden(el: Element): boolean {
  return el.classList.contains('flit-property-hidden');
}

function isContainerHidden(el: Element): boolean {
  return el.classList.contains('flit-container-hidden');
}

/** Mutation observer callbacks run as microtasks; a macrotask runs after all of them */
function flushMutations(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PropertyVisibility', () => {
  let propertyVisibility: PropertyVisibility | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    propertyVisibility?.cleanup();
    propertyVisibility = undefined;
    document.body.replaceChildren();
  });

  describe('blank first line property name', () => {
    it('should install no observer', () => {
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: { propertyKey: '', hideProperty: 'always' },
        })
      );

      propertyVisibility.updatePropertyVisibility();

      expect(propertyVisibility['observers'].size).toBe(0);
    });

    it('should hide nothing', () => {
      renderPropertiesMarkup();
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: { propertyKey: '', hideProperty: 'always' },
        })
      );

      propertyVisibility.updatePropertyVisibility();

      expect(isHidden(propertyEl())).toBe(false);
    });

    // Clearing the field while hiding is active goes through this same path, so
    // no separate teardown is needed - the cleanup that already runs at the top
    // of every update un-hides whatever the previous key hid.
    it('should un-hide what a previous key left hidden', () => {
      renderPropertiesMarkup();
      const plugin = createMockPlugin({
        firstLineProperty: { propertyKey: 'aliases', hideProperty: 'always' },
      });
      propertyVisibility = new PropertyVisibility(plugin);

      propertyVisibility.updatePropertyVisibility();
      expect(isHidden(propertyEl())).toBe(true);

      plugin.settings.firstLineProperty.propertyKey = '';
      propertyVisibility.updatePropertyVisibility();

      expect(isHidden(propertyEl())).toBe(false);
      expect(propertyVisibility['observers'].size).toBe(0);
    });
  });

  describe('with a property name set', () => {
    it('should install an observer and hide the property', () => {
      renderPropertiesMarkup();
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: { propertyKey: 'aliases', hideProperty: 'always' },
        })
      );

      propertyVisibility.updatePropertyVisibility();

      expect(propertyVisibility['observers'].has(document)).toBe(true);
      expect(isHidden(propertyEl())).toBe(true);
    });

    it('should leave other properties alone', () => {
      renderPropertiesMarkup();
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: { propertyKey: 'aliases', hideProperty: 'always' },
        })
      );

      propertyVisibility.updatePropertyVisibility();

      expect(isHidden(propertyEl('tags'))).toBe(false);
    });

    it('should install no observer when hiding is off', () => {
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: { propertyKey: 'aliases', hideProperty: 'never' },
        })
      );

      propertyVisibility.updatePropertyVisibility();

      expect(propertyVisibility['observers'].size).toBe(0);
    });

    it('should hide a property added after setup', async () => {
      const container = renderPropertiesMarkup({ keys: ['tags'] });
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: { propertyKey: 'aliases', hideProperty: 'always' },
        })
      );
      propertyVisibility.updatePropertyVisibility();

      container
        .querySelector('.metadata-properties')
        ?.appendChild(createPropertyEl(document, 'aliases', 'Alias'));
      await flushMutations();

      expect(isHidden(propertyEl())).toBe(true);
    });
  });

  describe('when empty', () => {
    const settings: DeepPartial<PluginSettings> = {
      firstLineProperty: { propertyKey: 'aliases', hideProperty: 'when_empty' },
    };

    it('should hide the property while it has no value', () => {
      renderPropertiesMarkup({ values: { tags: 'tag' } });
      propertyVisibility = new PropertyVisibility(createMockPlugin(settings));

      propertyVisibility.updatePropertyVisibility();

      expect(isHidden(propertyEl())).toBe(true);
    });

    it('should leave the property shown while it has a value', () => {
      renderPropertiesMarkup();
      propertyVisibility = new PropertyVisibility(createMockPlugin(settings));

      propertyVisibility.updatePropertyVisibility();

      expect(isHidden(propertyEl())).toBe(false);
      expect(propertyEl().classList.contains('flit-property-visible')).toBe(
        true
      );
    });

    it('should show the property once a value is typed in', async () => {
      renderPropertiesMarkup({ values: { tags: 'tag' } });
      propertyVisibility = new PropertyVisibility(createMockPlugin(settings));
      propertyVisibility.updatePropertyVisibility();

      const input = document.createElement('div');
      input.className = 'metadata-input-longtext';
      input.textContent = 'Alias';
      propertyEl()
        .querySelector('.metadata-property-value')
        ?.appendChild(input);
      await flushMutations();

      expect(isHidden(propertyEl())).toBe(false);
    });
  });

  describe('sidebar', () => {
    it('should leave the property shown without Hide in sidebar', () => {
      renderPropertiesMarkup({ leafType: 'file-properties' });
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: {
            propertyKey: 'aliases',
            hideProperty: 'always',
            hideInSidebar: false,
          },
        })
      );

      propertyVisibility.updatePropertyVisibility();

      expect(isHidden(propertyEl())).toBe(false);
    });

    it('should hide the property with Hide in sidebar', () => {
      renderPropertiesMarkup({ leafType: 'file-properties' });
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: {
            propertyKey: 'aliases',
            hideProperty: 'always',
            hideInSidebar: true,
          },
        })
      );

      propertyVisibility.updatePropertyVisibility();

      expect(isHidden(propertyEl())).toBe(true);
    });

    it('should hide a lone property in a note even without Hide in sidebar', () => {
      const container = renderPropertiesMarkup({
        keys: ['aliases'],
        leafType: 'markdown',
      });
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: {
            propertyKey: 'aliases',
            hideProperty: 'always',
            hideInSidebar: false,
          },
        })
      );

      propertyVisibility.updatePropertyVisibility();

      expect(isContainerHidden(container)).toBe(true);
    });

    it('should hide only the property list of a lone sidebar property, keeping Add property', () => {
      const container = renderPropertiesMarkup({
        keys: ['aliases'],
        leafType: 'file-properties',
      });
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: {
            propertyKey: 'aliases',
            hideProperty: 'always',
            hideInSidebar: true,
          },
        })
      );

      propertyVisibility.updatePropertyVisibility();

      expect(isContainerHidden(container)).toBe(false);
      const list = container.querySelector('.metadata-properties');
      expect(list && isContainerHidden(list)).toBe(true);
    });
  });

  describe('lone property', () => {
    it('should hide its whole container', () => {
      const container = renderPropertiesMarkup({ keys: ['aliases'] });
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: { propertyKey: 'aliases', hideProperty: 'always' },
        })
      );

      propertyVisibility.updatePropertyVisibility();

      expect(isContainerHidden(container)).toBe(true);
    });

    it('should show the container again when another property is added', async () => {
      const container = renderPropertiesMarkup({ keys: ['aliases'] });
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: { propertyKey: 'aliases', hideProperty: 'always' },
        })
      );
      propertyVisibility.updatePropertyVisibility();

      container
        .querySelector('.metadata-properties')
        ?.appendChild(createPropertyEl(document, 'tags', 'tag'));
      await flushMutations();

      expect(isContainerHidden(container)).toBe(false);
      expect(isHidden(propertyEl())).toBe(true);
    });

    it('should un-hide the container on cleanup', () => {
      const container = renderPropertiesMarkup({ keys: ['aliases'] });
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: { propertyKey: 'aliases', hideProperty: 'always' },
        })
      );
      propertyVisibility.updatePropertyVisibility();

      propertyVisibility.cleanup();

      expect(isContainerHidden(container)).toBe(false);
    });
  });

  describe('pop-out windows', () => {
    let popoutDoc: Document;

    beforeEach(() => {
      // A separate JSDOM is a separate realm, like a pop-out's window
      popoutDoc = new JSDOM('<!DOCTYPE html><html><body></body></html>').window
        .document;
    });

    it('should hide the property in a pop-out open at setup', () => {
      renderPropertiesMarkup({ doc: popoutDoc });
      propertyVisibility = new PropertyVisibility(
        createMockPlugin(
          {
            firstLineProperty: {
              propertyKey: 'aliases',
              hideProperty: 'always',
            },
          },
          [leafIn(document), leafIn(popoutDoc)]
        )
      );

      propertyVisibility.updatePropertyVisibility();

      expect(isHidden(propertyEl('aliases', popoutDoc))).toBe(true);
      expect(propertyVisibility['observers'].size).toBe(2);
    });

    it('should hide a property rendered in a pop-out after setup', async () => {
      propertyVisibility = new PropertyVisibility(
        createMockPlugin(
          {
            firstLineProperty: {
              propertyKey: 'aliases',
              hideProperty: 'always',
            },
          },
          [leafIn(popoutDoc)]
        )
      );
      propertyVisibility.updatePropertyVisibility();

      renderPropertiesMarkup({ doc: popoutDoc });
      await flushMutations();

      expect(isHidden(propertyEl('aliases', popoutDoc))).toBe(true);
    });

    it('should observe a pop-out opened later, and stop when it closes', () => {
      renderPropertiesMarkup({ doc: popoutDoc });
      const plugin = createMockPlugin({
        firstLineProperty: { propertyKey: 'aliases', hideProperty: 'always' },
      });
      propertyVisibility = new PropertyVisibility(plugin);
      propertyVisibility.updatePropertyVisibility();
      expect(propertyVisibility['observers'].has(popoutDoc)).toBe(false);

      workspaceHandler(plugin, 'window-open')({}, { document: popoutDoc });

      expect(propertyVisibility['observers'].has(popoutDoc)).toBe(true);
      expect(isHidden(propertyEl('aliases', popoutDoc))).toBe(true);

      workspaceHandler(plugin, 'window-close')({}, { document: popoutDoc });

      expect(propertyVisibility['observers'].has(popoutDoc)).toBe(false);
    });

    it('should not observe a pop-out opened while hiding is off', () => {
      const plugin = createMockPlugin({
        firstLineProperty: { propertyKey: 'aliases', hideProperty: 'never' },
      });
      propertyVisibility = new PropertyVisibility(plugin);

      workspaceHandler(plugin, 'window-open')({}, { document: popoutDoc });

      expect(propertyVisibility['observers'].size).toBe(0);
    });

    it('should un-hide in the pop-out on cleanup', () => {
      renderPropertiesMarkup({ doc: popoutDoc });
      propertyVisibility = new PropertyVisibility(
        createMockPlugin(
          {
            firstLineProperty: {
              propertyKey: 'aliases',
              hideProperty: 'always',
            },
          },
          [leafIn(popoutDoc)]
        )
      );
      propertyVisibility.updatePropertyVisibility();

      propertyVisibility.cleanup();

      expect(isHidden(propertyEl('aliases', popoutDoc))).toBe(false);
    });

    it('should register the window handlers once, however often setup re-runs', () => {
      const plugin = createMockPlugin({
        firstLineProperty: { propertyKey: 'aliases', hideProperty: 'always' },
      });
      propertyVisibility = new PropertyVisibility(plugin);

      propertyVisibility.updatePropertyVisibility();
      propertyVisibility.updatePropertyVisibility();

      expect(plugin.registerEvent).toHaveBeenCalledTimes(2);
      const names = plugin.app.workspace.on.mock.calls.map(
        (call: unknown[]) => call[0]
      );
      expect(names).toEqual(['window-open', 'window-close']);
    });
  });

  describe('property names with selector characters', () => {
    it.each(['say "hi"', 'back\\slash'])(
      'should hide a property named %s',
      (key) => {
        renderPropertiesMarkup({
          keys: [key, 'tags'],
          values: { tags: 'tag' },
        });
        propertyVisibility = new PropertyVisibility(
          createMockPlugin({
            firstLineProperty: { propertyKey: key, hideProperty: 'always' },
          })
        );

        expect(() =>
          propertyVisibility?.updatePropertyVisibility()
        ).not.toThrow();
        expect(isHidden(propertyEl(key))).toBe(true);
      }
    );
  });

  describe('mutation filtering', () => {
    function setUpObserved(): { container: HTMLElement; pass: any } {
      const container = renderPropertiesMarkup();
      propertyVisibility = new PropertyVisibility(
        createMockPlugin({
          firstLineProperty: { propertyKey: 'aliases', hideProperty: 'always' },
        })
      );
      propertyVisibility.updatePropertyVisibility();
      const pass = vi.spyOn(propertyVisibility as any, 'hidePropertiesIn');
      return { container, pass };
    }

    it('should run no pass for mutations outside properties', async () => {
      const { pass } = setUpObserved();

      const editor = document.createElement('div');
      editor.className = 'cm-content';
      document.body.appendChild(editor);
      editor.appendChild(document.createElement('div')).textContent = 'typing';
      editor.setAttribute('data-other', 'x');
      await flushMutations();

      expect(pass).not.toHaveBeenCalled();
    });

    it('should run one pass for a batch of property mutations', async () => {
      const { container, pass } = setUpObserved();

      const list = container.querySelector('.metadata-properties');
      list?.appendChild(createPropertyEl(document, 'one', 'a'));
      list?.appendChild(createPropertyEl(document, 'two', 'b'));
      await flushMutations();

      expect(pass).toHaveBeenCalledTimes(1);
    });

    it('should run a pass when a property key changes', async () => {
      const { pass } = setUpObserved();

      propertyEl('tags').setAttribute('data-property-key', 'renamed');
      await flushMutations();

      expect(pass).toHaveBeenCalledTimes(1);
    });

    it('should run a pass when a properties block is added', async () => {
      const { pass } = setUpObserved();

      const leaf = document.createElement('div');
      leaf.appendChild(createPropertyEl(document, 'aliases', 'Alias'));
      document.body.appendChild(leaf);
      await flushMutations();

      expect(pass).toHaveBeenCalledTimes(1);
    });
  });
});
