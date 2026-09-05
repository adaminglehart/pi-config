import type { RowInput } from "./row.js";

export function fixture(kind: RowInput["kind"], text: string, changes: Partial<RowInput> = {}): RowInput {
  return {
    kind, args: { path: "src/config.ts" }, result: { content: [{ type: "text", text }] },
    cwd: "/work/project", expanded: false, partial: false, error: false,
    started: true, hint: "ctrl+o to expand", ...changes,
  };
}

const log = Array.from({ length: 40 }, (_, i) => `PASS test ${i + 1}`);
export const fixtures: [string, RowInput][] = [
  ["Routine read", fixture("read", "const enabled = true;\n".repeat(56), { args: { path: "src/config.ts", offset: 40, limit: 56 } })],
  ["One search match", fixture("grep", "src/config.ts:42:  const enabled = true;", { args: { pattern: "enabled", path: "src" } })],
  ["Large search", fixture("find", Array.from({ length: 25 }, (_, i) => `src/features/feature-${i + 1}/index.ts`).join("\n"), { args: { pattern: "**/*.ts", path: "src" } })],
  ["Passing tests", fixture("bash", ["Starting test run", ...log, "40 passed, 0 failed"].join("\n"), { args: { command: "pnpm test" } })],
  ["Failure near the end", fixture("bash", ["Starting test run", ...log, "FAIL renderer.test.ts", "Expected 8 visible rows; received 14", "Tests: 1 failed, 40 passed", "", "Command exited with code 1"].join("\n"), { args: { command: "pnpm test" }, error: true })],
  ["Failure in the middle (known limit)", fixture("bash", ["Starting test run", ...log.slice(0, 20), "FAIL renderer.test.ts: expected 8 rows, received 14", ...log.slice(20), "Tests: 1 failed, 40 passed", "", "Command exited with code 1"].join("\n"), { args: { command: "pnpm test" }, error: true })],
  ["Live command", fixture("bash", log.join("\n"), { args: { command: "pnpm test" }, partial: true })],
  ["Empty success", fixture("bash", "", { args: { command: "git diff --check" } })],
  ["Long command", fixture("bash", "", { args: { command: `printf '%s\\n' ${"long-argument ".repeat(40)}` } })],
  ["No results", fixture("grep", "No matches found", { args: { pattern: "missing", path: "src" } })],
  ["Write", fixture("write", "Successfully wrote to src/config.ts", { args: { path: "src/config.ts", content: "one\ntwo\n" } })],
];
