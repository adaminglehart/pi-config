import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import unifiedEditExtension from "../unified-edit.ts";

initTheme("dark", false);
let tool: ToolDefinition;
unifiedEditExtension({ registerTool(definition) { tool = definition as ToolDefinition; } } as ExtensionAPI);

function createRow(cwd: string, text = "") {
	let redraws = 0;
	const ui = { requestRender() { redraws++; } } as TUI;
	const row = new ToolExecutionComponent("edit", "test-edit", { text }, {}, tool, ui, cwd);
	return { row, redraws: () => redraws };
}

function plain(row: ToolExecutionComponent, width = 80): string {
	return row.render(width).map(stripVTControlCharacters).join("\n");
}

async function temporaryFile(run: (cwd: string) => Promise<void>) {
	const cwd = await mkdtemp(join(tmpdir(), "unified-edit-render-"));
	try {
		await writeFile(join(cwd, "sample.txt"), "before\n");
		await run(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

test("streamed input keeps one stable header without background redraws", async () => {
	await temporaryFile(async (cwd) => {
		const { row, redraws } = createRow(cwd);
		const initial = row.render(80);
		const script = "[sample.txt]\n@REPLACE\n-before\n+after\n";
		for (let i = 1; i <= script.length; i++) {
			row.updateArgs({ text: script.slice(0, i) });
			assert.deepEqual(row.render(80), initial);
		}
		// Drain file I/O from the old asynchronous preview implementation.
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(redraws(), 0);
		assert.deepEqual(row.render(80), initial);
		row.setArgsComplete();
		row.markExecutionStarted();
		assert.match(plain(row), /sample\.txt/);
		assert.equal(row.render(80).length, initial.length);
	});
});

test("a pause in valid partial input cannot expand or collapse the diff", async () => {
	await temporaryFile(async (cwd) => {
		const { row } = createRow(cwd);
		const height = row.render(80).length;
		const script = "[sample.txt]\n@REPLACE\n-before\n+after";
		row.updateArgs({ text: script });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(row.render(80).length, height);
		row.updateArgs({ text: `${script} more` });
		assert.equal(row.render(80).length, height);
	});
});

for (const [mode, script] of [
	["rows", "[sample.txt]\n@REPLACE\n-before\n+after"],
	["patch", "*** Begin Patch\n*** Update File: sample.txt\n@@\n-before\n+after\n*** End Patch"],
] as const) {
	test(`${mode}: final diff appears once and remains stable after execution`, async () => {
		await temporaryFile(async (cwd) => {
			const { row } = createRow(cwd, script);
			row.setArgsComplete();
			row.markExecutionStarted();
			const result = await tool.execute("test-edit", { text: script }, undefined, undefined, { cwd } as ExtensionContext);
			row.updateResult({ ...result, isError: false });
			assert.equal(await readFile(join(cwd, "sample.txt"), "utf8"), "after\n");
			assert.equal(plain(row).match(/after/g)?.length, 1);
			assert.equal(plain(row).match(/before/g)?.length, 1);
			const final = row.render(80);
			await new Promise((resolve) => setTimeout(resolve, 50));
			row.invalidate();
			assert.deepEqual(row.render(80), final);
			row.setExpanded(true);
			assert.deepEqual(row.render(80), final);
			for (const width of [20, 40, 120]) {
				assert.ok(row.render(width).every((line) => visibleWidth(line) <= width));
			}
			// Restored output must use the recorded result, not current disk content.
			await rm(join(cwd, "sample.txt"));
			const restored = createRow(cwd, script).row;
			restored.setArgsComplete();
			restored.updateResult({ ...result, isError: false });
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.deepEqual(restored.render(80), final);
		});
	});
}

test("failed edits show one error with the error background", () => {
	const { row } = createRow("/missing", "[sample.txt]\n@REPLACE\n-before\n+after");
	row.setArgsComplete();
	row.updateResult({ content: [{ type: "text", text: "Edit failed: file changed." }], isError: true });
	assert.equal(plain(row).match(/Edit failed: file changed\./g)?.length, 1);
	assert.ok(row.render(80).some((line) => line.includes(theme.getBgAnsi("toolErrorBg"))));
	const final = row.render(80);
	row.invalidate();
	assert.deepEqual(row.render(80), final);
});

test("multiple file paths have a compact header and separate diffs", () => {
	const script = "[one.txt]\n@APPEND\n+one\n[two.txt]\n@APPEND\n+two";
	const { row } = createRow("/missing", script);
	row.setArgsComplete();
	row.updateResult({
		content: [{ type: "text", text: "Edited two files." }],
		details: {
			diff: "File: one.txt\n+1 one\n\nFile: two.txt\n+1 two",
			patch: "",
			files: [
				{ path: "one.txt", kind: "update", details: { diff: "+1 one", patch: "" } },
				{ path: "two.txt", kind: "update", details: { diff: "+1 two", patch: "" } },
			],
		},
		isError: false,
	});
	assert.match(plain(row), /edit 2 files/);
	assert.equal(plain(row).match(/File: one\.txt/g)?.length, 1);
	assert.equal(plain(row).match(/File: two\.txt/g)?.length, 1);
});
