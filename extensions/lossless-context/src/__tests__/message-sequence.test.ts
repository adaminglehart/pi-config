import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { validateMessageSequence } from "../message-sequence.js";
import { makeAssistantMessage, makeUserMessage } from "./helpers.js";

function toolCallingAssistant(...ids: string[]): AgentMessage {
  const message = makeAssistantMessage("") as Extract<
    AgentMessage,
    { role: "assistant" }
  >;
  return {
    ...message,
    content: ids.map((id) => ({
      type: "toolCall" as const,
      id,
      name: `tool-${id}`,
      arguments: { id },
    })),
    stopReason: "toolUse",
  };
}

function toolResult(id: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: `tool-${id}`,
    content: [{ type: "text", text: `result ${id}` }],
    isError: false,
    timestamp: 2,
  };
}

describe("provider message sequence validator", () => {
  it("accepts ordinary histories", () => {
    assert.deepEqual(
      validateMessageSequence([
        makeUserMessage("hello"),
        makeAssistantMessage("world"),
      ]),
      { valid: true },
    );
  });

  it("accepts complete single and parallel tool groups", () => {
    assert.deepEqual(
      validateMessageSequence([
        toolCallingAssistant("one"),
        toolResult("one"),
        toolCallingAssistant("two", "three"),
        toolResult("two"),
        toolResult("three"),
      ]),
      { valid: true },
    );
  });

  it("rejects orphan and duplicate tool results", () => {
    assert.equal(validateMessageSequence([toolResult("orphan")]).valid, false);
    assert.equal(
      validateMessageSequence([
        toolCallingAssistant("one"),
        toolResult("one"),
        toolResult("one"),
      ]).valid,
      false,
    );
  });

  it("rejects interrupted result groups and dangling calls", () => {
    const interrupted = validateMessageSequence([
      toolCallingAssistant("one", "two"),
      toolResult("one"),
      makeUserMessage("synthetic summary insertion"),
      toolResult("two"),
    ]);
    assert.equal(interrupted.valid, false);
    if (!interrupted.valid) {
      assert.match(interrupted.reason, /interrupted/);
    }

    const dangling = validateMessageSequence([toolCallingAssistant("missing")]);
    assert.equal(dangling.valid, false);
    if (!dangling.valid) assert.match(dangling.reason, /dangling/);
  });

  it("rejects duplicate tool call IDs", () => {
    assert.equal(
      validateMessageSequence([
        toolCallingAssistant("same", "same"),
        toolResult("same"),
      ]).valid,
      false,
    );
    assert.equal(
      validateMessageSequence([
        toolCallingAssistant("same"),
        toolResult("same"),
        toolCallingAssistant("same"),
        toolResult("same"),
      ]).valid,
      false,
    );
  });
});
