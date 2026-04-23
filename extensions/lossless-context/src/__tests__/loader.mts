/**
 * Custom Node.js ESM loader that rewrites .js imports to .ts files.
 * Used with: node --experimental-transform-types --loader ./src/__tests__/loader.mts --test ...
 */
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface ResolveContext {
  parentURL?: string;
  conditions?: string[];
}

interface ResolveResult {
  url: string;
  shortCircuit?: boolean;
}

type NextResolve = (
  specifier: string,
  context: ResolveContext,
) => Promise<ResolveResult>;

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult> {
  // Only rewrite relative .js imports
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    const parentPath = context.parentURL
      ? fileURLToPath(context.parentURL)
      : process.cwd();
    const dir =
      parentPath.endsWith("/") || parentPath.endsWith("\\")
        ? parentPath
        : resolvePath(parentPath, "..");

    const tsPath = resolvePath(dir, specifier.replace(/\.js$/, ".ts"));
    if (existsSync(tsPath)) {
      return nextResolve(pathToFileURL(tsPath).href, context);
    }
  }

  return nextResolve(specifier, context);
}
