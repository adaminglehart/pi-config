import { lines, splitNotice } from "./text.js";

export type SearchKind = "find" | "grep" | "ls";

export function searchSummary(kind: SearchKind, text: string, details: unknown, partial: boolean) {
  const { body, notice } = splitNotice(text);
  const empty = body === "" || body === ({
    find: "No files found matching pattern",
    grep: "No matches found",
    ls: "(empty directory)",
  }[kind]);
  const rows = empty ? [] : lines(body);
  const matches = kind === "grep" ? rows.filter(row => {
    const prefix = row.match(/^.+?(?::\d+:|-\d+-)/)?.[0];
    return prefix?.endsWith(":") === true;
  }) : rows;
  const data = details && typeof details === "object" ? details : {};
  const truncated = notice !== "" || partial ||
    ("truncation" in data && !!data.truncation) ||
    "matchLimitReached" in data || "entryLimitReached" in data || "resultLimitReached" in data;
  // Grep output is unstructured. Count observed matching records, never context lines.
  const observed = kind === "grep" || truncated;
  const noun = kind === "grep" ? (matches.length === 1 ? "match" : "matches") : kind === "find" ? (matches.length === 1 ? "file" : "files") : (matches.length === 1 ? "entry" : "entries");
  return {
    body: empty ? "" : body,
    notice,
    summary: empty ? (partial ? "Waiting for results" : "No results") :
      kind === "grep" && matches.length === 0 ? "Result count unavailable" :
      `${matches.length} ${noun}${observed ? " observed" : ""}`,
  };
}
