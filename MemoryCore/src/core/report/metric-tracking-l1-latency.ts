/**
 * L1 Latency Metric Reporter — L1 extraction phase latency metric reporting.
 *
 * Non-intrusively reports the following metrics to Kafka after L1 extraction is completed:
 *   - l1_extraction_latency_ms : L1 extraction end-to-end total latency (milliseconds)
 *   - l1_dedup_latency_ms     : deduplication phase latency (milliseconds)
 *
 * Design principles (isomorphic with metric-tracking-recall):
 *   1. After extraction is completed, try-catch to report (fail silently)
 *   2. Regardless of report success or failure, extraction results are unaffected
 *   3. Do not report when extraction fails (hasError=true)
 *   4. Do not report when there is no instanceId
 *   5. dedupLatencyMs being null means deduplication path was not taken, dedup metric is not reported
 */

import { metricProducer } from "./kafka-metric-producer.js";

// ============================
// Input Interface
// ============================

export interface L1LatencyMetricInput {
  /** Instance ID (Kafka key) */
  instanceId: string;
  /** L1 extraction end-to-end total latency (milliseconds) */
  extractionLatencyMs: number;
  /** Deduplication phase latency (milliseconds). null means deduplication path was not taken */
  dedupLatencyMs: number | null;
  /** Whether extraction failed */
  hasError: boolean;
}

// ============================
// Reporter
// ============================

/**
 * Report L1 extraction phase latency metrics to Kafka.
 *
 * Silently safe: any exceptions are try-catched and swallowed, never thrown outwards.
 */
export function reportL1LatencyMetrics(input: L1LatencyMetricInput): void {
  try {
    // Guard: Do not report on failure
    if (input.hasError) return;

    // Guard: Do not report without instanceId
    if (!input.instanceId) return;

    // 1. Report l1_extraction_latency_ms
    try {
      metricProducer.send({
        metric: "l1_extraction_latency_ms",
        instanceId: input.instanceId,
        value: Math.round(input.extractionLatencyMs),
        source: "core",
      });
    } catch {
      // Fail silently
    }

    // 2. Report l1_dedup_latency_ms (only when deduplication path was taken)
    if (input.dedupLatencyMs !== null) {
      try {
        metricProducer.send({
          metric: "l1_dedup_latency_ms",
          instanceId: input.instanceId,
          value: Math.round(input.dedupLatencyMs),
          source: "core",
        });
      } catch {
        // Fail silently
      }
    }
  } catch {
    // Outermost catch — never throw outwards
  }
}
