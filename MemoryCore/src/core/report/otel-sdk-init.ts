/**
 * OTel SDK Initialization Module — core service
 *
 * Adapted for the core service based on reference code (trace branch otel-sdk-init.ts).
 * Responsible for initializing OpenTelemetry NodeSDK, supporting Trace/Metrics/Logs three signals.
 *
 * Environment variable configuration (OTel standard):
 * - OTEL_EXPORTER_OTLP_ENDPOINT    : Collector endpoint (default: http://localhost:4317)
 * - OTEL_EXPORTER_OTLP_PROTOCOL    : "grpc" | "http/protobuf" (default: "grpc")
 * - OTEL_EXPORTER_OTLP_HEADERS     : Comma-separated key=value pairs, for authentication
 * - OTEL_SERVICE_NAME               : Service name (default: "core")
 * - OTEL_RESOURCE_ATTRIBUTES        : Additional resource attributes (Zhiyan needs tps.tenant.id)
 *
 * Custom environment variables:
 * - TDAI_OTEL_ENABLED              : "true" to enable OTel SDK (default: "false")
 * - TDAI_INSTANCE_ID               : Instance identifier
 * - TDAI_METRICS_MODE              : "otlp" | "none" (default: "none")
 * - CLICKHOUSE_ENABLED             : "true" to enable ClickHouse dual-write
 */

// Defensive loading of @opentelemetry/api — even if package is missing it doesn't affect startup
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let diag: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let DiagConsoleLogger: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let DiagLogLevel: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let trace: any;
let _otelApiAvailable = false;

try {
  const api = await import("@opentelemetry/api");
  diag = api.diag;
  DiagConsoleLogger = api.DiagConsoleLogger;
  DiagLogLevel = api.DiagLogLevel;
  trace = api.trace;
  _otelApiAvailable = true;
} catch {
  // @opentelemetry/api not available, OTel SDK initialization will be skipped
  console.warn("[core][otel] @opentelemetry/api not available, OTel SDK disabled.");
}

export interface OTelSDKInitOptions {
  serviceName?: string;
  serviceVersion?: string;
  instanceId?: string;
  endpoint?: string;
  protocol?: "grpc" | "http/protobuf";
  /** Zhiyan tenant ID, will be set as Resource Attribute "tps.tenant.id" (required for Zhiyan APM authentication) */
  tenantId?: string;
  headers?: Record<string, string>;
  debug?: boolean;
  logExportIntervalMs?: number;
  clickhouse?: boolean | {
    endpoint?: string;
    username?: string;
    password?: string;
    database?: string;
  };
  /** Langfuse LLM trace report config (only forwards ai and gen_ai prefixed spans) */
  langfuse?: boolean | {
    host: string;
    publicKey: string;
    secretKey: string;
  };
}

let _sdkInstance: { shutdown: () => Promise<void> } | undefined;
let _initialized = false;

/**
 * Initialize OpenTelemetry SDK.
 * Safe to call multiple times — subsequent calls are no-op.
 * If SDK package is not installed, logs a warning and returns false.
 */
