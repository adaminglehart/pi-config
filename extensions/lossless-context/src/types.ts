/**
 * Core type definitions for the Lossless Context Management system.
 * Ported from lossless-claw with strong typing throughout.
 */

// Summary types
export type SummaryKind = "leaf" | "condensed";

// Database record types
export interface ConversationRecord {
  id: string;
  session_key: string;
  created_at: string;
  updated_at: string;
  active: number; // SQLite boolean (0 or 1)
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  seq: number;
  role: string; // 'user' | 'assistant' | 'tool'
  content: string; // JSON string
  token_count: number;
  identity_hash: string | null;
  created_at: string;
}

export interface SummaryRecord {
  id: string;
  conversation_id: string;
  kind: SummaryKind;
  depth: number;
  content: string;
  token_count: number;
  metadata: string; // JSON string
  created_at: string;
}

export interface ContextItemRecord {
  id: string;
  conversation_id: string;
  ordinal: number;
  item_type: "message" | "summary";
  message_id: string | null;
  summary_id: string | null;
}

export interface SummaryParentRecord {
  summary_id: string;
  parent_summary_id: string;
}

export interface SummaryMessageRecord {
  summary_id: string;
  message_id: string;
}

export interface LargeFileRecord {
  id: string;
  conversation_id: string;
  message_id: string | null;
  file_path: string | null;
  storage_path: string;
  token_count: number;
  summary: string | null;
  created_at: string;
}

// Configuration
export interface LcmConfig extends Record<string, unknown> {
  // Context assembly
  contextThreshold: number;
  freshTailCount: number;
  freshTailMaxTokens: number;

  // Compaction fanout
  leafMinFanout: number;
  condensedMinFanout: number;
  condensedMinFanoutHard: number;
  incrementalMaxDepth: number;

  // Token targets
  leafChunkTokens: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  maxExpandTokens: number;
  largeFileTokenThreshold: number;

  // Model config
  summaryProvider: string;
  summaryModel: string;
  expansionProvider: string;
  expansionModel: string;

  // Database
  dbPath: string;

  // Feature flags
  enabled: boolean;
  summaryTimeoutMs: number;
}

// Metadata types
export interface SummaryMetadata {
  file_ids?: string[];
  aggressive?: boolean;
  [key: string]: unknown;
}

// Tool input/output types (for Phase 5)
export interface GrepInput {
  query: string;
  mode: "regex" | "full_text";
  scope: "messages" | "summaries" | "both";
  since?: string;
  limit?: number;
}

export interface GrepResult {
  messages: Array<{
    id: string;
    seq: number;
    role: string;
    snippet: string;
    token_count: number;
    created_at: string;
  }>;
  summaries: Array<{
    id: string;
    kind: SummaryKind;
    depth: number;
    snippet: string;
    token_count: number;
    created_at: string;
  }>;
}

export interface DescribeInput {
  id: string;
}

export interface DescribeResult {
  type: "summary" | "file";
  id: string;
  content?: string;
  metadata?: SummaryMetadata;
  parents?: Array<{ id: string; kind: SummaryKind }>;
  children?: Array<{ id: string; kind: SummaryKind }>;
  source_messages?: Array<{ id: string; seq: number }>;
  file_path?: string;
  storage_path?: string;
  token_count: number;
}

export interface ExpandInput {
  summary_id: string;
  depth?: number;
  include_messages?: boolean;
}

export interface ExpandResult {
  summaries: SummaryRecord[];
  messages?: MessageRecord[];
  total_tokens: number;
}

export interface ExpandQueryInput {
  query: string;
  summary_id?: string;
  max_tokens?: number;
}
