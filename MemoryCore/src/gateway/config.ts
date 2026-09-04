/**
 * TDAI Gateway — Configuration management.
 *
 * Reads gateway configuration from:
 * 1. `tdai-gateway.yaml` (or JSON) in CWD or data dir
 * 2. Environment variables (override individual fields)
 *
 * Minimal config: just LLM API credentials. Everything else has sensible defaults.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getEnv } from "../utils/env.js";
import { parseConfig as parseMemoryConfig } from "../config.js";
import type { MemoryTdaiConfig } from "../config.js";
import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";

// ============================
// Gateway config types
// ============================

/**
 * Deployment mode determines how the system manages state and coordination:
 *
 * - "standalone": Open-source single-node mode.
 *     Pipeline state lives in-process (Map/setTimeout/SerialQueue).
 *     No external dependencies beyond LLM API and optional VDB.
 *     Suitable for single-machine / sidecar / developer setups.
 *
 * - "service": Cloud service (multi-tenant) mode.
 *     Pipeline state is externalized through IStateBackend.
 *     Timer Scanner + Pipeline Worker run inside the gateway process.
 *     Supports multi-replica coordination and HA.
 *     May require deployment-specific remote backends.
 */
export type DeployMode = "standalone" | "service";

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  keyPrefix: string;
}

export interface SharkConfig {
  baseUrl?: string;
  vdbTtlMs: number;
  cosBufferMs: number;
  maxInstances: number;
}

export interface ScannerConfig {
  instances: string;
  instancesSharkUrl?: string;
  intervalMs: number;
  nodeId?: string;
}

export interface WorkerConfig {
  pollMs: number;
  /** Concurrent consumption coroutine count (default: 60) */
  concurrency: number;
}

export interface CosExtraConfig {
  domain?: string;
  /** Generation log retention in days. Default: 30. Set 0 to disable lifecycle management. */
  generationLogRetentionDays: number;
}

export interface KafkaConfig {
  /** Whether to enable Kafka (default: false) */
  enabled: boolean;
  /** Kafka Broker list (comma separated) */
  brokers: string;
  /** Topic name (default: "memory_monitor") */
  topic: string;
  /** Consumer group ID (used only by Consumer, e.g. Monitor) */
  groupId?: string;
  /** Total partition count (used only by Producer, for hash partitioning) */
  totalPartitions?: number;
}

export interface OTelConfig {
  /** Whether to enable OTel SDK (default: false) */
  enabled: boolean;
  /** Collector endpoint (default: http://localhost:4317) */
  endpoint: string;
  /** Protocol: "grpc" | "http/protobuf" (default: "grpc") */
  protocol: "grpc" | "http/protobuf";
  /** OTLP request headers, for auth etc., format key=value comma separated */
  headers?: string;
  /** Service name (default: "core") */
  serviceName: string;
  /** Service version */
  serviceVersion: string;
  /** Instance ID */
  instanceId?: string;
  /** Zhiyan APM tenant ID */
  tenantId: string;
  /** Metric export interval (seconds, default: 60) */
  metricExportInterval?: number;
  /** Log export interval (seconds, default: 5) */
  logExportInterval: number;
}

export interface ClickHouseConfig {
  /** Whether to enable ClickHouse dual write (default: false) */
  enabled: boolean;
  /** ClickHouse HTTP endpoint */
  endpoint: string;
  /** Username */
  username: string;
  /** Password */
  password: string;
  /** Database name */
  database: string;
  /** Target table name for writing (used by Monitor, other components can leave empty) */
  table?: string;
  /** Maximum batch write size */
  maxBatchSize?: number;
  /** Flush interval (seconds) */
  flushInterval?: number;
  /** Maximum buffer queue size, data discarded when exceeded */
  maxQueueSize?: number;
}

export interface LangfuseConfig {
  /** Whether to enable Langfuse LLM trace reporting (default: false) */
  enabled: boolean;
  /** Langfuse instance address (e.g. http://langfuse.example.local:3000) */
  host: string;
  /** Langfuse public key */
  publicKey: string;
  /** Langfuse secret key */
  secretKey: string;
}

/**
 * Observability config (unified format, shared by four components).
 * Each component enables corresponding sub-configs as needed, unused sub-configs just keep enabled=false.
 *
 * Sub-configs are enabled per deployment needs; unused sub-configs just keep enabled=false.
 *
 * yaml example:
 * ```yaml
 * observability:
 *   otel:
 *     enabled: true
 *     endpoint: "http://otel.example.com:4317"
 *     protocol: "grpc"
 *     serviceName: "core"
 *     serviceVersion: "1.0.0"
 *     tenantId: "<APM_TENANT_ID>"
 *     metricExportInterval: 60
 *     logExportInterval: 5
 *   clickhouse:
 *     enabled: true
 *     endpoint: "http://clickhouse.example.local:8123"
 *     username: "default"
 *     password: "xxx"
 *     database: "tdai_eval"
 *     maxBatchSize: 1000
 *     flushInterval: 5
 *     maxQueueSize: 10000
 *   kafka:
 *     enabled: true
 *     brokers: "kafka.example.local:9092"
 *     topic: "memory_monitor"
 *     totalPartitions: 32
 *   langfuse:
 *     enabled: true
 *     host: "http://langfuse.example.local:3000"
 *     publicKey: "pk-lf-xxx"
 *     secretKey: "sk-lf-yyy"
 * ```
 */
