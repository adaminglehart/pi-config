import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { findTagInTree, findTagTarget } from "../utils.js";

const ContextTagParams = Type.Object({
  name: Type.String({
    description:
      "Tag/milestone name. Use semantic names like '<task-slug>-<phase>' (e.g. 'auth-login-start', 'db-migration-plan').",
  }),
  target: Type.Optional(
    Type.String({
      description:
        "Entry ID to tag. Defaults to HEAD (current state), skipping internal tool noise.",
    })
  ),
});

export function registerContextTag(pi: ExtensionAPI) {
  pi.registerTool({
    name: "context_tag",
    label: "Context Tag",
    description:
      "Create a named bookmark/save-point in the conversation history. Use before risky changes, at task boundaries, or when a feature is stable.",
    promptSnippet: "Bookmark a point in conversation history with a semantic name",
    parameters: ContextTagParams,

    async execute(
      _toolCallId,
      params: Static<typeof ContextTagParams>,
      _signal,
      _onUpdate,
      ctx
    ) {
      const sm = ctx.sessionManager;

      // Validate tag uniqueness
      const existing = findTagInTree(sm, params.name);
      if (existing) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Tag '${params.name}' already exists at ${existing}. Use a different name.`,
            },
          ],
          details: {},
        };
      }

      // Resolve target
      let id: string | null;
      if (params.target) {
        // Verify the target exists
        const entry = sm.getEntry(params.target);
        if (!entry) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Entry '${params.target}' not found. Use context_log to find valid IDs.`,
              },
            ],
            details: {},
          };
        }
        id = params.target;
      } else {
        id = findTagTarget(sm);
      }

      if (!id) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: No valid entry found to tag.",
            },
          ],
          details: {},
        };
      }

      try {
        pi.setLabel(id, params.name);
        return {
          content: [
            {
              type: "text" as const,
              text: `Created tag '${params.name}' at ${id}`,
            },
          ],
          details: { tagName: params.name, entryId: id },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to create tag: ${msg}`);
      }
    },
  });
}
