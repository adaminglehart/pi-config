/**
 * Handlers for the navigation actions of the `lsp` tool: location lists,
 * call hierarchy, workspace symbols, and rename.
 */
import * as path from "node:path";
import * as fs from "node:fs";
import type { CallHierarchyItem } from "vscode-languageserver-protocol";
import type { LSPManager, LocationRequestKind } from "./lsp-core.js";
import {
  callHierarchyItemLabel,
  displayPath,
  formatGroupedLocations,
  formatWorkspaceSymbols,
  incomingCallLocations,
  outgoingCallLocations,
  type LabeledLocation,
} from "./lsp-location-format.js";
import { findProjectFile } from "./lsp-project-file.js";
import { applyWorkspaceEdit, renameIdentifierAt, workspaceEditPaths } from "./lsp-workspace-edit.js";

export type LocationAction =
  | "definition"
  | "references"
  | "implementation"
  | "type-definition";

export type CallsAction = "incoming-calls" | "outgoing-calls";

export interface LspActionResult {
  text: string;
  details: object | null;
}

const LOCATION_REQUESTS: Record<
  LocationAction,
  { kind: LocationRequestKind; noun: string }
> = {
  definition: { kind: "definition", noun: "definition" },
  references: { kind: "references", noun: "reference" },
  implementation: { kind: "implementation", noun: "implementation" },
  "type-definition": { kind: "typeDefinition", noun: "type definition" },
};

export async function runLocationAction(
  manager: LSPManager,
  action: LocationAction,
  file: string,
  line: number,
  column: number,
  cwd: string,
): Promise<LspActionResult> {
  const { kind, noun } = LOCATION_REQUESTS[action];
  const locations = await manager.getLocations(kind, file, line, column);
  return {
    text: formatGroupedLocations(locations, cwd, noun),
    details: { locations },
  };
}

function formatCalls(
  items: CallHierarchyItem[],
  locations: LabeledLocation[],
  noun: string,
  cwd: string,
): string {
  if (!items.length) return "No callable symbol at this position.";
  const targets = items.map(
    (item) => `target: ${callHierarchyItemLabel(item, cwd)}`,
  );
  return [...targets, formatGroupedLocations(locations, cwd, noun)].join("\n");
}

export async function runCallsAction(
  manager: LSPManager,
  action: CallsAction,
  file: string,
  line: number,
  column: number,
  cwd: string,
): Promise<LspActionResult> {
  if (action === "incoming-calls") {
    const result = await manager.getIncomingCalls(file, line, column);
    return {
      text: formatCalls(result.items, incomingCallLocations(result.calls), "call site", cwd),
      details: result,
    };
  }
  const result = await manager.getOutgoingCalls(file, line, column);
  return {
    text: formatCalls(result.items, outgoingCallLocations(result.calls), "callee", cwd),
    details: result,
  };
}

export async function runWorkspaceSymbolsAction(
  manager: LSPManager,
  query: string,
  file: string | undefined,
  cwd: string,
): Promise<LspActionResult> {
  const projectFile = file ?? findProjectFile(cwd);
  if (!projectFile) {
    throw new Error(
      'No project file found in cwd. Pass "file" to select the project.',
    );
  }
  const clients = await manager.getClientsForFile(projectFile);
  if (!clients.length) {
    throw new Error(
      `No language server available for ${path.extname(projectFile) || projectFile}.`,
    );
  }
  const symbols = await manager.getWorkspaceSymbols(projectFile, query);
  const absProjectFile = path.resolve(cwd, projectFile);
  return {
    text: `project: ${displayPath(absProjectFile, cwd)}\n${formatWorkspaceSymbols(symbols, cwd)}`,
    details: { projectFile: absProjectFile, symbols },
  };
}

/** Requests the rename, writes the WorkspaceEdit to disk, and syncs the server. */
export async function runRenameAction(
  manager: LSPManager,
  file: string,
  line: number,
  column: number,
  newName: string,
  cwd: string,
): Promise<LspActionResult> {
  const sourceText = manager.readFileText(file);
  if (sourceText === null) throw new Error(`Cannot read rename source: ${file}`);
  const oldName = renameIdentifierAt(sourceText, line, column);
  const snapshots = await manager.refreshOpenFilesFromDisk();
  snapshots.set(fs.realpathSync(path.resolve(cwd, file)), sourceText);
  const edit = await manager.rename(file, line, column, newName);
  if (!edit) {
    return { text: "No rename available at this position.", details: null };
  }
  // The first response only finds the target files. Some servers keep stale
  // positions for files that the client has not opened. Send current disk text
  // for every target, then request fresh positions before writing anything.
  const targets = workspaceEditPaths(edit);
  const fresh = await manager.openAndSnapshotFiles(targets);
  for (const [filePath, original] of snapshots) {
    if (fresh.has(filePath) && fresh.get(filePath) !== original) {
      throw new Error(`File changed during rename: ${filePath}. No files were changed.`);
    }
  }
  const finalEdit = await manager.rename(file, line, column, newName);
  if (!finalEdit) throw new Error("Language server returned no edit after file refresh. No files were changed.");
  for (const filePath of workspaceEditPaths(finalEdit)) {
    if (!fresh.has(filePath)) {
      throw new Error(`Language server added an unsynced rename target: ${filePath}. No files were changed.`);
    }
  }
  let applied: ReturnType<typeof applyWorkspaceEdit>;
  try {
    applied = applyWorkspaceEdit(finalEdit, oldName, fresh);
  } catch (error) {
    // A write can fail after one file was changed. Refresh the server even
    // when rollback fails, so its open documents match what remains on disk.
    await manager.refreshOpenFilesFromDisk().catch(() => {});
    throw error;
  }
  await manager.syncFilesFromDisk(applied.map((f) => f.path));
  const total = applied.reduce((sum, f) => sum + f.editCount, 0);
  const lines = [
    `newName: ${newName}`,
    `Applied ${total} edit(s) in ${applied.length} file(s):`,
    ...applied.map((f) => `  ${displayPath(f.path, cwd)}: ${f.editCount} edit(s)`),
  ];
  return { text: lines.join("\n"), details: { edit: finalEdit, applied } };
}
