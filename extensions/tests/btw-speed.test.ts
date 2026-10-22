import assert from "node:assert/strict";
import { test } from "bun:test";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBtwResourceLoader } from "../btw";

// Run this file separately from the overlay tests, which mock the SDK.
test("BTW changes the Sol Fast alias in side and summary requests", async () => {
	const model: Model<"openai-codex-responses"> = {
		id: "gpt-6.1-sol-fast", name: "Sol Fast", provider: "openai-codex",
		api: "openai-codex-responses", baseUrl: "https://example.com",
		reasoning: true, input: ["text"], contextWindow: 272000, maxTokens: 128000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const ctx = { cwd: process.cwd(), getSystemPrompt: () => "Test instructions." } as ExtensionContext;
	// This token is test data. It cannot authenticate with Codex.
	const access = `test.${Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
	})).toString("base64url")}.test`;
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai-codex", async () => ({
		type: "oauth", access, refresh: "test-refresh", expires: Date.now() + 3_600_000,
	}));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	for (const appendSystemPrompt of [undefined, ["Write a summary."]]) {
		const resourceLoader = await createBtwResourceLoader(ctx, appendSystemPrompt);
		assert.equal(resourceLoader.getExtensions().extensions.length, 1);
		const { session } = await createAgentSession({
			model,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory({}),
			modelRuntime,
			tools: [],
			resourceLoader,
		});
		try {
			let requestModel = "";
			const response = await session.modelRuntime.streamSimple(model, {
				messages: [{ role: "user", content: "Test", timestamp: 0 }],
			}, {
				onPayload: (_payload, resolvedModel) => {
					requestModel = resolvedModel.id;
					throw new Error("Stop before the network request");
				},
			}).result();
			assert.equal(requestModel, "gpt-6.1-sol");
			assert.equal(response.errorMessage, "Stop before the network request");
		} finally {
			session.dispose();
		}
	}
});
