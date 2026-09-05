/** Display-only replacement for minimal-tools. Execution delegates to Pi's factories. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool, createBashTool, createWriteTool, createFindTool, createGrepTool, createLsTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { toolRenderers } from "./renderers.js";

const ReadParams = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});

const BashParams = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number()),
});

const WriteParams = Type.Object({
  path: Type.String(),
  content: Type.String(),
});

const FindParams = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
});

const GrepParams = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
});

const LsParams = Type.Object({
  path: Type.Optional(Type.String()),
});

export default function toolView(pi: ExtensionAPI) {
  pi.registerTool({
    name: "read",
    label: "read",
    description: "Read the contents of a file.",
    promptSnippet: "Read the contents of a file",
    promptGuidelines: [
      "Use read to examine file contents before making changes.",
      "Prefer grep or find first if you're unsure of the file path.",
    ],
    parameters: ReadParams,

    async execute(
      toolCallId,
      params: Static<typeof ReadParams>,
      signal,
      onUpdate,
      ctx,
    ) {
      const tool = createReadTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },

    ...toolRenderers("read"),
  });

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: "Execute a bash command.",
    promptSnippet: "Execute a bash command",
    promptGuidelines: [
      "Use bash for file exploration, running tests, builds, or git operations.",
      "Prefer grep/find/ls tools over bash for file exploration when available.",
    ],
    parameters: BashParams,

    async execute(
      toolCallId,
      params: Static<typeof BashParams>,
      signal,
      onUpdate,
      ctx,
    ) {
      const tool = createBashTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },

    ...toolRenderers("bash"),
  });

  pi.registerTool({
    name: "write",
    label: "write",
    description: "Write content to a file.",
    promptSnippet: "Write content to a file",
    promptGuidelines: [
      "Use write to create new files with full content.",
      "For modifying existing files, prefer edit over write.",
    ],
    parameters: WriteParams,

    async execute(
      toolCallId,
      params: Static<typeof WriteParams>,
      signal,
      onUpdate,
      ctx,
    ) {
      const tool = createWriteTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },

    ...toolRenderers("write"),
  });

  pi.registerTool({
    name: "find",
    label: "find",
    description: "Find files by name pattern.",
    promptSnippet: "Find files by name pattern",
    promptGuidelines: [
      "Use find to locate files when you know the name or part of it.",
      "Supports glob patterns like '*.ts' or '**/config.*'.",
    ],
    parameters: FindParams,

    async execute(
      toolCallId,
      params: Static<typeof FindParams>,
      signal,
      onUpdate,
      ctx,
    ) {
      const tool = createFindTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },

    ...toolRenderers("find"),
  });

  pi.registerTool({
    name: "grep",
    label: "grep",
    description: "Search file contents by regex.",
    promptSnippet: "Search file contents by regex",
    promptGuidelines: [
      "Use grep to search for patterns across multiple files.",
      "Supports regex patterns. Use simple strings for literal matches.",
    ],
    parameters: GrepParams,

    async execute(
      toolCallId,
      params: Static<typeof GrepParams>,
      signal,
      onUpdate,
      ctx,
    ) {
      const tool = createGrepTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },

    ...toolRenderers("grep"),
  });

  pi.registerTool({
    name: "ls",
    label: "ls",
    description: "List directory contents.",
    promptSnippet: "List directory contents",
    promptGuidelines: [
      "Use ls to explore directory structure and see what files exist.",
      "Use find instead if you need to filter by name pattern.",
    ],
    parameters: LsParams,

    async execute(
      toolCallId,
      params: Static<typeof LsParams>,
      signal,
      onUpdate,
      ctx,
    ) {
      const tool = createLsTool(ctx.cwd);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },

    ...toolRenderers("ls"),
  });
}
