/**
 * WebSearch Tool - Multi-provider web search
 *
 * Supports Parallel Web (default) and Exa AI as search providers.
 * Performs real-time web searches with LLM-optimized results.
 *
 * Usage:
 * - Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * - Set PARALLEL_API_KEY in your environment for Parallel provider (default)
 *
 * Secret management (recommended):
 * - Use fnox for 1Password + age encryption: fnox sync --provider op --force
 * - Or add PARALLEL_API_KEY to .env file
 *
 * The tool will be automatically available to the LLM
 */

import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatSize } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { PROVIDERS, DEFAULT_NUM_RESULTS, DEFAULT_CONTEXT_MAX_CHARS, type Provider, type WebSearchDetails } from "./types.js";
import { searchParallel } from "./providers/parallel.js";
import { searchExa } from "./providers/exa.js";

const DESCRIPTION = `- Search the web using multiple providers (Parallel Web or Exa AI)
- Performs real-time web searches and retrieves LLM-optimized excerpts
- Provides up-to-date information for current events and recent data
- Supports configurable result counts and returns content from relevant sources
- Use this tool for accessing information beyond knowledge cutoff

Provider notes:
  - **Parallel** (default): AI-native search with natural language objectives, optimized excerpts
  - **Exa AI**: Uses MCP endpoint, supports live crawling and search modes (auto/fast/deep)

Usage notes:
  - Set PARALLEL_API_KEY environment variable to use Parallel provider (default)
  - Exa supports live crawling modes: 'fallback' or 'preferred'
  - Exa search types: 'auto' (balanced), 'fast' (quick), 'deep' (comprehensive)
  - Parallel uses natural language objectives for better semantic search

The current year is {{year}}. You MUST use this year when searching for recent information or current events
- Example: If the current year is 2026 and the user asks for "latest AI news", search for "AI news 2026", NOT "AI news 2025"`;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "websearch",
		label: "Web Search",
		description: DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString()),
		promptSnippet: "Search the web for current information using Parallel Web or Exa AI",

		parameters: Type.Object({
			query: Type.String({ description: "Web search query" }),
			provider: Type.Optional(
				StringEnum(PROVIDERS, {
					description: "Search provider - 'parallel' (default) or 'exa'",
				}),
			),
			numResults: Type.Optional(
				Type.Number({
					description: `Number of search results to return (default: ${DEFAULT_NUM_RESULTS})`,
				}),
			),
			// Exa-specific options
			livecrawl: Type.Optional(
				StringEnum(["fallback", "preferred"] as const, {
					description:
						"[Exa only] Live crawl mode - 'fallback': backup if cached unavailable, 'preferred': prioritize live crawling",
				}),
			),
			type: Type.Optional(
				StringEnum(["auto", "fast", "deep"] as const, {
					description:
						"[Exa only] Search type - 'auto': balanced, 'fast': quick results, 'deep': comprehensive",
				}),
			),
			contextMaxCharacters: Type.Optional(
				Type.Number({
					description: `[Exa only] Maximum characters for context (default: ${DEFAULT_CONTEXT_MAX_CHARS})`,
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const provider: Provider = params.provider || "parallel";
			const numResults = params.numResults || DEFAULT_NUM_RESULTS;

			const result =
				provider === "parallel"
					? await searchParallel(params.query, numResults, signal)
					: await searchExa(
							params.query,
							numResults,
							params.type || "auto",
							params.livecrawl || "fallback",
							params.contextMaxCharacters || DEFAULT_CONTEXT_MAX_CHARS,
							signal,
						);

			const contentSize = new TextEncoder().encode(result.content).byteLength;

			return {
				content: [
					{
						type: "text",
						text: result.content || "No search results found. Please try a different query.",
					},
				],
				details: {
					query: params.query,
					provider,
					numResults,
					resultCount: result.resultCount,
					contentSize,
					noResults: result.resultCount === 0,
					latencyMs: result.latencyMs,
				} as WebSearchDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("websearch "));
			text += theme.fg("accent", `"${args.query}"`);

			const provider = args.provider || "parallel";
			text += theme.fg("dim", ` [${provider}]`);

			if (args.type && args.type !== "auto") {
				text += theme.fg("dim", ` --type ${args.type}`);
			}
			if (args.numResults) {
				text += theme.fg("dim", ` --results ${args.numResults}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as WebSearchDetails | undefined;

			if (isPartial) {
				return new Text(theme.fg("warning", `Searching ${details?.provider || ""}...`), 0, 0);
			}

			let text = "";

			if (details?.noResults) {
				text = theme.fg("warning", `✗ No results (${details.provider})`);
			} else {
				const count = details?.resultCount ?? 0;
				const size = formatSize(details?.contentSize ?? 0);
				const provider = details?.provider ?? "parallel";
				text = theme.fg("success", `✓ ${count} result${count !== 1 ? "s" : ""}`);
				text += theme.fg("dim", ` (${size}) [${provider}]`);
				if (details?.latencyMs) {
					text += theme.fg("dim", ` ${details.latencyMs}ms`);
				}
			}

			if (expanded && details) {
				text += `\n${theme.fg("dim", `Query: ${details.query}`)}`;
				text += `\n${theme.fg("dim", `Provider: ${details.provider}`)}`;
				text += `\n${theme.fg("dim", `Requested: ${details.numResults} results`)}`;
				if (details.latencyMs) {
					text += `\n${theme.fg("dim", `Latency: ${details.latencyMs}ms`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
