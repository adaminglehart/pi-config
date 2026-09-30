/**
 * Picks a real project file in cwd for actions that have no `file`
 * (workspace-symbols). Opening it makes the server load the project.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { LSP_SERVERS, WARMUP_MAP } from "./lsp-servers.js";

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
]);
const MAX_SCANNED_DIRECTORIES = 2000;

/** Breadth-first search, so that the file nearest to cwd is used. */
function findFileWithExtension(cwd: string, extensions: string[]): string | undefined {
  const queue = [cwd];
  for (let scanned = 0; queue.length && scanned < MAX_SCANNED_DIRECTORIES; scanned++) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const file = entries.find(
      (e) => e.isFile() && extensions.includes(path.extname(e.name)),
    );
    if (file) return path.join(dir, file.name);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      queue.push(path.join(dir, entry.name));
    }
  }
  return undefined;
}

/**
 * The server comes from the first project marker in cwd (WARMUP_MAP). Files
 * with the marker extension (for example `.ts`) have priority over other
 * extensions of the same server (for example `.js`).
 */
export function findProjectFile(cwd: string): string | undefined {
  for (const [marker, extension] of Object.entries(WARMUP_MAP)) {
    if (!fs.existsSync(path.join(cwd, marker))) continue;
    const server = LSP_SERVERS.find((s) => s.extensions.includes(extension));
    const file = (
      findFileWithExtension(cwd, [extension]) ??
      (server ? findFileWithExtension(cwd, server.extensions) : undefined)
    );
    if (file) return file;
  }
  return undefined;
}