export interface ObservabilityConfig {
  /** OTel SDK config (Trace + Log). */
  otel: OTelConfig;
  /** ClickHouse dual write config. */
  clickhouse: ClickHouseConfig;
  /** Kafka config. */
  kafka: KafkaConfig;
  /** Barad cloud monitor reporting config. */
  barad?: BaradConfig;
  /** Zhiyan monitor Metric reporting config. */
  zhiyan?: ZhiYanConfig;
  /** Langfuse LLM trace reporting config. */
  langfuse: LangfuseConfig;
}

/** Barad cloud monitor reporting config. */
export interface BaradConfig {
  /** Whether to enable Barad reporting (default: false) */
  enabled: boolean;
  /** Reporting region, e.g. ap-guangzhou */
  region: string;
  /** Namespace (default: "qce/memory") */
  namespace: string;
  /** Reporting frequency (seconds) (default: 60) */
  freq: number;
  /** Test environment reporting address (overrides default region concatenated address) */
  testEndpoint?: string;
  /** Test environment query address (used for integration testing to verify data) */
  testQueryEndpoint?: string;
  /** Collection interval (seconds) (default: 10) */
  collectInterval?: number;
}

/** Zhiyan monitor Metric reporting config. Using component: Monitor ✓ */
export interface ZhiYanConfig {
  /** Whether to enable Zhiyan Metric reporting (default: false) */
  enabled: boolean;
  /** Zhiyan monitor reporting address */
  endpoint: string;
  /** App identifier (required for Zhiyan monitor), format: {BusinessID}_{AppID}_{AppName} */
  appMark: string;
  /** Group name (default: "default") */
  group: string;
  /** Environment identifier, e.g. dev/test/prod */
  env: string;
  /** Metric namespace prefix (default: "memory") */
  namespace: string;
  /** Reporting interval (seconds) (default: 60) */
  exportInterval: number;
}

export interface GatewayConfig {
  /**
   * Deployment mode. Default: "standalone".
   *
   * env: TDAI_DEPLOY_MODE=standalone|service
   * yaml: deployMode: service
   */
  deployMode: DeployMode;
  server: {
    port: number;
    host: string;
    /**
     * Optional API token for HTTP authentication.
     *
     * When set (non-empty string), every route except `GET /health` and CORS
     * preflight (`OPTIONS *`) requires an `Authorization: Bearer <apiKey>`
     * header. Requests without a valid token receive HTTP 401.
     *
     * **Default: undefined** — authentication is disabled, all routes are
     * open (preserves legacy behaviour). A WARN is emitted at startup if the
     * gateway binds to a non-loopback host without an API key set, to avoid
     * silently exposing an unauthenticated endpoint to the network.
     *
     * env: `TDAI_GATEWAY_API_KEY`
     * yaml: `server.apiKey`
     */
    apiKey?: string;
    /**
     * Optional CORS allow-list.
     *
     * When empty (default), the gateway sends **no** `Access-Control-Allow-*`
     * headers and rejects CORS preflight (`OPTIONS`) with 403 if an `Origin`
     * header is present — browsers will then block all cross-origin requests
     * via same-origin policy.
     *
     * When set, each request's `Origin` is matched against this list and
     * `Access-Control-Allow-Origin` is echoed back only on match. Use the
     * single entry `"*"` to restore the legacy permissive behaviour (only
     * appropriate for local development).
     *
     * env: `TDAI_CORS_ORIGINS` (comma-separated)
     * yaml: `server.corsOrigins` (string[])
     */
    corsOrigins: string[];
  };
  data: {
    /** Base directory for TDAI data storage. */
    baseDir: string;
  };
  llm: StandaloneLLMConfig;
  /** Parsed memory-tdai plugin config (recall, capture, extraction, pipeline, etc.). */
  memory: MemoryTdaiConfig;

  /**
   * Optional Skill module config — passed through to MemoryTdaiConfig.skill
   * at load time. Kept at the top level here so gateway-only deployments
   * can configure skills without nesting under `memory.skill`. The loader
   * shallow-merges this onto `memory.skill` (yaml top-level wins).
   */
  skill?: import("../core/skill/types.js").SkillConfigInput;

  // ── Service-mode config (also settable via env vars, env takes priority) ──

