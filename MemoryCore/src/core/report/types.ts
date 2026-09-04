/**
 * Observability Abstraction Layer — Core Types & Interfaces.
 *
 * This module defines the observability contracts for Trace, Log, Metric,
 * LLM Trace, and HTTP Trace Middleware.
 *
 * Design principles:
 * 1. **Backend-agnostic**: Upper layers (trace.ts, obs-logger.ts, etc.) depend
 *    only on these interfaces — never on OTel SDK, Kafka, or Langfuse directly.
 * 2. **Async-first**: All lifecycle methods return Promises; hot-path methods
 *    (report, send) are synchronous for zero-overhead.
 * 3. **Extensible**: Interface is minimal for v1; implementations can add
 *    backend-specific features without changing the contract.
 * 4. **Safe by default**: All implementations must be error-silent — never
 *    throw exceptions that could affect business logic.
 *
 * Relationship to IStorageBackend (src/core/storage/types.ts):
 *   - IStorageBackend = file storage abstraction (L2/L3 files → COS/local-fs)
 *   - IObservabilityBackend = observability abstraction (Trace/Log/Metric → OTel/Kafka/Langfuse)
 *   Both follow the same pattern: interface + factory + dynamic import for private impl.
 */

import type http from "node:http";

// ============================
// Common Types
// ============================

/** Trace attributes — supports primitives and null/undefined (which are filtered out) */
export type TraceAttrs = Record<string, string | number | boolean | null | undefined>;

/** Log attributes — only primitive types supported */
export type LogAttrs = Record<string, string | number | boolean>;

/** Span interface — minimal subset compatible with @opentelemetry/api Span */
export interface ISpan {
  /** End the Span */
  end(): void;
  /** Set a single attribute */
  setAttribute(key: string, value: string | number | boolean): this;
  /** Set multiple attributes at once */
  setAttributes(attrs: Record<string, string | number | boolean>): this;
  /** Set the Span status */
  setStatus(status: { code: number; message?: string }): this;
  /** Record an exception */
  recordException(exception: Error | string): void;
  /** Get the Span context */
  spanContext(): { traceId: string; spanId: string; traceFlags: number };
  /** Whether the Span is currently recording */
  isRecording(): boolean;
  /** Update the Span name */
  updateName(name: string): this;
  /** Add an event */
  addEvent(name: string, attrs?: Record<string, string | number | boolean>): this;
}

/** SpanProcessor interface — minimal subset compatible with @opentelemetry/sdk-trace-base SpanProcessor */
export interface ISpanProcessor {
  onStart(span: unknown, parentContext: unknown): void;
  onEnd(span: unknown): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

// ============================
// ITraceBackend — Trace Abstraction
// ============================

/**
 * Trace backend interface.
 *
 * Implementations:
 * - NoopTraceBackend   — no-op (open-source default)
 * - ConsoleTraceBackend — stdout output (development/debugging)
 * - OTelTraceBackend   — OpenTelemetry (internal: dual-write to Zhiyan + ClickHouse)
 */
export interface ITraceBackend {
  /** Backend identifier */
  readonly type: string;

  /**
   * Report a business event (event = Span).
   * Internally creates a Span → sets attributes → sets status → ends it.
   */
  report(event: string, attrs?: TraceAttrs): void;

  /**
   * Create a traditional Span (caller must manually call span.end()).
   * @param spanName Span name
   * @param kind SpanKind value (INTERNAL=0, SERVER=1, CLIENT=2, PRODUCER=3, CONSUMER=4)
   */
  start(spanName: string, kind?: number): ISpan;

  /** Create a SERVER-type Span */
  startServer(spanName: string): ISpan;

  /** Create a CLIENT-type Span */
  startClient(spanName: string): ISpan;
}

// ============================
// ILogBackend — Log Abstraction
// ============================

/**
 * Log backend interface.
 *
 * Implementations:
 * - NoopLogBackend    — no-op (open-source default)
 * - ConsoleLogBackend — stdout output (development/debugging)
 * - OTelLogBackend    — OpenTelemetry Logs API (internal: dual-write to Zhiyan + ClickHouse)
 */
export interface ILogBackend {
  /** Backend identifier */
  readonly type: string;

  /** INFO level log */
  info(eventName: string, attrs?: LogAttrs): void;

