#!/usr/bin/env bun

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readManifest, resolveDestDir } from "./manifest.ts";
import { parsePinnedNpmPackages } from "./stage-package-deps.ts";

const ROOT = join(import.meta.dirname, "..");
const EXTENSIONS_DIR = join(ROOT, "extensions");
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const MINIMUM_NODE_VERSION = "22.19.0";

function run(command: string[]): { exitCode: number; output: string } {
  const result = Bun.spawnSync({
    cmd: command,
    cwd: ROOT,
    env: { ...Bun.env, CI: "true" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
  return { exitCode: result.exitCode, output };
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : null;
}

function compareVersions(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function satisfiesCaret(version: string, specifier: string): boolean {
  if (!specifier.startsWith("^")) return version === specifier;
  const actual = parseVersion(version);
  const minimum = parseVersion(specifier.slice(1));
  if (!actual || !minimum || compareVersions(actual, minimum) < 0) return false;

  const [major, minor, patch] = minimum;
  const upper: [number, number, number] = major > 0
    ? [major + 1, 0, 0]
    : minor > 0
      ? [0, minor + 1, 0]
      : [0, 0, patch + 1];
  return compareVersions(actual, upper) < 0;
}

async function main(): Promise<void> {
  const errors: string[] = [];
  const extensionsPackage = JSON.parse(
    await Bun.file(join(EXTENSIONS_DIR, "package.json")).text(),
  ) as { devDependencies?: Record<string, string> };
  const expectedPiVersion = extensionsPackage.devDependencies?.[PI_PACKAGE];
  if (!expectedPiVersion) {
    errors.push(`extensions/package.json does not declare ${PI_PACKAGE}`);
  }

  const node = run(["node", "--version"]);
  const activeNode = parseVersion(node.output);
  const minimumNode = parseVersion(MINIMUM_NODE_VERSION)!;
  if (
    node.exitCode !== 0 ||
    !activeNode ||
    compareVersions(activeNode, minimumNode) < 0
  ) {
    errors.push(
      `active Node is ${node.output || "unavailable"}; Pi requires >=${MINIMUM_NODE_VERSION}`,
    );
  } else {
    console.log(`ok: active Node ${node.output}`);
  }

  const piPath = Bun.which("pi");
  if (!piPath) {
    errors.push("pi is not on PATH");
  } else {
    const resolvedPiPath = realpathSync(piPath);
    if (!resolvedPiPath.includes("/@earendil-works/pi-coding-agent/")) {
      errors.push(`pi resolves to an unexpected installation: ${resolvedPiPath}`);
    }

    const pi = run([piPath, "--version"]);
    if (
      pi.exitCode !== 0 ||
      !expectedPiVersion ||
      !satisfiesCaret(pi.output, expectedPiVersion)
    ) {
      errors.push(
        `pi version ${pi.output || "unavailable"} does not satisfy ${expectedPiVersion ?? "the declared version"}`,
      );
    } else {
      console.log(`ok: Pi ${pi.output} at ${piPath}`);
    }
  }

  const lock = run([
    "pnpm",
    "--dir",
    EXTENSIONS_DIR,
    "install",
    "--lockfile-only",
    "--frozen-lockfile",
    "--offline",
    "--ignore-scripts",
  ]);
  if (lock.exitCode !== 0) {
    errors.push(
      "extensions/pnpm-lock.yaml is missing or stale; run `pnpm --dir extensions install`",
    );
  } else {
    console.log("ok: extension development lockfile matches package.json");
  }

  const destination = resolveDestDir(await readManifest());
  const settingsPath = join(destination, "settings.json");
  if (!existsSync(settingsPath)) {
    errors.push(`deployed settings not found: ${settingsPath}`);
  } else {
    const settings = JSON.parse(await Bun.file(settingsPath).text()) as {
      packages?: unknown;
    };
    for (const pkg of parsePinnedNpmPackages(settings)) {
      const packagePath = join(
        destination,
        "npm",
        "node_modules",
        pkg.name,
        "package.json",
      );
      if (!existsSync(packagePath)) {
        errors.push(`managed package is missing: ${pkg.spec}`);
        continue;
      }
      const installed = JSON.parse(await Bun.file(packagePath).text()) as {
        version?: string;
      };
      if (installed.version !== pkg.version) {
        errors.push(
          `managed package ${pkg.name} is ${installed.version ?? "unknown"}; expected ${pkg.version}`,
        );
      }
    }
    if (!errors.some((error) => error.startsWith("managed package"))) {
      console.log("ok: deployed managed packages match settings.json");
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`);
    process.exit(1);
  }
  console.log("Pi installation checks passed.");
}

await main();
