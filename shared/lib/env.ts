/**
 * Whether this pi instance is running as a subagent (spawned by another pi session).
 */
export function isSubagent(): boolean {
  return !!process.env.PI_SUBAGENT_NAME;
}
