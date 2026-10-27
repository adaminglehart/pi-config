import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanDestination, reconcileDestination } from "./managed-destination.ts";

let fixture: string;
let buildDir: string;
let destDir: string;
const herdrPath = "extensions/herdr-agent-state.ts";

function put(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "pi-managed-destination-"));
  buildDir = join(fixture, "build");
  destDir = join(fixture, "destination");
  mkdirSync(buildDir);
  mkdirSync(destDir);
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe("Herdr extension ownership", () => {
  test("reconciliation keeps Herdr and removes stale managed extensions", () => {
    put(buildDir, "extensions/current.ts", "current");
    put(destDir, "extensions/current.ts", "current");
    put(destDir, "extensions/stale.ts", "stale");
    put(destDir, "extensions/package.json", "{}");
    put(destDir, herdrPath, "Herdr-owned content");

    reconcileDestination(buildDir, destDir);

    expect(readFileSync(join(destDir, herdrPath), "utf8")).toBe("Herdr-owned content");
    expect(existsSync(join(destDir, "extensions/current.ts"))).toBe(true);
    expect(existsSync(join(destDir, "extensions/package.json"))).toBe(true);
    expect(existsSync(join(destDir, "extensions/stale.ts"))).toBe(false);
  });

  test("deployment copy commands do not replace or delete the Herdr extension", () => {
    put(buildDir, herdrPath, "An old repository copy");
    put(buildDir, "extensions/current.ts", "current");
    put(destDir, herdrPath, "Herdr-owned content");
    put(destDir, "extensions/stale.ts", "stale");
    put(destDir, "extensions/current/node_modules/dependency.js", "dependency");
    const justfile = readFileSync(join(import.meta.dirname, "../Justfile"), "utf8");
    const commands = justfile.split("\n").map((line) => line.trim()).filter((line) =>
      line.startsWith("rsync ") && (line.includes('"$BUILD/"') || line.includes('"$BUILD/extensions/"'))
    );
    expect(commands).toHaveLength(2);

    for (const command of commands) {
      const result = Bun.spawnSync(["bash", "-c", command], {
        cwd: fixture,
        env: { ...process.env, BUILD: buildDir, DEST: destDir },
        timeout: 10_000,
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(destDir, herdrPath), "utf8")).toBe("Herdr-owned content");
    }
    expect(readFileSync(join(destDir, "extensions/current.ts"), "utf8")).toBe("current");
    expect(existsSync(join(destDir, "extensions/stale.ts"))).toBe(false);
    expect(existsSync(join(destDir, "extensions/current/node_modules/dependency.js"))).toBe(true);
  });

  test("clean keeps only externally managed extensions and runtime data", () => {
    put(destDir, herdrPath, "Herdr-owned content");
    put(destDir, "extensions/managed/index.ts", "managed");
    put(destDir, "extensions/package.json", "{}");
    put(destDir, "settings.json", "{}");
    put(destDir, "sessions/session.jsonl", "runtime data");

    cleanDestination(destDir);

    expect(readFileSync(join(destDir, herdrPath), "utf8")).toBe("Herdr-owned content");
    expect(existsSync(join(destDir, "extensions/managed"))).toBe(false);
    expect(existsSync(join(destDir, "extensions/package.json"))).toBe(false);
    expect(existsSync(join(destDir, "settings.json"))).toBe(false);
    expect(existsSync(join(destDir, "sessions/session.jsonl"))).toBe(true);
  });

  test("clean removes the extension directory when no external extension exists", () => {
    put(destDir, "extensions/managed.ts", "managed");

    cleanDestination(destDir);
    cleanDestination(destDir);

    expect(existsSync(join(destDir, "extensions"))).toBe(false);
  });
});