  /** WARN level log */
  warn(eventName: string, attrs?: LogAttrs): void;

  /** ERROR level log */
  error(eventName: string, attrs?: LogAttrs, error?: Error): void;

  /** DEBUG level log */
  debug?(eventName: string, attrs?: LogAttrs): void;
}

// ============================
// IMetricBackend — Metric Abstraction
// ============================

/** Metric message structure */
export interface MetricMessage {
  /** Metric name */
  metric: string;
  /** Instance ID (also used as Kafka key) */
  instanceId: string;
  /** Raw value */
  value: number;
  /** Unix seconds (UTC) when the event occurred; defaults to current time if not provided */
  timestamp?: number;
  /** Source service */
  source?: string;
  /**
   * Associated OTel Trace ID, used for Metric → Trace reverse lookup.
   * Automatically injected by metricProducer.send() from the current active span;
   * callers typically do not need to provide this manually.
   * Once stored in ClickHouse, the online evaluation service can use this field
   * to locate the full Trace for a specific request.
   */
  traceId?: string;
}

/** Kafka Metric configuration */
export interface MetricBackendConfig {
  /** Kafka broker list */
  brokers: string[];
  /** Topic name (default: "memory_monitor") */
  topic?: string;
  /** Whether enabled (default: false) */
  enabled?: boolean;
}

/**
 * Metric backend interface.
 *
 * Implementations:
 * - NoopMetricBackend  — no-op (open-source default)
 * - ConsoleMetricBackend — stdout output (development/debugging)
 * - KafkaMetricBackend — Kafka Producer (internal: memory-monitor consumer → Barad + ClickHouse)
 */
export interface IMetricBackend {
  /** Backend identifier */
  readonly type: string;

  /** Send a metric message (synchronous, non-blocking) */
  send(msg: MetricMessage): void;

  /** Initialize the backend (async) */
  initialize(config: MetricBackendConfig): Promise<void>;

  /** Graceful shutdown */
  destroy(): Promise<void>;
}

// ============================
// ILLMTraceBackend — AI/LLM Trace Abstraction
// ============================

/** Langfuse configuration */
export interface LLMTraceConfig {
  /** Whether enabled */
  enabled: boolean;
  /** Langfuse instance URL */
  host?: string;
  /** Langfuse public key */
  publicKey?: string;
  /** Langfuse secret key */
  secretKey?: string;
}

/**
 * LLM Trace backend interface.
 *
 * Implementations:
 * - NoopLLMTraceBackend     — no-op (open-source default)
 * - ConsoleLLMTraceBackend  — stdout output (development/debugging)
 * - LangfuseLLMTraceBackend — Langfuse (internal: filters AI Spans and reports to Langfuse)
 */
export interface ILLMTraceBackend {
  /** Backend identifier */
  readonly type: string;

  /**
   * Create a SpanProcessor instance.
   * The returned processor is registered with the OTel TracerProvider
   * to filter and report AI/LLM-related Spans.
   */
  createSpanProcessor(): ISpanProcessor | null;

  /** Force-flush pending LLM Trace data */
  flush(): Promise<void>;

  /** Graceful shutdown */
  shutdown(): Promise<void>;
}

// ============================
// ITraceMiddleware — HTTP Trace Middleware Abstraction
// ============================

/**
 * HTTP Trace middleware interface.
 *
 * Implementations:
 * - NoopTraceMiddleware — pass-through (open-source default)
 * - ConsoleTraceMiddleware — stdout output (development/debugging)
 * - OTelTraceMiddleware — OpenTelemetry (internal: creates SERVER Span + Context propagation)
 */
export interface ITraceMiddleware {
  /** Backend identifier */
  readonly type: string;

  /**
   * Wrap an HTTP request handler to add Trace instrumentation.
   * Restores upstream Trace Context from the traceparent header and creates a SERVER Span.
   */
  wrapWithTrace(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: () => Promise<void>,
  ): Promise<void>;

  /**
   * Create a child Span (for use inside business handlers).
   * Caller must manually call span.end().
   */
  startChildSpan(
    name: string,
    attrs?: Record<string, string | number | boolean>,
  ): ISpan;

