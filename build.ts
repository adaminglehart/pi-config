#!/usr/bin/env bun

/**
 * Build the primary Pi agent configuration.
 *
 * Reads the root pi.jsonc manifest, then stages selected extensions, skills,
 * shared library files, primary agent files, and merged configuration into
 * build/agent/ for deployment.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";

const ROOT = import.meta.dirname;
const AGENT_DIR = join(ROOT, "agent");
const EXTENSIONS_DIR = join(ROOT, "extensions");
const SKILLS_DIR = join(ROOT, "skills");
const SHARED_LIB_DIR = join(ROOT, "shared", "lib");
const BUILD_DIR = join(ROOT, "build", "agent");
const CONFIG_DIR = join(ROOT, "config");
const MANIFEST_PATH = join(ROOT, "pi.jsonc");

const HOME_HOSTNAME = "MacBook-Pro.local";
const environment =
  Bun.env.PI_BUILD_ENV ?? (hostname() === HOME_HOSTNAME ? "home" : "work");

interface PrimaryManifest {
  pi: {
    destDir: string;
    extensions: string[];
    skills: string[];
  };
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface ModelSettings {
  defaultProvider?: string;
  defaultModel?: string;
  modelAliases?: JsonValue;
}

function fatal(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Parse JSONC (JSON with comments and trailing commas). */
function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/(?<!:)\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

/** Read and parse a JSON or JSONC file. */
async function readJson(path: string): Promise<unknown> {
  const text = await Bun.file(path).text();
  return path.endsWith(".jsonc") ? parseJsonc(text) : JSON.parse(text);
}

/**
 * Find a file that may have a .json or .jsonc extension.
 * Returns the path if found, or null. Prefers .jsonc over .json.
 */
function findJsonFile(pathWithoutExt: string): string | null;
function findJsonFile(pathWithExt: string, withExt: true): string | null;
function findJsonFile(path: string, withExt?: boolean): string | null {
  if (withExt) {
    if (existsSync(path)) return path;
    const alternative = path.endsWith(".jsonc")
      ? path.replace(/\.jsonc$/, ".json")
      : path.replace(/\.json$/, ".jsonc");
    return existsSync(alternative) ? alternative : null;
  }

  const jsonc = `${path}.jsonc`;
  if (existsSync(jsonc)) return jsonc;
  const json = `${path}.json`;
  return existsSync(json) ? json : null;
}

function copyDir(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    filter: (path: string) => !path.includes("node_modules"),
  });
}

function resolveExtensionSource(name: string): { path: string; isFile: boolean } {
  const directoryPath = join(EXTENSIONS_DIR, name);
  if (existsSync(directoryPath) && statSync(directoryPath).isDirectory()) {
    return { path: directoryPath, isFile: false };
  }

  const filePath = join(EXTENSIONS_DIR, `${name}.ts`);
  if (existsSync(filePath)) {
    return { path: filePath, isFile: true };
  }

  fatal(`Extension not found: "${name}" (checked ${directoryPath}/ and ${filePath})`);
}

/** Deep merge source into target (mutates target). */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    const targetValue = target[key];
    const sourceValue = source[key];
    if (
      targetValue &&
      sourceValue &&
      typeof targetValue === "object" &&
      typeof sourceValue === "object" &&
      !Array.isArray(targetValue) &&
      !Array.isArray(sourceValue)
    ) {
      deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>,
      );
    } else {
      target[key] = sourceValue;
    }
  }
  return target;
}

/** Remove deployed agents, extensions, and skills no longer included in a build. */
function cleanupStaleArtifacts(buildDir: string, destDir: string): void {
  if (!existsSync(destDir)) return;

  const preserveInExtensions = new Set([
    "pnpm-lock.yaml",
    "node_modules",
    "package.json",
    "tsconfig.json",
  ]);

  const cleanupManagedDir = (
    subdir: string,
    label: string,
    preserve = new Set<string>(),
  ): void => {
    const builtDir = join(buildDir, subdir);
    const deployedDir = join(destDir, subdir);
    if (!existsSync(deployedDir)) return;

    const builtEntries = existsSync(builtDir)
      ? new Set(readdirSync(builtDir))
      : new Set<string>();

    for (const entry of readdirSync(deployedDir)) {
      if (!builtEntries.has(entry) && !preserve.has(entry)) {
        rmSync(join(deployedDir, entry), { recursive: true, force: true });
        console.log(`  removed stale ${label}: ${entry}`);
      }
    }
  };

  cleanupManagedDir("agents", "agent");
  cleanupManagedDir("extensions", "extension", preserveInExtensions);
  cleanupManagedDir("skills", "skill");
}

/** Read the primary deployment destination from the root manifest. */
async function getPrimaryDestDir(): Promise<string> {
  if (!existsSync(MANIFEST_PATH)) {
    fatal(`Primary manifest not found: ${MANIFEST_PATH}`);
  }

  const manifest = (await readJson(MANIFEST_PATH)) as PrimaryManifest;
  const destDir = manifest.pi?.destDir;
  if (!destDir) {
    fatal(`Primary manifest missing pi.destDir: ${MANIFEST_PATH}`);
  }

  return destDir.replace(/^~/, homedir());
}

