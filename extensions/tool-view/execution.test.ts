import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { createBashTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registeredTools } from "./test-support.js";
import type { DisplayResult } from "./row.js";

const tools = registeredTools();
function tool(name: string) {
  const result = tools.find(tool => tool.name === name);
  assert.ok(result);
  return result;
}

// Real factories and a different cwd for each test. No network or fixture commands from user data.
test("all six execution results match the current Pi factories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tool-view-parity-"));
  const ctx = { cwd } as ExtensionContext;
  try {
    await writeFile(join(cwd, "fixture.txt"), "first\n  match 界\nlast\n");
    assert.deepEqual(await tool("read").execute("read", { path: "fixture.txt", offset: 2, limit: 1 }, undefined, undefined, ctx), await createReadTool(cwd).execute("read", { path: "fixture.txt", offset: 2, limit: 1 }));
    assert.deepEqual(await tool("bash").execute("bash", { command: "printf '0 errors\\n'" }, undefined, undefined, ctx), await createBashTool(cwd).execute("bash", { command: "printf '0 errors\\n'" }));
    assert.deepEqual(await tool("find").execute("find", { pattern: "*.txt", path: "." }, undefined, undefined, ctx), await createFindTool(cwd).execute("find", { pattern: "*.txt", path: "." }));
    assert.deepEqual(await tool("grep").execute("grep", { pattern: "match", path: "." }, undefined, undefined, ctx), await createGrepTool(cwd).execute("grep", { pattern: "match", path: "." }));
    assert.deepEqual(await tool("ls").execute("ls", { path: "." }, undefined, undefined, ctx), await createLsTool(cwd).execute("ls", { path: "." }));
    const args = { path: "written.txt", content: "new 界\n" };
    assert.deepEqual(await tool("write").execute("write", args, undefined, undefined, ctx), await createWriteTool(cwd).execute("write", args));
    assert.equal(await readFile(join(cwd, "written.txt"), "utf8"), args.content);
    assert.deepEqual(await tool("grep").execute("empty", { pattern: "absent", path: "." }, undefined, undefined, ctx), await createGrepTool(cwd).execute("empty", { pattern: "absent", path: "." }));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("read retains truncation details and image blocks from the factory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tool-view-read-"));
  const ctx = { cwd } as ExtensionContext;
  try {
    await writeFile(join(cwd, "large.txt"), "line\n".repeat(2200));
    const large = await tool("read").execute("read", { path: "large.txt" }, undefined, undefined, ctx);
    assert.deepEqual(large, await createReadTool(cwd).execute("read", { path: "large.txt" }));
    assert.ok(large.details);
    function chunk(name: string, data: Buffer): Buffer {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(data.length);
      const value = Buffer.concat([Buffer.from(name), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(value));
      return Buffer.concat([size, value, crc]);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0)),
    ]);
    await writeFile(join(cwd, "pixel.png"), png);
    const image = await tool("read").execute("image", { path: "pixel.png" }, undefined, undefined, ctx);
    assert.deepEqual(image, await createReadTool(cwd).execute("image", { path: "pixel.png" }));
    assert.ok(image.content.some(block => block.type === "image"), JSON.stringify(image));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Bash forwards real streaming updates and returns the same final output", async () => {
  const cwd = tmpdir();
  const updates: DisplayResult[] = [];
  const args = { command: "printf 'first\\n'; sleep 0.15; printf 'second\\n'", timeout: 5 };
  const result = await tool("bash").execute("stream", args, undefined, update => { updates.push(update); }, { cwd } as ExtensionContext);
  assert.deepEqual(result, await createBashTool(cwd).execute("stream", args));
  assert.ok(updates.some(update => update.content.some(block => block.type === "text" && block.text.includes("first"))));
  assert.equal(result.content.filter(block => block.type === "text").map(block => block.text).join(""), "first\nsecond\n");
});

test("errors, timeout, and cancellation stay errors", async () => {
  const cwd = tmpdir();
  const ctx = { cwd } as ExtensionContext;
  await assert.rejects(tool("bash").execute("failure", { command: "printf 'diagnostic\\n'; exit 7" }, undefined, undefined, ctx), /diagnostic[\s\S]*Command exited with code 7/);
  await assert.rejects(tool("bash").execute("timeout", { command: "sleep 3", timeout: 0.05 }, undefined, undefined, ctx), /Command timed out/);
  const controller = new AbortController();
  const running = tool("bash").execute("cancel", { command: "printf 'ready\\n'; sleep 3" }, controller.signal, update => {
    if (update.content.some(block => block.type === "text" && block.text.includes("ready"))) controller.abort();
  }, ctx);
  await assert.rejects(running, /Command aborted/);
  const aborted = AbortSignal.abort();
  await assert.rejects(tool("read").execute("cancel-read", { path: "unused" }, aborted, undefined, ctx), /aborted/i);
  await assert.rejects(tool("write").execute("cancel-write", { path: "unused", content: "unused" }, aborted, undefined, ctx), /aborted/i);
  await assert.rejects(tool("read").execute("missing", { path: "tool-view-file-that-does-not-exist" }, undefined, undefined, ctx));
});
