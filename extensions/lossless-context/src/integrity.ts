/**
 * DAG integrity checking and repair for LCM.
 * Detects broken links, orphaned summaries, and inconsistencies in the summary DAG.
 */

import type { DatabaseSync } from "node:sqlite";

export interface IntegrityIssue {
  type:
    | "orphaned_summary"
    | "broken_parent_link"
    | "broken_message_link"
    | "missing_context_ref"
    | "depth_inconsistency";
  description: string;
  id: string;
  severity: "warning" | "error";
}

export interface IntegrityReport {
  issues: IntegrityIssue[];
  stats: {
    conversations: number;
    messages: number;
    summaries: number;
    contextItems: number;
    largeFiles: number;
  };
  healthy: boolean;
}

export class IntegrityChecker {
  constructor(private db: DatabaseSync) {}

  /**
   * Run all integrity checks and return a report.
   */
  check(): IntegrityReport {
    const issues: IntegrityIssue[] = [];

    // Gather stats
    const stats = this.gatherStats();

    // Check for orphaned summaries (no context_item reference and no parent)
    issues.push(...this.checkOrphanedSummaries());

    // Check for broken parent links
    issues.push(...this.checkBrokenParentLinks());

    // Check for broken message links
    issues.push(...this.checkBrokenMessageLinks());

    // Check context items pointing to missing records
    issues.push(...this.checkMissingContextRefs());

    // Check summary depth consistency
    issues.push(...this.checkDepthConsistency());

    return {
      issues,
      stats,
      healthy: issues.filter((i) => i.severity === "error").length === 0,
    };
  }

