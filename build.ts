#!/usr/bin/env bun

/**
 * Build script for pi-config profiles.
 *
 * Reads a profile's package.json manifest, then copies the right
 * extensions, skills, shared lib, and profile-level files into
 * a build output directory ready for deployment.
 *
 * Handles:
 * - Environment detection (work vs home based on hostname)
 * - JSON config merging (base + env overlay for settings/models)
 * - Variable substitution in profile files ({{var.name}} placeholders)
 *
 * Usage: bun run build.ts <profile>
 *   e.g. bun run build.ts coding
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { hostname } from "node:os";

const ROOT = import.meta.dirname;
const EXTENSIONS_DIR = join(ROOT, "extensions");
const SKILLS_DIR = join(ROOT, "skills");
const SHARED_LIB_DIR = join(ROOT, "shared", "lib");
const PROFILES_DIR = join(ROOT, "profiles");
const BUILD_DIR = join(ROOT, "build");
const CONFIG_DIR = join(ROOT, "config");

// Environment detection — same logic as the old chezmoi template
const HOME_HOSTNAME = "MacBook-Pro.local";
const environment =
  Bun.env.PI_BUILD_ENV ?? (hostname() === HOME_HOSTNAME ? "home" : "work");

interface ProfileManifest {
  pi: {
    destDir: string;
    extensions: string[];
    skills: string[];
    vars?: Record<string, Record<string, string>>;
  };
}

function fatal(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function copyDir(src: string, dest: string) {
  cpSync(src, dest, {
    recursive: true,
    filter: (source: string) => !source.includes("node_modules"),
  });
}

function resolveExtensionSource(name: string): {
  path: string;
  isFile: boolean;
} {
  const dirPath = join(EXTENSIONS_DIR, name);
  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
    return { path: dirPath, isFile: false };
  }

  const filePath = join(EXTENSIONS_DIR, `${name}.ts`);
  if (existsSync(filePath)) {
    return { path: filePath, isFile: true };
  }

  fatal(`Extension not found: "${name}" (checked ${dirPath}/ and ${filePath})`);
}

/** Deep merge source into target (mutates target) */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    const targetVal = target[key];
    const sourceVal = source[key];
    if (
      targetVal &&
      sourceVal &&
      typeof targetVal === "object" &&
      typeof sourceVal === "object" &&
      !Array.isArray(targetVal) &&
      !Array.isArray(sourceVal)
    ) {
      deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      target[key] = sourceVal;
    }
  }
  return target;
}

/** Build a merged JSON config from base + environment + profile overlays */
async function buildMergedConfig(
  prefix: string,
  profileDir: string,
): Promise<string> {
  const basePath = join(CONFIG_DIR, `${prefix}.base.json`);
  const envPath = join(CONFIG_DIR, environment, `${prefix}.json`);
  const envLocalPath = join(CONFIG_DIR, environment, `${prefix}.local.json`);
  const profilePath = join(profileDir, "config", `${prefix}.json`);
  const profileLocalPath = join(profileDir, "config", `${prefix}.local.json`);

  if (!existsSync(basePath)) {
    fatal(`Config not found: ${basePath}`);
  }

  // Merge: base → environment → environment.local → profile → profile.local
  // *.local.json files are gitignored and used for machine-specific overrides
  const base = await Bun.file(basePath).json();

  if (existsSync(envPath)) {
    const overlay = await Bun.file(envPath).json();
    deepMerge(base, overlay);
  }

  if (existsSync(envLocalPath)) {
    const localOverlay = await Bun.file(envLocalPath).json();
    deepMerge(base, localOverlay);
  }

  if (existsSync(profilePath)) {
    const profileOverlay = await Bun.file(profilePath).json();
    deepMerge(base, profileOverlay);
  }

  if (existsSync(profileLocalPath)) {
    const profileLocalOverlay = await Bun.file(profileLocalPath).json();
    deepMerge(base, profileLocalOverlay);
  }

  // Resolve ${ENV_VAR} references in string values from process.env
  const output = JSON.stringify(base, null, 2);
  return resolveEnvVars(output) + "\n";
}

/** Replace ${VAR_NAME} placeholders in text with values from process.env */
function resolveEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
    const value = Bun.env[varName];
    if (value === undefined) {
      fatal(
        `Environment variable "\${${varName}}" is not set. Add it to your .env file.`,
      );
    }
    return value;
  });
}

/** Replace {{var.name}} placeholders in text using profile vars for current environment */
function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    if (!(key in vars)) {
      fatal(
        `Unknown variable "{{${key}}}" — not defined in profile vars.${environment}`,
      );
    }
    return vars[key];
  });
}

