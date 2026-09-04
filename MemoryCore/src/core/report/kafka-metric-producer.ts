/**
 * Kafka Metric Producer — Core component (facade layer)
 *
 * Asynchronously sends monitoring metric messages, processed by IMetricBackend.
 * Internal environment: Kafka → memory-monitor consumes and aggregates before reporting to Barad + ClickHouse.
 * Open-source environment: Noop or Console output.
 *
 * Design highlights:
 *   - Asynchronous sending, non-blocking for business requests
 *   - Silent failure handling (no retries, no blocking)
 *   - No modification to business code, pure observability component
 *
 * Usage:
 *   import { metricProducer } from "../core/report/kafka-metric-producer.js";
 *   metricProducer.send({ metric: "l1_extraction_credit_rate", instanceId: "mem-abc", value: 150 });
 *
 * Public API signature remains unchanged, callers require no changes.
 */

import { getObservabilityBackend } from "./factory.js";
import type { MetricMessage, MetricBackendConfig } from "./types.js";

// Re-export types (backward compatibility)
export type { MetricMessage } from "./types.js";
export type KafkaMetricConfig = MetricBackendConfig;

// ============================
// CRC32 Partition calculation (retained export for private modules)
// ============================

import CRC32 from "crc-32";

/**
 * Calculate Partition number using CRC32 IEEE.
 * Consistent with Go end `crc32.ChecksumIEEE([]byte(instanceId)) % totalPartitions`.
 *
 * Note: crc-32 npm package returns signed 32-bit integer, needs conversion to unsigned.
 */
export function calculatePartition(instanceId: string, totalPartitions: number): number {
  if (totalPartitions <= 0) return 0;
  // crc-32 returns signed int32, convert to unsigned uint32
  const checksum = CRC32.str(instanceId) >>> 0;
  return checksum % totalPartitions;
}

// ============================
// Metric Producer Facade
// ============================

/**
 * Metric Producer Facade.
 *
 * Maintains same public API as original KafkaMetricProducer:
 * - send(msg) — Send a metric message
 * - initialize(config) — Initialize backend
 * - destroy() — Graceful shutdown
 *
 * Internally delegates to IMetricBackend (obtained via global singleton).
 */
class MetricProducerFacade {
  /**
   * Asynchronously send a monitoring message.
   * If backend is uninitialized or closed, silently ignore.
   *
   * Auto-inject traceId: extract traceId from current OTel active span,
   * inject into MetricMessage (only when caller did not pass one manually).
   * On injection failure, silently degrade to empty string without affecting metric sending.
   */
  send(msg: MetricMessage): void {
    try {
      // Auto-inject traceId (do not overwrite if caller passed manually)
      if (msg.traceId === undefined) {
        try {
          const ctx = getObservabilityBackend().tracePropagation.serializeTraceContext();
          msg = { ...msg, traceId: (ctx as Record<string, unknown>)._traceId as string ?? "" };
        } catch {
          msg = { ...msg, traceId: "" };
        }
      }
      getObservabilityBackend().metric.send(msg);
    } catch {
      // Silent failure
    }
  }

  /**
   * Initialize Metric backend.
   * Actual initialization is completed uniformly by initObservabilityBackend(),
   * this method is retained for backward compatibility.
   */
  async initialize(config: MetricBackendConfig): Promise<void> {
    try {
      await getObservabilityBackend().metric.initialize(config);
    } catch {
      // Silent failure
    }
  }

  /**
   * Graceful shutdown.
   */
  async destroy(): Promise<void> {
    try {
      await getObservabilityBackend().metric.destroy();
    } catch {
      // Silent failure
    }
  }
}

/** Global singleton */
export const metricProducer = new MetricProducerFacade();