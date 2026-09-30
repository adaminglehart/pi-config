/**
 * Output formatting for location lists (definition, references,
 * implementation, type-definition, call hierarchy, workspace symbols).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Location,
  SymbolInformation,
  WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { uriToPath } from "./lsp-core.js";

export const MAX_LISTED_LOCATIONS = 100;
const MAX_SOURCE_LINE_CHARS = 160;

const SYMBOL_KIND_NAMES = [
  "",
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum-member",
  "struct",
  "event",
  "operator",
  "type-parameter",
];

/** A location with an optional note, for example the caller name. */
export interface LabeledLocation extends Location {
  label?: string;
}

export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] ?? "symbol";
}

export function displayPath(filePath: string, cwd: string): string {
  if (!path.isAbsolute(filePath)) return filePath;
  // Servers report real paths; cwd can be a path through a symlink.
  for (const base of [cwd, realCwd(cwd)]) {
    const relative = path.relative(base, filePath);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative || ".";
    }
  }
  return filePath;
}

function realCwd(cwd: string): string {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function readLines(
  filePath: string,
  cache: Map<string, string[] | null>,
): string[] | null {
  if (!cache.has(filePath)) {
    try {
      cache.set(filePath, fs.readFileSync(filePath, "utf-8").split("\n"));
    } catch {
      cache.set(filePath, null);
    }
  }
  return cache.get(filePath) ?? null;
}

function sourceLineText(lines: string[] | null, line: number): string {
  const text = lines?.[line]?.trim() ?? "";
  return text.length > MAX_SOURCE_LINE_CHARS
    ? `${text.slice(0, MAX_SOURCE_LINE_CHARS)}…`
    : text;
}

function locationKey(location: LabeledLocation): string {
  const { start } = location.range;
  return `${location.uri}:${start.line}:${start.character}:${location.label ?? ""}`;
}

/**
 * Groups locations by relative file. Each entry shows `line:col`, the trimmed
 * source line, and the label. The list stops at MAX_LISTED_LOCATIONS entries.
 */
export function formatGroupedLocations(
  locations: LabeledLocation[],
  cwd: string,
  noun = "location",
): string {
  const seen = new Set<string>();
  const unique = locations.filter((location) => {
    const key = locationKey(location);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.length) return `No ${noun}s found.`;

  const byFile = new Map<string, LabeledLocation[]>();
  for (const location of unique) {
    const filePath = uriToPath(location.uri);
    const group = byFile.get(filePath) ?? [];
    group.push(location);
    byFile.set(filePath, group);
  }

  const lineCache = new Map<string, string[] | null>();
  const out = [`${unique.length} ${noun}(s) in ${byFile.size} file(s)`];
  let listed = 0;
  for (const [filePath, group] of byFile) {
    if (listed >= MAX_LISTED_LOCATIONS) break;
    out.push(displayPath(filePath, cwd));
    group.sort(
      (a, b) =>
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character,
    );
    const lines = readLines(filePath, lineCache);
    for (const location of group) {
      if (listed >= MAX_LISTED_LOCATIONS) break;
      const { line, character } = location.range.start;
      const label = location.label ? `  (${location.label})` : "";
      out.push(
        `  ${line + 1}:${character + 1}  ${sourceLineText(lines, line)}${label}`,
      );
      listed++;
    }
  }
  if (unique.length > listed) {
    out.push(
      `... ${unique.length - listed} more ${noun}(s) not shown (${unique.length} total)`,
    );
  }
  return out.join("\n");
}

export function callHierarchyItemLabel(
  item: CallHierarchyItem,
  cwd: string,
): string {
  const { line, character } = item.selectionRange.start;
  const where = `${displayPath(uriToPath(item.uri), cwd)}:${line + 1}:${character + 1}`;
  return `${symbolKindName(item.kind)} ${item.name} (${where})`;
}

/** Incoming calls: each call site in the caller, labeled with the caller name. */
export function incomingCallLocations(
  calls: CallHierarchyIncomingCall[],
): LabeledLocation[] {
  return calls.flatMap((call) => {
    const label = `in ${call.from.name}`;
    const ranges = call.fromRanges.length
      ? call.fromRanges
      : [call.from.selectionRange];
    return ranges.map((range) => ({ uri: call.from.uri, range, label }));
  });
}

/** Outgoing calls: the definition of each callee. */
export function outgoingCallLocations(
  calls: CallHierarchyOutgoingCall[],
): LabeledLocation[] {
  return calls.map((call) => ({
    uri: call.to.uri,
    range: call.to.selectionRange,
    label: `${symbolKindName(call.to.kind)} ${call.to.name}`,
  }));
}

/** One line per symbol: kind, name, container, relative path:line:col. */
export function formatWorkspaceSymbols(
  symbols: Array<SymbolInformation | WorkspaceSymbol>,
  cwd: string,
): string {
  if (!symbols.length) return "No symbols found.";
  const out = [`${symbols.length} symbol(s)`];
  for (const symbol of symbols.slice(0, MAX_LISTED_LOCATIONS)) {
    const where = displayPath(uriToPath(symbol.location.uri), cwd);
    const start =
      "range" in symbol.location ? symbol.location.range.start : undefined;
    const position = start ? `:${start.line + 1}:${start.character + 1}` : "";
    const container = symbol.containerName ? ` in ${symbol.containerName}` : "";
    out.push(
      `${symbolKindName(symbol.kind)} ${symbol.name}${container}  ${where}${position}`,
    );
  }
  if (symbols.length > MAX_LISTED_LOCATIONS) {
    out.push(
      `... ${symbols.length - MAX_LISTED_LOCATIONS} more symbol(s) not shown (${symbols.length} total)`,
    );
  }
  return out.join("\n");
}
