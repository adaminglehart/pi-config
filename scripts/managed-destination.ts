#!/usr/bin/env bun

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

interface ManagedDestinationPath {
  path: string;
  entryLabel?: string;
  preserveEntries?: readonly string[];
}

/**
 * Every destination path managed by this repository, including legacy paths
 * that must be removed when they are no longer present in the current build.
 */
export const MANAGED_DESTINATION_PATHS: readonly ManagedDestinationPath[] = [
  { path: "agents", entryLabel: "agent" },
  { path: "AGENTS.md" },
  {
    path: "extensions",
    entryLabel: "extension",
    preserveEntries: [
      "pnpm-lock.yaml",
      "node_modules",
      "package.json",
      "tsconfig.json",
    ],
  },
  { path: "skills", entryLabel: "skill" },
  { path: "settings.json" },
  { path: "models.json" },
  { path: "mcp.json" },
  { path: "fnox.toml" },
  { path: "run_after_install_extension_deps.sh" },
  { path: "APPEND_SYSTEM.md" },
  { path: ".chezmoiignore" },
  { path: "build" },
  { path: "build.ts" },
  { path: "config" },
  { path: "docs" },
  { path: "Justfile" },
  { path: "README.md" },
];

function remove(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Remove stale managed output before deploying a new build. */
export function reconcileDestination(buildDir: string, destDir: string): void {
  if (!existsSync(buildDir)) {
    throw new Error(`Build directory not found: ${buildDir}`);
  }
  if (!existsSync(destDir)) return;

  for (const managed of MANAGED_DESTINATION_PATHS) {
    const builtPath = join(buildDir, managed.path);
    const deployedPath = join(destDir, managed.path);
    if (!existsSync(deployedPath)) continue;

    if (managed.entryLabel) {
      const builtEntries = existsSync(builtPath)
        ? new Set(readdirSync(builtPath))
        : new Set<string>();
      const preserveEntries = new Set(managed.preserveEntries ?? []);

      for (const entry of readdirSync(deployedPath)) {
        if (!builtEntries.has(entry) && !preserveEntries.has(entry)) {
          remove(join(deployedPath, entry));
          console.log(`  removed stale ${managed.entryLabel}: ${entry}`);
        }
      }
      continue;
    }

    if (!existsSync(builtPath)) {
      remove(deployedPath);
      console.log(`  removed stale managed path: ${managed.path}`);
    }
  }
}

/** Remove all repository-managed paths from a deployment destination. */
export function cleanDestination(destDir: string): void {
  for (const managed of MANAGED_DESTINATION_PATHS) {
    remove(join(destDir, managed.path));
  }
}

function usage(): never {
  console.error(
    "usage: bun scripts/managed-destination.ts <reconcile BUILD_DIR DEST_DIR | clean DEST_DIR>",
  );
  process.exit(1);
}

if (import.meta.main) {
  const [, , command, ...args] = Bun.argv;
  if (command === "reconcile" && args.length === 2) {
    reconcileDestination(args[0], args[1]);
  } else if (command === "clean" && args.length === 1) {
    cleanDestination(args[0]);
  } else {
    usage();
  }
}
