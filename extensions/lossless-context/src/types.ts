import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type SummaryKind = "leaf" | "condensed";
export type CanonicalSessionEntryType = "message" | "custom_message";

export interface ConversationRecord {
  id: string;
  session_key: string;
  created_at: string;
  updated_at: string;
  active: number;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  seq: number;
  session_entry_id: string | null;
  session_parent_entry_id: string | null;
  session_entry_type: CanonicalSessionEntryType | null;
  role: string;
  canonical_json: string | null;
  search_text: string;
  token_count: number;
  /** Retained only as unindexed v1 metadata. Canonical inserts set null. */
  identity_hash: string | null;
  created_at: string;
}

export type DecodedStoredMessage =
  | {
      kind: "canonical";
      record: MessageRecord;
      message: AgentMessage;
    }
  | {
      kind: "legacy";
      record: MessageRecord;
      message: AgentMessage;
      originalRole: string;
    };

export interface SummaryRecord {
  id: string;
  conversation_id: string;
  kind: SummaryKind;
  depth: number;
  content: string;
  token_count: number;
  metadata: string;
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

export interface LcmConfig extends Record<string, unknown> {
  contextThreshold: number;
  freshTailCount: number;
  freshTailMaxTokens: number;
  softTokenThreshold: number;
  hardTokenThreshold: number;
  backgroundCompaction: boolean;
  leafMinFanout: number;
  condensedMinFanout: number;
  condensedMinFanoutHard: number;
  incrementalMaxDepth: number;
  leafChunkTokens: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  maxExpandTokens: number;
  largeFileTokenThreshold: number;
  summaryProvider: string;
  summaryModel: string;
  expansionProvider: string;
  expansionModel: string;
  dbPath: string;
  enabled: boolean;
  summaryTimeoutMs: number;
}

export interface SummaryMetadata {
  file_ids?: string[];
  aggressive?: boolean;
  [key: string]: unknown;
}

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
