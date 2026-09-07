import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth, type TUI } from "@earendil-works/pi-tui";
// Overlay tests do not start an agent or load server dependencies.
const unused = () => { throw new Error("Agent API must not run in overlay tests"); };
mock.module("@earendil-works/pi-coding-agent", {
	namedExports: {
		buildSessionContext: unused,
		createAgentSession: unused,
		createExtensionRuntime: unused,
		getMarkdownTheme: unused,
		SessionManager: unused,
	},
});
const { BtwOverlay } = await import("../btw");

function fixture(count = 100) {
	let transcript = Array.from({ length: count }, (_, i) => `message-${i + 1}`);
	const terminal = { rows: 40 };
	const tui = { terminal, requestRender() {} } as TUI;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as ExtensionContext["ui"]["theme"];
	const keys = getKeybindings();
	let submitted = "";
	let dismissed = false;
	const overlay = new BtwOverlay(tui, theme, keys, () => transcript, () => "Ready", (value) => { submitted = value; }, () => { dismissed = true; });
	const visible = () => overlay.render(100).filter((line) => line.startsWith("│message-"));
	return { overlay, terminal, visible, append() { transcript.push(`message-${transcript.length + 1}`); }, clear() { transcript = []; }, submitted: () => submitted, dismissed: () => dismissed };
}

test("scroll pauses streaming and resumes at the latest line", () => {
	const f = fixture();
	assert.match(f.visible().at(-1)!, /message-100 /);
	f.overlay.handleInput("\x1b[5~");
	const paused = f.visible();
	assert.match(paused.at(-1)!, /message-79 /);
	f.append();
	assert.deepEqual(f.visible(), paused);
	f.overlay.handleInput("\x1b[1;5F");
	assert.match(f.visible().at(-1)!, /message-101 /);
	f.append();
	assert.match(f.visible().at(-1)!, /message-102 /);
});

test("first, latest, line and page controls stay within bounds", () => {
	const f = fixture();
	f.visible();
	f.overlay.handleInput("\x1b[1;5H");
	assert.match(f.visible()[0], /message-1 /);
	f.overlay.handleInput("\x1b[5~");
	assert.match(f.visible()[0], /message-1 /);
	f.overlay.handleInput("\x1b[1;2B");
	assert.match(f.visible()[0], /message-2 /);
	f.overlay.handleInput("\x1b[1;2A");
	assert.match(f.visible()[0], /message-1 /);
	for (let i = 0; i < 10; i++) f.overlay.handleInput("\x1b[6~");
	assert.match(f.visible().at(-1)!, /message-100 /);
});

test("resize and short transcripts keep the input and borders visible", () => {
	const f = fixture(2);
	for (const rows of [16, 24, 40, 80]) {
		f.terminal.rows = rows;
		for (const width of [40, 72, 100]) {
			const rendered = f.overlay.render(width);
			assert.ok(rendered.length <= Math.floor(rows * 0.78));
			assert.ok(rendered.every((line) => visibleWidth(line) <= width));
			assert.ok(rendered.at(-1)!.startsWith("└"));
		}
	}
	f.clear();
	assert.equal(f.visible().length, 0);
	f.overlay.handleInput("hello");
	f.overlay.handleInput("\r");
	assert.equal(f.submitted(), "hello");
	f.overlay.handleInput("\x1b");
	assert.equal(f.dismissed(), true);
});
