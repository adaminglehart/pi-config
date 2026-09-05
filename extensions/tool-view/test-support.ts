import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import toolView from "./index.js";

export function registeredTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  toolView({ registerTool: (tool: ToolDefinition) => { tools.push(tool); } } as ExtensionAPI);
  return tools;
}
