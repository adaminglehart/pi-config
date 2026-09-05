import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { formatSize, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { clean, lines, preview, splitNotice, wrap } from "./text.js";
import { searchSummary } from "./search.js";

export type ToolKind = "read" | "find" | "grep" | "ls" | "bash" | "write";
export interface DisplayArgs {
  path?: string;
  pattern?: string;
  offset?: number;
  limit?: number;
  command?: string;
  content?: string;
}
export interface DisplayResult {
  content: (TextContent | ImageContent)[];
  details?: unknown;
}
export interface RowInput {
  kind: ToolKind;
  args: DisplayArgs;
  result?: DisplayResult;
  cwd: string;
  expanded: boolean;
  partial: boolean;
  error: boolean;
  started: boolean;
  hint: string;
}

function pathLabel(path: string): string {
  const home = process.env.HOME;
  return clean(home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);
}

function title(input: RowInput): string {
  const { kind, args } = input;
  const path = pathLabel(args.path ?? input.cwd);
  switch (kind) {
    case "read": {
      const start = args.offset ?? 1;
      const range = args.offset !== undefined || args.limit !== undefined
        ? `:${start}${args.limit === undefined ? "-" : `-${start + args.limit - 1}`}` : "";
      return `Read ${path}${range}`;
    }
    case "write": return `Write ${path}`;
    case "bash": return `Run ${clean(args.command ?? "…")}`;
    case "grep": return `Grep /${clean(args.pattern ?? "")}/ in ${path}`;
    case "find": return `Find ${clean(args.pattern ?? "")} in ${path}`;
    case "ls": return `List ${path}`;
  }
}

/** A concrete tool row. No execution, file access, or background work occurs here. */
export function renderRow(input: RowInput, width: number, theme: Pick<Theme, "fg">): string[] {
  if (width < 1) return [];
  const { result, kind, args, expanded, partial, error } = input;
  const raw = result?.content.filter((block): block is TextContent => block.type === "text").map(block => block.text).join("\n") ?? "";
  const text = clean(raw);
  const running = partial || (!result && input.started);
  const marker = error ? "✗" : running ? "◌" : result ? "✓" : "·";
  let heading = `${marker} ${title(input)}`;
  let body = text;
  let notice = "";
  let budget = error ? 14 : running ? 6 : 8;
  let mode: "head" | "tail" | "ends" = running ? "tail" : "ends";
  let hidden = false;

  if (running) heading += " · Running";
  else if (error) heading += " · Failed";

  if (result && !error) {
    switch (kind) {
      case "read": {
        heading += ` · ${formatSize(Buffer.byteLength(raw, "utf8"))} returned`;
        const images = result.content.filter(block => block.type === "image").length;
        if (images) heading += ` · ${images} image${images === 1 ? "" : "s"}`;
        ({ body, notice } = splitNotice(text));
        if (!expanded && !images && !text.startsWith("Read image file [")) { hidden = body.length > 0; body = ""; }
        break;
      }
      case "write":
        if (!partial && typeof args.content === "string") heading += ` · ${lines(args.content).length} lines written`;
        if (!expanded) body = "";
        break;
      case "find": case "grep": case "ls": {
        const search = searchSummary(kind, text, result.details, partial);
        heading += ` · ${search.summary}`;
        body = search.body;
        notice = search.notice;
        budget = 6;
        mode = "head";
        break;
      }
      case "bash":
        ({ body, notice } = splitNotice(text));
        break;
    }
  }

  // A failed Bash tool appends its status after the truncation notice.
  // Keep that notice outside preview selection, without interpreting log keywords.
  if (kind === "bash" && error && !expanded) {
    const footer = text.match(/\n\n(Command (?:exited with code -?\d+|aborted|timed out after [\d.]+ seconds))$/);
    const before = footer ? text.slice(0, footer.index) : text;
    const parts = splitNotice(before);
    notice = parts.notice;
    body = parts.body + (footer ? `\n\n${footer[1]}` : "");
  }

  // Expanded output uses every text block, including the original notice position.
  if (expanded && result) { body = text; notice = ""; }
  const headerRows = wrap(heading, width);
  const shownHeader = expanded ? headerRows : preview(headerRows, 3, width, "head");
  hidden ||= shownHeader.length < headerRows.length;
  const indent = width > 2 ? "  " : "";
  const bodyWidth = Math.max(1, width - indent.length);
  const bodyRows = wrap(body, bodyWidth);
  const shownBody = expanded ? bodyRows : preview(bodyRows, budget, bodyWidth, mode);
  hidden ||= shownBody.length < bodyRows.length;
  const headerColor = error ? "error" : running ? "warning" : "toolTitle";
  const output = shownHeader.map(row => theme.fg(headerColor, row));
  output.push(...shownBody.map(row => indent + theme.fg(error ? "error" : "toolOutput", row)));
  if (notice) output.push(...wrap(notice, bodyWidth).map(row => indent + theme.fg("warning", row)));
  // Streaming snapshots may carry truncation details before there is a text notice.
  const details = result?.details;
  if (!notice && details && typeof details === "object" && "fullOutputPath" in details && typeof details.fullOutputPath === "string" && !text.includes(details.fullOutputPath)) {
    output.push(...wrap(`Full output: ${clean(details.fullOutputPath)}`, bodyWidth).map(row => indent + theme.fg("warning", row)));
  }
  if (hidden && !expanded && input.hint) {
    // Quiet reads stay one row when the complete header and hint fit.
    const hint = clean(input.hint);
    const joined = `${heading} · ${hint}`;
    if (kind === "read" && !notice && output.length === 1 && wrap(joined, width).length === 1) {
      return [theme.fg(headerColor, joined)];
    }
    output.push(...wrap(hint, bodyWidth).map(row => indent + theme.fg("dim", row)));
  }
  return output;
}

export class ToolRow implements Component {
  constructor(private readonly input: () => RowInput | undefined, private readonly theme: Pick<Theme, "fg">) {}
  render(width: number): string[] {
    const input = this.input();
    return input ? renderRow(input, width, this.theme) : [];
  }
  // Render from current data and theme each time. No width or theme cache.
  invalidate(): void {}
}