export async function initOTelSDK(options: OTelSDKInitOptions = {}): Promise<boolean> {
  if (_initialized) return true;

  // Enable SDK when endpoint or Langfuse is configured
  const hasLangfuse = typeof options.langfuse === "object" && options.langfuse && options.langfuse.host;
  const enabled = options.endpoint
    ? true
    : hasLangfuse
      ? true
      : process.env.TDAI_OTEL_ENABLED === "true";
  if (!enabled) return false;

  // Return directly when @opentelemetry/api is not available
  if (!_otelApiAvailable) {
    console.warn("[core][otel] @opentelemetry/api not available, skipping SDK init.");
    return false;
  }

  if (options.debug || process.env.OTEL_LOG_LEVEL === "DEBUG") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  try {
    const [
      { NodeSDK },
      resourcesModule,
      { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_SERVICE_INSTANCE_ID },
      { OTLPTraceExporter: GrpcTraceExporter },
      { OTLPTraceExporter: HttpTraceExporter },
      { OTLPLogExporter: GrpcLogExporter },
      { OTLPLogExporter: HttpLogExporter },
      { LoggerProvider, BatchLogRecordProcessor },
      { AsyncLocalStorageContextManager },
    ] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
      import("@opentelemetry/exporter-trace-otlp-grpc"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/exporter-logs-otlp-grpc"),
      import("@opentelemetry/exporter-logs-otlp-http"),
      import("@opentelemetry/sdk-logs"),
      import("@opentelemetry/context-async-hooks"),
    ]);

    // Compatible with old and new versions of @opentelemetry/resources
    // New version uses resourceFromAttributes(), old version uses new Resource()
    const createResource = (attrs: Record<string, string>) => {
      if ("resourceFromAttributes" in resourcesModule) {
        return (resourcesModule as { resourceFromAttributes: (a: Record<string, string>) => unknown }).resourceFromAttributes(attrs);
      }
      // Old version fallback
      const ResourceClass = (resourcesModule as { Resource: new (a: Record<string, string>) => unknown }).Resource;
      return new ResourceClass(attrs);
    };

    const logsApiModule = "@opentelemetry/api-logs";
    const { logs } = await import(logsApiModule);

    // Parse configuration
    const endpoint = options.endpoint
      ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ?? "";

    // Whether there is a main OTel collector (distinguished from Langfuse-only scenario)
    const hasMainOtel = Boolean(endpoint);

    const protocol = options.protocol
      ?? (process.env.OTEL_EXPORTER_OTLP_PROTOCOL as "grpc" | "http/protobuf")
      ?? "grpc";

    const headers = options.headers ?? parseHeadersFromEnv();
    const serviceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "core";
    const serviceVersion = options.serviceVersion ?? "unknown";
    const os = await import("node:os");
    const instanceId = options.instanceId ?? process.env.TDAI_INSTANCE_ID ?? process.env.HOSTNAME ?? os.hostname() ?? "unknown";

    // Build Resource (Zhiyan APM requires tps.tenant.id as Resource Attribute for authentication)
    const extraResourceAttrs = parseResourceAttributesFromEnv();
    const tenantId = options.tenantId ?? extraResourceAttrs["tps.tenant.id"] ?? "";
    const resourceAttrs: Record<string, string> = {
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
      [ATTR_SERVICE_INSTANCE_ID]: instanceId,
      ...extraResourceAttrs,
    };
    // Ensure tps.tenant.id is set as Resource Attribute (Zhiyan APM authentication method)
    if (tenantId) {
      resourceAttrs["tps.tenant.id"] = tenantId;
    }
    const resource = createResource(resourceAttrs);

    // Trace Exporter (created only when there is a main OTel endpoint)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let traceExporter: any = null;
    if (hasMainOtel) {
      traceExporter = protocol === "grpc"
        ? new GrpcTraceExporter({ url: endpoint, headers })
        : new HttpTraceExporter({ url: `${endpoint}/v1/traces`, headers });
    }

    // Note: Metrics do not use OTLP, they are reported via Kafka.

    // Log Exporter (created only when there is a main OTel endpoint)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let logExporter: any = null;
    if (hasMainOtel) {
      logExporter = protocol === "grpc"
        ? new GrpcLogExporter({ url: endpoint, headers })
        : new HttpLogExporter({ url: `${endpoint}/v1/logs`, headers });
    }

    // Collect all Log Processors (New LoggerProvider requires passing them during construction)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logProcessors: any[] = [];
    if (logExporter) {
      logProcessors.push(
        new BatchLogRecordProcessor(logExporter, {
          maxExportBatchSize: 512,
          scheduledDelayMillis: options.logExportIntervalMs ?? 5_000,
        }),
      );
    }

    // ClickHouse dual-write (optional)
    // If options.clickhouse is an object, it is considered enabled; if true, it is also enabled;
    // if false/undefined, fall back to checking environment variable.
    const clickhouseEnabled = (typeof options.clickhouse === "object" && options.clickhouse !== null)
      || options.clickhouse === true
      || (options.clickhouse !== false && process.env.CLICKHOUSE_ENABLED === "true");

    let clickhouseShutdown: (() => Promise<void>) | undefined;

    if (clickhouseEnabled) {
      try {
        const { ClickHouseDirectExporter, ClickHouseSpanExporter, ClickHouseLogExporter } =
          await import("./clickhouse-exporter.js");

        const chOpts = typeof options.clickhouse === "object" ? options.clickhouse : {};
        const chExporter = new ClickHouseDirectExporter({
          endpoint: chOpts.endpoint,
          username: chOpts.username,
          password: chOpts.password,
          database: chOpts.database,
          serviceName,
          debug: options.debug,
        });

        // Add ClickHouse Log Processor
        const chLogExporter = new ClickHouseLogExporter(chExporter);
        logProcessors.push(
          new BatchLogRecordProcessor(chLogExporter as unknown as InstanceType<typeof GrpcLogExporter>, {
            maxExportBatchSize: 512,
            scheduledDelayMillis: options.logExportIntervalMs ?? 5_000,
          }),
        );

        const _chSpanExporter = new ClickHouseSpanExporter(chExporter);
        (globalThis as Record<string, unknown>).__chSpanExporter = _chSpanExporter;

        clickhouseShutdown = async () => {
          await chExporter.shutdown();
        };

        console.info(`[core][otel] ClickHouse direct-write enabled ✓`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[core][otel] ClickHouse exporter init failed: ${msg}. Continuing without ClickHouse.`);
      }
    }

    // Create LoggerProvider (New API: pass resource + processors during construction)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loggerProvider = new LoggerProvider({ resource, processors: logProcessors } as any);
    logs.setGlobalLoggerProvider(loggerProvider);

    // ── Collect all SpanProcessors (Must be ready before NodeSDK construction) ──
    // @opentelemetry/sdk-trace-base@2.x removed addSpanProcessor(),
    // all processors must be passed at once via spanProcessors option during construction.
    const { BatchSpanProcessor, SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spanProcessors: any[] = [];
    // Add BatchSpanProcessor only when there is a main OTel endpoint
    if (traceExporter) {
      spanProcessors.push(new BatchSpanProcessor(traceExporter));
    }

    // ClickHouse SpanProcessor
    if (clickhouseEnabled && (globalThis as Record<string, unknown>).__chSpanExporter) {
      spanProcessors.push(
        new SimpleSpanProcessor(
          (globalThis as Record<string, unknown>).__chSpanExporter as InstanceType<typeof GrpcTraceExporter>
        )
      );
      delete (globalThis as Record<string, unknown>).__chSpanExporter;
    }

    // Langfuse filtering SpanProcessor (only forwards LLM related spans)
    let langfuseShutdown: (() => Promise<void>) | undefined;
    try {
      const { LangfuseFilteringProcessor } =
        await import("./langfuse-span-processor.js");

      // Read Langfuse config from options (already parsed from YAML by gateway/config.ts)
      let langfuseEnabled = false;
      let langfuseHost = "";
      let langfusePublicKey = "";
      let langfuseSecretKey = "";

      if (typeof options.langfuse === "object" && options.langfuse) {
        langfuseEnabled = true;
        langfuseHost = options.langfuse.host;
        langfusePublicKey = options.langfuse.publicKey;
        langfuseSecretKey = options.langfuse.secretKey;
      } else if (options.langfuse === true || process.env.LANGFUSE_ENABLED === "true") {
        // Compatible with environment variable fallback
        langfuseEnabled = true;
        langfuseHost = process.env.LANGFUSE_HOST ?? "";
        langfusePublicKey = process.env.LANGFUSE_PUBLIC_KEY ?? "";
        langfuseSecretKey = process.env.LANGFUSE_SECRET_KEY ?? "";
      }

      if (langfuseEnabled && (!langfuseHost || !langfusePublicKey || !langfuseSecretKey)) {
        console.warn(
          `[core][otel] Langfuse enabled but config incomplete (host=${langfuseHost ? "✓" : "✗"}, publicKey=${langfusePublicKey ? "✓" : "✗"}, secretKey=${langfuseSecretKey ? "✓" : "✗"}). Skipping Langfuse.`,
        );
      }

      if (langfuseEnabled && langfuseHost && langfusePublicKey && langfuseSecretKey) {
        // Construct OTLP HTTP exporter pointing to Langfuse's OTel endpoint
        const langfuseExporter = new HttpTraceExporter({
          url: `${langfuseHost}/api/public/otel/v1/traces`,
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${langfusePublicKey}:${langfuseSecretKey}`
            ).toString("base64")}`,
          },
        });

        const langfuseProcessor = new LangfuseFilteringProcessor(langfuseExporter);
        spanProcessors.push(langfuseProcessor);
        langfuseShutdown = () => langfuseProcessor.shutdown();
        console.info(
          `[core][otel] Langfuse exporter enabled ✓ | host=${langfuseHost}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[core][otel] Langfuse exporter init failed: ${msg}. Continuing without Langfuse.`);
    }

    // Initialize NodeSDK (excluding Metrics, Metrics are reported via Kafka)
    // Note: @opentelemetry/sdk-trace-base@2.x no longer supports dynamic addSpanProcessor,
    // all processors must be passed at once via spanProcessors here.
    const sdk = new NodeSDK({
      resource,
      spanProcessors,
      contextManager: new AsyncLocalStorageContextManager(),
    });

    sdk.start();

    _sdkInstance = {
      shutdown: async () => {
        await Promise.all([
          sdk.shutdown(),
          loggerProvider.shutdown(),
          clickhouseShutdown?.(),
          langfuseShutdown?.(),
        ]);
      },
    };
    _initialized = true;

    console.info(
      `[core][otel] SDK initialized ✓ | endpoint=${endpoint || "(langfuse-only)"} | protocol=${protocol} | service=${serviceName} | tenantId=${tenantId ? tenantId.slice(0, 20) + "..." : "(none)"} | metrics=kafka`,
    );

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diag.warn(`[core] Failed to initialize OTel SDK: ${msg}`);
    return false;
  }
}

/**
 * Gracefully shutdown OTel SDK.
 */
export async function shutdownOTelSDK(): Promise<void> {
  if (!_sdkInstance) return;
  try {
    await _sdkInstance.shutdown();
  } catch {
    // Best-effort shutdown
  } finally {
    _sdkInstance = undefined;
    _initialized = false;
  }
}

/**
 * Check if OTel SDK is initialized.
 */
export function isOTelSDKInitialized(): boolean {
  return _initialized;
}

// ── Helpers ──

function parseHeadersFromEnv(): Record<string, string> {
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx <= 0) continue;
    headers[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
  }
  return headers;
}

function parseResourceAttributesFromEnv(): Record<string, string> {
  const raw = process.env.OTEL_RESOURCE_ATTRIBUTES;
  if (!raw) return {};
  const attrs: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx <= 0) continue;
    attrs[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
  }
  return attrs;
}
