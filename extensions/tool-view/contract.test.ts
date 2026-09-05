import { strict as assert } from "node:assert";
import { test } from "node:test";
import contracts from "./contracts.json";
import { registeredTools } from "./test-support.js";

test("replacement owns exactly the original six tools and public contracts", () => {
  const current = registeredTools();
  assert.deepEqual(current.map(tool => tool.name), contracts.map(tool => tool.name));
  assert.equal(current.length, 6);
  for (let i = 0; i < contracts.length; i++) {
    const before = contracts[i]!;
    const after = current[i]!;
    for (const field of ["parameters", "description", "promptSnippet", "promptGuidelines", "label"] as const) {
      // JSON is the public contract; TypeBox's internal symbols are not public parameters.
      assert.deepEqual(JSON.parse(JSON.stringify(after[field])), before[field], `${before.name}: ${field}`);
    }
    assert.equal(after.renderShell, "self");
  }
});