  /** State backend type. env: STATE_BACKEND. yaml: stateBackend */
  stateBackend?: "redis" | "local";
  /** Default instance ID for standalone pipeline. env: TDAI_INSTANCE_ID. yaml: instanceId */
  instanceId: string;
  redis: RedisConfig;
  shark: SharkConfig;
  scanner: ScannerConfig;
  worker: WorkerConfig;
  cos: CosExtraConfig;
  /** Observability config (yaml: observability, env: KAFKA_METRIC_*) */
  observability: ObservabilityConfig;
  /**
   * Metadata module config (env takes precedence over yaml; see applyMetadataEnvFromGatewayConfig).
   * yaml: metadata.*
   * env: TDAI_METADATA_*
   */
  metadata: GatewayMetadataConfig;
  /** Offload server executor config (yaml: offload) */
  offload: {
    forceTriggerThreshold: number;
    pendingMaxAgeSeconds: number;
    l1Temperature: number;
    l1MaxTokens: number;
    l1TimeoutMs: number;
    l15Temperature: number;
    l15MaxTokens: number;
    l15TimeoutMs: number;
    l2Temperature: number;
    l2MaxTokens: number;
    l2TimeoutMs: number;
    l2NullThreshold: number;
    mildOffloadRatio: number;
    aggressiveCompressRatio: number;
    emergencyCompressRatio: number;
    maxRetries: number;
  };
}

/** v3 metadata Gateway yaml config (§6.3). */
export interface GatewayMetadataStoreConfig {
  sqliteBaseDir?: string;
  mongoUri?: string;
  mongoTransactions?: boolean;
  storeCacheMaxInstances?: number;
  /** Metadata DB name prefix, default tdai_metadata; DB name {prefix}_{instance_id} */
  mongoDbPrefix?: string;
}

export interface GatewayMemorySystemUserConfig {
  userId?: string;
  displayName?: string;
  userKey?: string;
}

export interface GatewayMetadataSystemUserConfig {
  memory?: GatewayMemorySystemUserConfig;
}

export interface GatewayMetadataConfig {
  maxUsersPerInstance: number;
  maxTeamsPerInstance: number;
  configParamsFile?: string;
  store?: GatewayMetadataStoreConfig;
  /** Internal static system user (auth/verify only; not persisted to DB). */
  systemUser?: GatewayMetadataSystemUserConfig;
}

// ============================
// Config loading
// ============================

// ============================
// Utility Functions
// ============================

/**
 * Convert Kafka brokers config value to string[] array.
 *
 * Background: In gateway config, KafkaConfig.brokers type is string (comma separated),
 * but MetricBackendConfig.brokers expects string[]. If passed directly as a string,
 * KafkaJS parses by character causing port number to become NaN.
 *
 * @param brokers - comma separated broker address string, or already a string[] array
 * @returns array of broker addresses (trimmed, empty elements filtered)
 */
