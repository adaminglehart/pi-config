/**
 * File paths from the unified `edit` tool (extensions/unified-edit.ts).
 *
 * Its input is `{ text }`, with file sections headed by `[path]` lines. Its
 * result details list each changed file with the change kind.
 */

/** The same header rule that unified-edit.ts uses for row scripts. */
const EDIT_FILE_HEADER = /^\[(.+)]\s*$/;

type UnifiedEditFileKind = "update" | "write" | "add" | "delete";

interface UnifiedEditFileDetails {
  path: string;
  kind: UnifiedEditFileKind;
}

interface UnifiedEditResultDetails {
  files: UnifiedEditFileDetails[];
}

function normalizeHeaderPath(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

/** Paths from the `[path]` headers of an edit call, for client pre-warm. */
export function editHeaderPaths(text: string): string[] {
  const paths = new Set<string>();
  for (const line of text.split("\n")) {
    const match = EDIT_FILE_HEADER.exec(line.trim());
    if (!match) continue;
    const filePath = normalizeHeaderPath(match[1]);
    if (filePath) paths.add(filePath);
  }
  return [...paths];
}

function isUnifiedEditFileDetails(value: unknown): value is UnifiedEditFileDetails {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<Record<keyof UnifiedEditFileDetails, unknown>>;
  return typeof file.path === "string" && typeof file.kind === "string";
}

function isUnifiedEditResultDetails(value: unknown): value is UnifiedEditResultDetails {
  if (!value || typeof value !== "object" || !("files" in value)) return false;
  const { files } = value as { files: unknown };
  return Array.isArray(files) && files.every(isUnifiedEditFileDetails);
}

/**
 * Paths that an edit result changed, without deleted files. `details` is
 * `unknown` because the tool_result event types it per tool at runtime.
 */
export function editedPathsFromDetails(details: unknown): string[] {
  if (!isUnifiedEditResultDetails(details)) return [];
  const paths = new Set<string>();
  for (const file of details.files) {
    if (file.kind !== "delete") paths.add(file.path);
  }
  return [...paths];
}
