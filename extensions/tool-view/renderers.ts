import { keyText, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { ToolRow, type DisplayArgs, type DisplayResult, type RowInput, type ToolKind } from "./row.js";

interface RowState { hasResult?: boolean }
interface Context {
  args: DisplayArgs;
  state: RowState;
  cwd: string;
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
  executionStarted: boolean;
}

function rowInput(kind: ToolKind, context: Context, result?: DisplayResult): RowInput {
  const key = keyText("app.tools.expand");
  return {
    kind, args: context.args, cwd: context.cwd, result,
    expanded: context.expanded, partial: context.isPartial, error: context.isError,
    started: context.executionStarted, hint: key ? `${key} to expand` : "",
  };
}

// Six tool definitions share only these row-local rendering hooks.
export function toolRenderers(kind: ToolKind) {
  return {
    renderShell: "self" as const,
    renderCall(_args: DisplayArgs, theme: Theme, context: Context) {
      return new ToolRow(() => context.state.hasResult ? undefined : rowInput(kind, context), theme);
    },
    renderResult(result: DisplayResult, options: ToolRenderResultOptions, theme: Theme, context: Context) {
      context.state.hasResult = true;
      return new ToolRow(() => ({ ...rowInput(kind, context, result), expanded: options.expanded, partial: options.isPartial }), theme);
    },
  };
}
