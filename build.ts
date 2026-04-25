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
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { homedir, hostname } from "node:os";

const ROOT = import.meta.dirname;
const EXTENSIONS_DIR = join(ROOT, "extensions");
const SKILLS_DIR = join(ROOT, "skills");
const SHARED_LIB_DIR = join(ROOT, "shared", "lib");
const PROFILES_DIR = join(ROOT, "profiles");
const BUILD_DIR = join(ROOT, "build");
const CONFIG_DIR = join(ROOT, "config");

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

/** Parse JSONC (JSON with comments and trailing commas) */
function parseJsonc(text: string): unknown {
  const stripped = text
    // Remove single-line comments (but not // in URLs like https://)
    .replace(/(?<!:)\/\/.*$/gm, "")
    // Remove multi-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Remove trailing commas before } or ]
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

/** Read and parse a JSON or JSONC file */
async function readJson(path: string): Promise<unknown> {
  const text = await Bun.file(path).text();
  return path.endsWith(".jsonc") ? parseJsonc(text) : JSON.parse(text);
}

/**
 * Find a file that may have a .json or .jsonc extension.
 * Returns the path if found, or null. Prefers .jsonc over .json if both exist.
 */
function findJsonFile(pathWithoutExt: string): string | null;
function findJsonFile(pathWithExt: string, withExt: true): string | null;
function findJsonFile(path: string, withExt?: boolean): string | null {
  if (withExt) {
    // Path already has extension — check as-is, then try swapping
    if (existsSync(path)) return path;
    const alt = path.endsWith(".jsonc")
      ? path.replace(/\.jsonc$/, ".json")
      : path.replace(/\.json$/, ".jsonc");
    return existsSync(alt) ? alt : null;
  }
  // Path without extension — try .jsonc first, then .json
  const jsonc = `${path}.jsonc`;
  if (existsSync(jsonc)) return jsonc;
  const json = `${path}.json`;
  if (existsSync(json)) return json;
  return null;
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

/** Clean up extensions and skills from destination that are not in the build output.
 *  This removes stale extensions/skills when they're removed from the profile. */
function cleanupStaleArtifacts(
  buildDir: string,
  destDir: string,
  profileName: string,
): void {
  if (!existsSync(destDir)) return;

  // Files to preserve in extensions directory (installed dependencies, not source)
  const PRESERVE_IN_EXTENSIONS = new Set([
    "package-lock.json",
    "node_modules",
    "package.json",
    "tsconfig.json",
  ]);

  // Clean up stale extensions
  const buildExtDir = join(buildDir, "extensions");
  const destExtDir = join(destDir, "extensions");
  if (existsSync(buildExtDir) && existsSync(destExtDir)) {
    const builtExts = new Set(readdirSync(buildExtDir));
    const deployedExts = readdirSync(destExtDir);
    for (const ext of deployedExts) {
      if (!builtExts.has(ext) && !PRESERVE_IN_EXTENSIONS.has(ext)) {
        const extPath = join(destExtDir, ext);
        rmSync(extPath, { recursive: true, force: true });
        console.log(`  removed stale extension: ${ext}`);
      }
    }
  }

  // Clean up stale skills
  const buildSkillDir = join(buildDir, "skills");
  const destSkillDir = join(destDir, "skills");
  if (existsSync(buildSkillDir) && existsSync(destSkillDir)) {
    const builtSkills = new Set(readdirSync(buildSkillDir));
    const deployedSkills = readdirSync(destSkillDir);
    for (const skill of deployedSkills) {
      if (!builtSkills.has(skill)) {
        const skillPath = join(destSkillDir, skill);
        rmSync(skillPath, { recursive: true, force: true });
        console.log(`  removed stale skill: ${skill}`);
      }
    }
  }
}

/** Get the destination directory for a profile from its manifest */
async function getProfileDestDir(profileName: string) {
  const manifestPath = findJsonFile(join(PROFILES_DIR, profileName, "package"));
  if (!manifestPath) {
    fatal(`Profile manifest not found: ${profileName}`);
  }

  const parsed = (await readJson(manifestPath)) as ProfileManifest;
  const destDir = parsed.pi?.destDir;

  if (!destDir) {
    fatal(`Profile manifest missing pi.destDir: ${profileName}`);
  }

  // Expand ~ to home directory
  return destDir.replace(/^~/, homedir());
}

/** Build a merged JSON config from base + environment + profile overlays */
async function buildMergedConfig(
  prefix: string,
  profileDir: string,
): Promise<string> {
  const basePath = findJsonFile(join(CONFIG_DIR, `${prefix}.base`));
  if (!basePath) {
    fatal(`Config not found: ${join(CONFIG_DIR, `${prefix}.base.json`)}`);
  }

  // Merge: base → environment → environment.local → profile → profile.local
  // *.local.json(c) files are gitignored and used for machine-specific overrides
  const base = (await readJson(basePath)) as Record<string, unknown>;

  const layerPaths = [
    findJsonFile(join(CONFIG_DIR, environment, prefix)),
    findJsonFile(join(CONFIG_DIR, environment, `${prefix}.local`)),
    findJsonFile(join(profileDir, "config", prefix)),
    findJsonFile(join(profileDir, "config", `${prefix}.local`)),
  ];

  for (const layerPath of layerPaths) {
    if (layerPath) {
      const overlay = (await readJson(layerPath)) as Record<string, unknown>;
      deepMerge(base, overlay);
    }
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

  const manifestPath = findJsonFile(join(profileDir, "package"));
  if (!manifestPath) {
    fatal(`No package.json(c) in profile: ${profileDir}`);
  }

  const manifest = (await readJson(manifestPath)) as ProfileManifest;

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
    if (
      item === "package.json" ||
      item === "package.jsonc" ||
      item === "node_modules"
    )
      continue;

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
    const basePath = findJsonFile(
      join(CONFIG_DIR, `${configName}.base.json`),
      true,
    );
    if (!existsSync(basePath)) {
      continue; // Skip if base file doesn't exist (e.g., mcp.json is optional)
    }

    const configJson = await buildMergedConfig(configName, profileDir);
    await Bun.write(join(outputDir, `${configName}.json`), configJson);
    console.log(`  generated ${configName}.json`);
  }

  // 7. Copy fnox.toml for encrypted secrets (if it exists)
  const fnoxPath = join(ROOT, "fnox.toml");
  if (existsSync(fnoxPath)) {
    cpSync(fnoxPath, join(outputDir, "fnox.toml"));
    console.log(`  copied fnox.toml (encrypted secrets)`);
  }

  // 8. Clean up stale extensions and skills from destination
  const destDir = await getProfileDestDir(profileName);
  cleanupStaleArtifacts(outputDir, destDir, profileName);

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
  if (!filePath.match(/\.(md|jsonc?|yaml|yml|ts|js|txt|sh|env)$/)) return;
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
