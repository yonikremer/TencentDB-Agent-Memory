/**
 * MetricTrackingRunner / MetricTrackingRunnerFactory — LLMRunner decorator,
 * which non-intrusively reports credit consumption to Kafka after an LLM call completes.
 *
 * Design Principles (Isomorphic to MetricTrackingStore):
 *   1. Execute the original method first and capture the result.
 *   2. On success, report metrics via try-catch (silent failure).
 *   3. Always return the original result, regardless of report success/failure.
 *   4. Re-throw exceptions from the original method; do not report in case of failure.
 *   5. Maintain the original LLMRunner / LLMRunnerFactory interface signatures.
 *
 * taskId to Metric Name Mapping:
 *   - "l1-extraction"        → "l1_extraction_credit_rate"
 *   - "l1-conflict-detection" → "l1_dedup_credit_rate"
 *   - "scene-extract-*"      → "l2_extraction_credit_rate"
 *   - "persona-generation"   → "l3_generation_credit_rate"
 *
 * Token Usage Acquisition Strategy:
 *   - Prioritize precise values from the inner runner's lastUsage side-channel (distinguishing input/output).
 *   - If unavailable (e.g., OpenClaw path), estimate based on character length.
 *
 * Credit Calculation (Performed on the Producer side; Consumer calculates rate by ÷ window period):
 *   Formula: Credit = (input_tokens/10000 × INPUT_RATE + output_tokens/10000 × OUTPUT_RATE) × multiplier
 *   1 Credit = 10,000 standard Input Tokens (anchored to M2.7).
 *   Base Rates:
 *     - INPUT_RATE  = 1.0 Credit / 10k tokens
 *     - CACHE_RATE  = 0.2 Credit / 10k tokens (no distinction yet, treated as input)
 *     - OUTPUT_RATE = 4.0 Credit / 10k tokens
 *   Model Multiplier: M2.7 = 1.0, Flagship = 15.0, Speed-optimized = 0.8 (defaults to 1.0).
 *   Fallback Strategy: If input/output cannot be distinguished, estimate conservatively using the input rate (1.0).
 */

import type {
  LLMRunner,
  LLMRunParams,
  LLMRunnerFactory,
  LLMRunnerCreateOptions,
} from "../types.js";
import { metricProducer } from "./kafka-metric-producer.js";

// ============================
// taskId → Metric Name Mapping
// ============================

/** Token usage information for LLM Runner (side-channel) */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** LLMRunner with optional lastUsage side-channel */
export interface LLMRunnerWithUsage extends LLMRunner {
  lastUsage?: LLMUsage;
}

/**
 * Maps taskId to Kafka metric name.
 * Returns undefined if the taskId does not require credit reporting.
 */
export function taskIdToMetricName(taskId: string): string | undefined {
  if (taskId === "l1-extraction") return "l1_extraction_credit_rate";
  if (taskId === "l1-conflict-detection") return "l1_dedup_credit_rate";
  if (taskId.startsWith("scene-extract")) return "l2_extraction_credit_rate";
  if (taskId === "persona-generation") return "l3_generation_credit_rate";
  return undefined;
}

/**
 * Maps taskId to evaluation token metric prefix.
 * Returns undefined if the taskId does not require per-stage token reporting.
 *
 * Example metric names:
 *   l1_extraction_input_tokens / l1_extraction_output_tokens
 *   l1_dedup_input_tokens / l1_dedup_output_tokens
 *   l2_extraction_input_tokens / l2_extraction_output_tokens
 *   l3_generation_input_tokens / l3_generation_output_tokens
 */
export function taskIdToTokenMetricPrefix(taskId: string): string | undefined {
  if (taskId === "l1-extraction") return "l1_extraction";
  if (taskId === "l1-conflict-detection") return "l1_dedup";
  if (taskId.startsWith("scene-extract")) return "l2_extraction";
  if (taskId === "persona-generation") return "l3_generation";
  return undefined;
}

// ============================
// Credit Calculation Constants and Functions
// ============================