export function parseBrokers(brokers: string | string[]): string[] {
  if (Array.isArray(brokers)) return brokers;
  if (!brokers) return [];
  return brokers.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Load gateway config from file + environment variables.
 *
 * Resolution order for config file:
 * 1. `TDAI_GATEWAY_CONFIG` env var (explicit path)
 * 2. `./tdai-gateway.yaml` or `./tdai-gateway.json` in CWD
 * 3. `<dataDir>/tdai-gateway.yaml` or `<dataDir>/tdai-gateway.json`
 * 4. Pure environment-variable config (no file)
 */
export function loadGatewayConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  let fileConfig: Record<string, unknown> = {};

  // Try to load config file
  const configPath = resolveConfigPath();
  if (configPath) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      if (configPath.endsWith(".json")) {
        fileConfig = JSON.parse(raw);
      } else {
      // Full YAML support (arbitrary nesting, anchors, lists, multi-line).
        // We still postprocess ${VAR} env-var interpolation on string leaves
        // below so existing configs that relied on the previous simple parser
        // keep working.
        const parsed = YAML.parse(raw);
        fileConfig = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          ? parsed as Record<string, unknown>
          : {};
      }
      fileConfig = expandEnvVars(fileConfig) as Record<string, unknown>;
    } catch {
      // Config file is optional — malformed files fall back to env-only config.
    }
  }

  // Server config
  const serverConfig = obj(fileConfig, "server");
  const port = envInt("TDAI_GATEWAY_PORT") ?? num(serverConfig, "port") ?? 8420;
  const host = env("TDAI_GATEWAY_HOST") ?? str(serverConfig, "host") ?? "127.0.0.1";

  // Optional auth / CORS — both default to "disabled" so existing setups keep
  // working unchanged. When unset the gateway behaves exactly like before this
  // change (open v1 routes, permissive CORS *will not* be re-introduced — see
  // resolveCorsOrigins below: empty list means "send no CORS headers").
  const apiKey = env("TDAI_GATEWAY_API_KEY") ?? str(serverConfig, "apiKey");
  const corsOrigins = resolveCorsOrigins(serverConfig);

  // Data config (expand leading ~ to $HOME so Node.js fs/path can resolve it)
  const dataConfig = obj(fileConfig, "data");
  const rawBaseDir = env("TDAI_DATA_DIR") ?? str(dataConfig, "baseDir") ?? resolveDefaultDataDir();
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";
  const baseDir = rawBaseDir.startsWith("~/") ? path.join(home, rawBaseDir.slice(2)) : rawBaseDir;

  // LLM config
  //
  // provider supports two modes:
  //   - "openai" (default): connects directly to OpenAI compatible services
  //   - "proxy": routes through context_proxy, concatenates baseUrl at runtime into ${baseUrl}/proxy/<iid>/v1,
  //             Authorization uses memory system user key. gateway layer is responsible for final resolution,
  //             see resolveEffectiveLlmConfig in src/gateway/llm-resolver.ts.
  const llmConfig = obj(fileConfig, "llm");
  const llmProxyConfig = obj(llmConfig, "proxy");
  const rawLlmProvider = env("TDAI_LLM_PROVIDER") ?? str(llmConfig, "provider");
  const llmProvider: "openai" | "proxy" =
    rawLlmProvider === "proxy" ? "proxy" : "openai";
  const llm: StandaloneLLMConfig = {
    baseUrl: env("TDAI_LLM_BASE_URL") ?? str(llmConfig, "baseUrl") ?? "https://api.openai.com/v1",
    apiKey: env("TDAI_LLM_API_KEY") ?? str(llmConfig, "apiKey") ?? "",
    model: env("TDAI_LLM_MODEL") ?? str(llmConfig, "model") ?? "gpt-4o",
    maxTokens: envInt("TDAI_LLM_MAX_TOKENS") ?? num(llmConfig, "maxTokens") ?? 4096,
    timeoutMs: envInt("TDAI_LLM_TIMEOUT_MS") ?? num(llmConfig, "timeoutMs") ?? 120_000,
    provider: llmProvider,
    proxy: {
      useMemorySystemUserKey: bool(llmProxyConfig, "useMemorySystemUserKey") ?? true,
    },
    // When env exists, parse directly using env (can explicitly override yaml);
    // fallback to yaml only when env is unset, consistent with other LLM field semantics.
    stream: (() => {
      const envVal = env("TDAI_LLM_STREAM");
      if (envVal !== undefined) return envVal === "true";
      return bool(llmConfig, "stream") ?? false;
    })(),
  };

  // Memory config (reuse the plugin's parseConfig for full compatibility)
  const memoryRaw = obj(fileConfig, "memory");
  const topLevelPromptMode = str(fileConfig, "promptMode") ?? str(obj(fileConfig, "prompts"), "mode");
  const memoryCompatRaw: Record<string, unknown> = { ...memoryRaw };
  if (!str(memoryCompatRaw, "promptMode") && topLevelPromptMode) {
    memoryCompatRaw.promptMode = topLevelPromptMode;
  }
  const memory = parseMemoryConfig(memoryCompatRaw);

  // ── Standalone LLM override pass-through to MemoryTdaiConfig.llm ──
  // The gateway has its own top-level `llm` block (read above into the
  // `llm` variable), and `parseMemoryConfig` ALSO has a `memory.llm` block
  // that defaults to enabled=false. When the gateway's top-level llm is
  // configured (baseUrl + apiKey), splice it onto memory.llm so the
  // SkillExtractor / L1 / L2 / L3 runners see a usable runner without
  // requiring the user to duplicate the block under `memory.llm`.
  // In provider=proxy mode, splice even if apiKey is empty —— because the final apiKey is provided
  // by memory systemUser.userKey, llm.apiKey is only an explicit config when provider=openai.
  const shouldSpliceLlm =
    !memory.llm.enabled && llm.baseUrl && (llm.apiKey || llm.provider === "proxy");
  if (shouldSpliceLlm) {
    memory.llm = {
      enabled: true,
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.model,
      maxTokens: llm.maxTokens ?? 4096,
      timeoutMs: llm.timeoutMs ?? 120_000,
      provider: llm.provider,
      proxy: {
        useMemorySystemUserKey: llm.proxy?.useMemorySystemUserKey ?? true,
      },
    };
  }

  // ── Standalone embedding override pass-through ──
  // Some existing gateway configs place `embedding` at the top level next to
  // `llm`. The memory parser expects it under `memory.embedding`, so splice the
  // top-level block into MemoryTdaiConfig for backward compatibility.
  const topLevelEmbedding = obj(fileConfig, "embedding");
  if (topLevelEmbedding) {
    memory.embedding = {
      ...memory.embedding,
      enabled: bool(topLevelEmbedding, "enabled") ?? memory.embedding.enabled,
      provider: str(topLevelEmbedding, "provider") ?? memory.embedding.provider,
      baseUrl: str(topLevelEmbedding, "baseUrl") ?? memory.embedding.baseUrl,
      apiKey: str(topLevelEmbedding, "apiKey") ?? memory.embedding.apiKey,
      model: str(topLevelEmbedding, "model") ?? memory.embedding.model,
      dimensions: num(topLevelEmbedding, "dimensions") ?? memory.embedding.dimensions,
      sendDimensions: bool(topLevelEmbedding, "sendDimensions") ?? memory.embedding.sendDimensions,
      conflictRecallTopK: num(topLevelEmbedding, "conflictRecallTopK") ?? memory.embedding.conflictRecallTopK,
      maxInputChars: num(topLevelEmbedding, "maxInputChars") ?? memory.embedding.maxInputChars,
      timeoutMs: num(topLevelEmbedding, "timeoutMs") ?? memory.embedding.timeoutMs,
      recallTimeoutMs: num(topLevelEmbedding, "recallTimeoutMs") ?? memory.embedding.recallTimeoutMs,
      captureTimeoutMs: num(topLevelEmbedding, "captureTimeoutMs") ?? memory.embedding.captureTimeoutMs,
      proxyUrl: str(topLevelEmbedding, "proxyUrl") ?? memory.embedding.proxyUrl,
    };
  }

  // ── Skill module config ──
  // Resolution order:
  //   1. Top-level `skill` block in yaml (preferred — skill is a top-level
  //      gateway feature, not buried under `memory`).
  //   2. `memory.skill` (if user nested it under memory by accident).
  //   3. env var TDAI_SKILL_ENABLED forces enabled=true so a one-line
  //      shell flag opts in without touching yaml.
  // The result is *also* spliced onto memory.skill so TdaiCore (which reads
  // from cfg.skill in its config) sees it regardless of which path wired it.
  const topLevelSkill = (fileConfig.skill && typeof fileConfig.skill === "object" && !Array.isArray(fileConfig.skill))
    ? (fileConfig.skill as import("../core/skill/types.js").SkillConfigInput)
    : undefined;
  const envSkillEnabled = env("TDAI_SKILL_ENABLED");
  const skillFromAnywhere: import("../core/skill/types.js").SkillConfigInput | undefined =
    topLevelSkill ?? memory.skill ?? (envSkillEnabled === "true" || envSkillEnabled === "1" ? { enabled: true } : undefined);
  if (skillFromAnywhere) {
    // Last write wins: env-only override forces enabled=true on top of yaml.
    if (envSkillEnabled === "true" || envSkillEnabled === "1") {
      skillFromAnywhere.enabled = true;
    }
    memory.skill = skillFromAnywhere;
  }

  // Deploy mode: "standalone" (open-source single-node) or "service" (cloud multi-tenant)
  const rawMode = env("TDAI_DEPLOY_MODE") ?? str(fileConfig, "deployMode") ?? "standalone";
  const deployMode: DeployMode = rawMode === "service" ? "service" : "standalone";

  // State backend (env > yaml > auto from deployMode)
  const rawBackend = env("STATE_BACKEND") ?? str(fileConfig, "stateBackend");
  const stateBackend = rawBackend === "redis" || rawBackend === "local" ? rawBackend : undefined;

  // Instance ID: service mode requires explicit instanceId from request headers (x-tdai-service-id),
  // standalone mode uses configured or defaults to "default".
  const instanceId = env("TDAI_INSTANCE_ID") ?? str(fileConfig, "instanceId")
    ?? (deployMode === "standalone" ? "default" : undefined);

  // Remote state backend config
  const redisConfig = obj(fileConfig, "redis");
  const redis: RedisConfig = {
    host: env("REDIS_HOST") ?? str(redisConfig, "host") ?? "127.0.0.1",
    port: envInt("REDIS_PORT") ?? num(redisConfig, "port") ?? 6379,
    password: env("REDIS_PASSWORD") ?? str(redisConfig, "password"),
    db: envInt("REDIS_DB") ?? num(redisConfig, "db") ?? 0,
    // v2 default prefix: physically isolated from pre-upgrade "tdai_memory".
    // Upgrade reason: sk/bk hash tag upgraded from {p:inst} to {p:inst:tid:aid},
    // old keys and new keys are not mutually exclusive, mixing them destroys lock mutual exclusion semantics; switching prefix isolates them physically,
    // old data is discarded. If pending tasks in redis need to be kept during upgrade, stop service first + wait for queue to empty.
    keyPrefix: env("REDIS_KEY_PREFIX") ?? str(redisConfig, "keyPrefix") ?? "tdai_memory_v2",
  };

  // Remote config source settings
  const sharkConfig = obj(fileConfig, "shark");
  const shark: SharkConfig = {
    baseUrl: env("SHARK_BASE_URL") ?? str(sharkConfig, "baseUrl"),
    vdbTtlMs: envInt("CONFIG_VDB_TTL_MS") ?? num(sharkConfig, "vdbTtlMs") ?? 300_000,
    cosBufferMs: envInt("CONFIG_COS_BUFFER_MS") ?? num(sharkConfig, "cosBufferMs") ?? 120_000,
    maxInstances: envInt("CONFIG_MAX_INSTANCES") ?? num(sharkConfig, "maxInstances") ?? 1000,
  };

  // Scanner config
  const scannerConfig = obj(fileConfig, "scanner");
  const scanner: ScannerConfig = {
    instances: env("SCANNER_INSTANCES") ?? str(scannerConfig, "instances") ?? "default",
    instancesSharkUrl: env("SCANNER_INSTANCES_SHARK_URL") ?? str(scannerConfig, "instancesSharkUrl"),
    intervalMs: envInt("SCANNER_INTERVAL_MS") ?? num(scannerConfig, "intervalMs") ?? 500,
    nodeId: env("SCANNER_NODE_ID") ?? str(scannerConfig, "nodeId"),
  };

  // Worker config
  const workerConfig = obj(fileConfig, "worker");
  const worker: WorkerConfig = {
    pollMs: envInt("WORKER_POLL_MS") ?? num(workerConfig, "pollMs") ?? 200,
    concurrency: envInt("WORKER_CONCURRENCY") ?? num(workerConfig, "concurrency") ?? 60,
  };

  // COS extra config
  const cosConfig = obj(fileConfig, "cos");
  const cos: CosExtraConfig = {
    domain: env("COS_DOMAIN") ?? str(cosConfig, "domain"),
    generationLogRetentionDays: envInt("COS_GENERATION_LOG_RETENTION_DAYS")
      ?? num(cosConfig, "generationLogRetentionDays")
      ?? 30,
  };
  if (!Number.isInteger(cos.generationLogRetentionDays) || cos.generationLogRetentionDays < 0) {
    throw new Error("cos.generationLogRetentionDays must be a non-negative integer");
  }

  // Observability config (yaml: observability.{otel,clickhouse,kafka}, env fallback)
  const observabilityConfig = obj(fileConfig, "observability");

  // OTel config
  const otelConfig = obj(observabilityConfig, "otel");
  const otel: OTelConfig = {
    enabled: otelConfig.enabled !== undefined
      ? Boolean(otelConfig.enabled)
      : env("TDAI_OTEL_ENABLED") === "true",
    endpoint: str(otelConfig, "endpoint") ?? env("OTEL_EXPORTER_OTLP_ENDPOINT") ?? "http://localhost:4317",
    protocol: (str(otelConfig, "protocol") ?? env("OTEL_EXPORTER_OTLP_PROTOCOL") ?? "grpc") as "grpc" | "http/protobuf",
    serviceName: str(otelConfig, "serviceName") ?? env("OTEL_SERVICE_NAME") ?? "core",
    serviceVersion: str(otelConfig, "serviceVersion") ?? "1.0.0",
    tenantId: str(otelConfig, "tenantId") ?? env("OTEL_TENANT_ID") ?? "",
    logExportInterval: num(otelConfig, "logExportInterval") ?? envInt("OTEL_LOG_EXPORT_INTERVAL") ?? 5,
  };

  // ClickHouse config
  const chConfig = obj(observabilityConfig, "clickhouse");
  const clickhouse: ClickHouseConfig = {
    enabled: chConfig.enabled !== undefined
      ? Boolean(chConfig.enabled)
      : env("CLICKHOUSE_ENABLED") === "true",
    endpoint: str(chConfig, "endpoint") ?? env("CLICKHOUSE_ENDPOINT") ?? "",
    username: str(chConfig, "username") ?? env("CLICKHOUSE_USERNAME") ?? "default",
    password: str(chConfig, "password") ?? env("CLICKHOUSE_PASSWORD") ?? "",
    database: str(chConfig, "database") ?? env("CLICKHOUSE_DATABASE") ?? "tdai_eval",
  };

  // Kafka config
  const kafkaConfig = obj(observabilityConfig, "kafka");
  const kafka: KafkaConfig = {
    brokers: str(kafkaConfig, "brokers") ?? env("KAFKA_METRIC_BROKERS") ?? "",
    topic: str(kafkaConfig, "topic") ?? env("KAFKA_METRIC_TOPIC") ?? "memory_monitor",
    enabled: kafkaConfig.enabled !== undefined
      ? Boolean(kafkaConfig.enabled)
      : (env("KAFKA_METRIC_ENABLED") === "true" || Boolean(str(kafkaConfig, "brokers") ?? env("KAFKA_METRIC_BROKERS"))),
  };

  // Langfuse config
  const langfuseConfig = obj(observabilityConfig, "langfuse");
  const langfuse: LangfuseConfig = {
    enabled: langfuseConfig.enabled !== undefined
      ? Boolean(langfuseConfig.enabled)
      : env("LANGFUSE_ENABLED") === "true",
    host: str(langfuseConfig, "host") ?? env("LANGFUSE_HOST") ?? "",
    publicKey: str(langfuseConfig, "publicKey") ?? env("LANGFUSE_PUBLIC_KEY") ?? "",
    secretKey: str(langfuseConfig, "secretKey") ?? env("LANGFUSE_SECRET_KEY") ?? "",
  };

  const observability: ObservabilityConfig = { otel, clickhouse, kafka, langfuse };

  // Offload executor config (yaml: offload)
  const metadataConfig = obj(fileConfig, "metadata");
  const storeYaml = obj(metadataConfig, "store");
  const systemUserYaml = obj(metadataConfig, "systemUser");
  const memorySystemUserYaml = obj(systemUserYaml, "memory");
  const metadataStore: GatewayMetadataStoreConfig | undefined =
    str(storeYaml, "sqliteBaseDir") || str(storeYaml, "mongoUri") ||
    str(storeYaml, "mongoDbPrefix") ||
    bool(storeYaml, "mongoTransactions") !== undefined || num(storeYaml, "storeCacheMaxInstances") !== undefined
      ? {
          sqliteBaseDir: str(storeYaml, "sqliteBaseDir"),
          mongoUri: str(storeYaml, "mongoUri"),
          mongoTransactions: bool(storeYaml, "mongoTransactions") ?? true,
          storeCacheMaxInstances: num(storeYaml, "storeCacheMaxInstances"),
          mongoDbPrefix: str(storeYaml, "mongoDbPrefix"),
        }
      : undefined;
  const metadata: GatewayMetadataConfig = {
    maxUsersPerInstance: positiveQuotaLimit(
      envInt("TDAI_METADATA_MAX_USERS") ?? num(metadataConfig, "maxUsersPerInstance"),
      500,
    ),
    maxTeamsPerInstance: positiveQuotaLimit(
      envInt("TDAI_METADATA_MAX_TEAMS") ?? num(metadataConfig, "maxTeamsPerInstance"),
      100,
    ),
    configParamsFile: process.env.TDAI_METADATA_CONFIG_PARAMS_FILE || str(metadataConfig, "configParamsFile") || undefined,
    store: metadataStore,
    systemUser: str(memorySystemUserYaml, "userId") || str(memorySystemUserYaml, "userKey") ||
      str(memorySystemUserYaml, "displayName")
      ? {
          memory: {
            userId: str(memorySystemUserYaml, "userId"),
            displayName: str(memorySystemUserYaml, "displayName"),
            userKey: str(memorySystemUserYaml, "userKey"),
          },
        }
      : undefined,
  };

  const offloadConfig = obj(fileConfig, "offload");
  const offload = {
    forceTriggerThreshold: num(offloadConfig, "forceTriggerThreshold") ?? 4,
    pendingMaxAgeSeconds: num(offloadConfig, "pendingMaxAgeSeconds") ?? 30,
    l1Temperature: num(offloadConfig, "l1Temperature") ?? 0.3,
    l1MaxTokens: num(offloadConfig, "l1MaxTokens") ?? 8000,
    l1TimeoutMs: num(offloadConfig, "l1TimeoutMs") ?? 120_000,
    l15Temperature: num(offloadConfig, "l15Temperature") ?? 0.2,
    l15MaxTokens: num(offloadConfig, "l15MaxTokens") ?? 3000,
    l15TimeoutMs: num(offloadConfig, "l15TimeoutMs") ?? 120_000,
    l2Temperature: num(offloadConfig, "l2Temperature") ?? 0.4,
    l2MaxTokens: num(offloadConfig, "l2MaxTokens") ?? 16000,
    l2TimeoutMs: num(offloadConfig, "l2TimeoutMs") ?? 120_000,
    l2NullThreshold: num(offloadConfig, "l2NullThreshold") ?? 6,
    mildOffloadRatio: num(offloadConfig, "mildOffloadRatio") ?? 0.5,
    aggressiveCompressRatio: num(offloadConfig, "aggressiveCompressRatio") ?? 0.85,
    emergencyCompressRatio: num(offloadConfig, "emergencyCompressRatio") ?? 0.95,
    maxRetries: num(offloadConfig, "maxRetries") ?? 3,
  };

  const base: GatewayConfig = {
    deployMode,
    stateBackend,
    instanceId,
    server: { port, host, apiKey, corsOrigins },
    data: { baseDir },
    llm,
    memory,
    redis,
    shark,
    scanner,
    worker,
    cos,
    observability,
    metadata,
    offload,
    skill: skillFromAnywhere,
  };

  // Merge overrides one level deep so partial `server`/`data`/`llm` patches
  // (frequently used by e2e tests) don't accidentally drop sibling fields
  // such as `corsOrigins` introduced after they were written.
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    server: { ...base.server, ...(overrides.server ?? {}) },
    data: { ...base.data, ...(overrides.data ?? {}) },
    llm: { ...base.llm, ...(overrides.llm ?? {}) },
  };
}

