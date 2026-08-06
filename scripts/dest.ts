#!/usr/bin/env bun
/** Read destDir from the root pi.jsonc manifest. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const manifestPath = join(root, "pi.jsonc");

if (!existsSync(manifestPath)) {
  console.error(`error: primary manifest not found: ${manifestPath}`);
  process.exit(1);
}

const text = await Bun.file(manifestPath).text();
const stripped = text
  .replace(/(?<!:)\/\/.*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/,(\s*[}\]])/g, "$1");
const destDir = JSON.parse(stripped).pi?.destDir;

if (typeof destDir !== "string" || !destDir) {
  console.error(`error: primary manifest missing pi.destDir: ${manifestPath}`);
  process.exit(1);
}

console.log(destDir.replace(/^~/, homedir()));
