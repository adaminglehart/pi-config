/**
 * Shared types for websearch extension
 */

export const PROVIDERS = ["parallel", "exa"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const DEFAULT_NUM_RESULTS = 10;
export const DEFAULT_CONTEXT_MAX_CHARS = 10000;
export const EXA_TIMEOUT_MS = 25000;
export const PARALLEL_TIMEOUT_MS = 30000;

export interface WebSearchDetails {
  query: string;
  provider: Provider;
  numResults: number;
  resultCount: number;
  contentSize: number;
  noResults?: boolean;
  latencyMs?: number;
}

export interface SearchResult {
  content: string;
  resultCount: number;
  latencyMs: number;
}

// Exa-specific types
export interface ExaSearchRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: {
    name: string;
    arguments: {
      query: string;
      numResults?: number;
      livecrawl?: "fallback" | "preferred";
      type?: "auto" | "fast" | "deep";
      contextMaxCharacters?: number;
    };
  };
}

export interface ExaSearchResponse {
  jsonrpc: string;
  result: {
    content: Array<{
      type: string;
      text: string;
    }>;
  };
}
