import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

interface ParameterSchema {
  type?: string;
  enum?: string[];
  properties?: Record<string, ParameterSchema>;
  items?: ParameterSchema;
}

const cases = [
  { path: "goal.ts", tool: "update_goal", field: "status", values: ["complete", "blocked"] },
  { path: "imagegen.ts", tool: "imagegen", field: "quality", values: ["auto", "low", "medium", "high"] },
  { path: "question.ts", tool: "question", field: "questions.items.type", values: ["single", "multiple", "text"] },
  { path: "lsp/index.ts", tool: "lsp", field: "severity", values: ["all", "error", "warning", "info", "hint"] },
  { path: "todos/index.ts", tool: "todo", field: "action", values: ["list", "list-all", "get", "create", "update", "append", "delete", "claim", "release"] },
  { path: "websearch/index.ts", tool: "websearch", field: "provider", values: ["parallel", "exa"] },
];

for (const entry of cases) {
  test(`${entry.tool} keeps its string enum when Pi loads the extension`, async () => {
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    const path = fileURLToPath(new URL(`../${entry.path}`, import.meta.url));
    const loaded = await loadExtensions([path], cwd);
    assert.deepEqual(loaded.errors, []);
    const tool = loaded.extensions[0]?.tools.get(entry.tool);
    assert.ok(tool);
    let schema = tool.definition.parameters as ParameterSchema;
    for (const field of entry.field.split(".")) {
      const next = field === "items" ? schema.items : schema.properties?.[field];
      assert.ok(next, field);
      schema = next;
    }
    assert.equal(schema.type, "string");
    assert.deepEqual(schema.enum, entry.values);
  });
}
