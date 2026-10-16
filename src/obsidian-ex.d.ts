/**
 * Extended type definitions for Obsidian API
 * These extend the official API with unofficial/undocumented properties
 */

import { CachedMetadata, Command, TFile, EventRef, Menu, View } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type { EmbeddedEditor } from './utils/embedded-editors';

declare module 'obsidian' {
  interface SettingDefinitionBase {
    /**
     * Row key for re-render reconciliation, read before `control.key` and `name` (`SettingDefinitionItem#id`, added in 1.14.0 per its changelog; the published typings do not declare it yet)
     */
    id?: string;
  }

  interface MetadataCache {
    /**
     * Get all tags in the vault (undocumented)
     */
    getTags(): Record<string, number>;
    /**
     * Parse UTF-8 text with Obsidian's metadata worker, no note needed; the buffer is transferred, so it is detached afterwards, and a worker error resolves undefined (undocumented)
     */
    computeMetadataAsync(
      data: ArrayBuffer
    ): Promise<CachedMetadata | undefined>;
  }

  interface App {
    commands: {
      commands: Record<string, Command>;
    };
    plugins: {
      enabledPlugins: Set<string>;
      getPlugin(id: string): unknown;
      /**
       * Registry of loaded plugin instances, keyed by plugin ID (undocumented)
       */
      plugins: Record<string, unknown>;
      /**
       * Fires (debounced) whenever a plugin is enabled or disabled (undocumented)
       */
      on(name: 'changed', callback: () => unknown): EventRef;
    };
    /** Settings pane controller (undocumented API) */
    setting?: {
      /** Close the settings pane */
      close?(): void;
    };
  }

  interface WorkspaceLeaf {
    /**
     * Internal leaf ID (undocumented)
     */
    id?: string;
  }

  interface Editor {
    /**
     * CodeMirror view behind the editor (undocumented)
     */
    cm?: EditorView;
  }

  interface TextFileView {
    /**
     * True while the view holds changes it has not saved yet (undocumented)
     */
    dirty: boolean;
  }

  interface MarkdownFileInfo {
    /**
     * Heading or block a page preview or Canvas card embed shows, empty for the whole note (undocumented)
     */
    subpath?: string;
  }

  interface Event {
    /**
     * Obsidian context menu cache (undocumented)
     */
    obsidian_contextmenu?: Menu;
  }

  /**
   * Helper type for accessing undocumented properties on leaf views
   * At runtime, leaf.view may be a FileView or MarkdownView with these properties
   */
  type ViewWithFileEditor = View & {
    file?: TFile | null;
    editor?: Editor | null;
    hoverPopover?: { targetEl?: HTMLElement; embed?: EmbeddedEditor } | null;
    /** Absent on a canvas leaf that is still deferred */
    canvas?: {
      nodes?: Map<
        string,
        { file?: TFile | null; child?: EmbeddedEditor | null }
      >;
    };
  };
}

// Global Window interface extensions
declare global {
  interface Window {
    FLIT?: {
      debug: {
        enable: () => Promise<void>;
        disable: () => Promise<void>;
      };
    };
    DEBUG?: {
      enable: (namespace?: string) => Promise<void>;
      disable: (namespace?: string) => Promise<void>;
    };
  }
}
