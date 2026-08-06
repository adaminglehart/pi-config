import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AssembledContext } from "../assembler.js";
import { decideContextReplacement } from "../context-replacement.js";
import type { SynchronizationResult } from "../session-message-synchronizer.js";

const message: AgentMessage = {
  role: "user",
  content: "safe replacement",
  timestamp: 1,
};

function synchronization(
  overrides: Partial<SynchronizationResult> = {},
): SynchronizationResult {
  return {
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
    pendingFinalizedMessages: 0,
    pendingEntries: 0,
    safeForContextReplacement: true,
    ...overrides,
  };
}

const validAssembly: AssembledContext = {
  valid: true,
  messages: [message],
  totalTokens: 1,
  summaryCount: 0,
  messageCount: 1,
};

describe("context replacement decision", () => {
  it("fails open while finalized messages or failed entries remain pending", () => {
    assert.equal(
      decideContextReplacement(
        synchronization({
          pendingFinalizedMessages: 1,
          safeForContextReplacement: false,
        }),
        validAssembly,
      ),
      undefined,
    );
    assert.equal(
      decideContextReplacement(
        synchronization({
          failed: 1,
          pendingEntries: 1,
          safeForContextReplacement: false,
        }),
        validAssembly,
      ),
      undefined,
    );
  });

  it("fails open for invalid or empty assembled context", () => {
    const invalid: AssembledContext = {
      valid: false,
      messages: [],
      reason: "orphan tool result",
      totalTokens: 1,
      summaryCount: 0,
      messageCount: 1,
    };
    assert.equal(
      decideContextReplacement(synchronization(), invalid),
      undefined,
    );
    assert.equal(
      decideContextReplacement(synchronization(), {
        ...validAssembly,
        messages: [],
      }),
      undefined,
    );
  });

  it("returns the validated canonical messages when replacement is safe", () => {
    assert.deepEqual(
      decideContextReplacement(synchronization(), validAssembly),
      { messages: [message] },
    );
  });
});
