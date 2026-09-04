/**
 * Recall Metric Reporter — Recall phase metric reporting.
 *
 * Non-intrusively reports the following metrics to Kafka after recall is completed:
 *   - recall_hit_count   : Number of L1 memory items hit in this recall
 *   - recall_top_score   : Highest similarity score in recall results (TCVDB RRF score)
 *   - recall_latency_ms  : Total recall latency (milliseconds, integer)
 *
 * Design principles (isomorphic with MetricTrackingRunner):
 *   1. After recall is completed, try-catch to report (fail silently)
 *   2. Regardless of report success or failure, recall results are unaffected
 *   3. Do not report when recall fails (hasError=true)
 *   4. Do not report when there is no instanceId
 *   5. Still report hit_count=0 + latency when 0 items recalled, but do not report top_score
 */

import { metricProducer } from "./kafka-metric-producer.js";

// ============================
// Strategy Encoding (numeric for ClickHouse storage)
// ============================

const STRATEGY_CODE: Record<string, number> = {
  skipped: 0,
  keyword: 1,
  embedding: 2,
  hybrid: 3,
};

// ============================
// Input Interface
// ============================

export interface RecallMetricInput {
  /** Instance ID (Kafka key) */
  instanceId: string;
  /** Recalled L1 memory list (with score) */
  recalledL1Memories: Array<{ content: string; score: number; type: string }> | undefined;
  /** Effective recall strategy */
  recallStrategy: string;
  /** Total recall latency (milliseconds) */
  recallLatencyMs: number;
  /** Whether recall failed */
  hasError: boolean;
}

// ============================
// Reporter
// ============================

/**
 * Report recall phase metrics to Kafka.
 *
 * Silently safe: any exceptions are try-catched and swallowed, never thrown outwards.
 * Call timing: called after performAutoRecallCore returns, before passing results to business logic.
 */
export function reportRecallMetrics(input: RecallMetricInput): void {
  try {
    // Guard: Do not report on failure
    if (input.hasError) return;

    // Guard: Do not report without instanceId
    if (!input.instanceId) return;

    const memories = input.recalledL1Memories ?? [];
    const hitCount = memories.length;
    const latencyMs = Math.round(input.recallLatencyMs);

    // 1. Report recall_hit_count (including 0 items scenarios)
    try {
      metricProducer.send({
        metric: "recall_hit_count",
        instanceId: input.instanceId,
        value: hitCount,
        source: "core",
      });
    } catch {
      // Fail silently
    }

    // 2. Report recall_top_score (only when there are memories)
    if (hitCount > 0) {
      try {
        const topScore = Math.max(...memories.map((m) => m.score));
        metricProducer.send({
          metric: "recall_top_score",
          instanceId: input.instanceId,
          value: topScore,
          source: "core",
        });
      } catch {
        // Fail silently
      }
    }

    // 3. Report recall_latency_ms
    try {
      metricProducer.send({
        metric: "recall_latency_ms",
        instanceId: input.instanceId,
        value: latencyMs,
        source: "core",
      });
    } catch {
      // Fail silently
    }

    // 4. Report recall_strategy (numeric encoding: skipped=0, keyword=1, embedding=2, hybrid=3, unknown=-1)
    try {
      const strategyCode = STRATEGY_CODE[input.recallStrategy] ?? -1;
      metricProducer.send({
        metric: "recall_strategy",
        instanceId: input.instanceId,
        value: strategyCode,
        source: "core",
      });
    } catch {
      // Fail silently
    }
  } catch {
    // Outermost catch — never throw outwards
  }
}
