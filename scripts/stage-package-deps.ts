#!/usr/bin/env bun

import { mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

interface Settings {
  packages?: unknown;
}

export interface PinnedPackage {
  name: string;
  version: string;
  spec: string;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parsePinnedNpmPackages(settings: Settings): PinnedPackage[] {
  if (settings.packages === undefined) return [];
  if (!Array.isArray(settings.packages)) {
    throw new Error("settings.packages must be an array");
  }

  const packages: PinnedPackage[] = [];
  for (const entry of settings.packages) {
    if (typeof entry !== "string" || !entry.startsWith("npm:")) continue;

    const spec = entry.slice("npm:".length);
    const separator = spec.lastIndexOf("@");
    if (separator <= 0) {
      throw new Error(`npm package must have an exact version: ${entry}`);
    }

    const name = spec.slice(0, separator);
    const version = spec.slice(separator + 1);
    if (!name || !EXACT_VERSION.test(version)) {
      throw new Error(`npm package must have an exact version: ${entry}`);
    }
    packages.push({ name, version, spec });
  }

  return packages;
}

async function main(): Promise<void> {
  const [, , settingsPathArg, outputDirArg] = Bun.argv;
  if (!settingsPathArg || !outputDirArg) {
    console.error(
      "usage: bun scripts/stage-package-deps.ts SETTINGS_JSON OUTPUT_DIR",
    );
    process.exit(1);
  }

  const root = resolve(import.meta.dirname, "..");
  const buildRoot = join(root, "build");
  const settingsPath = resolve(settingsPathArg);
  const outputDir = resolve(outputDirArg);
  if (!outputDir.startsWith(`${buildRoot}${sep}`)) {
    throw new Error(`package staging directory must be under ${buildRoot}`);
  }

  const settings = JSON.parse(await Bun.file(settingsPath).text()) as Settings;
  const packages = parsePinnedNpmPackages(settings);

  rmSync(outputDir, { recursive: true, force: true });
  if (packages.length === 0) return;
  mkdirSync(outputDir, { recursive: true });

  const dependencies = Object.fromEntries(
    packages.map(({ name, version }) => [name, version]),
  );
  await Bun.write(
    join(outputDir, "package.json"),
    `${JSON.stringify({ name: "pi-managed-packages", private: true, dependencies }, null, 2)}\n`,
  );
  await Bun.write(
    join(outputDir, "pnpm-workspace.yaml"),
    [
      "nodeLinker: hoisted",
      "dangerouslyAllowAllBuilds: true",
      "minimumReleaseAgeExclude:",
      ...packages.map(({ spec }) => `  - ${JSON.stringify(spec)}`),
      "",
    ].join("\n"),
  );

  console.log(`Installing managed Pi packages in ${outputDir}...`);
  const result = Bun.spawnSync({
    cmd: ["pnpm", "install", "--prod", "--no-frozen-lockfile", "--silent"],
    cwd: outputDir,
    env: { ...Bun.env, CI: "true" },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`managed Pi package install failed with code ${result.exitCode}`);
  }
}

if (import.meta.main) await main();
