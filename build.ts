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
import { basename, join, sep } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { resolveBuildEnvironment } from "./scripts/env.ts";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  readManifest,
} from "./scripts/manifest.ts";

const ROOT = import.meta.dirname;
const AGENT_DIR = join(ROOT, "agent");
const EXTENSIONS_DIR = join(ROOT, "extensions");
const SKILLS_DIR = join(ROOT, "skills");
const SHARED_LIB_DIR = join(ROOT, "shared", "lib");
const BUILD_ROOT = join(ROOT, "build");
const BUILD_DIR = join(BUILD_ROOT, "agent");
const CONFIG_DIR = join(ROOT, "config");

const environment = resolveBuildEnvironment();

type ModelSettings = JsonObject & {
  defaultProvider?: string;
  defaultModel?: string;
  modelAliases?: Record<string, string>;
};

function fatal(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Read and parse a JSON or JSONC file. */
async function readJson(path: string): Promise<JsonValue> {
  const text = await Bun.file(path).text();
  if (!path.endsWith(".jsonc")) return JSON.parse(text);

  const errors: ParseError[] = [];
  const value: JsonValue = parse(text, errors, { allowTrailingComma: true });
  const firstError = errors[0];
  if (firstError) {
    fatal(
      `Invalid JSONC in ${path} at offset ${firstError.offset}: ${printParseErrorCode(firstError.error)}`,
    );
  }
  return value;
}

async function readJsonObject(path: string): Promise<JsonObject> {
  const value = await readJson(path);
  if (!isJsonObject(value)) {
    fatal(`Config must contain a JSON object: ${path}`);
  }
  return value;
}

/**
 * Find a file that may have a .json or .jsonc extension.
 * Returns the path if found, or null. Prefers .jsonc over .json.
 */
function findJsonFile(pathWithoutExt: string): string | null {
  const jsonc = `${pathWithoutExt}.jsonc`;
  if (existsSync(jsonc)) return jsonc;
  const json = `${pathWithoutExt}.json`;
  return existsSync(json) ? json : null;
}

function copyDir(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    filter: (path: string) => !path.split(sep).includes("node_modules"),
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
function deepMerge(target: JsonObject, source: JsonObject): JsonObject {
  for (const key of Object.keys(source)) {
    const targetValue = target[key];
    const sourceValue = source[key];
    if (isJsonObject(targetValue) && isJsonObject(sourceValue)) {
      deepMerge(targetValue, sourceValue);
    } else {
      target[key] = sourceValue;
    }
  }
  return target;
}

/** Build a merged JSON config from base, environment, and environment-local layers. */
async function buildMergedConfig(
  prefix: string,
  basePath: string,
): Promise<JsonObject> {
  const base = await readJsonObject(basePath);
  const layerPaths = [
    findJsonFile(join(CONFIG_DIR, environment, prefix)),
    findJsonFile(join(CONFIG_DIR, environment, `${prefix}.local`)),
  ];

  for (const layerPath of layerPaths) {
    if (layerPath) {
      deepMerge(base, await readJsonObject(layerPath));
    }
  }

  return resolveEnvVarsInJsonObject(base);
}

function parseModelSettings(value: JsonObject): ModelSettings {
  const defaultProvider = value.defaultProvider;
  const defaultModel = value.defaultModel;
  const modelAliases = value.modelAliases;

  if (defaultProvider !== undefined && typeof defaultProvider !== "string") {
    fatal("Merged settings defaultProvider must be a string");
  }
  if (defaultModel !== undefined && typeof defaultModel !== "string") {
    fatal("Merged settings defaultModel must be a string");
  }
  if (modelAliases !== undefined && !isJsonObject(modelAliases)) {
    fatal("Merged settings modelAliases must be an object");
  }

  const validatedAliases: Record<string, string> = {};
  if (modelAliases) {
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
      validatedAliases[name] = reference;
    }
  }

  return {
    ...value,
    ...(defaultProvider === undefined ? {} : { defaultProvider }),
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(modelAliases === undefined ? {} : { modelAliases: validatedAliases }),
  };
}

/** Read named model aliases from merged settings as build variables. */
function readModelAliasVars(settings: ModelSettings): Record<string, string> {
  const modelVars: Record<string, string> = {};
  for (const [name, reference] of Object.entries(settings.modelAliases ?? {})) {
    modelVars[`model.${name}`] = reference;
  }
  return modelVars;
}

function defaultModelUsesAlias(settings: ModelSettings): boolean {
  return /^\{\{model\.\w+\}\}$/.test(settings.defaultModel ?? "");
}

/** Resolve Pi's configured default model into a provider/model reference. */
function resolveDefaultModelReference(settings: ModelSettings): string {
  const { defaultProvider, defaultModel } = settings;

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
  settings: ModelSettings,
  defaultFromAlias: boolean,
): ModelSettings {
  if (defaultFromAlias) delete settings.defaultProvider;

  const reference = resolveDefaultModelReference(settings);
  const separator = reference.indexOf("/");
  settings.defaultProvider = reference.slice(0, separator);
  settings.defaultModel = reference.slice(separator + 1);

  return settings;
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

function resolveEnvVarsInJson(value: JsonValue): JsonValue {
  if (typeof value === "string") return resolveEnvVars(value);
  if (Array.isArray(value)) return value.map(resolveEnvVarsInJson);
  if (isJsonObject(value)) return resolveEnvVarsInJsonObject(value);
  return value;
}

function resolveEnvVarsInJsonObject(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      resolveEnvVarsInJson(entry),
    ]),
  );
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

