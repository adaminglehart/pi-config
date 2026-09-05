import { strict as assert } from "node:assert";
import { test } from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, getKeybindings, setKeybindings, KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { registeredTools } from "./test-support.js";

const ui = { requestRender() {} } as TUI;
const definitions = registeredTools();

test("Pi composes one compact settled row and expands restored results", () => {
  initTheme("dark", false);
  const host = new ToolExecutionComponent("read", "restored", { path: "file.ts" }, { showImages: false }, definitions.find(tool => tool.name === "read"), ui, "/work");
  host.updateResult({ content: [{ type: "text", text: "  const value = 1;\n".repeat(80) }], isError: false });
  const settled = host.render(100).map(stripTerminalSequences);
  // Pi adds one separator row even in self-shell mode. Do not patch the host.
  assert.equal(settled[0], "");
  assert.equal(settled.length, 2, JSON.stringify(settled));
  assert.match(settled[1]!, /Read file.ts/);
  host.setExpanded(true);
  assert.equal(host.render(100).map(stripTerminalSequences).join("\n").match(/const value/g)?.length, 80);
  host.setExpanded(false);
  assert.equal(host.render(100).length, 2);
});

test("Pi refreshes streaming, final error, width, and theme", () => {
  initTheme("dark", false);
  const host = new ToolExecutionComponent("bash", "live", { command: "pnpm test" }, {}, definitions.find(tool => tool.name === "bash"), ui, "/work");
  host.markExecutionStarted();
  assert.match(host.render(100).map(stripTerminalSequences).join("\n"), /Running/);
  host.updateResult({ content: [{ type: "text", text: "first\nsecond" }], isError: false }, true);
  assert.equal(host.render(100).map(stripTerminalSequences).join("\n").match(/first/g)?.length, 1);
  host.updateResult({ content: [{ type: "text", text: "  A long diagnostic with indentation and source position\n\nCommand exited with code 2" }], isError: true });
  assert.match(host.render(100).map(stripTerminalSequences).join("\n"), /Failed/);
  assert.doesNotMatch(host.render(100).map(stripTerminalSequences).join("\n"), /Running/);
  assert.ok(host.render(30).length > host.render(100).length);
  const dark = host.render(100);
  initTheme("light", false);
  host.invalidate();
  assert.notDeepEqual(host.render(100), dark);
});


test("expansion hints use the configured key, including an unbound key", () => {
  const previous = getKeybindings();
  try {
    initTheme("dark", false);
    setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }, { "app.tools.expand": "ctrl+e" }));
    const host = new ToolExecutionComponent("read", "keys", { path: "file.ts" }, {}, definitions.find(tool => tool.name === "read"), ui, "/work");
    host.updateResult({ content: [{ type: "text", text: "contents" }], isError: false });
    assert.match(host.render(100).map(stripTerminalSequences).join("\n"), /ctrl\+e to expand/);
    setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: [] } }));
    host.invalidate();
    assert.doesNotMatch(host.render(100).map(stripTerminalSequences).join("\n"), /to expand/);
  } finally { setKeybindings(previous); }
});
