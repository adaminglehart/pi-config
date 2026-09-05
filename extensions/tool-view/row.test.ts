import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { fixture, fixtures } from "./fixtures.js";
import { renderRow, type RowInput } from "./row.js";
import { clean, preview } from "./text.js";
import { toolRenderers } from "./renderers.js";

const theme = { fg: (_color: string, text: string) => text } as Theme;
function rows(input: RowInput, width = 100) {
  return renderRow(input, width, theme).map(stripTerminalSequences);
}
function output(input: RowInput, width = 100) { return rows(input, width).join("\n"); }

test("routine reads show path, range, UTF-8 size, not content", () => {
  const rendered = output(fixture("read", "界", { args: { path: "src/文件.ts", offset: 2, limit: 3 } }));
  assert.match(rendered, /Read src\/文件.ts:2-4 · 3B returned/);
  assert.ok(!rendered.includes("界"));
  assert.equal(rendered.split("\n").length, 1);
});
test("read notices survive collapse, including the first-line byte limit", () => {
  for (const text of ["hidden\n\n[20 more lines in file. Use offset=40 to continue.]", "[Line 1 is 80KB, exceeds 50KB limit. Use bash: sed -n '1p' file | head -c 51200]"]) {
    assert.match(output(fixture("read", text)), /Use /);
  }
});
test("small searches keep complete matching records and count no context", () => {
  const input = fixture("grep", "file.ts-1- context\nfile.ts:2: hit\nfile.ts-3- context", { args: { pattern: "hit", path: "src" } });
  assert.match(output(input), /1 match observed/);
  assert.match(output(input), /file.ts:2: hit/);
  assert.match(output(input), /in src/);
});
test("no-results sentinels are not matches", () => {
  for (const [kind, text] of [["find", "No files found matching pattern"], ["grep", "No matches found"], ["ls", "(empty directory)"]] as const) {
    assert.match(output(fixture(kind, text)), /No results/);
    assert.ok(!output(fixture(kind, text)).includes("1 matches"));
  }
});
test("limited search counts are observed, not totals, with notices visible", () => {
  const input = fixture("find", "a.ts\nb.ts\n\n[2 results limit reached. Use limit=4 for more]", { result: { content: [{ type: "text", text: "a.ts\nb.ts\n\n[2 results limit reached. Use limit=4 for more]" }], details: { resultLimitReached: 2 } } });
  assert.match(output(input), /2 files observed/);
  assert.match(output(input), /Use limit=4/);
});
test("status comes from isError, not keywords", () => {
  assert.match(output(fixture("bash", "0 errors")), /^✓/);
  assert.match(output(fixture("bash", "all fine", { error: true })), /^✗/);
  assert.match(output(fixture("write", "Permission denied", { error: true })), /Permission denied/);
});
test("short and empty Bash success", () => {
  assert.match(output(fixture("bash", "one\ntwo")), /one\n  two/);
  assert.equal(rows(fixture("bash", "")).length, 1);
});
test("long Bash success retains start and end, failures get more space", () => {
  const input = fixture("bash", Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
  assert.match(output(input), /line 0\n/);
  assert.match(output(input), /line 99/);
  assert.match(output(input), /rows omitted/);
  assert.ok(rows({ ...input, error: true }).length > rows(input).length);
});
test("failure status and cancellation text remain visible without invented classification", () => {
  for (const status of ["Command exited with code 1", "Command aborted", "Command timed out after 1 seconds"]) {
    const input = fixture("bash", "line\n".repeat(50) + status, { error: true });
    assert.match(output(input), /Failed/);
    assert.ok(output(input).includes(status));
  }
});
test("live output uses the current snapshot, with no duplicate accumulation", () => {
  const input = fixture("bash", "one\ntwo", { partial: true });
  assert.match(output(input), /Running/);
  assert.equal(output(input).match(/one/g)?.length, 1);
  assert.equal(output(input), output(input));
  assert.match(output({ ...input, result: { content: [{ type: "text", text: "one\ntwo\nthree" }] } }), /three/);
});
test("write line counts do not count a trailing newline as another line", () => {
  assert.match(output(fixture("write", "done", { args: { path: "file", content: "one\ntwo\n" } })), /2 lines written/);
  assert.match(output(fixture("write", "done", { args: { path: "file", content: "" } })), /0 lines written/);
});
test("expansion retains all text blocks, more than 50 lines, and notices", () => {
  const input = fixture("read", "", { expanded: true, result: { content: [{ type: "text", text: "first\n".repeat(80) }, { type: "text", text: "last\n\n[20 more lines in file. Use offset=100 to continue.]" }] } });
  assert.equal(output(input).match(/first/g)?.length, 80);
  assert.match(output(input), /last/);
  assert.match(output(input), /offset=100/);
});
test("images and stored data are untouched", () => {
  const input = fixture("read", "", { result: { content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }, { type: "text", text: "\x1b[31mnote\x1b[0m" }] } });
  const saved = JSON.stringify(input);
  assert.match(output(input), /1 image/);
  assert.equal(JSON.stringify(input), saved);
});
test("all fixtures fit narrow and wide widths, including Unicode and unbroken lines", () => {
  const extra = fixture("bash", "  界👩‍💻é".repeat(100));
  for (const width of [8, 20, 40, 100, 160]) {
    for (const [, input] of [...fixtures, ["unicode", extra] as [string, RowInput]]) {
      for (const expanded of [true, false]) {
        for (const row of renderRow({ ...input, expanded }, width, theme)) assert.ok(visibleWidth(row) <= width, row);
      }
    }
  }
});
test("controls are sanitized but Unicode and indentation remain", () => {
  assert.equal(clean("\x1b]52;c;secret\x07\x1b[2J  界\tword\x00"), "  界    word");
});
test("preview budget includes omission row", () => {
  assert.equal(preview(Array(100).fill("row"), 6, 40, "ends").length, 6);
});
test("restored results need no live record; call and result do not duplicate headers", () => {
  const hooks = toolRenderers("read");
  const context = { args: { path: "file" }, state: {}, cwd: "/work", expanded: false, isPartial: false, isError: false, executionStarted: false };
  const call = hooks.renderCall(context.args, theme, context);
  const result = hooks.renderResult({ content: [{ type: "text", text: "hello" }] }, { expanded: false, isPartial: false }, theme, context);
  assert.equal(call.render(100).length, 0);
  assert.match(result.render(100).map(stripTerminalSequences).join("\n"), /Read file/);
});

test("Bash failure truncation paths remain visible outside the preview budget", () => {
  const notice = "[Showing lines 100-200 of 200. Full output: /tmp/full-output.log]";
  const input = fixture("bash", "line\n".repeat(90) + `\n${notice}\n\nCommand exited with code 1`, { error: true });
  assert.match(output(input), /Full output: \/tmp\/full-output.log/);
  assert.match(output(input), /Command exited with code 1/);
});
test("resize and new theme are applied without cached text", () => {
  const input = fixture("bash", "  a long line ".repeat(12));
  assert.notEqual(output(input, 40), output(input, 100));
  const colored = { fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[0m` };
  assert.ok(renderRow(input, 100, colored)[0]?.startsWith("\x1b[31m"));
});

test("context text that resembles a match is not counted", () => {
  const input = fixture("grep", "file.ts-1- context other.ts:99: text\nfile.ts:2: hit");
  assert.match(output(input), /1 match observed/);
});
test("image omission notices remain visible", () => {
  assert.match(output(fixture("read", "Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]")), /Image omitted/);
});
