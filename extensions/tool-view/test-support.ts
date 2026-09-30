import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import toolView from "./index.js";

export function registeredTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  toolView({ registerTool: (tool: ToolDefinition) => { tools.push(tool); } } as ExtensionAPI);
  return tools;
}

/**
 * Minimal context for direct `tool.execute()` calls in tests. Built-in tools
 * read the session identity for PI_* environment variables; the partial cast
 * avoids mocking the whole ExtensionContext surface.
 */
export function toolContext(cwd: string): ExtensionToolContext {
  return {
    cwd,
    tools: [],
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => undefined,
    },
    executeTool: async () => {
      throw new Error("executeTool is not available in tests");
    },
  } as unknown as ExtensionToolContext;
}