  /**
   * Repair identified issues. Returns count of fixes applied.
   */
  repair(): number {
    let fixes = 0;
    this.db.exec("BEGIN");
    try {
      // Remove context items pointing to missing records
      const missingRefs = this.checkMissingContextRefs();
      for (const issue of missingRefs) {
        this.db.prepare("DELETE FROM context_items WHERE id = ?").run(issue.id);
        fixes++;
      }

      // Remove broken parent links
      const brokenParents = this.checkBrokenParentLinks();
      for (const issue of brokenParents) {
        // issue.id is "summary_id:parent_id"
        const [summaryId, parentId] = issue.id.split(":");
        this.db
          .prepare(
            "DELETE FROM summary_parents WHERE summary_id = ? AND parent_summary_id = ?",
          )
          .run(summaryId, parentId);
        fixes++;
      }

      // Remove broken message links
      const brokenMessages = this.checkBrokenMessageLinks();
      for (const issue of brokenMessages) {
        const [summaryId, messageId] = issue.id.split(":");
        this.db
          .prepare(
            "DELETE FROM summary_messages WHERE summary_id = ? AND message_id = ?",
          )
          .run(summaryId, messageId);
        fixes++;
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return fixes;
  }

  private gatherStats(): IntegrityReport["stats"] {
    const conversations =
      (this.db.prepare("SELECT COUNT(*) as c FROM conversations").get() as {
        c: number;
      })?.c ?? 0;
    const messages =
      (this.db.prepare("SELECT COUNT(*) as c FROM messages").get() as {
        c: number;
      })?.c ?? 0;
    const summaries =
      (this.db.prepare("SELECT COUNT(*) as c FROM summaries").get() as {
        c: number;
      })?.c ?? 0;
    const contextItems =
      (this.db.prepare("SELECT COUNT(*) as c FROM context_items").get() as {
        c: number;
      })?.c ?? 0;
    const largeFiles =
      (this.db.prepare("SELECT COUNT(*) as c FROM large_files").get() as {
        c: number;
      })?.c ?? 0;
    return { conversations, messages, summaries, contextItems, largeFiles };
  }

  private checkOrphanedSummaries(): IntegrityIssue[] {
    const orphans = this.db
      .prepare(
        `
      SELECT s.id FROM summaries s
      WHERE s.id NOT IN (SELECT summary_id FROM context_items WHERE summary_id IS NOT NULL)
        AND s.id NOT IN (SELECT parent_summary_id FROM summary_parents)
    `,
      )
      .all() as Array<{ id: string }>;

    return orphans.map((o) => ({
      type: "orphaned_summary" as const,
      description: `Summary ${o.id} has no context_item reference and is not a parent of any other summary`,
      id: o.id,
      severity: "warning" as const,
    }));
  }

  private checkBrokenParentLinks(): IntegrityIssue[] {
    const broken = this.db
      .prepare(
        `
      SELECT sp.summary_id, sp.parent_summary_id
      FROM summary_parents sp
      WHERE sp.parent_summary_id NOT IN (SELECT id FROM summaries)
    `,
      )
      .all() as Array<{ summary_id: string; parent_summary_id: string }>;

    return broken.map((b) => ({
      type: "broken_parent_link" as const,
      description: `Summary ${b.summary_id} references missing parent ${b.parent_summary_id}`,
      id: `${b.summary_id}:${b.parent_summary_id}`,
      severity: "error" as const,
    }));
  }

  private checkBrokenMessageLinks(): IntegrityIssue[] {
    const broken = this.db
      .prepare(
        `
      SELECT sm.summary_id, sm.message_id
      FROM summary_messages sm
      WHERE sm.message_id NOT IN (SELECT id FROM messages)
    `,
      )
      .all() as Array<{ summary_id: string; message_id: string }>;

    return broken.map((b) => ({
      type: "broken_message_link" as const,
      description: `Summary ${b.summary_id} references missing message ${b.message_id}`,
      id: `${b.summary_id}:${b.message_id}`,
      severity: "error" as const,
    }));
  }

  private checkMissingContextRefs(): IntegrityIssue[] {
    const issues: IntegrityIssue[] = [];

    // Check message refs
    const missingMsgs = this.db
      .prepare(
        `
      SELECT ci.id, ci.message_id FROM context_items ci
      WHERE ci.item_type = 'message' AND ci.message_id IS NOT NULL
        AND ci.message_id NOT IN (SELECT id FROM messages)
    `,
      )
      .all() as Array<{ id: string; message_id: string }>;

    for (const m of missingMsgs) {
      issues.push({
        type: "missing_context_ref",
        description: `Context item ${m.id} references missing message ${m.message_id}`,
        id: m.id,
        severity: "error",
      });
    }

    // Check summary refs
    const missingSums = this.db
      .prepare(
        `
      SELECT ci.id, ci.summary_id FROM context_items ci
      WHERE ci.item_type = 'summary' AND ci.summary_id IS NOT NULL
        AND ci.summary_id NOT IN (SELECT id FROM summaries)
    `,
      )
      .all() as Array<{ id: string; summary_id: string }>;

    for (const s of missingSums) {
      issues.push({
        type: "missing_context_ref",
        description: `Context item ${s.id} references missing summary ${s.summary_id}`,
        id: s.id,
        severity: "error",
      });
    }

    return issues;
  }

  private checkDepthConsistency(): IntegrityIssue[] {
    // Check: condensed summaries at depth N should only have parents at depth N-1
    const inconsistent = this.db
      .prepare(
        `
      SELECT s.id, s.depth as summary_depth, p.depth as parent_depth
      FROM summaries s
      JOIN summary_parents sp ON sp.summary_id = s.id
      JOIN summaries p ON sp.parent_summary_id = p.id
      WHERE s.kind = 'condensed' AND p.depth != s.depth - 1
    `,
      )
      .all() as Array<{
      id: string;
      summary_depth: number;
      parent_depth: number;
    }>;

    return inconsistent.map((i) => ({
      type: "depth_inconsistency" as const,
      description: `Condensed summary ${i.id} at depth ${i.summary_depth} has parent at depth ${i.parent_depth} (expected ${i.summary_depth - 1})`,
      id: i.id,
      severity: "warning" as const,
    }));
  }
}
