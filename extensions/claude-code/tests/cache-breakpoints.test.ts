import assert from "node:assert/strict";
import test from "node:test";
import { rewriteInitialRequest } from "../src/claude-cli.ts";

for (const markedBlock of [0, 1]) {
  test(`keeps one final-message cache marker when block ${markedBlock} is already marked`, () => {
    const marker = { type: "ephemeral", ttl: "1h" } as const;
    const finalContent = [
      { type: "text", text: "date reminder", cache_control: markedBlock === 0 ? marker : undefined },
      { type: "text", text: "use parallel tools", cache_control: markedBlock === 1 ? marker : undefined },
    ];
    const canonical = [{ type: "text", text: "run the command" }];
    const environment = [{
      role: "system",
      content: [{ type: "text", text: "environment reminder", cache_control: marker }],
    }];
    const request = {
      tools: [{ name: "mcp__pi__bash", input_schema: { type: "object" }, cache_control: marker }],
      system: [
        { type: "text", text: "identity", cache_control: marker },
        { type: "text", text: "prompt", cache_control: marker },
      ],
      messages: [
        { role: "user", content: canonical },
        ...environment,
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__pi__bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hi" }] },
        { role: "system", content: finalContent },
      ],
    };

    const output = rewriteInitialRequest(
      Buffer.from(JSON.stringify(request)),
      undefined,
      canonical,
      environment,
      [],
    ).toString("utf8");
    const rewritten = JSON.parse(output) as typeof request;
    const final = rewritten.messages.at(-1)?.content as typeof finalContent;
    const markerCount = output.match(/"cache_control":/g)?.length ?? 0;

    assert.equal(markerCount, 4, `The request has ${markerCount} cache markers.`);
    assert.deepEqual(final, [
      { type: "text", text: "date reminder" },
      { type: "text", text: "use parallel tools", cache_control: marker },
    ]);
    assert.deepEqual(rewritten.tools, request.tools);
    assert.equal(rewritten.messages.length, request.messages.length);
    assert.deepEqual(rewritten.messages.slice(0, -1), request.messages.slice(0, -1));
  });
}
