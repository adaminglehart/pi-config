const COMPACT_UNITS = [
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "k"],
] as const;

/** Format a count as 999, 1.2k, 12k, 1.2M, 12M, 1.2B. */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  for (const [size, suffix] of COMPACT_UNITS) {
    if (Math.abs(value) < size) continue;
    const scaled = value / size;
    const digits =
      Math.abs(scaled) < 10
        ? scaled.toFixed(1).replace(/\.0$/, "")
        : String(Math.round(scaled));
    return `${digits}${suffix}`;
  }
  return String(Math.round(value));
}

/** Format a US dollar amount. Small amounts get more decimal places. */
export function formatUsd(cost: number): string {
  if (!Number.isFinite(cost)) return "$0.00";
  if (cost === 0 || cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}
