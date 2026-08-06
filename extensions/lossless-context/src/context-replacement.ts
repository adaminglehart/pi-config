import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssembledContext } from "./assembler.js";
import type { SynchronizationResult } from "./session-message-synchronizer.js";

export interface ContextReplacement {
  messages: AgentMessage[];
}

/**
 * Return a context override only after synchronization and provider-sequence
 * validation have both succeeded. Undefined means Pi must keep native context.
 */
export function decideContextReplacement(
  synchronization: SynchronizationResult | undefined,
  assembled: AssembledContext | undefined,
): ContextReplacement | undefined {
  if (!synchronization?.safeForContextReplacement) return undefined;
  if (!assembled?.valid || assembled.messages.length === 0) return undefined;
  return { messages: assembled.messages };
}
