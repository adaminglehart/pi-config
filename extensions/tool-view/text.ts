import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Display only: never write sanitized text back to a result. */
export function clean(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
    .replace(/\t/g, "    ");
}

export function lines(text: string): string[] {
  if (!text) return [];
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows;
}

export function wrap(text: string, width: number): string[] {
  if (!text || width < 1) return [];
  return wrapTextWithAnsi(text, width).map(row => truncateToWidth(row, width, ""));
}

export type PreviewMode = "head" | "tail" | "ends";

/** The budget includes the omission row. Counts are screen rows, not source lines. */
export function preview(rows: string[], budget: number, width: number, mode: PreviewMode): string[] {
  if (rows.length <= budget) return rows;
  const keep = Math.max(0, budget - 1);
  const head = mode === "tail" ? 0 : mode === "head" ? keep : Math.floor(keep / 3);
  const tail = keep - head;
  const notice = truncateToWidth(`… ${rows.length - keep} rows omitted`, width);
  return [...rows.slice(0, head), notice, ...(tail ? rows.slice(-tail) : [])];
}

/** Only the known trailing tool notice is separated; arbitrary bracketed output stays output. */
export function splitNotice(text: string): { body: string; notice: string } {
  const match = text.match(/(?:^|\n\n)(\[(?:Showing (?:lines |last )|Line \d+ is |\d+ more lines in file\.|\d+ (?:results|matches|entries) limit reached|[\d.]+[KMG]?B limit reached|Some lines truncated to )[^\n]*\])$/);
  if (!match) return { body: text, notice: "" };
  return { body: text.slice(0, match.index), notice: match[1]! };
}
