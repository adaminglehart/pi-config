import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { mock, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const calls: Array<{ file: string; args: string[]; options: ExecFileSyncOptions }> = [];
let frontmostApp = "Safari";
let failAt = 0;
mock.module("node:child_process", {
  namedExports: {
    ...childProcess,
    execFileSync(file: string, args: string[], options: ExecFileSyncOptions) {
      calls.push({ file, args, options });
      if (calls.length === failAt) {
        // A real child failure must not write to the parent terminal.
        return execFileSync(process.execPath, ["-e", 'process.stderr.write("notification failure"); process.exit(1)'], options);
      }
      return frontmostApp;
    },
  },
});
mock.module("../_lib/env.js", { namedExports: { isSubagent: () => false } });
const { default: notifyExtension } = await import("../notify.ts");

function setup() {
  calls.length = 0;
  frontmostApp = "Safari";
  failAt = 0;
  let request: Parameters<ExtensionAPI["events"]["on"]>[1] = () => {
    throw new Error("Notification listener was not registered");
  };
  const pi: Pick<ExtensionAPI, "events" | "on"> = {
    events: {
      on(_name: string, handler: typeof request) {
        request = handler;
        return () => {};
      },
      emit() {},
    },
    on() {},
  };
  notifyExtension(pi as ExtensionAPI);
  return (title: string, body: string) => request({ title, body });
}

test("notification text is passed as arguments, not executable source", () => {
  const send = setup();
  const title = `π's "title" \\`;
  const body = "Path: \\q; ' apostrophe; \"quote\"; $(echo unsafe); `echo unsafe`\nnext line \\";
  send(title, body);
  assert.equal(calls.length, 2);
  const { file, args, options } = calls[1]!;
  assert.equal(file, "osascript");
  assert.deepEqual(args.slice(2), ["--", title, body]);
  assert.match(args[1]!, /display notification \(item 2 of argv\) with title \(item 1 of argv\)/);
  assert.ok(!args[1]!.includes(body));
  assert.equal(options.stdio, "pipe");
  assert.equal(options.timeout, 1000);
});

test("focused terminals do not receive notifications", () => {
  const send = setup();
  frontmostApp = "Ghostty";
  send("π", "Done");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options.stdio, "pipe");
});

for (const failedCall of [1, 2]) {
  test(`failure in call ${failedCall} is silent and does not escape`, () => {
    const send = setup();
    failAt = failedCall;
    const stderr = mock.method(process.stderr, "write", () => true);
    try {
      assert.doesNotThrow(() => send("π", "Done"));
      assert.equal(calls.length, failedCall);
      assert.equal(stderr.mock.callCount(), 0);
    } finally {
      stderr.mock.restore();
    }
  });
}

test("macOS preserves special characters through the AppleScript argument handler", {
  skip: process.platform !== "darwin",
}, () => {
  const send = setup();
  send("π's title", "Path: \\q \"quote\" 'apostrophe' $(echo unsafe)\nend\\");
  const { args } = calls[1]!;
  // Exercise the real handler without sending a desktop notification.
  const script = args[1]!.replace(
    "display notification (item 2 of argv) with title (item 1 of argv)",
    'return (item 1 of argv) & linefeed & (item 2 of argv)',
  );
  const result = execFileSync("osascript", ["-e", script, ...args.slice(2)], {
    encoding: "utf8", stdio: "pipe", timeout: 1000,
  });
  assert.equal(result, `${args[3]}\n${args[4]}\n`);
});
