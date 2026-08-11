import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

const ROOT = join(import.meta.dirname, "..");
export const MANIFEST_PATH = join(ROOT, "pi.jsonc");

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface PrimaryManifest {
  pi: {
    destDir: string;
    extensions: string[];
    skills: string[];
    uiShSkills: string[];
  };
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

export function validateNameList(
  value: JsonValue | undefined,
  label: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  const names: string[] = [];
  for (const name of value) {
    if (
      typeof name !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
    ) {
      throw new Error(`Invalid name in ${label}: ${String(name)}`);
    }
    names.push(name);
  }

  if (new Set(names).size !== names.length) {
    throw new Error(`Duplicate name in ${label}`);
  }

  return names;
}

export async function readManifest(): Promise<PrimaryManifest> {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Primary manifest not found: ${MANIFEST_PATH}`);
  }

  const errors: ParseError[] = [];
  const value: JsonValue = parse(
    await Bun.file(MANIFEST_PATH).text(),
    errors,
    { allowTrailingComma: true },
  );
  const firstError = errors[0];
  if (firstError) {
    throw new Error(
      `Invalid JSONC in ${MANIFEST_PATH} at offset ${firstError.offset}: ${printParseErrorCode(firstError.error)}`,
    );
  }
  if (!isJsonObject(value) || !isJsonObject(value.pi)) {
    throw new Error(`Primary manifest missing pi object: ${MANIFEST_PATH}`);
  }

  const destDir = value.pi.destDir;
  if (typeof destDir !== "string" || !destDir) {
    throw new Error(`Primary manifest missing pi.destDir: ${MANIFEST_PATH}`);
  }

  return {
    pi: {
      destDir,
      extensions: validateNameList(value.pi.extensions, "pi.extensions"),
      skills: validateNameList(value.pi.skills, "pi.skills"),
      uiShSkills: validateNameList(value.pi.uiShSkills, "pi.uiShSkills"),
    },
  };
}

export function resolveDestDir(manifest: PrimaryManifest): string {
  return manifest.pi.destDir.replace(/^~/, homedir());
}