async function buildProfile(profileName: string) {
  const profileDir = join(PROFILES_DIR, profileName);
  if (!existsSync(profileDir)) {
    fatal(`Profile not found: ${profileDir}`);
  }

  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) {
    fatal(`No package.json in profile: ${profileDir}`);
  }

  const manifest: ProfileManifest = await Bun.file(manifestPath).json();

  if (!manifest.pi) {
    fatal(`package.json missing "pi" field in ${manifestPath}`);
  }

  const { extensions, skills, vars } = manifest.pi;
  const envVars = vars?.[environment] ?? {};
  const outputDir = join(BUILD_DIR, profileName, "agent");

  console.log(`  environment: ${environment}`);
  console.log("");

  // Clean output
  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true });
  }
  mkdirSync(outputDir, { recursive: true });

  // 1. Copy shared lib → extensions/_lib/
  const libOutputDir = join(outputDir, "extensions", "_lib");
  if (existsSync(SHARED_LIB_DIR) && readdirSync(SHARED_LIB_DIR).length > 0) {
    console.log(`  _lib/ → extensions/_lib/`);
    copyDir(SHARED_LIB_DIR, libOutputDir);
  }

  // 2. Copy extensions
  const extOutputDir = join(outputDir, "extensions");
  mkdirSync(extOutputDir, { recursive: true });

  for (const extName of extensions) {
    const source = resolveExtensionSource(extName);
    if (source.isFile) {
      const dest = join(extOutputDir, basename(source.path));
      cpSync(source.path, dest);
      console.log(`  ext ${extName} (file)`);
    } else {
      const dest = join(extOutputDir, extName);
      copyDir(source.path, dest);
      console.log(`  ext ${extName}/`);
    }
  }

  // 3. Copy extensions root-level dev tooling (package.json, tsconfig.json)
  for (const devFile of ["package.json", "tsconfig.json"]) {
    const src = join(EXTENSIONS_DIR, devFile);
    if (existsSync(src)) {
      cpSync(src, join(extOutputDir, devFile));
    }
  }

  // 4. Copy skills
  const skillOutputDir = join(outputDir, "skills");
  mkdirSync(skillOutputDir, { recursive: true });

  for (const skillName of skills) {
    const src = join(SKILLS_DIR, skillName);
    if (!existsSync(src)) {
      fatal(`Skill not found: ${src}`);
    }
    const dest = join(skillOutputDir, skillName);
    copyDir(src, dest);
    console.log(`  skill ${skillName}/`);
  }

  // 5. Copy profile-level files with variable substitution
  const profileFiles = readdirSync(profileDir);
  for (const item of profileFiles) {
    if (item === "package.json" || item === "node_modules") continue;

    const src = join(profileDir, item);
    const dest = join(outputDir, item);

    if (statSync(src).isDirectory()) {
      copyDir(src, dest);
      await applyVarsToDir(dest, envVars);
      console.log(`  profile ${item}/`);
    } else {
      cpSync(src, dest);
      await applyVarsToFile(dest, envVars);
      console.log(`  profile ${item}`);
    }
  }

  // 6. Generate merged config files (settings.json, models.json, mcp.json, etc.)
  const configFiles = ["settings", "models", "mcp"];
  for (const configName of configFiles) {
    const basePath = join(CONFIG_DIR, `${configName}.base.json`);
    if (!existsSync(basePath)) {
      continue; // Skip if base file doesn't exist (e.g., mcp.json is optional)
    }

    const configJson = await buildMergedConfig(configName, profileDir);
    await Bun.write(join(outputDir, `${configName}.json`), configJson);
    console.log(`  generated ${configName}.json`);
  }

  console.log(`\n✓ Built profile "${profileName}" → ${outputDir}`);
}

/** Apply variable substitution to all files in a directory (recursive) */
async function applyVarsToDir(dir: string, vars: Record<string, string>) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await applyVarsToDir(fullPath, vars);
    } else {
      await applyVarsToFile(fullPath, vars);
    }
  }
}

/** Apply variable substitution to a single file (only if it contains placeholders) */
async function applyVarsToFile(filePath: string, vars: Record<string, string>) {
  // Only process text files
  if (!filePath.match(/\.(md|json|yaml|yml|ts|js|txt|sh|env)$/)) return;
  if (Object.keys(vars).length === 0) return;

  const text = await Bun.file(filePath).text();
  if (!text.includes("{{")) return;

  const result = substituteVars(text, vars);
  await Bun.write(filePath, result);
}

// --- Main ---

const profileName = process.argv[2];
if (!profileName) {
  fatal("Usage: bun run build.ts <profile>");
}

console.log(`Building profile: ${profileName}\n`);
await buildProfile(profileName);