/** Token base unit for 1 Credit (10000 tokens = 1 Credit) */
export const TOKENS_PER_CREDIT = 10000;
/** Base rate: Standard input 1.0 Credit / 10k tokens (M2.7 anchor) */
export const INPUT_RATE = 1.0;
/** Base rate: Cached input 0.2 Credit / 10k tokens (treated as input) */
export const CACHE_RATE = 0.2;
/** Base rate: Model output 4.0 Credit / 10k tokens */
export const OUTPUT_RATE = 4.0;
/** Default model multiplier (M2.7 Standard) */
export const DEFAULT_MULTIPLIER = 1.0;

/**
 * Rounds Credit values to 5 decimal places.
 * Used consistently across all reporting to ensure precision consistency.
 */
export function roundCredit(value: number): number {
  return Math.round(value * 100000) / 100000;
}

/**
 * Maps taskId to memory level (for usage reporting).
 * Returns undefined if not reportable.
 */
export function taskIdToLevel(taskId: string): "L1" | "L2" | "L3" | undefined {
  if (taskId === "l1-extraction" || taskId === "l1-conflict-detection") return "L1";
  if (taskId.startsWith("scene-extract")) return "L2";
  if (taskId === "persona-generation") return "L3";
  return undefined;
}

/** onCreditConsumed callback parameters */
export interface CreditConsumedEvent {
  instanceId: string;
  credit: number;
  level: "L1" | "L2" | "L3";
  taskId: string;
}

/** onCreditConsumed callback type */
export type OnCreditConsumed = (event: CreditConsumedEvent) => void;

/**
 * Computes Credit based on precise input/output token counts.
 * Formula: Credit = (input/10000 × INPUT_RATE + output/10000 × OUTPUT_RATE) × multiplier
 */
export function computeCredit(
  inputTokens: number,
  outputTokens: number,
  multiplier: number = DEFAULT_MULTIPLIER,
): number {
  return ((inputTokens / TOKENS_PER_CREDIT) * INPUT_RATE + (outputTokens / TOKENS_PER_CREDIT) * OUTPUT_RATE) * multiplier;
}

/**
 * Estimates Credit from character length.
 * English ~4 chars/token, Chinese ~2 chars/token; using 3 chars/token as a heuristic.
 *
 * Fallback Strategy: If unable to distinguish input/output, estimate using the input rate (1.0).
 */
export function estimateCreditFromChars(
  inputCharLength: number,
  outputCharLength: number,
  multiplier: number = DEFAULT_MULTIPLIER,
): number {
  const estimatedTokens = Math.ceil((inputCharLength + outputCharLength) / 3);
  return (estimatedTokens / TOKENS_PER_CREDIT) * INPUT_RATE * multiplier;
}

// ============================
// MetricTrackingRunner (Decorator)
// ============================

/**
 * Wraps LLMRunner to asynchronously report credit consumption to Kafka after run() completes.
 *
 * Reported value is the Credit value. Consumer side calculates rate by dividing by the window.
 *
 * Guarantees:
 *   - Reporting failures are ignored and do not affect run() returns.
 *   - Exceptions in the original method halt reporting and propagate normally.
 *   - Does not modify run() signature or return type.
 */
export class MetricTrackingRunner implements LLMRunner {
  private readonly inner: LLMRunner;
  private readonly getInstanceId: () => string | undefined;
  private readonly multiplier: number;
  private readonly onCreditConsumed?: OnCreditConsumed;

  /** Accumulated credit consumed across all run() calls on this runner instance. */
  accumulatedCredit = 0;

  constructor(
    inner: LLMRunner,
    getInstanceId: () => string | undefined,
    multiplier: number = DEFAULT_MULTIPLIER,
    onCreditConsumed?: OnCreditConsumed,
  ) {
    this.inner = inner;
    this.getInstanceId = getInstanceId;
    this.multiplier = multiplier;
    this.onCreditConsumed = onCreditConsumed;
  }