  /**
   * Execute a function within a Span context, automatically creating a child Span.
   */
  withSpan<T>(
    name: string,
    attrs: Record<string, string | number | boolean>,
    fn: (span: ISpan) => Promise<T>,
  ): Promise<T>;
}

// ============================
// ITracePropagation — Trace Context Propagation Abstraction
// ============================

/**
 * Interface for propagating Trace Context across async boundaries.
 * Used to serialize/deserialize OTel Trace Context in async tasks.
 */
export interface ITracePropagation {
  /**
   * Serialize the current Trace Context to a plain object.
   * The returned object can be spread into TaskPayload.data.
   */
  serializeTraceContext(): Record<string, string | number>;

  /**
   * Deserialize and restore Trace Context from TaskPayload.data.
   * Returns parentContext and parentSpanContext.
   */
  deserializeTraceContext(data?: Record<string, unknown>): {
    parentContext: unknown;
    parentSpanContext: { traceId: string; spanId: string; traceFlags: number; isRemote: boolean } | null;
  };
}

// ============================
// IObservabilityBackend — Aggregate Interface
// ============================

/**
 * Aggregate observability backend interface — contains all sub-backends.
 *
 * Created via the factory function createObservabilityBackend(config).
 * Exposed as a global singleton for use by all facade modules.
 */
export interface IObservabilityBackend {
  /** Backend type identifier */
  readonly type: "noop" | "console" | "internal" | string;

  /** Trace backend */
  readonly trace: ITraceBackend;

  /** Log backend */
  readonly log: ILogBackend;

  /** Metric backend */
  readonly metric: IMetricBackend;

  /** LLM Trace backend */
  readonly llmTrace: ILLMTraceBackend;

  /** HTTP Trace middleware */
  readonly traceMiddleware: ITraceMiddleware;

  /** Trace Context propagation */
  readonly tracePropagation: ITracePropagation;

  /** Initialize all sub-backends */
  initialize(config: ObservabilityConfig): Promise<void>;

  /** Gracefully shut down all sub-backends */
  shutdown(): Promise<void>;
}

// ============================
// Configuration
// ============================

/** OTel configuration */
export interface OTelConfig {
  /** Whether enabled */
  enabled: boolean;
  /** OTel Collector endpoint */
  endpoint?: string;
  /** Protocol (grpc | http | http/protobuf) */
  protocol?: "grpc" | "http" | "http/protobuf";
  /** Service name */
  serviceName?: string;
  /** Tenant ID */
  tenantId?: string;
}

/** ClickHouse configuration */
export interface ClickHouseConfig {
  /** Whether enabled */
  enabled: boolean;
  /** ClickHouse HTTP endpoint */
  endpoint?: string;
  /** Username */
  username?: string;
  /** Password */
  password?: string;
  /** Database name */
  database?: string;
}

/**
 * Overall observability configuration.
 *
 * Backend type descriptions:
 * - "noop"     — no-op, zero overhead (default when not configured)
 * - "console"  — output to stdout, for development/debugging
 * - "otlp"     — standard OTLP protocol backend (recommended for open-source users)
 *                configure otel.endpoint to send Trace/Log/Metric to any OTLP-compatible backend
 *                (e.g. ClickHouse, Jaeger, Grafana Tempo/Loki/Mimir, SigNoz, OTel Collector, etc.)
 * - "internal" — internal private module (via git submodule, Zhiyan + Kafka + Langfuse)
 */
export interface ObservabilityConfig {
  /** Backend type: noop | console | otlp | internal */
  type: "noop" | "console" | "otlp" | "internal" | string;

  /**
   * OTel configuration (used in otlp and internal modes).
   *
   * For open-source users using "otlp" mode, only these fields are needed:
   *   otel: {
   *     enabled: true,
   *     endpoint: "http://localhost:4318",  // your OTLP backend address
   *     serviceName: "my-memory-service",   // optional, defaults to "tdai-memory"
   *   }
   */
  otel?: OTelConfig;

  /** ClickHouse configuration (used in internal mode) */
  clickhouse?: ClickHouseConfig;

  /** Kafka Metric configuration (used in internal mode) */
  kafka?: MetricBackendConfig;

  /** Langfuse LLM Trace configuration (used in internal mode) */
  langfuse?: LLMTraceConfig;
}

// ============================
// Logger Interface (for internal use)
// ============================

/** Minimal logger interface used internally by the observability module */
export interface ObservabilityLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}
