/**
 * Applies an LSP WorkspaceEdit (for example from rename) to files on disk.
 */
import * as fs from "node:fs";
import type {
  AnnotatedTextEdit,
  Position,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver-protocol";
import { uriToPath } from "./lsp-core.js";

export interface AppliedFileEdit {
  path: string;
  editCount: number;
}

/**
 * Text edits for each file. `documentChanges` has priority over `changes`,
 * as the LSP specification requires. Resource operations (create, rename,
 * delete file) and snippet edits cause an error before any file is written.
 */
function collectTextEdits(edit: WorkspaceEdit): Map<string, TextEdit[]> {
  const byFile = new Map<string, TextEdit[]>();
  const add = (uri: string, edits: TextEdit[]) => {
    const filePath = fs.realpathSync(uriToPath(uri));
    byFile.set(filePath, [...(byFile.get(filePath) ?? []), ...edits]);
  };

  if (edit.documentChanges) {
    const resourceOps: string[] = [];
    for (const change of edit.documentChanges) {
      if ("kind" in change) {
        const target = "uri" in change ? change.uri : change.oldUri;
        resourceOps.push(`${change.kind} ${uriToPath(target)}`);
        continue;
      }
      add(change.textDocument.uri, change.edits.map(toTextEdit));
    }
    if (resourceOps.length) {
      throw new Error(
        `The server returned file operations, which the lsp tool does not apply: ${resourceOps.join(", ")}. No files were changed.`,
      );
    }
    return byFile;
  }

  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    add(uri, edits);
  }
  return byFile;
}

function toTextEdit(edit: TextEdit | AnnotatedTextEdit): TextEdit {
  if ("snippet" in edit) {
    throw new Error(
      "The server returned snippet edits, which the lsp tool does not apply. No files were changed.",
    );
  }
  return edit;
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** Converts an LSP position (UTF-16 code units) to a string offset. */
function positionOffset(text: string, starts: number[], position: Position): number {
  if (!Number.isInteger(position.line) || position.line < 0 || position.line >= starts.length ||
      !Number.isInteger(position.character) || position.character < 0) {
    throw new Error("Invalid LSP edit position. No files were changed.");
  }
  const lineStart = starts[position.line];
  const nextLineStart =
    position.line + 1 < starts.length ? starts[position.line + 1] : text.length + 1;
  let lineEnd = nextLineStart - 1;
  if (lineEnd > lineStart && text[lineEnd - 1] === "\r") lineEnd--;
  if (lineStart + position.character > lineEnd) {
    throw new Error("LSP edit position exceeds the line length. No files were changed.");
  }
  return lineStart + position.character;
}

function applyTextEdits(filePath: string, text: string, edits: TextEdit[], oldName: string): string {
  const starts = lineStartOffsets(text);
  const resolved = edits.map((edit, index) => ({
    index,
    start: positionOffset(text, starts, edit.range.start),
    end: positionOffset(text, starts, edit.range.end),
    newText: edit.newText,
  }));
  // Reverse order, so that each edit keeps the offsets of the edits before it.
  // For edits at the same offset, the later edit is applied first.
  resolved.sort((a, b) => b.start - a.start || b.index - a.index);

  let result = text;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of resolved) {
    if (edit.start > edit.end) {
      throw new Error(`Invalid edit range in ${filePath}. No files were changed.`);
    }
    if (text.slice(edit.start, edit.end) !== oldName) {
      throw new Error(`Rename edit does not match "${oldName}" in ${filePath}. The language server may have stale positions. No files were changed.`);
    }
    if (edit.end > previousStart) {
      throw new Error(`Overlapping edits in ${filePath}. No files were changed.`);
    }
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
    previousStart = edit.start;
  }
  return result;
}

/** Find the exact identifier at the 1-based LSP cursor position. */
export function renameIdentifierAt(text: string, line: number, column: number): string {
  const offset = positionOffset(text, lineStartOffsets(text), {
    line: line - 1,
    character: column - 1,
  });
  for (const match of text.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu)) {
    if (match.index <= offset && offset < match.index + match[0].length) {
      return match[0];
    }
  }
  throw new Error("Rename position is not on an identifier. No files were changed.");
}

/** Every file in a rename edit, with resource and snippet edits rejected. */
export function workspaceEditPaths(edit: WorkspaceEdit): string[] {
  return [...collectTextEdits(edit).keys()];
}

/** Computes all new file contents first, then writes them. */
export function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  oldName: string,
  openFileSnapshots: ReadonlyMap<string, string> = new Map(),
): AppliedFileEdit[] {
  const planned: Array<{ path: string; original: Buffer; text: string; editCount: number }> = [];
  for (const [filePath, edits] of collectTextEdits(edit)) {
    if (!edits.length) continue;
    const original = fs.readFileSync(filePath);
    const originalText = original.toString("utf-8");
    if (!Buffer.from(originalText, "utf-8").equals(original)) {
      throw new Error(`Cannot safely rename non-UTF-8 file: ${filePath}. No files were changed.`);
    }
    const snapshot = openFileSnapshots.get(filePath);
    if (snapshot !== undefined && snapshot !== originalText) {
      throw new Error(`File changed during rename: ${filePath}. No files were changed.`);
    }
    planned.push({
      path: filePath,
      original,
      text: applyTextEdits(filePath, originalText, edits, oldName),
      editCount: edits.length,
    });
  }
  // Fail before the first write when a target is already known to be read-only.
  for (const file of planned) fs.accessSync(file.path, fs.constants.W_OK);
  const attempted: typeof planned = [];
  try {
    for (const file of planned) {
      // Include the current file: a failed write can have truncated it.
      attempted.push(file);
      fs.writeFileSync(file.path, file.text, "utf-8");
    }
  } catch (error) {
    const failedRollbacks: string[] = [];
    for (const file of attempted.reverse()) {
      try {
        fs.writeFileSync(file.path, file.original, "utf-8");
      } catch {
        failedRollbacks.push(file.path);
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    const result = failedRollbacks.length
      ? `Rollback failed for: ${failedRollbacks.join(", ")}. Inspect these files before continuing.`
      : `Rolled back ${attempted.length} file(s).`;
    throw new Error(`Rename write failed: ${reason}. ${result}`);
  }
  return planned.map(({ path, editCount }) => ({ path, editCount }));
}
