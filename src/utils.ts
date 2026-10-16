import { DebugLogger, PluginSettings } from './types';

export function verboseLog(
  plugin: { settings: PluginSettings },
  message: string,
  data?: unknown
) {
  if (plugin.settings.core.debug) {
    if (data) {
      console.debug(message, data);
    } else {
      console.debug(message);
    }
  }
}

/** A `DebugLogger` writing through `verboseLog`, for the helpers that take settings and a logger rather than the plugin. */
export function verboseLogger(plugin: {
  settings: PluginSettings;
}): DebugLogger {
  return (message, data) => verboseLog(plugin, message, data);
}
