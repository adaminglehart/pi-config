/**
 * Session key generation utilities.
 * Generates stable session keys from session file paths for conversation mapping.
 */

import * as os from "node:os";

/**
 * Generate a stable session key from a session file path.
 * Uses the session file as the key for per-session isolation.
 *
 * Examples:
 *   /Users/adam/.pi/agent/sessions/abc123.jsonl → .pi--agent--sessions--abc123.jsonl
 */
export function sessionKeyFromFile(sessionFile: string): string {
  const home = os.homedir();
  // Strip home directory prefix if present
  const relative = sessionFile.startsWith(home)
    ? sessionFile.slice(home.length + 1)
    : sessionFile;
  // Replace slashes with double dashes, remove leading slash
  return relative.replace(/^\//, "").replace(/\//g, "--");
}