/** Build a merged JSON config from base, environment, and environment-local layers. */
async function buildMergedConfig(prefix: string): Promise<string> {
  const basePath = findJsonFile(join(CONFIG_DIR, `${prefix}.base`));
  if (!basePath) {
    fatal(`Config not found: ${join(CONFIG_DIR, `${prefix}.base.json`)}`);
  }

  const base = (await readJson(basePath)) as Record<string, unknown>;
  const layerPaths = [
    findJsonFile(join(CONFIG_DIR, environment, prefix)),
    findJsonFile(join(CONFIG_DIR, environment, `${prefix}.local`)),
  ];

  for (const layerPath of layerPaths) {
    if (layerPath) {
      deepMerge(base, (await readJson(layerPath)) as Record<string, unknown>);
    }
  }

  return `${resolveEnvVars(JSON.stringify(base, null, 2))}\n`;
}

/** Read named model aliases from merged settings as build variables. */
function readModelAliasVars(settingsJson: string): Record<string, string> {
  const { modelAliases } = JSON.parse(settingsJson) as ModelSettings;
  if (modelAliases === undefined) return {};
  if (
    modelAliases === null ||
    typeof modelAliases !== "object" ||
    Array.isArray(modelAliases)
  ) {
    fatal("Merged settings modelAliases must be an object");
  }

  const modelVars: Record<string, string> = {};
  for (const [name, reference] of Object.entries(modelAliases)) {
    if (!/^\w+$/.test(name) || typeof reference !== "string" || !reference) {
      fatal(
        "Merged settings modelAliases must use word-only names and non-empty values",
      );
    }
    if (name === "default") {
      fatal(
        'Merged settings modelAliases must not define "default"; use defaultModel instead',
      );
    }

    const separator = reference.indexOf("/");
    if (separator <= 0 || separator >= reference.length - 1) {
      fatal(
        `Merged settings modelAliases.${name} must use a provider/model reference`,
      );
    }
    modelVars[`model.${name}`] = reference;
  }

  return modelVars;
}

function defaultModelUsesAlias(settingsJson: string): boolean {
  const { defaultModel } = JSON.parse(settingsJson) as ModelSettings;
  return /^\{\{model\.\w+\}\}$/.test(defaultModel ?? "");
}

/** Resolve Pi's configured default model into a provider/model reference. */
function resolveDefaultModelReference(settingsJson: string): string {
  const { defaultProvider, defaultModel } = JSON.parse(
    settingsJson,
  ) as ModelSettings;

  if (!defaultModel) {
    fatal("Merged settings must define defaultModel");
  }
  if (defaultProvider) {
    return `${defaultProvider}/${defaultModel}`;
  }

  const separator = defaultModel.indexOf("/");
  if (separator > 0 && separator < defaultModel.length - 1) {
    return defaultModel;
  }

  fatal(
    "Merged settings defaultModel must include its provider when defaultProvider is not defined",
  );
}

/** Normalize generated settings to separate defaultProvider/defaultModel fields. */
function normalizeDefaultModelSettings(
  settingsJson: string,
  defaultFromAlias: boolean,
): string {
  const settings = JSON.parse(settingsJson) as ModelSettings;
  if (defaultFromAlias) delete settings.defaultProvider;

  const reference = resolveDefaultModelReference(JSON.stringify(settings));
  const separator = reference.indexOf("/");
  settings.defaultProvider = reference.slice(0, separator);
  settings.defaultModel = reference.slice(separator + 1);

  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Replace ${VAR_NAME} placeholders with values from the build environment. */
function resolveEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (_match, variableName: string) => {
    const value = Bun.env[variableName];
    if (value === undefined) {
      fatal(
        `Environment variable "\${${variableName}}" is not set. Add it to your .env file.`,
      );
    }
    return value;
  });
}

/** Replace {{var.name}} placeholders using build variables for the current environment. */
function substituteVars(
  text: string,
  vars: Record<string, string>,
  strict = true,
): string {
  return text.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, key: string) => {
    if (!(key in vars)) {
      if (strict) {
        fatal(
          `Unknown variable "{{${key}}}" — not defined in build vars for ${environment}`,
        );
      }
      return match;
    }
    return vars[key];
  });
}

/** Apply variable substitution to all text files in a directory. */
async function applyVarsToDir(
  dir: string,
  vars: Record<string, string>,
  strict = true,
): Promise<void> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await applyVarsToDir(fullPath, vars, strict);
    } else {
      await applyVarsToFile(fullPath, vars, strict);
    }
  }
}