// ============================
// Helpers
// ============================

function resolveConfigPath(): string | null {
  // 1. Explicit env var
  const explicit = getEnv("TDAI_GATEWAY_CONFIG")?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  // 2. CWD
  for (const name of ["tdai-gateway.yaml", "tdai-gateway.json"]) {
    const p = path.join(process.cwd(), name);
    if (fs.existsSync(p)) return p;
  }

  // 3. Default data dir
  const dataDir = resolveDefaultDataDir();
  for (const name of ["tdai-gateway.yaml", "tdai-gateway.json"]) {
    const p = path.join(dataDir, name);
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function resolveDefaultDataDir(): string {
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";

  // New canonical location: everything related to standalone/Hermes-mode TDAI
  // is collected under ~/.memory-tencentdb/ to avoid scattering top-level dirs
  // in $HOME. The Gateway data dir lives at:
  //
  //   ~/.memory-tencentdb/memory-tdai/
  //
  // Note: this only governs the standalone/Hermes fallback. Under the openclaw
  // host the plugin data dir is decided by `resolveStateDir() + "memory-tdai"`
  // (typically ~/.openclaw/memory-tdai/) which is intentionally NOT changed.
  const root = getEnv("MEMORY_TENCENTDB_ROOT") ?? path.join(home, ".memory-tencentdb");
  const newDefault = path.join(root, "memory-tdai");

  // Backward compatibility: if the new location does not yet exist but the
  // legacy ~/memory-tdai still has data, keep using the legacy dir so existing
  // users don't silently lose their memory store. The install script
  // (install_hermes_memory_tencentdb.sh, Step 0) will migrate it on next run.
  try {
    if (!fs.existsSync(newDefault)) {
      const legacy = path.join(home, "memory-tdai");
      if (fs.existsSync(legacy)) {
        // Stderr-only deprecation hint; doesn't pollute structured logs.
        process.stderr.write(
          `[tdai-gateway] DEPRECATED: using legacy data dir ${legacy}; ` +
          `move it to ${newDefault} (or set TDAI_DATA_DIR / MEMORY_TENCENTDB_ROOT) to silence this warning.\n`,
        );
        return legacy;
      }
    }
  } catch {
    // existsSync should not throw, but guard anyway.
  }

  return newDefault;
}

function env(key: string): string | undefined {
  const v = getEnv(key)?.trim();
  return v || undefined;
}

function envInt(key: string): number | undefined {
  const v = env(key);
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function obj(c: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = c[key];
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function str(src: Record<string, unknown>, key: string): string | undefined {
  const v = src[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(src: Record<string, unknown>, key: string): number | undefined {
  const v = src[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function positiveQuotaLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback;
}

function bool(src: Record<string, unknown>, key: string): boolean | undefined {
  const v = src[key];
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Read `server.corsOrigins` from yaml or `TDAI_CORS_ORIGINS` from env.
 *
 * Accepted yaml shapes (yaml has precedence over env):
 *   server:
 *     corsOrigins: []                              # explicit empty → no CORS
 *     corsOrigins: ["https://app.example.com"]     # array of allowed origins
 *     corsOrigins: "https://a,https://b"           # comma-separated string
 *
 * Env: `TDAI_CORS_ORIGINS="https://a,https://b"`
 *
 * Returns `[]` when nothing is set — the server interprets that as
 * "do not emit any CORS headers" (most restrictive default).
 */
function resolveCorsOrigins(serverConfig: Record<string, unknown>): string[] {
  // 1. YAML takes precedence so an explicit `corsOrigins: []` can mean
  //    "I want CORS off" even when the env var leaks in from the shell.
  const raw = serverConfig["corsOrigins"];
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map(s => s.trim());
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map(s => s.trim()).filter(Boolean);
  }

  // 2. Fall back to env. Empty string from env is treated as "not set".
  const envValue = env("TDAI_CORS_ORIGINS");
  if (!envValue) return [];
  return envValue.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Recursively replace ``${VAR_NAME}`` placeholders in string leaves with
 * the corresponding ``process.env`` value. Missing variables expand to an
 * empty string, matching the behaviour of the previous simple YAML parser
 * so existing configs keep working after the switch to the full YAML lib.
 *
 * - Only whole-string matches (``"${VAR}"``) are substituted, preserving
 *   types: numbers/booleans/null pass through unchanged.
 * - Arrays and nested objects are walked in-place (new arrays/objects are
 *   returned; the input is not mutated).
 */
function expandEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    const m = value.match(/^\$\{(\w+)\}$/);
    if (m) {
      return process.env[m[1]!] ?? "";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(expandEnvVars);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvVars(v);
    }
    return out;
  }
  return value;
}
