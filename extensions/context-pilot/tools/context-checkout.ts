import type {
  ExtensionAPI,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { resolveTargetId, findTagInTree, getCommandCtx, setPendingCheckout } from "../utils.js";

const ContextCheckoutParams = Type.Object({
  target: Type.String({
    description:
      "Where to jump/squash to. A tag name (e.g. 'task-start'), a commit ID, or 'root'.",
  }),
  message: Type.String({
    description:
      "Carryover message for the new branch. Structure: '[Status] + [Reason] + [Important Changes] + [Next Step]'. This is your lifeline — be specific.",
  }),
  backupTag: Type.Optional(
    Type.String({
      description:
        "Optional tag to apply to the CURRENT state before checkout. Creates a backup you can return to.",
    })
  ),
});

export type CheckoutParams = Static<typeof ContextCheckoutParams>;

export function registerContextCheckout(pi: ExtensionAPI) {
  pi.registerTool({
    name: "context_checkout",
    label: "Context Checkout",
    description:
      "Navigate to any point in conversation history. Resets conversation context (NOT disk files). ALWAYS provide a detailed 'message' to bridge context. Do NOT call any other tools in the same turn as this tool.",
    promptSnippet:
      "Time-travel: navigate/squash conversation history to any tag or commit",
    promptGuidelines: [
      "After calling context_checkout, do NOT call any other tools in the same turn. End your turn immediately and wait for the checkout to complete.",
    ],
    parameters: ContextCheckoutParams,

    async execute(
      _toolCallId,
      params: CheckoutParams,
      _signal,
      _onUpdate,
      ctx
    ) {
      const cmdCtx = getCommandCtx();
      if (!cmdCtx) {
        ctx.ui.setEditorText(
          `/acm ${ctx.ui.getEditorText() || "continue"}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: "Agentic context management is not enabled. Ask the user to run `/acm` to enable it, then retry.",
            },
          ],
          details: {},
        };
      }

      // Cast to full SessionManager for branchWithSummary
      const sm = ctx.sessionManager as unknown as SessionManager;
      const targetId = resolveTargetId(sm, params.target);

      // Validate target exists
      const targetEntry = sm.getEntry(targetId);
      if (!targetEntry) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Target '${params.target}' (resolved: ${targetId}) not found. Use context_log to find valid IDs/tags.`,
            },
          ],
          details: {},
        };
      }

      // Check if already at target
      const currentLeaf = sm.getLeafId();
      if (currentLeaf === targetId) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Already at target ${targetId}. No checkout needed.`,
            },
          ],
          details: {},
        };
      }

      // Validate backup tag uniqueness
      if (params.backupTag) {
        const existing = findTagInTree(sm, params.backupTag);
        if (existing) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Backup tag '${params.backupTag}' already exists at ${existing}. Use a different name.`,
              },
            ],
            details: {},
          };
        }
      }

      // Apply backup tag to current position
      if (params.backupTag && currentLeaf) {
        pi.setLabel(currentLeaf, params.backupTag);
      }

      // Build enriched message with origin info
      const currentLabel = currentLeaf ? sm.getLabel(currentLeaf) : undefined;
      const origin = currentLabel
        ? `tag: ${currentLabel}`
        : currentLeaf || "unknown";
      const enrichedMessage = `(summary from ${origin})\n${params.message}`;

      // Create the branch with summary — this writes to the session tree
      const branchId = sm.branchWithSummary(targetId, enrichedMessage);

      // Queue the checkout for turn_end → agent_end lifecycle
      setPendingCheckout({
        branchId,
        targetId,
        target: params.target,
        enrichedMessage,
        backupTag: params.backupTag,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: "checkout start",
          },
        ],
        details: {},
      };
    },
  });
}
