import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";

const execAsync = promisify(exec);

// Track browser state across tool calls
interface BrowserState {
  activeBrowser: string;
  namedPages: Map<string, { url: string; title: string }>;
  isConnected: boolean;
}

// Global state for the session
let browserState: BrowserState = {
  activeBrowser: "default",
  namedPages: new Map(),
  isConnected: false,
};

/**
 * Check if dev-browser CLI is installed and available
 */
async function isDevBrowserAvailable(): Promise<boolean> {
  try {
    await execAsync("which dev-browser");
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a dev-browser script
 */
async function executeDevBrowser(
  script: string,
  options: {
    browser?: string;
    headless?: boolean;
    connect?: string;
    timeout?: number;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args: string[] = [];
  
  if (options.browser) {
    args.push("--browser", options.browser);
  }
  if (options.headless) {
    args.push("--headless");
  }
  if (options.connect) {
    args.push("--connect", options.connect);
  }
  if (options.timeout) {
    args.push("--timeout", options.timeout.toString());
  }

  const command = `dev-browser ${args.join(" ")}`;
  
  try {
    const { stdout, stderr } = await execAsync(command, {
      input: script,
      timeout: (options.timeout || 30) * 1000 + 5000, // Add 5s buffer
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      exitCode: error.code || 1,
    };
  }
}

/**
 * Install dev-browser if not already installed
 */
async function installDevBrowser(): Promise<boolean> {
  try {
    // Check if npm is available
    await execAsync("which npm");
    
    // Try to install dev-browser globally
    await execAsync("npm install -g dev-browser", { timeout: 120000 });
    
    // Run dev-browser install for Playwright browsers
    await execAsync("dev-browser install", { timeout: 300000 });
    
    return true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    // Check if dev-browser is available
    const available = await isDevBrowserAvailable();
    
    if (!available) {
      ctx.ui.notify(
        "dev-browser not found. Run 'npm install -g dev-browser' and 'dev-browser install' to enable browser automation.",
        "warning"
      );
    } else {
      ctx.ui.notify("dev-browser extension loaded", "info");
    }

    // Restore state from previous session entries if any
    const entries = ctx.sessionManager.getBranch();
    for (const entry of entries) {
      if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "browser_run"
      ) {
        const details = entry.message.details as BrowserState | undefined;
        if (details) {
          browserState = {
            activeBrowser: details.activeBrowser || "default",
            namedPages: new Map(Object.entries(details.namedPages || {})),
            isConnected: details.isConnected || false,
          };
        }
      }
    }
  });

  // Register the browser_run tool
  pi.registerTool({
    name: "browser_run",
    label: "Browser Run",
    description:
      "Execute JavaScript in a sandboxed browser environment using Playwright. " +
      "Supports navigation, element interaction, screenshots, and data extraction. " +
      "Named pages persist across calls for multi-step workflows.",
    promptSnippet:
      "Execute browser automation scripts with Playwright in a QuickJS sandbox",
    promptGuidelines: [
      "Use browser.getPage('name') to create or retrieve a named persistent page",
      "Use browser.newPage() for temporary anonymous pages",
      "Scripts run in QuickJS sandbox - no require(), fs, or fetch available",
      "Available globals: browser, console, saveScreenshot(), readFile(), writeFile()",
      "Pages are full Playwright Page objects with goto, click, fill, evaluate, screenshot",
      "Use console.log(JSON.stringify(data)) for structured output",
    ],
    parameters: Type.Object({
      script: Type.String({
        description:
          "JavaScript code to execute in the browser sandbox. " +
          "Example: 'const page = await browser.getPage(\"main\"); await page.goto(\"https://example.com\"); console.log(await page.title());'",
      }),
      browser: Type.Optional(
        Type.String({
          description: "Browser instance name for isolation (default: 'default')",
          default: "default",
        })
      ),
      headless: Type.Optional(
        Type.Boolean({
          description: "Run browser without visible window (default: true)",
          default: true,
        })
      ),
      connect: Type.Optional(
        Type.String({
          description:
            "Connect to existing Chrome instance via CDP URL (e.g., 'http://localhost:9222'). " +
            "Use 'auto' to auto-discover.",
        })
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Script timeout in seconds (default: 30)",
          default: 30,
        })
      ),
    }),

    async execute(
      toolCallId,
      params,
      signal,
      onUpdate,
      ctx
    ) {
      // Check if dev-browser is available
      const available = await isDevBrowserAvailable();
      
      if (!available) {
        // Try to install it
        onUpdate?.({
          content: [
            { type: "text", text: "dev-browser not found. Attempting to install..." },
          ],
        });
        
        const installed = await installDevBrowser();
        if (!installed) {
          throw new Error(
            "dev-browser is not installed and automatic installation failed. " +
            "Please install manually: npm install -g dev-browser && dev-browser install"
          );
        }
      }

      // Execute the script
      onUpdate?.({
        content: [{ type: "text", text: "Executing browser script..." }],
      });

      const result = await executeDevBrowser(params.script, {
        browser: params.browser,
        headless: params.headless,
        connect: params.connect,
        timeout: params.timeout,
      });

      // Update state
      browserState.activeBrowser = params.browser || "default";
      browserState.isConnected = true;

      // Try to extract named pages from the script result
      // This is a heuristic - in a full implementation we'd parse the actual page state
      try {
        const stdoutData = JSON.parse(result.stdout);
        if (stdoutData.pages) {
          for (const [name, info] of Object.entries(stdoutData.pages)) {
            browserState.namedPages.set(name, info as { url: string; title: string });
          }
        }
      } catch {
        // Not JSON or no pages field, that's fine
      }

      // Format the result
      const output: string[] = [];
      
      if (result.stdout) {
        output.push("STDOUT:", result.stdout);
      }
      
      if (result.stderr) {
        output.push("STDERR:", result.stderr);
      }

      if (result.exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: output.join("\n") || "Script failed with no output",
            },
          ],
          isError: true,
          details: {
            exitCode: result.exitCode,
            state: {
              activeBrowser: browserState.activeBrowser,
              namedPages: Object.fromEntries(browserState.namedPages),
              isConnected: browserState.isConnected,
            },
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: output.join("\n") || "Script executed successfully",
          },
        ],
        details: {
          exitCode: result.exitCode,
          state: {
            activeBrowser: browserState.activeBrowser,
            namedPages: Object.fromEntries(browserState.namedPages),
            isConnected: browserState.isConnected,
          },
        },
      };
    },
  });

  // Register browser management commands
  pi.registerCommand("browser-status", {
    description: "Check dev-browser daemon status",
    handler: async (_args, ctx) => {
      try {
        const { stdout } = await execAsync("dev-browser status");
        ctx.ui.notify(stdout.trim(), "info");
      } catch (error: any) {
        ctx.ui.notify(error.stderr || "Failed to check status", "error");
      }
    },
  });

  pi.registerCommand("browser-stop", {
    description: "Stop dev-browser daemon and close all browsers",
    handler: async (_args, ctx) => {
      try {
        await execAsync("dev-browser stop");
        browserState.isConnected = false;
        browserState.namedPages.clear();
        ctx.ui.notify("Browser daemon stopped", "info");
      } catch (error: any) {
        ctx.ui.notify(error.stderr || "Failed to stop daemon", "error");
      }
    },
  });

  pi.registerCommand("browser-install", {
    description: "Install dev-browser and Playwright browsers",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Installing dev-browser...", "info");
      const installed = await installDevBrowser();
      if (installed) {
        ctx.ui.notify("dev-browser installed successfully", "success");
      } else {
        ctx.ui.notify("Installation failed", "error");
      }
    },
  });

  // Session shutdown cleanup
  pi.on("session_shutdown", async (_event, _ctx) => {
    // Optionally stop the browser daemon on session end
    // Commented out to allow persistence across sessions
    // try {
    //   await execAsync("dev-browser stop");
    // } catch {
    //   // Ignore errors during shutdown
    // }
  });
}
