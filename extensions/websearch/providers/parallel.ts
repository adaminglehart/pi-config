/**
 * Parallel Web provider implementation
 * Uses the parallel-web SDK for AI-native web search
 */

import Parallel, { APIConnectionError, APIError } from "parallel-web";
import {
  DEFAULT_NUM_RESULTS,
  PARALLEL_TIMEOUT_MS,
  type SearchResult,
} from "../types.js";

/**
 * Parallel cannot serve the request now (no credit, rate limit, server or
 * connection failure, or timeout). Another provider can try the search.
 */
export class ParallelUnavailableError extends Error {
  constructor(reason: string) {
    super(`Parallel search unavailable: ${reason.replace(/\.+$/, "")}`);
    this.name = "ParallelUnavailableError";
  }
}

function isUnavailableStatus(status: number | undefined): boolean {
  return status === 402 || status === 429 || (status !== undefined && status >= 500);
}

// Initialize Parallel client (API key from PARALLEL_API_KEY env var)
let _client: Parallel | undefined;
const getClient = () => {
  if (!_client) {
    _client = new Parallel();
  }
  return _client;
};

export async function searchParallel(
  query: string,
  numResults: number = DEFAULT_NUM_RESULTS,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const startTime = Date.now();

  // Create abort controller for timeout
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    PARALLEL_TIMEOUT_MS,
  );

  // Link external signal
  if (signal) {
    const onAbort = () => abortController.abort();
    signal.addEventListener("abort", onAbort);
    if (signal.aborted) abortController.abort();
  }

  try {
    const search = await getClient().search(
      {
        objective: query,
        search_queries: [query],
      },
      {
        signal: abortController.signal,
      },
    );

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    // Format results into text
    let content = "";
    const results = search.results.slice(0, numResults);

    for (const result of results) {
      content += `Title: ${result.title}\n`;
      content += `URL: ${result.url}\n`;
      if (result.publish_date) {
        content += `Published: ${result.publish_date}\n`;
      }
      for (const excerpt of result.excerpts) {
        content += `Content: ${excerpt}\n`;
      }
      content += "\n";
    }

    return { content, resultCount: results.length, latencyMs };
  } catch (error) {
    clearTimeout(timeoutId);
    if (signal?.aborted) throw error;
    if (abortController.signal.aborted) {
      throw new ParallelUnavailableError("request timed out");
    }
    if (error instanceof APIConnectionError) {
      throw new ParallelUnavailableError(error.message);
    }
    if (error instanceof APIError && isUnavailableStatus(error.status)) {
      throw new ParallelUnavailableError(`HTTP ${error.status}`);
    }
    throw error;
  }
}
