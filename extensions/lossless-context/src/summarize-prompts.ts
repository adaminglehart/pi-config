/**
 * Depth-aware summarization prompt templates for LCM.
 */

/**
 * System prompt for all summarization LLM calls.
 */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context-compaction engine for a coding agent session. Your job is to create concise summaries that preserve what a fresh model instance needs to continue the conversation effectively. Return plain text summary content only. No preamble.`;

/**
 * Build a leaf summary prompt for raw messages.
 * Leaf summaries preserve key facts, decisions, and technical details.
 */
export function buildLeafSummaryPrompt(
  serializedMessages: string,
  targetTokens: number,
  aggressive: boolean = false,
): string {
  const policy = aggressive
    ? [
        "Aggressive mode: keep only durable facts and current task state.",
        "Remove examples, repetition, and low-value narrative.",
      ].join("\n")
    : [
        "Normal mode: preserve decisions, rationale, constraints, and active tasks.",
        "Keep technical details needed to continue work safely.",
      ].join("\n");

  return [
    "Summarize this SEGMENT of a coding conversation for future model turns.",
    "",
    policy,
    "",
    "Preserve (highest priority):",
    "- Decisions made AND their outcomes (not just what was attempted — what worked/didn't).",
    "- Bug fixes: what the bug was, root cause, and the fix applied.",
    "- Configuration changes: what was changed, where, and why.",
    "- Code changes: files modified, what changed, and the reasoning.",
    "- Names, paths, commands, error messages.",
    "- Active problems and their CURRENT status (resolved vs still open).",
    "",
    "Drop:",
    "- Conversational filler and pleasantries.",
    "- Verbose tool output (keep only key findings).",
    "- Files that were merely read but not meaningfully discussed.",
    "- Redundant explanations and repeated attempts at the same fix.",
    "",
    "Format:",
    "- Start with a 1-2 sentence overview of the segment's main topic.",
    "- Use structured sections: Key Decisions & Rationale, Active Problems, File Operations.",
    "- Mark resolved problems as resolved; only list truly open issues as active.",
    "- For file operations, only list files that were created, modified, or deleted — not files that were just read.",
    "- Do NOT include an 'Expand for details' footer.",
    `- Target length: about ${targetTokens} tokens or less.`,
    "",
    "<conversation_segment>",
    serializedMessages,
    "</conversation_segment>",
  ].join("\n");
}

/**
 * Build a condensed summary prompt for summarizing other summaries.
 * Depth determines abstraction level.
 */
export function buildCondensedSummaryPrompt(
  serializedSummaries: string,
  depth: number,
  targetTokens: number,
): string {
  if (depth === 1) {
    return buildD1Prompt(serializedSummaries, targetTokens);
  } else if (depth === 2) {
    return buildD2Prompt(serializedSummaries, targetTokens);
  } else {
    return buildD3PlusPrompt(serializedSummaries, targetTokens);
  }
}

/**
 * Depth 1: Condensing leaf summaries into session-level summary.
 */
function buildD1Prompt(serializedSummaries: string, targetTokens: number): string {
  return [
    "Condense these leaf-level summaries into a single session-level memory node.",
    "A fresh model instance will use this to understand what happened and continue the work.",
    "",
    "Preserve:",
    "- Decisions made, their rationale, and outcomes.",
    "- Superseded decisions: what changed and what replaced them.",
    "- Completed tasks with outcomes.",
    "- In-progress items with current state and what remains.",
    "- Bugs found and fixed: root cause and fix applied.",
    "- Configuration and architectural changes.",
    "- Blockers, open questions, and unresolved tensions.",
    "- Specific references (names, paths, URLs) needed for continuation.",
    "",
    "Drop:",
    "- Intermediate dead ends where the conclusion is already known.",
    "- Transient states that are already resolved.",
    "- Tool-internal mechanics and process scaffolding.",
    "- 'Expand for details' footers from input summaries.",
    "",
    "Use plain text. No mandatory structure, but chronological order is preferred.",
    "Do NOT include an 'Expand for details' footer.",
    `Target length: about ${targetTokens} tokens.`,
    "",
    "<conversation_to_condense>",
    serializedSummaries,
    "</conversation_to_condense>",
  ].join("\n");
}

/**
 * Depth 2: Condensing session-level summaries into phase-level summary.
 */
function buildD2Prompt(serializedSummaries: string, targetTokens: number): string {
  return [
    "Condense multiple session-level summaries into a higher-level memory node.",
    "A future model should understand trajectory, not per-session minutiae.",
    "",
    "Preserve:",
    "- Decisions still in effect and their rationale.",
    "- Decisions that evolved: what changed and why.",
    "- Completed work with outcomes.",
    "- Active constraints, limitations, and known issues.",
    "- Current state of in-progress work.",
    "",
    "Drop:",
    "- Session-local operational detail and process mechanics.",
    "- Identifiers that are no longer relevant.",
    "- Intermediate states superseded by later outcomes.",
    "",
    "Use plain text. Brief headers are fine if useful.",
    "Do NOT include an 'Expand for details' footer.",
    `Target length: about ${targetTokens} tokens.`,
    "",
    "<conversation_to_condense>",
    serializedSummaries,
    "</conversation_to_condense>",
  ].join("\n");
}

/**
 * Depth 3+: Condensing phase-level summaries into project-level summary.
 */
function buildD3PlusPrompt(serializedSummaries: string, targetTokens: number): string {
  return [
    "Create a high-level memory node from multiple phase-level summaries.",
    "This may persist for the rest of the conversation. Keep only durable context.",
    "",
    "Preserve:",
    "- Key decisions and rationale.",
    "- What was accomplished and current state.",
    "- Active constraints and hard limitations.",
    "- Important relationships between people, systems, or concepts.",
    "",
    "Drop:",
    "- Operational and process detail.",
    "- Method details unless the method itself was the decision.",
    "- Specific references unless essential for continuation.",
    "",
    "Use plain text. Be concise.",
    "Do NOT include an 'Expand for details' footer.",
    `Target length: about ${targetTokens} tokens.`,
    "",
    "<conversation_to_condense>",
    serializedSummaries,
    "</conversation_to_condense>",
  ].join("\n");
}