/** Apply variable substitution to a single text file. */
async function applyVarsToFile(
  filePath: string,
  vars: Record<string, string>,
  strict = true,
): Promise<void> {
  if (!filePath.match(/\.(md|jsonc?|yaml|yml|ts|js|txt|sh|env)$/)) return;
  if (Object.keys(vars).length === 0) return;

  const text = await Bun.file(filePath).text();
  if (!text.includes("{{")) return;

  await Bun.write(filePath, substituteVars(text, vars, strict));
}

async function buildPrimaryAgent(): Promise<void> {
  if (!existsSync(MANIFEST_PATH)) {
    fatal(`Primary manifest not found: ${MANIFEST_PATH}`);
  }
  if (!existsSync(AGENT_DIR)) {
    fatal(`Primary agent source directory not found: ${AGENT_DIR}`);
  }

  const manifest = (await readJson(MANIFEST_PATH)) as PrimaryManifest;
  if (!manifest.pi) {
    fatal(`Primary manifest missing "pi" field: ${MANIFEST_PATH}`);
  }

  const { extensions, skills } = manifest.pi;
  const mergedSettingsJson = await buildMergedConfig("settings");
  const buildVars = readModelAliasVars(mergedSettingsJson);
  const settingsJson = normalizeDefaultModelSettings(
    substituteVars(mergedSettingsJson, buildVars),
    defaultModelUsesAlias(mergedSettingsJson),
  );
  buildVars["model.default"] = resolveDefaultModelReference(settingsJson);
  const destDir = await getPrimaryDestDir();

  console.log(`  environment: ${environment}\n`);

  if (existsSync(BUILD_DIR)) {
    rmSync(BUILD_DIR, { recursive: true });
  }
  mkdirSync(BUILD_DIR, { recursive: true });

  const libOutputDir = join(BUILD_DIR, "extensions", "_lib");
  if (existsSync(SHARED_LIB_DIR) && readdirSync(SHARED_LIB_DIR).length > 0) {
    console.log("  _lib/ → extensions/_lib/");
    copyDir(SHARED_LIB_DIR, libOutputDir);
  }

  const extensionOutputDir = join(BUILD_DIR, "extensions");
  mkdirSync(extensionOutputDir, { recursive: true });
  for (const extensionName of extensions) {
    const source = resolveExtensionSource(extensionName);
    const destination = join(extensionOutputDir, basename(source.path));
    if (source.isFile) {
      cpSync(source.path, destination);
      await applyVarsToFile(destination, buildVars, false);
      console.log(`  ext ${extensionName} (file)`);
    } else {
      copyDir(source.path, destination);
      await applyVarsToDir(destination, buildVars, false);
      console.log(`  ext ${extensionName}/`);
    }
  }

  for (const devFile of ["package.json", "tsconfig.json"]) {
    const source = join(EXTENSIONS_DIR, devFile);
    if (existsSync(source)) cpSync(source, join(extensionOutputDir, devFile));
  }

  const skillOutputDir = join(BUILD_DIR, "skills");
  mkdirSync(skillOutputDir, { recursive: true });
  for (const skillName of skills) {
    const source = join(SKILLS_DIR, skillName);
    if (!existsSync(source)) fatal(`Skill not found: ${source}`);
    const destination = join(skillOutputDir, skillName);
    copyDir(source, destination);
    console.log(`  skill ${skillName}/`);
  }

  for (const item of readdirSync(AGENT_DIR)) {
    if (item === "extensions" || item === "skills" || item === "node_modules") {
      continue;
    }

    const source = join(AGENT_DIR, item);
    const destination = join(BUILD_DIR, item);
    if (statSync(source).isDirectory()) {
      copyDir(source, destination);
      await applyVarsToDir(destination, buildVars);
      console.log(`  agent ${item}/`);
    } else {
      cpSync(source, destination);
      await applyVarsToFile(destination, buildVars);
      console.log(`  agent ${item}`);
    }
  }

  for (const configName of ["settings", "models", "mcp"]) {
    const basePath = findJsonFile(
      join(CONFIG_DIR, `${configName}.base.json`),
      true,
    );
    if (!basePath) continue;

    const configJson =
      configName === "settings"
        ? settingsJson
        : await buildMergedConfig(configName);
    await Bun.write(join(BUILD_DIR, `${configName}.json`), configJson);
    console.log(`  generated ${configName}.json`);
  }

  const environmentFnoxPath = join(CONFIG_DIR, environment, "fnox.toml");
  const baseFnoxPath = join(ROOT, "fnox.toml");
  const fnoxPath = existsSync(environmentFnoxPath)
    ? environmentFnoxPath
    : baseFnoxPath;
  if (existsSync(fnoxPath)) {
    cpSync(fnoxPath, join(BUILD_DIR, "fnox.toml"));
    console.log(
      `  copied ${fnoxPath === environmentFnoxPath ? `${environment}/` : ""}fnox.toml (encrypted secrets)`,
    );
  }

  cleanupStaleArtifacts(BUILD_DIR, destDir);
  console.log(`\n✓ Built primary agent → ${BUILD_DIR}`);
}

console.log("Building primary Pi agent\n");
await buildPrimaryAgent();