function substituteVarsInJson(
  value: JsonValue,
  vars: Record<string, string>,
): JsonValue {
  if (typeof value === "string") return substituteVars(value, vars);
  if (Array.isArray(value)) {
    return value.map((entry) => substituteVarsInJson(entry, vars));
  }
  if (isJsonObject(value)) return substituteVarsInJsonObject(value, vars);
  return value;
}

function substituteVarsInJsonObject(
  value: JsonObject,
  vars: Record<string, string>,
): JsonObject {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      substituteVarsInJson(entry, vars),
    ]),
  );
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
  if (!existsSync(AGENT_DIR)) {
    fatal(`Primary agent source directory not found: ${AGENT_DIR}`);
  }

  const manifest = await readManifest();
  const { extensions, skills, uiShSkills } = manifest.pi;
  const selectedSkills = [...skills, ...uiShSkills];
  if (new Set(selectedSkills).size !== selectedSkills.length) {
    fatal("A skill is selected by both pi.skills and pi.uiShSkills");
  }

  const settingsBasePath = findJsonFile(join(CONFIG_DIR, "settings.base"));
  if (!settingsBasePath) {
    fatal(`Config not found: ${join(CONFIG_DIR, "settings.base.json")}`);
  }
  const mergedSettings = parseModelSettings(
    await buildMergedConfig("settings", settingsBasePath),
  );
  const buildVars = readModelAliasVars(mergedSettings);
  const settings = normalizeDefaultModelSettings(
    parseModelSettings(substituteVarsInJsonObject(mergedSettings, buildVars)),
    defaultModelUsesAlias(mergedSettings),
  );
  buildVars["model.default"] = resolveDefaultModelReference(settings);

  console.log(`  environment: ${environment}\n`);

  if (existsSync(BUILD_ROOT)) {
    rmSync(BUILD_ROOT, { recursive: true });
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
    // Extension source can contain literal {{...}} syntax, so leave unknown
    // build placeholders unchanged instead of failing the build.
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
  // Skills are copied without build substitution so their literal {{...}}
  // examples and templates remain unchanged.
  for (const skillName of selectedSkills) {
    const source = join(SKILLS_DIR, skillName);
    if (!existsSync(source)) fatal(`Skill not found: ${source}`);
    const destination = join(skillOutputDir, skillName);
    copyDir(source, destination);
    console.log(`  skill ${skillName}/`);
  }

  // Agent prompt files only use declared build placeholders, so unknown ones
  // are configuration errors and remain strict.
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

  await Bun.write(
    join(BUILD_DIR, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
  console.log("  generated settings.json");

  for (const configName of ["models", "mcp"]) {
    const basePath = findJsonFile(join(CONFIG_DIR, `${configName}.base`));
    if (!basePath) continue;

    const config = await buildMergedConfig(configName, basePath);
    await Bun.write(
      join(BUILD_DIR, `${configName}.json`),
      `${JSON.stringify(config, null, 2)}\n`,
    );
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

  console.log(`\n✓ Built primary agent → ${BUILD_DIR}`);
}

console.log("Building primary Pi agent\n");
await buildPrimaryAgent();
