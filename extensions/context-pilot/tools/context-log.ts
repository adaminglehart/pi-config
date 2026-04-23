import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { SessionTreeNode } from "../utils.js";
import { Type, type Static } from "typebox";
import {
  formatTokens,
  isInternalTool,
  getEntryRole,
  getEntryContent,
} from "../utils.js";

const ContextLogParams = Type.Object({
  limit: Type.Optional(
    Type.Number({
      description: "Max visible entries (default: 50).",
    })
  ),
  verbose: Type.Optional(
    Type.Boolean({
      description:
        "If true, show ALL messages. If false (default), show only milestones: user messages, tags, summaries, and branch points.",
    })
  ),
});

export function registerContextLog(pi: ExtensionAPI) {
  pi.registerTool({
    name: "context_log",
    label: "Context Log",
    description:
      "Show conversation history structure with context dashboard. Like 'git log --graph --oneline --decorate'. Use to find IDs for checkout, check context health, and understand where you are.",
    promptSnippet:
      "Visualize conversation history with context usage dashboard",
    parameters: ContextLogParams,

    async execute(
      _toolCallId,
      params: Static<typeof ContextLogParams>,
      _signal,
      _onUpdate,
      ctx
    ) {
      const sm = ctx.sessionManager;
      const branch = sm.getBranch();
      const currentLeafId = sm.getLeafId();
      const verbose = params.verbose ?? false;
      const limit = params.limit ?? 50;

      // Build sequence: current branch + off-path summaries
      const backboneIds = new Set(branch.map((e) => e.id));
      const sequence: SessionEntry[] = [];

      // Build a parent→children map from the tree for off-path summary detection
      const childMap = new Map<string, SessionEntry[]>();
      const buildChildMap = (nodes: SessionTreeNode[]) => {
        for (const node of nodes) {
          const kids = node.children.map((c) => c.entry);
          childMap.set(node.entry.id, kids);
          buildChildMap(node.children);
        }
      };
      buildChildMap(sm.getTree());

      for (const entry of branch) {
        sequence.push(entry);

        // Show off-path summaries/compactions
        const children = childMap.get(entry.id) ?? [];
        for (const child of children) {
          if (
            (child.type === "branch_summary" || child.type === "compaction") &&
            !backboneIds.has(child.id)
          ) {
            sequence.push(child);
          }
        }
      }

      // Determine which entries are "interesting"
      const isInteresting = (entry: SessionEntry): boolean => {
        if (entry.id === currentLeafId) return true;
        if (branch.length > 0 && entry.id === branch[0].id) return true;
        if (sm.getLabel(entry.id)) return true;
        if (entry.type === "label") return false;
        if (entry.type === "branch_summary" || entry.type === "compaction")
          return true;

        // Branch points (entries with multiple children in the tree)
        const children = childMap.get(entry.id);
        if (children && children.length > 1) return true;

        // User messages are natural milestones
        if (entry.type === "message" && entry.message.role === "user")
          return true;

        return false;
      };

      // Filter visible entries
      let visibleIds = new Set<string>();
      for (const e of sequence) {
        if (verbose || isInteresting(e)) {
          visibleIds.add(e.id);
        }
      }

      // Apply limit (keep most recent)
      if (visibleIds.size > limit) {
        const visible = sequence.filter((e) => visibleIds.has(e.id));
        const kept = new Set(visible.slice(-limit).map((e) => e.id));
        visibleIds = kept;
      }

      // Render lines
      const lines: string[] = [];
      let hiddenCount = 0;

      for (const entry of sequence) {
        if (!visibleIds.has(entry.id)) {
          hiddenCount++;
          continue;
        }

        if (hiddenCount > 0) {
          lines.push(`  :  ... (${hiddenCount} hidden messages) ...`);
          hiddenCount = 0;
        }

        const isHead = entry.id === currentLeafId;
        const isRoot = branch.length > 0 && entry.id === branch[0].id;
        const label = sm.getLabel(entry.id);
        const role = getEntryRole(entry);

        // Skip custom messages in output
        if (role === "CUSTOM") continue;

        const content = getEntryContent(entry, verbose).replace(/\s+/g, " ");
        const body =
          content.length > 100 ? content.slice(0, 100) + "..." : content;

        const meta = [
          isRoot ? "ROOT" : null,
          isHead ? "HEAD" : null,
          label ? `tag: ${label}` : null,
        ]
          .filter(Boolean)
          .join(", ");

        const marker = isHead ? "*" : role === "USER" ? "•" : "|";

        lines.push(
          `${marker} ${entry.id}${meta ? ` (${meta})` : ""} [${role}] ${body}`
        );
      }

      if (hiddenCount > 0) {
        lines.push(`  :  ... (${hiddenCount} hidden messages) ...`);
      }

      // Context Dashboard (HUD)
      const usage = await ctx.getContextUsage();
      let usageStr = "Unknown";
      if (usage && usage.percent !== null && usage.tokens !== null && usage.contextWindow !== null) {
        usageStr = `${usage.percent.toFixed(1)}% (${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)})`;
      }

      // Distance to nearest tag
      let stepsSinceTag = 0;
      let nearestTagName = "None";
      for (let i = branch.length - 1; i >= 0; i--) {
        const label = sm.getLabel(branch[i].id);
        if (label) {
          nearestTagName = label;
          break;
        }
        stepsSinceTag++;
      }

      const hud = [
        `[Context Dashboard]`,
        `• Context Usage:    ${usageStr}`,
        `• Segment Size:     ${stepsSinceTag} steps since last tag '${nearestTagName}'`,
        `---------------------------------------------------`,
      ].join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: hud + "\n" + (lines.join("\n") || "(Empty history)"),
          },
        ],
        details: {},
      };
    },
  });
}
