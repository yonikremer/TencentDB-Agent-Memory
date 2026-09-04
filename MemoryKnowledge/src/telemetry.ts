/**
 * OpenTelemetry + Langfuse span processor initialization.
 *
 * Invokes initTelemetry() at the very top of server.ts to ensure OTel SDK is registered
 * before any modules are loaded. Silently skips when LANGFUSE_SECRET_KEY is not configured, without affecting service operation.
 *
 * AI SDK's generateText({ experimental_telemetry: { isEnabled: true } })
 * automatically produces GEN_AI semantic convention spans, which LangfuseSpanProcessor batch reports to Langfuse.
 */

// Must load .env before reading process.env,
// because initTelemetry() executes before config.ts (which contains import 'dotenv/config')
import 'dotenv/config';

import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { trace, type Span } from "@opentelemetry/api";
import { createLogger } from "./logger.js";

const log = createLogger("telemetry");

let sdk: NodeSDK | null = null;

/** Initializes OpenTelemetry + Langfuse. Silently skips when key is not configured. */
export function initTelemetry(): void {
  if (sdk) return; // Prevents duplicate initialization

  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!secretKey) {
    log.info("Langfuse telemetry disabled (LANGFUSE_SECRET_KEY not set)");
    return;
  }

  try {
    sdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          shouldExportSpan: () => true,
        }),
      ],
    });
    sdk.start();
    log.info("Langfuse telemetry initialized", {
      baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
    });
  } catch (err) {
    log.warn("Langfuse telemetry init failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    sdk = null;
  }

  // Flush residual spans on graceful shutdown
  process.on("SIGTERM", () => {
    sdk?.shutdown().catch(() => {});
  });
}

// ── Tracing helpers ──

/** Shared tracer for ingest workflow to create parent spans. */
export const tracer = trace.getTracer("knowledge-wiki");

/**
 * Executes an async function within a span context. AI SDK's experimental_telemetry automatically
 * merges generateText spans as child spans of the current active span.
 *
 * Usage:
 *   const result = await withSpan("wiki-ingest", async (span) => {
 *     span.setAttribute("wiki.name", name);
 *     return runIngest(...);
 *   });
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    // langfuse.name attribute makes Langfuse UI display trace title
    span.setAttribute("langfuse.name", name);
    try {
      return await fn(span);
    } finally {
      span.end();
    }
  });
}
