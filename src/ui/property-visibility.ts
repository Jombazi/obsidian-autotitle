import { PluginSettings } from '../types';
import { parseFirstLinePropertyKeys } from '../utils/first-line-property-keys';
import FirstLineIsTitle from '../../main';

/** Class names one hidden state writes; a container has no visible class because nothing styles one */
interface HiddenStateClasses {
  hidden: string;
  visible?: string;
}

const PROPERTY_CLASSES: HiddenStateClasses = {
  hidden: 'flit-property-hidden',
  visible: 'flit-property-visible',
};

const CONTAINER_CLASSES: HiddenStateClasses = {
  hidden: 'flit-container-hidden',
};

/** Elements whose arrival can bring a property into a window */
const PROPERTY_HOST_SELECTOR = '.metadata-container, .metadata-property';

/**
 * Writes an element's hidden state as its hidden class, plus the opposite visible class when it has one.
 * With `force`, the native `classList.toggle` leaves the attribute alone when nothing changes, while Obsidian's `toggleClass`/`addClass` rewrite it every time (measured).
 */
function writeHiddenState(
  el: Element,
  classes: HiddenStateClasses,
  hidden: boolean
): void {
  el.classList.toggle(classes.hidden, hidden);
  if (classes.visible) el.classList.toggle(classes.visible, !hidden);
}

/**
 * Whether a mutation can have added, removed, renamed or emptied a property, so typing in a note body or another plugin's UI runs no pass.
 * Tests `nodeType`, never `instanceof`: a pop-out's nodes come from another realm and fail the main window's `Element` check.
 */
function canAffectProperties(record: MutationRecord): boolean {
  // `attributeFilter` admits only `data-property-key` changes
  if (record.type === 'attributes') return true;

  const target = record.target;
  if (
    target.nodeType === 1 &&
    (target as Element).closest('.metadata-container')
  ) {
    return true;
  }

  const addedNodes = record.addedNodes;
  for (let i = 0; i < addedNodes.length; i++) {
    const node = addedNodes[i];
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (
      el.matches(PROPERTY_HOST_SELECTOR) ||
      el.querySelector(PROPERTY_HOST_SELECTOR)
    ) {
      return true;
    }
  }
  return false;
}

/** True when a property shows no value */
function isPropertyEmpty(property: Element): boolean {
  const valueContainer = property.querySelector('.metadata-property-value');
  return (
    !valueContainer ||
    valueContainer.textContent?.trim() === '' ||
    valueContainer.children.length === 0
  );
}

export class PropertyVisibility {
  /** One observer per window showing notes: the main window's document and each pop-out's */
  private observers = new Map<Document, MutationObserver>();

  constructor(private plugin: FirstLineIsTitle) {
    // Registered once here rather than in setup, which re-runs on every settings cascade and would add a pair each time
    plugin.registerEvent(
      plugin.app.workspace.on('window-open', (_, win) => {
        const propertyKeys = this.getKeysToHide();
        if (propertyKeys.length > 0) {
          this.observeDocument(win.document, propertyKeys);
        }
      })
    );
    plugin.registerEvent(
      plugin.app.workspace.on('window-close', (_, win) => {
        this.disconnectDocument(win.document);
      })
    );
  }

  get settings(): PluginSettings {
    return this.plugin.settings;
  }

  /**
   * Keys to hide under the current settings
   * @returns Array of property keys, empty while hiding is off or the property name is blank
   */
  private getKeysToHide(): string[] {
    if (this.settings.firstLineProperty.hideProperty === 'never') {
      return [];
    }
    return parseFirstLinePropertyKeys(
      this.settings.firstLineProperty.propertyKey
    );
  }