  async run(params: LLMRunParams): Promise<string> {
    const enrichedParams = params.instanceId
      ? params
      : { ...params, instanceId: this.getInstanceId() };

    const text = await this.inner.run(enrichedParams);

    try {
      const metricName = taskIdToMetricName(params.taskId);
      if (metricName) {
        const instanceId = enrichedParams.instanceId ?? this.getInstanceId();
        if (instanceId) {
          const innerWithUsage = this.inner as LLMRunnerWithUsage;
          let creditValue: number;
          let inputTokens: number;
          let outputTokens: number;

          if (innerWithUsage.lastUsage && innerWithUsage.lastUsage.totalTokens > 0) {
            inputTokens = innerWithUsage.lastUsage.promptTokens;
            outputTokens = innerWithUsage.lastUsage.completionTokens;
            creditValue = computeCredit(inputTokens, outputTokens, this.multiplier);
          } else {
            const inputChars = (params.prompt?.length ?? 0) + (params.systemPrompt?.length ?? 0);
            const outputChars = text.length;
            inputTokens = Math.ceil(inputChars / 3);
            outputTokens = Math.ceil(outputChars / 3);
            creditValue = estimateCreditFromChars(inputChars, outputChars, this.multiplier);
          }

          const roundedCredit = roundCredit(creditValue);
          this.accumulatedCredit += roundedCredit;

          if (roundedCredit > 0) {
            try {
              metricProducer.send({
                metric: metricName,
                instanceId,
                value: roundedCredit,
                source: "core",
              });
            } catch {
              // Metric send failure silently ignored
            }

            // Report usage callback (also 5 decimal places, fail silently)
            if (this.onCreditConsumed) {
              const level = taskIdToLevel(params.taskId);
              if (level) {
                try {
                  this.onCreditConsumed({
                    instanceId,
                    credit: roundedCredit,
                    level,
                    taskId: params.taskId,
                  });
                } catch {
                  // Fail silently, absolutely do not affect business
                }
              }
            }
          }

          // Report raw Token metrics (used for calculating TPM on aggregation side)
          // Only report metrics > 0, fail silently
          try {
            if (inputTokens > 0) {
              metricProducer.send({
                metric: "llm_input_tokens",
                instanceId,
                value: inputTokens,
                source: "core",
              });
            }
            if (outputTokens > 0) {
              metricProducer.send({
                metric: "llm_output_tokens",
                instanceId,
                value: outputTokens,
                source: "core",
              });
            }
          } catch {
            // Token metric report failure silently ignored, absolutely do not affect business
          }

          // Report per-stage Token metrics (for evaluation, with traceId)
          try {
            const tokenPrefix = taskIdToTokenMetricPrefix(params.taskId);
            if (tokenPrefix && inputTokens > 0) {
              metricProducer.send({
                metric: `${tokenPrefix}_input_tokens`,
                instanceId,
                value: inputTokens,
                source: "core",
              });
            }
            if (tokenPrefix && outputTokens > 0) {
              metricProducer.send({
                metric: `${tokenPrefix}_output_tokens`,
                instanceId,
                value: outputTokens,
                source: "core",
              });
            }
          } catch {
            // Fail silently
          }
        }
      }
    } catch {
      // Fail silently, absolutely do not affect business
    }

    // 3. Regardless of report success or failure, always return the original method's result
    return text;
  }
}

// ============================
// MetricTrackingRunnerFactory (Decorator)
// ============================

/**
 * Wraps LLMRunnerFactory, the created Runner comes with credit reporting capabilities.
 *
 * Injection point: wraps the factory in wirePipelineRunners() inside tdai-core.ts.
 * This is the only "modification" — it is an injection point for observability code, not a modification of business logic.
 *
 * @param multiplier Model multiplier (default 1.0 = M2.7 Standard).
 *   Can be read from config later, supporting dynamic switching of multiple models.
 */
export class MetricTrackingRunnerFactory implements LLMRunnerFactory {
  private readonly inner: LLMRunnerFactory;
  private readonly getInstanceId: () => string | undefined;
  private readonly multiplier: number;
  private readonly onCreditConsumed?: OnCreditConsumed;

  constructor(
    inner: LLMRunnerFactory,
    getInstanceId: () => string | undefined,
    multiplier: number = DEFAULT_MULTIPLIER,
    onCreditConsumed?: OnCreditConsumed,
  ) {
    this.inner = inner;
    this.getInstanceId = getInstanceId;
    this.multiplier = multiplier;
    this.onCreditConsumed = onCreditConsumed;
  }

  createRunner(opts?: LLMRunnerCreateOptions): LLMRunner {
    const innerRunner = this.inner.createRunner(opts);
    return new MetricTrackingRunner(innerRunner, this.getInstanceId, this.multiplier, this.onCreditConsumed);
  }
}
