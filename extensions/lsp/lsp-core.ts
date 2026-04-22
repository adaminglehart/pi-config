/**
 * LSP Core - Language Server Protocol client management
 *
 * Manages LSP client lifecycle, JSON-RPC connections, diagnostics,
 * and file tracking. Modeled after opencode's LSP implementation.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  type TextDocumentContentChangeEvent,
  type InitializeResult,
  type ServerCapabilities,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidSaveTextDocumentNotification,
  PublishDiagnosticsNotification,
  DocumentDiagnosticRequest,
  DefinitionRequest,
  ReferencesRequest,
  HoverRequest,
  SignatureHelpRequest,
  DocumentSymbolRequest,
  RenameRequest,
  CodeActionRequest,
} from "vscode-languageserver-protocol/node.js";
import {
  type Diagnostic,
  type Location,
  type LocationLink,
  type DocumentSymbol,
  type SymbolInformation,
  type Hover,
  type SignatureHelp,
  type WorkspaceEdit,
  type CodeAction,
  type Command,
  DiagnosticSeverity,
  CodeActionKind,
  DocumentDiagnosticReportKind,
} from "vscode-languageserver-protocol";

// -------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------

const INIT_TIMEOUT_MS = 30_000;
const MAX_OPEN_FILES = 30;
const IDLE_FILE_TIMEOUT_MS = 60_000;
const CLEANUP_INTERVAL_MS = 30_000;

// -------------------------------------------------------------------
// Language ID mapping
// -------------------------------------------------------------------

export const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".vue": "vue",
  ".svelte": "svelte",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
};

// -------------------------------------------------------------------
// Server config interface
// -------------------------------------------------------------------

export interface LSPServerConfig {
  id: string;
  extensions: string[];
  findRoot: (file: string, cwd: string) => string | undefined;
  spawn: (root: string) => Promise<LSPServerHandle | undefined>;
}

export interface LSPServerHandle {
  process: ChildProcessWithoutNullStreams;
  initOptions?: Record<string, unknown>;
}

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

interface OpenFile {
  version: number;
  lastAccess: number;
}

interface LSPClient {
  connection: MessageConnection;
  process: ChildProcessWithoutNullStreams;
  diagnostics: Map<string, Diagnostic[]>;
  openFiles: Map<string, OpenFile>;
  listeners: Map<string, Array<() => void>>;
  capabilities?: ServerCapabilities<unknown>;
  root: string;
  closed: boolean;
}

export interface FileDiagnosticItem {
  file: string;
  diagnostics: Diagnostic[];
  status: "ok" | "timeout" | "error" | "unsupported";
  error?: string;
}

export type SeverityFilter = "all" | "error" | "warning" | "info" | "hint";

// -------------------------------------------------------------------
// Utilities
// -------------------------------------------------------------------

const SEARCH_PATHS = [
  ...(process.env.PATH?.split(path.delimiter) ?? []),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  `${process.env.HOME}/go/bin`,
  `${process.env.HOME}/.cargo/bin`,
];

export function which(cmd: string): string | undefined {
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const dir of SEARCH_PATHS) {
    const full = path.join(dir, cmd + ext);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    } catch {
      // ignore
    }
  }
}

function normalizeFsPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export function findNearestFile(
  startDir: string,
  targets: string[],
  stopDir: string,
): string | undefined {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (current.length >= stop.length) {
    for (const t of targets) {
      const candidate = path.join(current, t);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function findRoot(
  file: string,
  cwd: string,
  markers: string[],
): string | undefined {
  const found = findNearestFile(path.dirname(file), markers, cwd);
  return found ? path.dirname(found) : undefined;
}

function timeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${name} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (r) => { clearTimeout(timer); resolve(r); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// -------------------------------------------------------------------
// Singleton Manager
// -------------------------------------------------------------------

let sharedManager: LSPManager | null = null;
let managerCwd: string | null = null;

export function getOrCreateManager(
  cwd: string,
  servers: LSPServerConfig[],
): LSPManager {
  if (!sharedManager || managerCwd !== cwd) {
    sharedManager?.shutdown().catch(() => {});
    sharedManager = new LSPManager(cwd, servers);
    managerCwd = cwd;
  }
  return sharedManager;
}

export function getManager(): LSPManager | null {
  return sharedManager;
}

export async function shutdownManager(): Promise<void> {
  const manager = sharedManager;
  if (!manager) return;
  sharedManager = null;
  managerCwd = null;
  await manager.shutdown();
}

// -------------------------------------------------------------------
// LSP Manager
// -------------------------------------------------------------------

export class LSPManager {
  private clients = new Map<string, LSPClient>();
  private spawning = new Map<string, Promise<LSPClient | undefined>>();
  private broken = new Set<string>();
  private cwd: string;
  private servers: LSPServerConfig[];
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(cwd: string, servers: LSPServerConfig[]) {
    this.cwd = cwd;
    this.servers = servers;
    this.cleanupTimer = setInterval(
      () => this.cleanupIdleFiles(),
      CLEANUP_INTERVAL_MS,
    );
    this.cleanupTimer.unref();
  }

  // -----------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------

  private cleanupIdleFiles() {
    const now = Date.now();
    for (const client of this.clients.values()) {
      for (const [fp, state] of client.openFiles) {
        if (now - state.lastAccess > IDLE_FILE_TIMEOUT_MS) {
          this.closeFile(client, fp);
        }
      }
    }
  }

  private closeFile(client: LSPClient, absPath: string) {
    if (!client.openFiles.has(absPath)) return;
    client.openFiles.delete(absPath);
    if (client.closed) return;
    try {
      client.connection
        .sendNotification(DidCloseTextDocumentNotification.method, {
          textDocument: { uri: pathToFileURL(absPath).href },
        })
        .catch(() => {});
    } catch {
      // ignore
    }
  }

  private evictLRU(client: LSPClient) {
    if (client.openFiles.size <= MAX_OPEN_FILES) return;
    let oldest: { path: string; time: number } | null = null;
    for (const [fp, s] of client.openFiles) {
      if (!oldest || s.lastAccess < oldest.time) {
        oldest = { path: fp, time: s.lastAccess };
      }
    }
    if (oldest) this.closeFile(client, oldest.path);
  }

  private key(id: string, root: string) {
    return `${id}:${root}`;
  }

  private resolve(fp: string) {
    const abs = path.isAbsolute(fp) ? fp : path.resolve(this.cwd, fp);
    return normalizeFsPath(abs);
  }

  private langId(fp: string) {
    return LANGUAGE_IDS[path.extname(fp)] ?? "plaintext";
  }

  private readFile(fp: string): string | null {
    try {
      return fs.readFileSync(fp, "utf-8");
    } catch {
      return null;
    }
  }

  private toPos(line: number, col: number) {
    return {
      line: Math.max(0, line - 1),
      character: Math.max(0, col - 1),
    };
  }

  // -----------------------------------------------------------------
  // Client initialization
  // -----------------------------------------------------------------

  private async initClient(
    config: LSPServerConfig,
    root: string,
  ): Promise<LSPClient | undefined> {
    const k = this.key(config.id, root);
    try {
      const handle = await config.spawn(root);
      if (!handle) {
        this.broken.add(k);
        return undefined;
      }

      const reader = new StreamMessageReader(handle.process.stdout!);
      const writer = new StreamMessageWriter(handle.process.stdin!);
      const conn = createMessageConnection(reader, writer);

      // Prevent crashes from stream errors
      handle.process.stdin?.on("error", () => {});
      handle.process.stdout?.on("error", () => {});
      handle.process.stderr?.on("error", () => {});

      const client: LSPClient = {
        connection: conn,
        process: handle.process,
        diagnostics: new Map(),
        openFiles: new Map(),
        listeners: new Map(),
        root,
        closed: false,
      };

      // Handle published diagnostics
      conn.onNotification(
        PublishDiagnosticsNotification.method,
        (params) => {
          const fpRaw = decodeURIComponent(new URL(params.uri).pathname);
          const fp = normalizeFsPath(fpRaw);
          client.diagnostics.set(fp, params.diagnostics);

          const notify = (target: string) => {
            const cbs = client.listeners.get(target);
            cbs?.slice().forEach((fn) => {
              try { fn(); } catch { /* listener error */ }
            });
          };
          notify(fp);
          if (fp !== fpRaw) notify(fpRaw);
        },
      );

      conn.onError(() => {});
      conn.onClose(() => {
        client.closed = true;
        this.clients.delete(k);
      });

      conn.onRequest("workspace/configuration", () => [
        handle.initOptions ?? {},
      ]);
      conn.onRequest("window/workDoneProgress/create", () => null);
      conn.onRequest("client/registerCapability", () => {});
      conn.onRequest("client/unregisterCapability", () => {});
      conn.onRequest("workspace/workspaceFolders", () => [
        { name: "workspace", uri: pathToFileURL(root).href },
      ]);

      handle.process.on("exit", () => {
        client.closed = true;
        this.clients.delete(k);
      });
      handle.process.on("error", () => {
        client.closed = true;
        this.clients.delete(k);
        this.broken.add(k);
      });

      conn.listen();

      const initResult: Record<string, unknown> = await timeout(
        conn.sendRequest(InitializeRequest.method, {
          rootUri: pathToFileURL(root).href,
          rootPath: root,
          processId: process.pid,
          workspaceFolders: [
            { name: "workspace", uri: pathToFileURL(root).href },
          ],
          initializationOptions: handle.initOptions ?? {},
          capabilities: {
            window: { workDoneProgress: true },
            workspace: { configuration: true },
            textDocument: {
              synchronization: {
                didSave: true,
                didOpen: true,
                didChange: true,
                didClose: true,
              },
              publishDiagnostics: { versionSupport: true },
              diagnostic: {
                dynamicRegistration: false,
                relatedDocumentSupport: false,
              },
            },
          },
        }),
        INIT_TIMEOUT_MS,
        `${config.id} initialize`,
      );

      client.capabilities = (initResult as Record<string, unknown>)
        ?.capabilities as Record<string, unknown>;

      conn.sendNotification(InitializedNotification.method, {});
      if (handle.initOptions) {
        conn.sendNotification("workspace/didChangeConfiguration", {
          settings: handle.initOptions,
        });
      }

      return client;
    } catch {
      this.broken.add(k);
      return undefined;
    }
  }

  // -----------------------------------------------------------------
  // Client resolution
  // -----------------------------------------------------------------

  async getClientsForFile(filePath: string): Promise<LSPClient[]> {
    const ext = path.extname(filePath);
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.cwd, filePath);
    const clients: LSPClient[] = [];

    for (const config of this.servers) {
      if (!config.extensions.includes(ext)) continue;
      const root = config.findRoot(absPath, this.cwd);
      if (!root) continue;
      const k = this.key(config.id, root);
      if (this.broken.has(k)) continue;

      const existing = this.clients.get(k);
      if (existing) {
        clients.push(existing);
        continue;
      }

      if (!this.spawning.has(k)) {
        const p = this.initClient(config, root);
        this.spawning.set(k, p);
        p.finally(() => this.spawning.delete(k));
      }

      const client = await this.spawning.get(k);
      if (client) {
        this.clients.set(k, client);
        clients.push(client);
      }
    }

    return clients;
  }

  // -----------------------------------------------------------------
  // File open/update
  // -----------------------------------------------------------------

  private async openOrUpdate(
    clients: LSPClient[],
    absPath: string,
    uri: string,
    langId: string,
    content: string,
    evict = true,
  ) {
    const now = Date.now();
    for (const client of clients) {
      if (client.closed) continue;
      const state = client.openFiles.get(absPath);
      try {
        if (state) {
          const v = state.version + 1;
          client.openFiles.set(absPath, { version: v, lastAccess: now });
          client.connection
            .sendNotification(DidChangeTextDocumentNotification.method, {
              textDocument: { uri, version: v },
              contentChanges: [{ text: content }],
            })
            .catch(() => {});
        } else {
          client.openFiles.set(absPath, { version: 1, lastAccess: now });
          client.connection
            .sendNotification(DidOpenTextDocumentNotification.method, {
              textDocument: { uri, languageId: langId, version: 0, text: content },
            })
            .catch(() => {});
          // Immediately send didChange to trigger analysis
          client.connection
            .sendNotification(DidChangeTextDocumentNotification.method, {
              textDocument: { uri, version: 1 },
              contentChanges: [{ text: content }],
            })
            .catch(() => {});
          if (evict) this.evictLRU(client);
        }
        // didSave triggers analysis in some servers (e.g. TypeScript)
        client.connection
          .sendNotification(DidSaveTextDocumentNotification.method, {
            textDocument: { uri },
            text: content,
          })
          .catch(() => {});
      } catch {
        // ignore
      }
    }
  }

  private async loadFile(filePath: string) {
    const absPath = this.resolve(filePath);
    const clients = await this.getClientsForFile(absPath);
    if (!clients.length) return null;
    const content = this.readFile(absPath);
    if (content === null) return null;
    return {
      clients,
      absPath,
      uri: pathToFileURL(absPath).href,
      langId: this.langId(absPath),
      content,
    };
  }

  // -----------------------------------------------------------------
  // Diagnostics waiting
  // -----------------------------------------------------------------

  private waitForDiagnostics(
    client: LSPClient,
    absPath: string,
    timeoutMs: number,
    isNew: boolean,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      if (client.closed) return resolve(false);

      let resolved = false;
      let settleTimer: NodeJS.Timeout | null = null;

      const finish = (value: boolean) => {
        if (resolved) return;
        resolved = true;
        if (settleTimer) clearTimeout(settleTimer);
        clearTimeout(timer);
        cleanupListener();
        resolve(value);
      };

      const cleanupListener = () => {
        const listeners = client.listeners.get(absPath);
        if (!listeners) return;
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
        if (listeners.length === 0) client.listeners.delete(absPath);
      };

      const listener = () => {
        if (resolved) return;
        const current = client.diagnostics.get(absPath);
        if (current && current.length > 0) return finish(true);
        // For new documents debounce empty diagnostics
        if (!isNew) return finish(true);
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => finish(true), 2500);
        (settleTimer as NodeJS.Timeout).unref?.();
      };

      const timer = setTimeout(() => finish(false), timeoutMs);
      (timer as NodeJS.Timeout).unref?.();

      const listeners = client.listeners.get(absPath) ?? [];
      listeners.push(listener);
      client.listeners.set(absPath, listeners);
    });
  }

  private async pullDiagnostics(
    client: LSPClient,
    absPath: string,
    uri: string,
  ): Promise<{ diagnostics: Diagnostic[]; responded: boolean }> {
    if (client.closed) return { diagnostics: [], responded: false };

    // Only attempt pull diagnostics if server advertises support
    if (
      !client.capabilities ||
      !(client.capabilities as Record<string, unknown>).diagnosticProvider
    ) {
      return { diagnostics: [], responded: false };
    }

    try {
      const res = (await client.connection.sendRequest(
        DocumentDiagnosticRequest.method,
        { textDocument: { uri } },
      )) as Record<string, unknown>;

      if (res?.kind === DocumentDiagnosticReportKind.Full) {
        return {
          diagnostics: Array.isArray(res.items) ? res.items : [],
          responded: true,
        };
      }
      if (res?.kind === DocumentDiagnosticReportKind.Unchanged) {
        return {
          diagnostics: client.diagnostics.get(absPath) ?? [],
          responded: true,
        };
      }
      if (Array.isArray(res?.items)) {
        return { diagnostics: res.items as Diagnostic[], responded: true };
      }
      return { diagnostics: [], responded: true };
    } catch {
      return { diagnostics: [], responded: false };
    }
  }

  // -----------------------------------------------------------------
  // Public: Touch file and wait for diagnostics
  // -----------------------------------------------------------------

  async touchFileAndWait(
    filePath: string,
    timeoutMs: number,
  ): Promise<{
    diagnostics: Diagnostic[];
    receivedResponse: boolean;
    unsupported?: boolean;
    error?: string;
  }> {
    const absPath = this.resolve(filePath);

    if (!fs.existsSync(absPath)) {
      return {
        diagnostics: [],
        receivedResponse: false,
        unsupported: true,
        error: "File not found",
      };
    }

    const clients = await this.getClientsForFile(absPath);
    if (!clients.length) {
      return {
        diagnostics: [],
        receivedResponse: false,
        unsupported: true,
        error: `No LSP server available for ${path.extname(absPath)}`,
      };
    }

    const content = this.readFile(absPath);
    if (content === null) {
      return {
        diagnostics: [],
        receivedResponse: false,
        unsupported: true,
        error: "Could not read file",
      };
    }

    const uri = pathToFileURL(absPath).href;
    const langId = this.langId(absPath);
    const isNew = clients.some((c) => !c.openFiles.has(absPath));

    const waits = clients.map((c) =>
      this.waitForDiagnostics(c, absPath, timeoutMs, isNew),
    );
    await this.openOrUpdate(clients, absPath, uri, langId, content);
    const results = await Promise.all(waits);

    let responded = results.some((r) => r);
    const diags: Diagnostic[] = [];
    for (const c of clients) {
      const d = c.diagnostics.get(absPath);
      if (d) diags.push(...d);
    }
    if (!responded && clients.some((c) => c.diagnostics.has(absPath))) {
      responded = true;
    }

    // Try pull diagnostics if push didn't work
    if (!responded || diags.length === 0) {
      const pulled = await Promise.all(
        clients.map((c) => this.pullDiagnostics(c, absPath, uri)),
      );
      for (let i = 0; i < clients.length; i++) {
        const r = pulled[i];
        if (r.responded) responded = true;
        if (r.diagnostics.length) {
          clients[i].diagnostics.set(absPath, r.diagnostics);
          diags.push(...r.diagnostics);
        }
      }
    }

    return { diagnostics: diags, receivedResponse: responded };
  }

  // -----------------------------------------------------------------
  // Public: Batch diagnostics
  // -----------------------------------------------------------------

  async getDiagnosticsForFiles(
    files: string[],
    timeoutMs: number,
  ): Promise<{ items: FileDiagnosticItem[] }> {
    const unique = [...new Set(files.map((f) => this.resolve(f)))];
    const results: FileDiagnosticItem[] = [];
    const toClose = new Map<LSPClient, string[]>();

    for (const absPath of unique) {
      if (!fs.existsSync(absPath)) {
        results.push({
          file: absPath,
          diagnostics: [],
          status: "error",
          error: "File not found",
        });
        continue;
      }

      let clients: LSPClient[];
      try {
        clients = await this.getClientsForFile(absPath);
      } catch (e) {
        results.push({
          file: absPath,
          diagnostics: [],
          status: "error",
          error: String(e),
        });
        continue;
      }

      if (!clients.length) {
        results.push({
          file: absPath,
          diagnostics: [],
          status: "unsupported",
          error: `No LSP for ${path.extname(absPath)}`,
        });
        continue;
      }

      const content = this.readFile(absPath);
      if (!content) {
        results.push({
          file: absPath,
          diagnostics: [],
          status: "error",
          error: "Could not read file",
        });
        continue;
      }

      const uri = pathToFileURL(absPath).href;
      const langId = this.langId(absPath);
      const isNew = clients.some((c) => !c.openFiles.has(absPath));

      for (const c of clients) {
        if (!c.openFiles.has(absPath)) {
          if (!toClose.has(c)) toClose.set(c, []);
          toClose.get(c)!.push(absPath);
        }
      }

      const waits = clients.map((c) =>
        this.waitForDiagnostics(c, absPath, timeoutMs, isNew),
      );
      await this.openOrUpdate(clients, absPath, uri, langId, content, false);
      const waitResults = await Promise.all(waits);

      const diags: Diagnostic[] = [];
      for (const c of clients) {
        const d = c.diagnostics.get(absPath);
        if (d) diags.push(...d);
      }

      let responded = waitResults.some((r) => r) || diags.length > 0;

      if (!responded || diags.length === 0) {
        const pulled = await Promise.all(
          clients.map((c) => this.pullDiagnostics(c, absPath, uri)),
        );
        for (let i = 0; i < clients.length; i++) {
          const r = pulled[i];
          if (r.responded) responded = true;
          if (r.diagnostics.length) {
            clients[i].diagnostics.set(absPath, r.diagnostics);
            diags.push(...r.diagnostics);
          }
        }
      }

      results.push({
        file: absPath,
        diagnostics: diags,
        status: responded || diags.length > 0 ? "ok" : "timeout",
        error: !responded && !diags.length ? "LSP did not respond" : undefined,
      });
    }

    // Cleanup temporarily opened files
    for (const [c, fps] of toClose) {
      for (const fp of fps) this.closeFile(c, fp);
    }
    for (const c of this.clients.values()) {
      while (c.openFiles.size > MAX_OPEN_FILES) this.evictLRU(c);
    }

    return { items: results };
  }

  // -----------------------------------------------------------------
  // Public: LSP operations
  // -----------------------------------------------------------------

  private normalizeLocs(
    result: Location | Location[] | LocationLink[] | null | undefined,
  ): Location[] {
    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    if (!items.length) return [];
    if ("uri" in items[0] && "range" in items[0]) return items as Location[];
    return (items as LocationLink[]).map((l) => ({
      uri: l.targetUri,
      range: l.targetSelectionRange ?? l.targetRange,
    }));
  }

  private normalizeSymbols(
    result: DocumentSymbol[] | SymbolInformation[] | null | undefined,
  ): DocumentSymbol[] {
    if (!result?.length) return [];
    const first = result[0];
    if ("location" in first) {
      return (result as SymbolInformation[]).map((s) => ({
        name: s.name,
        kind: s.kind,
        range: s.location.range,
        selectionRange: s.location.range,
        detail: s.containerName,
        tags: s.tags,
        deprecated: s.deprecated,
        children: [],
      }));
    }
    return result as DocumentSymbol[];
  }

  async getDefinition(
    fp: string,
    line: number,
    col: number,
  ): Promise<Location[]> {
    const l = await this.loadFile(fp);
    if (!l) return [];
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    const results = await Promise.all(
      l.clients.map(async (c) => {
        if (c.closed) return [];
        try {
          return this.normalizeLocs(
            await c.connection.sendRequest(DefinitionRequest.method, {
              textDocument: { uri: l.uri },
              position: pos,
            }),
          );
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  }

  async getReferences(
    fp: string,
    line: number,
    col: number,
  ): Promise<Location[]> {
    const l = await this.loadFile(fp);
    if (!l) return [];
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    const results = await Promise.all(
      l.clients.map(async (c) => {
        if (c.closed) return [];
        try {
          return this.normalizeLocs(
            await c.connection.sendRequest(ReferencesRequest.method, {
              textDocument: { uri: l.uri },
              position: pos,
              context: { includeDeclaration: true },
            }),
          );
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  }

  async getHover(
    fp: string,
    line: number,
    col: number,
  ): Promise<Hover | null> {
    const l = await this.loadFile(fp);
    if (!l) return null;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    for (const c of l.clients) {
      if (c.closed) continue;
      try {
        const r = (await c.connection.sendRequest(HoverRequest.method, {
          textDocument: { uri: l.uri },
          position: pos,
        })) as Hover | null;
        if (r) return r;
      } catch {
        // ignore
      }
    }
    return null;
  }

  async getSignatureHelp(
    fp: string,
    line: number,
    col: number,
  ): Promise<SignatureHelp | null> {
    const l = await this.loadFile(fp);
    if (!l) return null;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    for (const c of l.clients) {
      if (c.closed) continue;
      try {
        const r = (await c.connection.sendRequest(SignatureHelpRequest.method, {
          textDocument: { uri: l.uri },
          position: pos,
        })) as SignatureHelp | null;
        if (r) return r;
      } catch {
        // ignore
      }
    }
    return null;
  }

  async getDocumentSymbols(fp: string): Promise<DocumentSymbol[]> {
    const l = await this.loadFile(fp);
    if (!l) return [];
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const results = await Promise.all(
      l.clients.map(async (c) => {
        if (c.closed) return [];
        try {
          return this.normalizeSymbols(
            await c.connection.sendRequest(DocumentSymbolRequest.method, {
              textDocument: { uri: l.uri },
            }),
          );
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  }

  async rename(
    fp: string,
    line: number,
    col: number,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    const l = await this.loadFile(fp);
    if (!l) return null;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    for (const c of l.clients) {
      if (c.closed) continue;
      try {
        const r = await c.connection.sendRequest(RenameRequest.method, {
          textDocument: { uri: l.uri },
          position: pos,
          newName,
        });
        if (r) return r;
      } catch {
        // ignore
      }
    }
    return null;
  }

  async getCodeActions(
    fp: string,
    startLine: number,
    startCol: number,
    endLine?: number,
    endCol?: number,
  ): Promise<(CodeAction | Command)[]> {
    const l = await this.loadFile(fp);
    if (!l) return [];
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);

    const start = this.toPos(startLine, startCol);
    const end = this.toPos(endLine ?? startLine, endCol ?? startCol);
    const range = { start, end };

    const diagnostics: Diagnostic[] = [];
    for (const c of l.clients) {
      const fileDiags = c.diagnostics.get(l.absPath) ?? [];
      for (const d of fileDiags) {
        if (this.rangesOverlap(d.range, range)) diagnostics.push(d);
      }
    }

    const results = await Promise.all(
      l.clients.map(async (c) => {
        if (c.closed) return [];
        try {
          const r = await c.connection.sendRequest(CodeActionRequest.method, {
            textDocument: { uri: l.uri },
            range,
            context: {
              diagnostics,
              only: [
                CodeActionKind.QuickFix,
                CodeActionKind.Refactor,
                CodeActionKind.Source,
              ],
            },
          }) as (CodeAction | Command)[] | null;
          return r ?? [];
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  }

  private rangesOverlap(
    a: { start: { line: number; character: number }; end: { line: number; character: number } },
    b: { start: { line: number; character: number }; end: { line: number; character: number } },
  ): boolean {
    if (a.end.line < b.start.line || b.end.line < a.start.line) return false;
    if (a.end.line === b.start.line && a.end.character < b.start.character) return false;
    if (b.end.line === a.start.line && b.end.character < a.start.character) return false;
    return true;
  }

  // -----------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------

  async shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    for (const c of clients) {
      const wasClosed = c.closed;
      c.closed = true;
      if (!wasClosed) {
        try {
          await Promise.race([
            c.connection.sendRequest("shutdown"),
            new Promise((r) => setTimeout(r, 1000)),
          ]);
        } catch {
          // ignore
        }
        try {
          c.connection.sendNotification("exit").catch(() => {});
        } catch {
          // ignore
        }
      }
      try { c.connection.end(); } catch { /* ignore */ }
      try { c.process.kill(); } catch { /* ignore */ }
    }
  }
}

// -------------------------------------------------------------------
// Formatting utilities
// -------------------------------------------------------------------

export { DiagnosticSeverity };

export function formatDiagnostic(d: Diagnostic): string {
  const sev = ["", "ERROR", "WARN", "INFO", "HINT"][d.severity ?? 1];
  return `${sev} [${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}`;
}

export function filterDiagnosticsBySeverity(
  diags: Diagnostic[],
  filter: SeverityFilter,
): Diagnostic[] {
  if (filter === "all") return diags;
  const max = { error: 1, warning: 2, info: 3, hint: 4 }[filter];
  return diags.filter((d) => (d.severity ?? 1) <= max);
}

export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      // ignore
    }
  }
  return uri;
}

// -------------------------------------------------------------------
// Symbol utilities
// -------------------------------------------------------------------

export function findSymbolPosition(
  symbols: DocumentSymbol[],
  query: string,
): { line: number; character: number } | null {
  const q = query.toLowerCase();
  let exact: { line: number; character: number } | null = null;
  let partial: { line: number; character: number } | null = null;

  const visit = (items: DocumentSymbol[]) => {
    for (const sym of items) {
      const name = String(sym?.name ?? "").toLowerCase();
      const pos = sym?.selectionRange?.start ?? sym?.range?.start;
      if (pos && typeof pos.line === "number" && typeof pos.character === "number") {
        if (!exact && name === q) exact = pos;
        if (!partial && name.includes(q)) partial = pos;
      }
      if ((sym as DocumentSymbol & { children?: DocumentSymbol[] })?.children?.length) {
        visit((sym as DocumentSymbol & { children: DocumentSymbol[] }).children);
      }
    }
  };
  visit(symbols);
  return exact ?? partial;
}

export async function resolvePosition(
  manager: LSPManager,
  file: string,
  query: string,
): Promise<{ line: number; column: number } | null> {
  const symbols = await manager.getDocumentSymbols(file);
  const pos = findSymbolPosition(symbols, query);
  return pos ? { line: pos.line + 1, column: pos.character + 1 } : null;
}

export function collectSymbols(
  symbols: DocumentSymbol[],
  depth = 0,
  lines: string[] = [],
  query?: string,
): string[] {
  for (const sym of symbols) {
    const name = sym?.name ?? "<unknown>";
    if (query && !name.toLowerCase().includes(query.toLowerCase())) {
      const children = (sym as DocumentSymbol & { children?: DocumentSymbol[] })?.children;
      if (children?.length) collectSymbols(children, depth + 1, lines, query);
      continue;
    }
    const startPos = sym?.selectionRange?.start ?? sym?.range?.start;
    const loc = startPos ? `${startPos.line + 1}:${startPos.character + 1}` : "";
    lines.push(`${"  ".repeat(depth)}${name}${loc ? ` (${loc})` : ""}`);
    const children = (sym as DocumentSymbol & { children?: DocumentSymbol[] })?.children;
    if (children?.length) collectSymbols(children, depth + 1, lines, query);
  }
  return lines;
}