  /** The main window's document plus each pop-out's, read off the leaves they hold */
  private collectWindowDocuments(): Set<Document> {
    // Module-scope `document` is the main window's, which is the one wanted here
    const docs = new Set<Document>([document]);
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      docs.add(leaf.view.containerEl.ownerDocument);
    });
    return docs;
  }

  /**
   * Starts hiding properties in one window's document, replacing any observer it already has
   */
  private observeDocument(doc: Document, propertyKeys: string[]): void {
    this.disconnectDocument(doc);

    // A closed pop-out's document has no window and nothing left to hide
    const win = doc.defaultView;
    if (!win || !doc.body) return;

    const selector = propertyKeys
      .map((key) => `[data-property-key="${CSS.escape(key)}"]`)
      .join(', ');

    // Built from the document's own window, since main-window ResizeObserver and IntersectionObserver silently fail on a pop-out's DOM
    const observer = new win.MutationObserver((records) => {
      // The pass stays in the callback: deferring it a frame would show the property for that frame
      if (records.some(canAffectProperties)) {
        this.hidePropertiesIn(doc, selector);
      }
    });

    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-property-key'],
    });
    this.observers.set(doc, observer);

    this.hidePropertiesIn(doc, selector);
  }

  /**
   * Stops observing one window's document, leaving its classes as they are
   */
  private disconnectDocument(doc: Document): void {
    this.observers.get(doc)?.disconnect();
    this.observers.delete(doc);
  }

  /**
   * One hiding pass over every matching property in one window's document
   */
  private hidePropertiesIn(doc: Document, selector: string): void {
    doc.querySelectorAll(selector).forEach((property) => {
      this.applyHiding(property);
    });
  }

  /**
   * Hides or shows one property, and its container, based on current settings and context
   */
  private applyHiding(property: Element): void {
    const metadataContainer = property.closest('.metadata-container');

    // Skip if in source view (check for CodeMirror editor context)
    if (property.closest('.cm-editor') && !metadataContainer) {
      return;
    }

    // Detect context: sidebar vs in-note
    // Sidebar properties are typically in workspace-leaf-content but NOT in Markdown views
    const isInSidebar =
      !!property.closest('.workspace-leaf-content') &&
      !property.closest('.workspace-leaf-content[data-type="markdown"]') &&
      !property.closest('.markdown-source-view') &&
      !property.closest('.markdown-preview-view');

    const { hideProperty, hideInSidebar } = this.settings.firstLineProperty;
    const contextAllowsHiding = !isInSidebar || hideInSidebar;
    const shouldHide =
      contextAllowsHiding &&
      (hideProperty === 'always' ||
        (hideProperty === 'when_empty' && isPropertyEmpty(property)));

    const metadataProperties = property.closest('.metadata-properties');

    if (!shouldHide) {
      writeHiddenState(property, PROPERTY_CLASSES, false);
      // Ensure containers are visible since we have a property that should be shown
      if (metadataProperties) {
        writeHiddenState(metadataProperties, CONTAINER_CLASSES, false);
      }
      if (metadataContainer) {
        writeHiddenState(metadataContainer, CONTAINER_CLASSES, false);
      }
      return;
    }

    if (!metadataProperties) {
      // Fallback: just hide the individual property
      writeHiddenState(property, PROPERTY_CLASSES, true);
      return;
    }

    const allProperties = metadataProperties.querySelectorAll(
      '.metadata-property[data-property-key]'
    );

    if (allProperties.length === 1 && allProperties[0] === property) {
      // SIDEBAR: Only hide .metadata-properties, preserve "Add property" button
      // IN-NOTE: Hide entire .metadata-container including "Add property" button
      writeHiddenState(
        isInSidebar
          ? metadataProperties
          : (metadataContainer ?? metadataProperties),
        CONTAINER_CLASSES,
        true
      );
      return;
    }

    // There are other properties - hide this individual property
    writeHiddenState(property, PROPERTY_CLASSES, true);

    const anyPropertyVisible =
      metadataProperties.querySelector(
        `.metadata-property[data-property-key]:not(.${PROPERTY_CLASSES.hidden})`
      ) !== null;

    if (anyPropertyVisible) {
      writeHiddenState(metadataProperties, CONTAINER_CLASSES, false);
      if (metadataContainer) {
        writeHiddenState(metadataContainer, CONTAINER_CLASSES, false);
      }
    } else if (isInSidebar) {
      // All properties hidden - hide the entire container
      writeHiddenState(metadataProperties, CONTAINER_CLASSES, true);
    } else if (metadataContainer) {
      writeHiddenState(metadataContainer, CONTAINER_CLASSES, true);
    }
  }

  /**
   * Restores every element hiding left hidden in one window's document
   */
  private unhideAll(doc: Document): void {
    doc.querySelectorAll(`.${PROPERTY_CLASSES.hidden}`).forEach((property) => {
      writeHiddenState(property, PROPERTY_CLASSES, false);
    });
    doc
      .querySelectorAll(`.${CONTAINER_CLASSES.hidden}`)
      .forEach((container) => {
        writeHiddenState(container, CONTAINER_CLASSES, false);
      });
  }

  /**
   * Updates property visibility based on current settings
   */
  updatePropertyVisibility(): void {
    this.cleanup();

    // Hiding off or a blank property name leaves nothing to hide; the cleanup above has already un-hidden whatever a previous key hid
    const propertyKeys = this.getKeysToHide();
    if (propertyKeys.length === 0) return;

    for (const doc of this.collectWindowDocuments()) {
      this.observeDocument(doc, propertyKeys);
    }
  }

  /**
   * Disconnects every observer and restores hidden elements in every observed document
   */
  cleanup(): void {
    for (const [doc, observer] of this.observers) {
      observer.disconnect();
      this.unhideAll(doc);
    }
    this.observers.clear();
  }
}
