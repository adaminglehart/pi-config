/**
 * Shared utilities for reading Pi agent settings.
 *
 * Extensions can use this to read configuration from the Pi settings.json file,
 * with support for namespaced config (e.g., settings.honcho.baseUrl).
 *
 * Usage:
 *   import { getNamespacedConfig } from "../_lib/settings.js";
 *
 *   // Read namespaced config with defaults
 *   const config = getNamespacedConfig("honcho", {
 *     baseUrl: "http://localhost:8100",
 *     enabled: true,
 *   });
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Do not import runtime values from the Pi SDK here. extensions/_lib is a
// symlink to shared/lib in development, and Node cannot resolve the SDK
// package from shared/lib when tests run.
const GLOBAL_SETTINGS_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "settings.json",
);

/**
 * Read a Pi settings file.
 * Returns an empty object if the file doesn't exist or can't be parsed.
 */
function readPiSettings(settingsPath: string): Record<string, unknown> {
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
  settingsPath: string = GLOBAL_SETTINGS_PATH,
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
 * Merge keys into a namespace of the global Pi settings file.
 * Keeps other keys in the namespace. Creates the file and any parent
 * directories if they don't exist.
 *
 * @param namespace - The top-level key to update (e.g., "lsp")
 * @param config - The keys to write into the namespace
 * @returns true if successful, false otherwise
 */
export function setNamespacedConfig(
  namespace: string,
  config: Record<string, unknown>,
): boolean {
  try {
    const settings = readPiSettings(GLOBAL_SETTINGS_PATH);
    const existing = settings[namespace];
    settings[namespace] =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...existing, ...config }
        : config;

    fs.mkdirSync(path.dirname(GLOBAL_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(
      GLOBAL_SETTINGS_PATH,
      JSON.stringify(settings, null, 2),
      "utf-8",
    );
    return true;
  } catch {
    return false;
  }
}
