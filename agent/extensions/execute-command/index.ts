import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // Queue of commands to execute after agent turn ends
  let pendingCommand: { command: string; reason?: string } | null = null;

  // Tool to execute a command/message directly (self-invoke)
  pi.registerTool({
    name: "execute_command",
    label: "Execute Command",
    description: `Execute a slash command or send a message as if the user typed it. The message is added to the session history and triggers a new turn. Use this to:
- Self-invoke /answer after asking multiple questions
- Send follow-up prompts to yourself
- Execute other slash commands programmatically after making changes

IMPORTANT: This tool does NOT work with /reload. Never use execute_command for /reload - it will fail or cause unexpected behavior. /reload must be typed by the user directly. Also, do NOT use this tool when the user has already typed a command - that creates a loop. Only use it to programmatically trigger commands after YOUR actions.`,
    promptSnippet:
      "Execute a slash command or send a message programmatically after making changes. " +
      "Use for /answer after questions or follow-up prompts. " +
      "IMPORTANT: Does NOT work with /reload. Never use for user-typed commands.", Type.Object({
      command: Type.String({
        description:
          "The command or message to execute (e.g., '/answer', '/compact', or any text). NOTE: /reload does NOT work with this tool.",
      }),
      reason: Type.Optional(
        Type.String({
          description:
            "Optional explanation for why you're executing this command (shown to user)",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { command, reason } = params;

      // Explicitly block /reload - it does not work with this tool
      if (command === "/reload") {
        throw new Error(
          "execute_command does NOT work with /reload. /reload must be typed by the user directly, not executed programmatically."
        );
      }

      // Safety check: Don't queue if we're responding to a user-typed command
      const entries = ctx.sessionManager.getBranch();
      const lastEntry = entries[entries.length - 1];
      if (
        lastEntry?.type === "message" &&
        lastEntry.message.role === "user" &&
        lastEntry.message.content?.[0]?.type === "text" &&
        lastEntry.message.content[0].text === command
      ) {
        throw new Error(
          `Cannot execute "${command}" - user just typed this command. ` +
          `This tool should only be used to programmatically trigger commands, ` +
          `not to echo user commands.`
        );
      }

      // Store command to be executed after agent turn ends
      pendingCommand = { command, reason };

      const explanation = reason
        ? `Queued for execution: ${command}\nReason: ${reason}`
        : `Queued for execution: ${command}`;

      return {
        content: [{ type: "text", text: explanation }],
        details: {
          command,
          reason,
          queued: true,
        },
      };
    },
  });

  // Execute pending command after agent turn completes
  pi.on("agent_end", async (event, ctx) => {
    if (pendingCommand) {
      const { command } = pendingCommand;
      pendingCommand = null;

      // Special handling for /answer via event bus (needs context)
      if (command === "/answer") {
        setTimeout(() => {
          pi.events.emit("trigger:answer", ctx);
        }, 100);
      }
      // Auto-execute slash commands via sendUserMessage
      else if (command.startsWith("/")) {
        setTimeout(() => {
          pi.sendUserMessage(command);
        }, 100);
      }
      // For non-command text, prefill editor and notify
      else {
        if (ctx.hasUI) {
          ctx.ui.setEditorText(command);
          ctx.ui.notify(`Press Enter to send: ${command}`, "info");
        }
      }
    }
  });
}
