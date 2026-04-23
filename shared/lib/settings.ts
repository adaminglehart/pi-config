/**
 * Shared utilities for reading Pi agent settings.
 *
 * Extensions can use this to read configuration from the Pi settings.json file,
 * with support for namespaced config (e.g., settings.honcho.baseUrl).
 *
 * Usage:
 *   import { readPiSettings, getNamespacedConfig } from "../_lib/settings.js";
 *
 *   // Read entire settings object
 *   const settings = readPiSettings();
 *
 *   // Read namespaced config with defaults
 *   const config = getNamespacedConfig("honcho", {
 *     baseUrl: "http://localhost:8100",
 *     enabled: true,
 *   });
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_SETTINGS_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "settings.json",
);

/**
 * Read the Pi settings file from the default location.
 * Returns an empty object if the file doesn't exist or can't be parsed.
 */
export function readPiSettings(
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): Record<string, unknown> {
  try {
    if (!fs.existsSync(settingsPath)) {
      return {};
    }
    const content = fs.readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Get namespaced configuration from Pi settings with default values.
 *
 * @param namespace - The top-level key in settings.json (e.g., "honcho", "compaction")
 * @param defaults - Default values to merge with any settings found
 * @returns Merged configuration object
 *
 * Example settings.json:
 *   {
 *     "honcho": {
 *       "baseUrl": "http://localhost:8100",
 *       "enabled": true
 *     }
 *   }
 *
 * Usage:
 *   const config = getNamespacedConfig("honcho", {
 *     baseUrl: "http://localhost:8100",
 *     workspace: "pi",
 *     enabled: true,
 *   });
 */
export function getNamespacedConfig<T extends Record<string, unknown>>(
  namespace: string,
  defaults: T,
  settingsPath?: string,
): T {
  const settings = readPiSettings(settingsPath);
  const namespaced = settings[namespace] as Record<string, unknown> | undefined;

  if (!namespaced || typeof namespaced !== "object") {
    return { ...defaults };
  }

  // Merge defaults with settings, preserving types where possible
  const result = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (key in namespaced) {
      const value = namespaced[key];
      const defaultValue = defaults[key];

      // Type-coerce based on default value type
      if (typeof defaultValue === "boolean" && typeof value === "boolean") {
        (result as Record<string, unknown>)[key] = value;
      } else if (
        typeof defaultValue === "number" &&
        (typeof value === "number" || typeof value === "string")
      ) {
        const num = typeof value === "string" ? parseFloat(value) : value;
        if (!isNaN(num)) {
          (result as Record<string, unknown>)[key] = num;
        }
      } else if (typeof value === typeof defaultValue) {
        (result as Record<string, unknown>)[key] = value;
      }
    }
  }

  return result;
}

/**
 * Write namespaced configuration to Pi settings.
 * Creates the file and any parent directories if they don't exist.
 *
 * @param namespace - The top-level key to write (e.g., "honcho")
 * @param config - The configuration object to write
 * @returns true if successful, false otherwise
 */
export function setNamespacedConfig(
  namespace: string,
  config: Record<string, unknown>,
  settingsPath: string = DEFAULT_SETTINGS_PATH,
): boolean {
  try {
    const settings = readPiSettings(settingsPath);
    settings[namespace] = config;

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}
