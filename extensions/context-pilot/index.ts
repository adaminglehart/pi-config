import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextTag } from "./tools/context-tag.js";
import { registerContextLog } from "./tools/context-log.js";
import { registerContextCheckout } from "./tools/context-checkout.js";
import { registerContextDashboard } from "./commands/context-dashboard.js";
import {
  setCommandCtx,
  getCommandCtx,
  getPendingCheckout,
  setPendingCheckout,
} from "./utils.js";

export default function contextPilot(pi: ExtensionAPI) {
  // Register tools
  registerContextTag(pi);
  registerContextLog(pi);
  registerContextCheckout(pi);

  // Register commands
  registerContextDashboard(pi);

  // Handle status requests from other extensions (e.g. footer)
  pi.events.on("context-pilot:status_request", (sm?: any) => {
    if (getCommandCtx(sm)) {
      pi.events.emit("context-pilot:enabled", true);
    }
  });

  // /acm — captures ExtensionCommandContext (required for navigateTree).
  // Must be run once per session before context_checkout can work.
  pi.registerCommand("acm", {
    description: "Enable agentic context management for the current session",
    handler: async (args, ctx) => {
      setCommandCtx(ctx, ctx.sessionManager as any);
      pi.events.emit("context-pilot:enabled", true);
      ctx.ui.notify("Agentic Context Management enabled.", "info");
      pi.sendMessage(
        {
          customType: "context-pilot",
          content: "use context-management skill",
          display: false,
        },
        { deliverAs: "followUp" },
      );
      if (args) {
        pi.sendUserMessage(args);
      }
    },
  });

  // Checkout lifecycle:
  // 1. context_checkout tool calls branchWithSummary + setPendingCheckout
  // 2. turn_end aborts the agent (can't navigate mid-turn)
  // 3. agent_end navigates to the new branch via saved CommandCtx
  pi.on("turn_end", async (_event, ctx) => {
    if (!getPendingCheckout(ctx.sessionManager as any)) return;
    ctx.abort();
  });

  pi.on("agent_end", async (_event, ctx) => {
    const sm = ctx.sessionManager as any;
    const checkout = getPendingCheckout(sm);
    if (!checkout) return;

    const cmdCtx = getCommandCtx(sm);
    if (!cmdCtx) return;

    setPendingCheckout(null, sm);

    try {
      await cmdCtx.navigateTree(checkout.branchId, {
        summarize: false,
      });

      cmdCtx.ui.notify(
        `Checked out '${checkout.target}' (${checkout.targetId})${checkout.backupTag ? `\nBackup tag: ${checkout.backupTag}` : ""}`,
        "info",
      );

      pi.sendMessage(
        {
          customType: "context-pilot",
          content: `context_checkout complete. Summary from previous branch:\n\n${checkout.enrichedMessage}\n\nRead the summary above carefully. Execute the 'Next Step' from it.`,
          display: false,
        },
        { triggerTurn: true },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Checkout failed: ${msg}`, "error");
    }
  });
}
