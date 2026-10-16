/**
 * Test setup file
 * Runs before all tests to configure the test environment
 */

import { vi } from 'vitest';
import { JSDOM } from 'jsdom';

// Setup DOM environment for tests that need it
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
});

global.document = dom.window.document as any;
global.window = dom.window as any;

// Use defineProperty for navigator since it's read-only in newer Node.js
Object.defineProperty(global, 'navigator', {
  value: dom.window.navigator,
  writable: true,
  configurable: true,
});

global.HTMLElement = dom.window.HTMLElement as any;
global.Element = dom.window.Element as any;
global.Node = dom.window.Node as any;
global.MutationObserver = dom.window.MutationObserver as any;
// Title extraction decodes character references through the platform's HTML parser.
global.DOMParser = dom.window.DOMParser as any;

// jsdom has no `CSS`; a minimal stand-in covering the two characters that break a quoted attribute selector
if (typeof globalThis.CSS === 'undefined') {
  globalThis.CSS = {
    escape: (value: string) => String(value).replace(/["\\]/g, '\\$&'),
  } as any;
}

// Obsidian's runtime patches HTMLElement.prototype with DOM helpers like addClass;
// jsdom doesn't have this, so tests that call it on real elements (e.g., Notice.containerEl) need it polyfilled.
global.HTMLElement.prototype.addClass = function (...classNames: string[]) {
  this.classList.add(...classNames);
};

global.HTMLElement.prototype.removeClass = function (...classNames: string[]) {
  this.classList.remove(...classNames);
};

global.HTMLElement.prototype.toggleClass = function (
  classes: string | string[],
  value: boolean
) {
  for (const className of Array.isArray(classes) ? classes : [classes]) {
    this.classList.toggle(className, value);
  }
};

// Obsidian's `trigger` dispatches a plain event of the given type; the exclusion entry dialog fires `input` through it
global.HTMLElement.prototype.trigger = function (eventType: string) {
  this.dispatchEvent(new dom.window.Event(eventType));
};

// Obsidian also patches Node.prototype with element factories and exposes createFragment globally;
// jsdom has neither, so a settings builder whose `desc` is a fragment cannot be called at all without them.
// Only the DomElementInfo fields src/settings/ actually passes are honored: cls, text, attr, href, type.
function applyElementInfo(
  el: HTMLElement,
  info?: DomElementInfo | string
): void {
  if (info === undefined) return;
  const options: DomElementInfo =
    typeof info === 'string' ? { cls: info } : info;
  if (options.cls) {
    el.className = Array.isArray(options.cls)
      ? options.cls.join(' ')
      : options.cls;
  }
  if (typeof options.text === 'string') {
    el.textContent = options.text;
  } else if (options.text) {
    el.appendChild(options.text);
  }
  if (options.attr) {
    for (const [name, value] of Object.entries(options.attr)) {
      el.setAttribute(name, String(value));
    }
  }
  if (options.href !== undefined) el.setAttribute('href', options.href);
  if (options.type !== undefined) el.setAttribute('type', options.type);
}

// Dialogs clear their content with Obsidian's `empty` before building it
global.Node.prototype.empty = function () {
  while (this.firstChild) this.removeChild(this.firstChild);
};

global.Node.prototype.appendText = function (text: string) {
  this.appendChild(document.createTextNode(text));
};

global.Node.prototype.createEl = function <
  K extends keyof HTMLElementTagNameMap,
>(tag: K, info?: DomElementInfo | string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyElementInfo(el, info);
  this.appendChild(el);
  return el;
};

global.Node.prototype.createDiv = function (info?: DomElementInfo | string) {
  return this.createEl('div', info);
};

global.Node.prototype.createSpan = function (info?: DomElementInfo | string) {
  return this.createEl('span', info);
};

// Obsidian gives every node its owning document and window, which popout-safe code schedules timers and reads focus through
Object.defineProperty(global.Node.prototype, 'doc', {
  get(this: Node) {
    return this.ownerDocument ?? document;
  },
  configurable: true,
});
Object.defineProperty(global.Node.prototype, 'win', {
  get(this: Node) {
    return (this.ownerDocument ?? document).defaultView ?? window;
  },
  configurable: true,
});

globalThis.createFragment = (
  callback?: (frag: DocumentFragment) => void
): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  callback?.(fragment);
  return fragment;
};

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
