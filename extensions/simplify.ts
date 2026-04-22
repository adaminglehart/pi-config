/**
 * /simplify - Review branch changes and simplify code patterns
 *
 * Gathers the diff of the current branch vs its base (default: main),
 * then spawns a subagent focused on simplifying code: deduplication,
 * pattern consolidation, removing unnecessary abstractions, etc.
 *
 * Usage:
 *   /simplify              — simplify all branch changes vs main
 *   /simplify auth module  — focus simplification on a specific area
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Text } from "@mariozechner/pi-tui";

const SYSTEM_PROMPT = `You are a code simplification specialist. You have been given a diff of changes from a feature branch and your job is to review and simplify the code.

Your goals (in priority order):
1. **Deduplicate** — Extract repeated code into shared functions or constants. If the same logic appears in multiple places within the diff, consolidate it.
2. **Simplify patterns** — Replace verbose or overly complex patterns with simpler alternatives. Prefer direct approaches over indirection.
3. **Remove unnecessary abstractions** — If a generic type, callback pattern, options object, or wrapper exists but only has one consumer, inline it.
4. **Clean up** — Remove dead code, unused imports, and unnecessary type assertions introduced in the diff.
5. **Consolidate** — If related logic is scattered across files, consider whether it belongs together.

Rules:
- Only modify files that are part of the diff. Do not refactor unrelated code.
- Preserve all existing behavior. This is simplification, not a feature change.
- Make changes incrementally — one logical simplification per edit.
- If a file is fine as-is, skip it. Not every file needs changes, dont over-optimize.
- Read files before editing to ensure you have the latest content.
- Prefer small, targeted edits over large rewrites.
- Do NOT add comments explaining your simplifications — the code should speak for itself.
- When you're done, provide a brief summary of what you changed and why.`;

async function exec(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.on("error", () => resolve({ stdout, stderr, code: 1 }));
    if (signal) {
      const kill = () => proc.kill("SIGTERM");
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
  });
}

async function getBaseBranch(
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  // Fallback: check for main or master
  const main = await exec(
    "git",
    ["rev-parse", "--verify", "main"],
    cwd,
    signal,
  );
  if (main.code === 0) return "main";

  const master = await exec(
    "git",
    ["rev-parse", "--verify", "master"],
    cwd,
    signal,
  );
  if (master.code === 0) return "master";

  return "main";
}

async function getMergeBase(
  base: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await exec("git", ["merge-base", base, "HEAD"], cwd, signal);
  return result.code === 0 ? result.stdout.trim() : base;
}

interface DiffInfo {
  combinedDiff: string;
  changedFiles: string[];
  baseBranch: string;
}

async function gatherDiff(
  cwd: string,
  signal?: AbortSignal,
): Promise<DiffInfo> {
  const baseBranch = await getBaseBranch(cwd, signal);
  const mergeBase = await getMergeBase(baseBranch, cwd, signal);

  // Branch diff (committed changes since diverging from base)
  const branchDiff = await exec(
    "git",
    ["diff", mergeBase, "HEAD"],
    cwd,
    signal,
  );

  // Uncommitted changes (unstaged + staged)
  const uncommittedDiff = await exec("git", ["diff", "HEAD"], cwd, signal);

  // Get list of changed files
  const branchFiles = await exec(
    "git",
    ["diff", "--name-only", mergeBase, "HEAD"],
    cwd,
    signal,
  );
  const uncommittedFiles = await exec(
    "git",
    ["diff", "--name-only", "HEAD"],
    cwd,
    signal,
  );

  const allFiles = new Set<string>();
  for (const f of branchFiles.stdout.split("\n").filter(Boolean))
    allFiles.add(f);
  for (const f of uncommittedFiles.stdout.split("\n").filter(Boolean))
    allFiles.add(f);

  const parts: string[] = [];
  if (branchDiff.stdout.trim()) {
    parts.push(
      `=== Committed changes (${baseBranch}..HEAD) ===\n${branchDiff.stdout}`,
    );
  }
  if (uncommittedDiff.stdout.trim()) {
    parts.push(`=== Uncommitted changes ===\n${uncommittedDiff.stdout}`);
  }

  return {
    combinedDiff: parts.join("\n\n"),
    changedFiles: Array.from(allFiles),
    baseBranch,
  };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

async function writePromptFile(
  content: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-simplify-"),
  );
  const filePath = path.join(tmpDir, "system-prompt.md");
  await fs.promises.writeFile(filePath, content, {
    encoding: "utf-8",
    mode: 0o600,
  });
  return { dir: tmpDir, filePath };
}

interface SubagentResult {
  output: string;
  exitCode: number;
  stderr: string;
}

async function runSubagent(
  cwd: string,
  task: string,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  const promptFile = await writePromptFile(SYSTEM_PROMPT);

  try {
    const piArgs = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--append-system-prompt",
      promptFile.filePath,
      task,
    ];

    const invocation = getPiInvocation(piArgs);
    let output = "";
    let stderr = "";

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";
      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (
              event.type === "message_end" &&
              event.message?.role === "assistant"
            ) {
              for (const part of event.message.content) {
                if (part.type === "text") {
                  output = part.text;
                }
              }
            }
          } catch {
            // skip non-JSON lines
          }
        }
      });

      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", (code) => {
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            if (
              event.type === "message_end" &&
              event.message?.role === "assistant"
            ) {
              for (const part of event.message.content) {
                if (part.type === "text") output = part.text;
              }
            }
          } catch {
            // ignore
          }
        }
        resolve(code ?? 1);
      });
      proc.on("error", () => resolve(1));

      if (signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    return { output, exitCode, stderr };
  } finally {
    try {
      fs.unlinkSync(promptFile.filePath);
    } catch {
      /* ignore */
    }
    try {
      fs.rmdirSync(promptFile.dir);
    } catch {
      /* ignore */
    }
  }
}

