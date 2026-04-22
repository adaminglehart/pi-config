import type {
  SessionEntry,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";

// SessionTreeNode is not exported from pi-coding-agent, define locally
export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
}
import type { TextContent, ImageContent, ToolCall } from "@mariozechner/pi-ai";

// --- Session-scoped state for checkout flow ---
// CommandCtx captures ExtensionCommandContext from /acm (only source of navigateTree).
// pendingCheckout holds params between tool execution → turn_end → agent_end.
//
// Use WeakMaps keyed by sessionManager to ensure each session has isolated state.
// This prevents state pollution across forked sessions running in the same process.

import type { SessionManager } from "@mariozechner/pi-coding-agent";

const commandCtxMap = new WeakMap<SessionManager, ExtensionCommandContext>();

export interface PendingCheckout {
  branchId: string;
  targetId: string;
  target: string;
  enrichedMessage: string;
  backupTag?: string;
}
const pendingCheckoutMap = new WeakMap<SessionManager, PendingCheckout>();

export function getCommandCtx(sm?: SessionManager): ExtensionCommandContext | null {
  return sm ? commandCtxMap.get(sm) || null : null;
}

export function setCommandCtx(ctx: ExtensionCommandContext, sm: SessionManager): void {
  commandCtxMap.set(sm, ctx);
}

export function getPendingCheckout(sm?: SessionManager): PendingCheckout | null {
  return sm ? pendingCheckoutMap.get(sm) || null : null;
}

export function setPendingCheckout(checkout: PendingCheckout | null, sm: SessionManager): void {
  if (checkout === null) {
    pendingCheckoutMap.delete(sm);
  } else {
    pendingCheckoutMap.set(sm, checkout);
  }
}

// --- Constants and helpers ---

export const INTERNAL_TOOLS = ["context_tag", "context_log", "context_checkout"];

export const isInternalTool = (name: string): boolean =>
  INTERNAL_TOOLS.includes(name);

export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return n.toString();
};

interface ReadonlySM {
  getTree(): SessionTreeNode[];
  getLeafId(): string | null;
  getLabel(id: string): string | undefined;
  getBranch(): SessionEntry[];
  getEntry(id: string): SessionEntry | undefined;
}

/**
 * Resolve a target string to an entry ID.
 * Accepts: "root", a tag name, or a hex ID prefix.
 */
export const resolveTargetId = (sm: ReadonlySM, target: string): string => {
  if (target.toLowerCase() === "root") {
    const tree = sm.getTree();
    return tree.length > 0 ? tree[0].entry.id : target;
  }

  // Already looks like a hex ID
  if (/^[0-9a-f]{8,}$/i.test(target)) return target;

  // Search tree for a label match
  const stack: SessionTreeNode[] = [...sm.getTree()];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (sm.getLabel(node.entry.id) === target) return node.entry.id;
    if (node.children?.length) stack.push(...node.children);
  }

  // Fallback — let SessionManager deal with it
  return target;
};

/** Check if a tag name already exists anywhere in the tree. */
export const findTagInTree = (
  sm: ReadonlySM,
  tagName: string
): string | null => {
  const stack: SessionTreeNode[] = [...sm.getTree()];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (sm.getLabel(node.entry.id) === tagName) return node.entry.id;
    if (node.children?.length) stack.push(...node.children);
  }
  return null;
};

/** Find the best entry to tag when no explicit target is given.
 *  Walks backward from HEAD, skipping our own tool results and
 *  assistant messages that only contain internal tool calls. */
export const findTagTarget = (sm: ReadonlySM): string | null => {
  const branch = sm.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];

    if (entry.type === "message") {
      const msg = entry.message;

      // Skip tool results from our own tools
      if (msg.role === "toolResult" && isInternalTool(msg.toolName)) continue;

      // Skip assistant messages that ONLY call our internal tools
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const toolCalls = msg.content.filter(
          (c): c is ToolCall => c.type === "toolCall"
        );
        const hasText = msg.content.some(
          (c) => c.type === "text" && c.text.trim().length > 0
        );
        if (
          toolCalls.length > 0 &&
          !hasText &&
          toolCalls.every((tc) => isInternalTool(tc.name))
        ) {
          continue;
        }
      }
    }

    return entry.id;
  }

  return sm.getLeafId();
};

/** Extract a display role string from a session entry. */
export const getEntryRole = (entry: SessionEntry): string => {
  if (entry.type === "branch_summary" || entry.type === "compaction")
    return "SUMMARY";
  if (entry.type === "label") return "LABEL";
  if (entry.type === "custom") return "CUSTOM";
  if (entry.type !== "message") return entry.type.toUpperCase();

  const msg = entry.message;
  switch (msg.role) {
    case "assistant":
      return "AI";
    case "user":
      return "USER";
    case "toolResult":
      return "TOOL";
    case "bashExecution":
      return "BASH";
    default:
      return msg.role.toUpperCase();
  }
};

/** Extract a one-line content preview from any entry type. */
export const getEntryContent = (
  entry: SessionEntry,
  verbose: boolean
): string => {
  if (entry.type === "branch_summary" || entry.type === "compaction") {
    return entry.summary || "[No summary]";
  }
  if (entry.type === "label") return `tag: ${entry.label}`;
  if (entry.type !== "message") return "";

  const msg = entry.message;

  if (msg.role === "toolResult") {
    if (!verbose && isInternalTool(msg.toolName)) return "";

    const text = msg.content
      .map((p: TextContent | ImageContent) =>
        p.type === "text" ? p.text : ""
      )
      .join(" ")
      .trim();

    const details = msg.details as Record<string, unknown> | undefined;
    const path =
      details && "path" in details && typeof details.path === "string"
        ? `${details.path}: `
        : "";

    return `(${msg.toolName}) ${path}${text}`;
  }

  if (msg.role === "bashExecution") {
    return `[Bash] ${msg.command}`;
  }

  if (msg.role === "user" || msg.role === "assistant") {
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .map((p: { type: string; text?: string }) =>
          p.type === "text" ? (p.text ?? "") : ""
        )
        .join(" ")
        .trim();
    }

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const toolCalls = msg.content.filter(
        (c): c is ToolCall => c.type === "toolCall"
      );
      const visibleCalls = toolCalls.filter(
        (tc) => verbose || !isInternalTool(tc.name)
      );
      if (visibleCalls.length > 0) {
        const callsStr = visibleCalls
          .map((tc) => `call: ${tc.name}`)
          .join("; ");
        text = [text, callsStr].filter(Boolean).join(" ");
      }
    }

    return text;
  }

  return "";
};
