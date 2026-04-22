#!/usr/bin/env bun
/**
 * Read destDir from a profile's package.json or package.jsonc.
 * Usage: bun scripts/dest.ts <profile>
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const profile = process.argv[2];
if (!profile) {
  console.error("Usage: bun scripts/dest.ts <profile>");
  process.exit(1);
}

const root = join(import.meta.dirname, "..");
const jsonc = join(root, "profiles", profile, "package.jsonc");
const json = join(root, "profiles", profile, "package.json");
const manifest = existsSync(jsonc) ? jsonc : existsSync(json) ? json : null;

if (!manifest) {
  console.error(`error: no package.json(c) in profiles/${profile}/`);
  process.exit(1);
}

const text = await Bun.file(manifest).text();
const stripped = text
  .replace(/\/\/.*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/,(\s*[}\]])/g, "$1");

const destDir = JSON.parse(stripped).pi.destDir.replace("~", process.env.HOME!);
console.log(destDir);