export default function simplify(pi: ExtensionAPI) {
  pi.registerMessageRenderer("simplify-result", (message, _options, theme) => {
    const mdTheme = getMarkdownTheme();
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    const header = theme.fg("accent", theme.bold("✨ Simplification Summary"));
    box.addChild(new Text(header, 0, 0));
    const content = typeof message.content === "string"
      ? message.content
      : message.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
    box.addChild(new Markdown(content, 0, 0, mdTheme));
    return box;
  });

  pi.registerCommand("simplify", {
    description: "Review branch changes and simplify code patterns",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/simplify requires interactive mode", "error");
        return;
      }

      const focusArea = args.trim() || undefined;

      // Gather diff with a loader
      const diffInfo = await ctx.ui.custom<DiffInfo | null>(
        (tui, theme, _kb, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            "Gathering branch diff...",
          );
          loader.onAbort = () => done(null);

          gatherDiff(ctx.cwd, loader.signal)
            .then(done)
            .catch(() => done(null));

          return loader;
        },
      );

      if (!diffInfo) {
        ctx.ui.notify("Cancelled or failed to gather diff", "error");
        return;
      }

      if (!diffInfo.combinedDiff.trim()) {
        ctx.ui.notify(
          `No changes found compared to ${diffInfo.baseBranch}`,
          "info",
        );
        return;
      }

      ctx.ui.notify(
        `Found ${diffInfo.changedFiles.length} changed file(s) vs ${diffInfo.baseBranch}`,
        "info",
      );

      // Build the task prompt
      const fileList = diffInfo.changedFiles.map((f) => `- ${f}`).join("\n");
      let task = `Review and simplify the following changes.\n\n`;
      task += `## Changed files\n${fileList}\n\n`;
      if (focusArea) {
        task += `## Focus area\nPay special attention to: ${focusArea}\n\n`;
      }
      task += `## Diff\n\`\`\`diff\n${diffInfo.combinedDiff}\n\`\`\`\n\n`;
      task += `Read each changed file to get full context, then make simplification edits. When done, summarize what you changed.`;

      // Run the subagent with a loader
      const result = await ctx.ui.custom<SubagentResult | null>(
        (tui, theme, _kb, done) => {
          const loader = new BorderedLoader(tui, theme, "Simplifying code...");
          loader.onAbort = () => done(null);

          runSubagent(ctx.cwd, task, loader.signal)
            .then(done)
            .catch(() => done(null));

          return loader;
        },
      );

      if (!result) {
        ctx.ui.notify("Simplification cancelled", "info");
        return;
      }

      if (result.exitCode !== 0) {
        ctx.ui.notify(`Subagent failed (exit ${result.exitCode})`, "error");
        if (result.stderr) {
          ctx.ui.notify(result.stderr.slice(0, 200), "error");
        }
        return;
      }

      // Inject the summary into the conversation so the parent agent sees it
      pi.sendMessage(
        {
          customType: "simplify-result",
          content: result.output || "(no output from simplification agent)",
          display: true,
        },
        { deliverAs: "nextTurn" },
      );

      ctx.ui.notify("Simplification complete", "info");
    },
  });
}
