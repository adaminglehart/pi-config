#!/usr/bin/env bun
/** Read destDir from the root pi.jsonc manifest. */
import { readManifest, resolveDestDir } from "./manifest.ts";

try {
  console.log(resolveDestDir(await readManifest()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exit(1);
}
