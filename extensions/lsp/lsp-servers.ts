/**
 * LSP Server Configurations
 *
 * Per-language server definitions: binary resolution, root detection,
 * and spawn configuration.
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import {
  type LSPServerConfig,
  type LSPServerHandle,
  which,
  findRoot,
  findNearestFile,
} from "./lsp-core.js";

function simpleSpawn(
  bin: string,
  args: string[] = ["--stdio"],
): (root: string) => Promise<LSPServerHandle | undefined> {
  return async (root) => {
    const cmd = which(bin);
    if (!cmd) return undefined;
    return {
      process: spawn(cmd, args, {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    };
  };
}

// -------------------------------------------------------------------
// TypeScript / JavaScript
// -------------------------------------------------------------------

const typescript: LSPServerConfig = {
  id: "typescript",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  findRoot: (file, cwd) => {
    // Skip if this is a Deno project
    if (findNearestFile(path.dirname(file), ["deno.json", "deno.jsonc"], cwd)) {
      return undefined;
    }
    return findRoot(file, cwd, ["package.json", "tsconfig.json", "jsconfig.json"]);
  },
  spawn: async (root) => {
    // Prefer local installation
    const local = path.join(
      root,
      "node_modules",
      ".bin",
      "typescript-language-server",
    );
    const cmd = fs.existsSync(local) ? local : which("typescript-language-server");
    if (!cmd) return undefined;
    return {
      process: spawn(cmd, ["--stdio"], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    };
  },
};

// -------------------------------------------------------------------
// Go
// -------------------------------------------------------------------

const gopls: LSPServerConfig = {
  id: "gopls",
  extensions: [".go"],
  findRoot: (file, cwd) => {
    // Prefer go.work for multi-module workspaces
    return findRoot(file, cwd, ["go.work"]) ?? findRoot(file, cwd, ["go.mod"]);
  },
  spawn: simpleSpawn("gopls", []),
};

// -------------------------------------------------------------------
// Python
// -------------------------------------------------------------------

const pyright: LSPServerConfig = {
  id: "pyright",
  extensions: [".py", ".pyi"],
  findRoot: (file, cwd) =>
    findRoot(file, cwd, [
      "pyproject.toml",
      "setup.py",
      "requirements.txt",
      "pyrightconfig.json",
    ]),
  spawn: simpleSpawn("pyright-langserver", ["--stdio"]),
};

// -------------------------------------------------------------------
// Rust
// -------------------------------------------------------------------

const rustAnalyzer: LSPServerConfig = {
  id: "rust-analyzer",
  extensions: [".rs"],
  findRoot: (file, cwd) => {
    const crateRoot = findRoot(file, cwd, ["Cargo.toml"]);
    if (!crateRoot) return undefined;

    // Walk up to find workspace root
    let current = crateRoot;
    while (current.length >= cwd.length) {
      const cargoToml = path.join(current, "Cargo.toml");
      try {
        const content = fs.readFileSync(cargoToml, "utf-8");
        if (content.includes("[workspace]")) return current;
      } catch {
        // ignore
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return crateRoot;
  },
  spawn: simpleSpawn("rust-analyzer", []),
};

// -------------------------------------------------------------------
// Vue
// -------------------------------------------------------------------

const vue: LSPServerConfig = {
  id: "vue",
  extensions: [".vue"],
  findRoot: (file, cwd) =>
    findRoot(file, cwd, [
      "package.json",
      "vite.config.ts",
      "vite.config.js",
    ]),
  spawn: simpleSpawn("vue-language-server", ["--stdio"]),
};

// -------------------------------------------------------------------
// Svelte
// -------------------------------------------------------------------

const svelte: LSPServerConfig = {
  id: "svelte",
  extensions: [".svelte"],
  findRoot: (file, cwd) =>
    findRoot(file, cwd, ["package.json", "svelte.config.js"]),
  spawn: simpleSpawn("svelteserver", ["--stdio"]),
};

// -------------------------------------------------------------------
// Kotlin
// -------------------------------------------------------------------

const kotlin: LSPServerConfig = {
  id: "kotlin",
  extensions: [".kt", ".kts"],
  findRoot: (file, cwd) => {
    // Prefer Gradle settings root for multi-module projects
    const gradleRoot = findRoot(file, cwd, [
      "settings.gradle.kts",
      "settings.gradle",
    ]);
    if (gradleRoot) return gradleRoot;

    return findRoot(file, cwd, [
      "build.gradle.kts",
      "build.gradle",
      "gradlew",
      "pom.xml",
    ]);
  },
  spawn: async (root) => {
    // Try kotlin-lsp (JetBrains) first, then kotlin-language-server
    const jetbrains = which("kotlin-lsp") ?? which("kotlin-lsp.sh");
    if (jetbrains) {
      return {
        process: spawn(jetbrains, ["--stdio"], {
          cwd: root,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      };
    }
    const kls = which("kotlin-language-server");
    if (!kls) return undefined;
    return {
      process: spawn(kls, [], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    };
  },
};

// -------------------------------------------------------------------
// Swift
// -------------------------------------------------------------------

const swift: LSPServerConfig = {
  id: "swift",
  extensions: [".swift"],
  findRoot: (file, cwd) => {
    // Check Package.swift and Xcode project markers
    const spmRoot = findRoot(file, cwd, ["Package.swift"]);
    if (spmRoot) return spmRoot;

    // Walk up to find .xcodeproj or .xcworkspace
    let current = path.resolve(path.dirname(file));
    const stop = path.resolve(cwd);
    while (current.length >= stop.length) {
      try {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          if (e.name.endsWith(".xcodeproj") || e.name.endsWith(".xcworkspace")) {
            return current;
          }
        }
      } catch {
        // ignore
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return undefined;
  },
  spawn: async (root) => {
    const direct = which("sourcekit-lsp");
    if (direct) {
      return {
        process: spawn(direct, [], {
          cwd: root,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      };
    }
    // macOS: try via xcrun
    const xcrun = which("xcrun");
    if (!xcrun) return undefined;
    return {
      process: spawn(xcrun, ["sourcekit-lsp"], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    };
  },
};

// -------------------------------------------------------------------
// Export all servers
// -------------------------------------------------------------------

export const LSP_SERVERS: LSPServerConfig[] = [
  typescript,
  gopls,
  pyright,
  rustAnalyzer,
  vue,
  svelte,
  kotlin,
  swift,
];

/**
 * Map from project marker file to file extension for warmup.
 */
export const WARMUP_MAP: Record<string, string> = {
  "package.json": ".ts",
  "tsconfig.json": ".ts",
  "go.mod": ".go",
  "pyproject.toml": ".py",
  "Cargo.toml": ".rs",
  "settings.gradle.kts": ".kt",
  "Package.swift": ".swift",
};
