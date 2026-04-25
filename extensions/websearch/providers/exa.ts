/**
 * Exa AI provider implementation
 * Uses Exa's MCP endpoint for web search
 */

import {
	DEFAULT_CONTEXT_MAX_CHARS,
	EXA_TIMEOUT_MS,
	type ExaSearchRequest,
	type ExaSearchResponse,
	type SearchResult,
} from "../types.js";

export async function searchExa(
	query: string,
	numResults: number,
	type: "auto" | "fast" | "deep",
	livecrawl: "fallback" | "preferred",
	contextMaxCharacters: number = DEFAULT_CONTEXT_MAX_CHARS,
	signal?: AbortSignal,
): Promise<SearchResult> {
	const searchRequest: ExaSearchRequest = {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "web_search_exa",
			arguments: {
				query,
				type,
				numResults,
				livecrawl,
				contextMaxCharacters,
			},
		},
	};

	const startTime = Date.now();
	const abortController = new AbortController();
	const timeoutId = setTimeout(() => abortController.abort(), EXA_TIMEOUT_MS);

	if (signal) {
		const onAbort = () => abortController.abort();
		signal.addEventListener("abort", onAbort);
		if (signal.aborted) abortController.abort();
	}

	try {
		const response = await fetch("https://mcp.exa.ai/mcp", {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			body: JSON.stringify(searchRequest),
			signal: abortController.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Exa search error (${response.status}): ${errorText}`);
		}

		const responseText = await response.text();
		const latencyMs = Date.now() - startTime;

		// Parse SSE response
		const lines = responseText.split("\n");
		for (const line of lines) {
			if (line.startsWith("data: ")) {
				const data: ExaSearchResponse = JSON.parse(line.substring(6));
				if (data.result?.content?.length > 0) {
					const resultText = data.result.content[0].text;
					// Count results by looking for URL patterns
					const urlMatches = resultText.match(/URL:\s*http/gi);
					const resultCount = urlMatches ? urlMatches.length : 0;
					return { content: resultText, resultCount, latencyMs };
				}
			}
		}

		return { content: "", resultCount: 0, latencyMs };
	} catch (error) {
		clearTimeout(timeoutId);
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error("Exa search request timed out");
		}
		throw error;
	}
}
