/**
 * lcm_expand_query tool: Ask a question about historical context.
 * Searches the summary DAG, expands relevant summaries, and synthesizes an answer using LLM.
 */

import { Type } from "typebox";
import type {
  ExtensionAPI,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";
import type { RetrievalEngine } from "../retrieval.js";
import type { LcmConfig } from "../types.js";

export function registerExpandQueryTool(
  pi: ExtensionAPI,
  getEngine: () => RetrievalEngine | undefined,
  getConversationId: () => string | undefined,
  getConfig: () => LcmConfig,
  getModelRegistry: () => ModelRegistry | undefined,
) {
  pi.registerTool({
    name: "lcm_expand_query",
    label: "LCM Expand Query",
    description:
      "Ask a question about historical conversation context. Searches the summary DAG, expands relevant summaries, and synthesizes an answer. Use this when you need to recall specific details from earlier in the conversation that may have been compacted.",
    promptSnippet:
      "Ask a question about old conversation context — searches and synthesizes from the summary DAG",
    promptGuidelines: [
      "Use lcm_expand_query for complex recall questions about past context. For simple keyword searches, prefer lcm_grep instead.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Question about historical context" }),
      summary_id: Type.Optional(
        Type.String({
          description: "Optional starting summary ID to search within",
        }),
      ),
      max_tokens: Type.Optional(
        Type.Number({
          description: "Max tokens for expanded context. Default: 4000",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const engine = getEngine();
      const conversationId = getConversationId();
      const config = getConfig();
      const modelRegistry = getModelRegistry();
      if (!engine || !conversationId || !modelRegistry) {
        throw new Error("LCM not initialized");
      }

      const maxTokens = params.max_tokens ?? config.maxExpandTokens;

      // Step 1: Find relevant summaries via grep
      const grepResult = engine.grep(params.query, conversationId, "both", 10);

      // Step 2: Expand the most relevant summaries
      const expandedContext: string[] = [];
      let tokensUsed = 0;

      // If a specific summary_id was given, start there
      if (params.summary_id) {
        const expanded = engine.expand(params.summary_id, maxTokens);
        if (expanded) {
          for (const item of expanded.items) {
            expandedContext.push(item.content);
            tokensUsed +=
              item.type === "message" ? item.content.length / 3.5 : 0;
          }
        }
      }

      // Expand top grep results
      for (const s of grepResult.summaries) {
        if (tokensUsed >= maxTokens) break;
        const expanded = engine.expand(s.id, maxTokens - tokensUsed);
        if (expanded) {
          for (const item of expanded.items) {
            expandedContext.push(item.content);
          }
          tokensUsed += expanded.totalTokens;
        }
      }

      // Include matching raw messages
      for (const m of grepResult.messages) {
        if (tokensUsed >= maxTokens) break;
        expandedContext.push(`[${m.role}]: ${m.snippet}`);
        tokensUsed += m.snippet.length / 3.5;
      }

      if (expandedContext.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No relevant context found for: "${params.query}"`,
            },
          ],
          details: {},
        };
      }

      // Step 3: Synthesize answer using LLM
      const provider = config.expansionProvider || config.summaryProvider;
      const modelId = config.expansionModel || config.summaryModel;
      const model = modelRegistry.find(provider, modelId);
      if (!model) {
        // Fall back to returning raw expanded context
        return {
          content: [
            {
              type: "text",
              text: `## Expanded Context\n\n${expandedContext.join("\n\n---\n\n")}`,
            },
          ],
          details: {},
        };
      }

      const auth = await modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        return {
          content: [
            {
              type: "text",
              text: `## Expanded Context\n\n${expandedContext.join("\n\n---\n\n")}`,
            },
          ],
          details: {},
        };
      }

      try {
        const response = await completeSimple(
          model,
          {
            systemPrompt:
              "You are a context recall assistant. Given historical conversation context and a question, provide a concise, accurate answer based only on the provided context. If the context doesn't contain enough information, say so.",
            messages: [
              {
                role: "user",
                content: `## Historical Context\n\n${expandedContext.join("\n\n---\n\n")}\n\n## Question\n\n${params.query}`,
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            maxTokens: 2000,
            temperature: 0,
            signal: signal ?? undefined,
          },
        );

        const text = response.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");

        return {
          content: [
            { type: "text", text: text || "No answer could be synthesized." },
          ],
          details: {},
        };
      } catch {
        // On LLM failure, return raw context
        return {
          content: [
            {
              type: "text",
              text: `## Expanded Context\n\n${expandedContext.join("\n\n---\n\n")}`,
            },
          ],
          details: {},
        };
      }
    },
  });
}
