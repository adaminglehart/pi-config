#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");
const MANIFEST_PATH = join(ROOT, "config", "ui-sh-skills.json");
const API_URL = "https://ui.sh/api/skills";

interface SkillSummary {
  name: string;
  description: string;
}

interface SkillIndex {
  skills: SkillSummary[];
}

interface Skill {
  name: string;
  description: string;
  files: Record<string, string>;
}

interface UiShSkillsManifest {
  skills: string[];
}

function fatal(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function validateSkillName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    fatal(`Invalid ui.sh skill name: ${name}`);
  }
}

function resolveSkillFile(root: string, fileName: string): string {
  const path = resolve(root, fileName);
  const relativePath = relative(root, path);
  if (
    !fileName ||
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    relativePath.startsWith(sep)
  ) {
    fatal(`Invalid ui.sh skill file path: ${fileName}`);
  }
  return path;
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    fatal(`ui.sh request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

async function readPreviousManifest(): Promise<UiShSkillsManifest> {
  if (!existsSync(MANIFEST_PATH)) return { skills: [] };
  const manifest = (await Bun.file(MANIFEST_PATH).json()) as UiShSkillsManifest;
  if (!Array.isArray(manifest.skills)) {
    fatal(`Invalid ui.sh skills manifest: ${MANIFEST_PATH}`);
  }
  for (const name of manifest.skills) validateSkillName(name);
  if (new Set(manifest.skills).size !== manifest.skills.length) {
    fatal(`Duplicate skill in ui.sh skills manifest: ${MANIFEST_PATH}`);
  }
  return manifest;
}

const token = Bun.env.UIDOTSH_TOKEN;
if (!token) {
  fatal("UIDOTSH_TOKEN is not set; run this command through fnox");
}

const index = await fetchJson<SkillIndex>(API_URL, token);
if (!Array.isArray(index.skills) || index.skills.length === 0) {
  fatal("ui.sh returned no skills");
}

const names = index.skills.map(({ name }) => name).sort();
for (const name of names) validateSkillName(name);
if (new Set(names).size !== names.length) {
  fatal("ui.sh returned duplicate skill names");
}

const previousManifest = await readPreviousManifest();
const previousNames = new Set(previousManifest.skills);
mkdirSync(SKILLS_DIR, { recursive: true });
const stagingRoot = mkdtempSync(join(SKILLS_DIR, ".ui-sh-staging-"));

try {
  const skills = await Promise.all(
    names.map((name) =>
      fetchJson<Skill>(`${API_URL}/${encodeURIComponent(name)}`, token),
    ),
  );

  for (const [skillIndex, skill] of skills.entries()) {
    if (skill.name !== names[skillIndex]) {
      fatal(
        `ui.sh returned ${skill.name} when ${names[skillIndex]} was requested`,
      );
    }
    if (!skill.files || typeof skill.files !== "object") {
      fatal(`ui.sh skill has no files: ${skill.name}`);
    }

    const skillRoot = join(stagingRoot, skill.name);
    for (const [fileName, content] of Object.entries(skill.files)) {
      if (typeof content !== "string") {
        fatal(`ui.sh skill file is not text: ${skill.name}/${fileName}`);
      }
      const filePath = resolveSkillFile(skillRoot, fileName);
      mkdirSync(dirname(filePath), { recursive: true });
      await Bun.write(filePath, content);
    }

    const skillFile = join(skillRoot, "SKILL.md");
    if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
      fatal(`ui.sh skill has no SKILL.md file: ${skill.name}`);
    }
  }

  for (const name of names) {
    const destination = join(SKILLS_DIR, name);
    if (existsSync(destination) && !previousNames.has(name)) {
      fatal(`Refusing to replace non-ui.sh skill directory: ${destination}`);
    }
  }

  const backupRoot = mkdtempSync(join(SKILLS_DIR, ".ui-sh-backup-"));
  const backedUpNames: string[] = [];
  const installedNames: string[] = [];
  const manifestTempPath = `${MANIFEST_PATH}.tmp`;

  try {
    for (const name of previousManifest.skills) {
      const destination = join(SKILLS_DIR, name);
      if (!existsSync(destination)) continue;
      renameSync(destination, join(backupRoot, name));
      backedUpNames.push(name);
    }

    for (const name of names) {
      renameSync(join(stagingRoot, name), join(SKILLS_DIR, name));
      installedNames.push(name);
      console.log(`  updated ${name}/`);
    }

    const manifest: UiShSkillsManifest = { skills: names };
    await Bun.write(
      manifestTempPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    renameSync(manifestTempPath, MANIFEST_PATH);
  } catch (error) {
    rmSync(manifestTempPath, { force: true });
    for (const name of installedNames.reverse()) {
      rmSync(join(SKILLS_DIR, name), { recursive: true, force: true });
    }
    for (const name of backedUpNames.reverse()) {
      renameSync(join(backupRoot, name), join(SKILLS_DIR, name));
    }
    throw error;
  } finally {
    rmSync(backupRoot, { recursive: true, force: true });
  }

  console.log(`\n✓ Updated ${names.length} ui.sh skills`);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
