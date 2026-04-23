/**
 * Configuration resolution for LCM.
 * Reads settings from Pi's settings.json under the 'lcm' namespace.
 */

import { getNamespacedConfig } from "../../_lib/settings.js";
import type { LcmConfig } from "./types.js";

/**
 * Load LCM configuration from Pi settings with defaults matching lossless-claw.
 */
export function loadLcmConfig(): LcmConfig {
  return getNamespacedConfig<LcmConfig>("lcm", {
    // Context assembly
    contextThreshold: 0.75,
    freshTailCount: 64,
    freshTailMaxTokens: 40000,

    // Compaction fanout
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 1,

    // Token targets
    leafChunkTokens: 20000,
    leafTargetTokens: 2400,
    condensedTargetTokens: 2000,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25000,

    // Model config
    summaryProvider: "openrouter",
    summaryModel: "google/gemini-3-flash-preview",
    expansionProvider: "", // Uses summary provider/model if empty
    expansionModel: "", // Uses summary provider/model if empty

    // Database
    dbPath: "~/.pi/lcm.db",

    // Feature flags
    enabled: true,
    summaryTimeoutMs: 60000,
  });
}
