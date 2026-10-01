import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import { test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { compact } from "@earendil-works/pi-coding-agent";
import { createCodexSpeedProvider } from "../codex-speed-models";

// This token is test data. It cannot authenticate with Codex.
const apiKey = `test.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url")}.test`;

test("Codex aliases send base model IDs for chat and compaction", async () => {
  const requests: { model: string; service_tier?: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const bytes = Buffer.from(await request.arrayBuffer());
      const text = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes).toString() : bytes.toString();
      const body = JSON.parse(text) as { model: string; service_tier?: string };
      requests.push({ model: body.model, service_tier: body.service_tier });
      return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const provider = createCodexSpeedProvider();
  const model: Model<"openai-codex-responses"> = {
    id: "gpt-6.1-sol-fast", name: "Sol Fast", provider: "openai-codex",
    api: "openai-codex-responses", baseUrl: server.url.toString(),
    reasoning: true, input: ["text"], contextWindow: 272000, maxTokens: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const messages = [{ role: "user" as const, content: "Test", timestamp: 0 }];
  const context = normalizeContext({ messages });
  const options = { apiKey, transport: "sse" as const, timeoutMs: 5000 };
  try {
    for (const id of ["gpt-6.1-sol-fast", "gpt-6-astra-fast", "gpt-6-luna-fast", "gpt-6-astra-ultrafast", "gpt-6.1-sol"]) {
      for (const stream of [provider.stream.bind(provider), provider.streamSimple.bind(provider)]) {
        const response = await stream({ ...model, id }, context, options).result();
        assert.equal(response.stopReason, "stop", response.errorMessage ?? "");
        assert.deepEqual(requests.at(-1), {
          model: id.replace(/-(fast|ultrafast)$/, ""),
          service_tier: id.endsWith("-ultrafast") ? "ultrafast" : id.endsWith("-fast") ? "priority" : undefined,
        });
      }
    }
    const preparation: Parameters<typeof compact>[0] = {
      firstKeptEntryId: "kept", messagesToSummarize: messages,
      turnPrefixMessages: messages, isSplitTurn: true, tokensBefore: 100,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 10 },
    };
    const before = requests.length;
    await compact(preparation, model, apiKey, undefined, undefined, undefined, undefined,
      (requestModel, transcript, requestOptions) => provider.streamSimple({ ...requestModel, api: "openai-codex-responses" }, transcript, { ...requestOptions, ...options }));
    assert.equal(requests.length - before, 2);
    for (const request of requests.slice(before)) {
      assert.deepEqual(request, { model: "gpt-6.1-sol", service_tier: "priority" });
    }
  } finally {
    server.stop(true);
  }
});
