/**
 * Whether this pi instance is running as a subagent (spawned by pi-subagents).
 */
export function isSubagent(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}
