import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  deserializeCanonicalMessage,
  encodeCanonicalMessage,
  projectMessageSearchText,
  serializeCanonicalMessage,
} from "../message-codec.js";

const usage = {
  input: 10,
  output: 20,
  cacheRead: 3,
  cacheWrite: 4,
  reasoning: 5,
  totalTokens: 37,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

const fixtures: AgentMessage[] = [
  { role: "user", content: "plain user text", timestamp: 1 },
  {
    role: "user",
    content: [
      { type: "text", text: "user blocks" },
      { type: "image", mimeType: "image/png", data: "BASE64_USER_SECRET" },
    ],
    timestamp: 2,
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "assistant text" },
      { type: "thinking", thinking: "private reasoning", thinkingSignature: "sig" },
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { z: [1, { nested: true }], a: "path" },
        thoughtSignature: "thought-sig",
      },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    responseId: "response-1",
    usage,
    stopReason: "toolUse",
    timestamp: 3,
  },
  {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [
      { type: "text", text: "tool output" },
      { type: "image", mimeType: "image/jpeg", data: "BASE64_TOOL_SECRET" },
    ],
    details: { arbitrarySecret: "DETAIL_SECRET", usage: { billed: 12 } },
    addedToolNames: ["grep"],
    isError: true,
    timestamp: 4,
  },
  {
    role: "bashExecution",
    command: "printf hello",
    output: "hello",
    exitCode: 0,
    cancelled: false,
    truncated: true,
    fullOutputPath: "/tmp/full-output",
    excludeFromContext: false,
    timestamp: 5,
  },
  {
    role: "custom",
    customType: "fixture",
    content: [{ type: "text", text: "custom text" }],
    display: true,
    details: { preserved: "CUSTOM_DETAIL" },
    timestamp: 6,
  },
  {
    role: "branchSummary",
    summary: "branch detail",
    fromId: "entry-old",
    timestamp: 7,
  },
  {
    role: "compactionSummary",
    summary: "compaction detail",
    tokensBefore: 1234,
    timestamp: 8,
  },
];

describe("canonical message codec", () => {
  for (const fixture of fixtures) {
    it(`round-trips ${fixture.role}`, () => {
      const serialized = serializeCanonicalMessage(fixture);
      const decoded = deserializeCanonicalMessage(serialized, "local-row");
      assert.deepEqual(decoded, JSON.parse(JSON.stringify(fixture)));
    });
  }

  it("rejects malformed JSON and invalid discriminants without leaking content", () => {
    assert.throws(
      () => deserializeCanonicalMessage("not json SECRET", "local-42"),
      (error: Error) =>
        error.message === "Corrupt canonical LCM message row local-42" &&
        !error.message.includes("SECRET"),
    );
    assert.throws(
      () =>
        deserializeCanonicalMessage(
          JSON.stringify({ role: "invalid", timestamp: 1, secret: "NOPE" }),
          "local-43",
        ),
      /Corrupt canonical LCM message row local-43/,
    );
  });

  it("projects structured searchable data but excludes binary and metadata", () => {
    const assistantProjection = projectMessageSearchText(fixtures[2]);
    assert.match(assistantProjection, /assistant text/);
    assert.match(assistantProjection, /private reasoning/);
    assert.match(assistantProjection, /read/);
    assert.match(assistantProjection, /call-1/);
    assert.match(assistantProjection, /"a":"path"/);
    assert.doesNotMatch(assistantProjection, /totalTokens|response-1/);

    const userProjection = projectMessageSearchText(fixtures[1]);
    assert.match(userProjection, /\[image: image\/png\]/);
    assert.doesNotMatch(userProjection, /BASE64_USER_SECRET/);

    const toolProjection = projectMessageSearchText(fixtures[3]);
    assert.match(toolProjection, /tool output|call-1|read|error/);
    assert.doesNotMatch(
      toolProjection,
      /BASE64_TOOL_SECRET|DETAIL_SECRET|billed/,
    );

    const customProjection = projectMessageSearchText(fixtures[5]);
    assert.match(customProjection, /fixture|custom text/);
    assert.doesNotMatch(customProjection, /CUSTOM_DETAIL/);

    const bashProjection = projectMessageSearchText(fixtures[4]);
    assert.match(bashProjection, /printf hello|hello|exit=0|truncated|full-output/);
  });

  it("uses the Pi AgentMessage token estimator at the encoding boundary", () => {
    const encoded = encodeCanonicalMessage({
      role: "user",
      content: "12345678",
      timestamp: 1,
    });
    assert.equal(encoded.tokenCount, 2);
  });
});
