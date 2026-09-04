/** Shared type definitions for context-proxy. */

/**
 * Optional private forwarding extension config.
 *
 * The host only understands a few generic fields; every other setting is kept
 * opaque in `options` and passed through to the private extension untouched.
 * The host never inspects, defaults, or type-checks the opaque payload.
 */
export interface CostGuardConfig {
  /** Master switch for the private forwarding extension. */
  enabled: boolean;
  /**
   * Whether the `/cost-guard` URL marker is required to activate the router.
   *
   *   - `false` (default, historical behavior): every request that reaches a
   *     primary handler goes through the cost-guard router (subject to
   *     `enabled`). The `/{agent}/{spaceId}/cost-guard/...` routes are NOT
   *     registered and return 404. This is what production runs — clients that
   *     never learned about the marker continue to work unchanged.
   *   - `true` (opt-in, test env): the router is only activated when the
   *     request path contains the `/cost-guard` segment. Paths without the
   *     marker skip the router and passthrough directly to the default
   *     upstream. Used to A/B compare guarded vs. bare traffic side by side.
   *
   * Independent of `enabled`: when `enabled=false` every request is a
   * passthrough regardless of this flag, matching pre-existing semantics.
   */
  markerOptIn?: boolean;
  /**
   * Pin the agent profile by id ("claude-code", "codebuddy").
   * Empty or "auto" (default) = auto-detect from request headers.
   */
  agentProfile?: string;
  /**
   * Anthropic-specific upstream override (global fallback upstream for Anthropic-protocol requests).
   * Per-agent override (upstream.agents[agent].url) takes higher precedence.
   */
  anthropicUpstream?: {
    url: string;
  };
  /**
   * Opaque private options, forwarded to the extension as-is.
   *
   * Known keys the current cost-guard build understands (still untyped here):
   * `taskArchiveEnabled`, `compress*` / `gate*`, `judge` (enabled, baseUrl,
   * timeouts, everyNToolTurns, latch*), `requestPrepare`, `controlPlane`,
   * analyze/cheap model fields, `agents` (per-agent cheap overrides).
   */
  options: Record<string, unknown>;
}

/**
 * ProxyStorage configuration —— unified storage abstraction layer that migrates
 * injection/skill data from Redis to COS/SQLite/FS. See docs/design/2026-07-10-cos-ttl-nottl-split-plan.md
 *
 * When `enabled: true`, the injection and Skill layers replace the Redis repo
 * with ProxyStorage; otherwise they fully use the original Redis path. CostGuard's `cg:sess:*` is unaffected.
 *
 * Storage key prefixes come in two tiers:
 *   - `ttl/` —— hot cache (Session Init State / Injection Hook warm-up), backed by a COS
 *     lifecycle rule that auto-deletes entries unmodified for `ttlDays` days. Rebuildable, invisible to users.
 *   - `nottl/` —— business state (Binding / Skill extraction / Skill version lock), **no** rule,
 *     kept permanently.
 */
export interface StorageConfig {
  /** Master switch. false = fully use the original Redis path; this migration code is as if never loaded. */
  enabled: boolean;
  /** Preferred backend; on init failure degrade in the order cos → sqlite → fs → memory. */
  backend: "cos" | "sqlite" | "fs" | "memory";
  /**
   * Lifetime (days) of objects under the `ttl/` prefix. Only affects the ttl prefix; nottl is completely unaffected.
   * Default 7 days, aligned with COS lifecycle rule granularity (COS scans on a daily basis).
   */
  ttlDays: number;

  cos: {
    /**
     * Business namespace prefix (isolated from core's memory_v2/cos_data).
     * bucket/region/endpointDomain are all parsed from the CosUrl returned by Shark; nothing to configure.
     */
    rootPrefix: string;
    /**
     * Optional: force VPC private network / custom domain (e.g. `cos.example.com`).
     * If empty, use the host from the CosUrl returned by Shark.
     */
    endpointDomain?: string;
    /**
     * Shark pulls temporary credentials —— each spaceId gets an independent STS, with permissions strictly bound
     * to the two prefixes `proxy_cache/{ttl|nottl}/{spaceId}/*`.
     * See docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.1.
     */
    shark: {
      /** Shark base URL, e.g. `http://gateway.example.com:8000`. */
      baseUrl: string;
      /** Shark HTTP request timeout. Default 10s. */
      timeoutMs: number;
      /** Retry count for 5xx / 429 / network errors / timeouts. Default 2. */
      retryCount: number;
      /** How many ms before STS expiry to refresh early. Default 2min. */
      refreshBufferMs: number;
      /** per-spaceId backend pool cap (LRU). Default 100. */
      maxSpaces: number;
      /** Delay in ms for lazily closing old backends on LRU evict. Default 30_000. */
      graceCloseDelayMs: number;
    };
  };

  sqlite: {
    /** Empty = use PROXY_DB_PATH or ~/.tdai-memory-proxy/proxy.db. */
    dbPath: string;
  };

  fs: {
    fsRoot: string;
  };
}

/** Redis connection configuration for session store (CostGuard + Injection). */
export interface RedisConfig {
  enabled: boolean;
  /** Redis connection URL (e.g. redis://:password@host:port/db). Overrides host/port/password/db if set. */
  url: string;
  /** Redis host. Default: "127.0.0.1". */
  host: string;
  /** Redis port. Default: 6379. */
  port: number;
  /** Redis password. Default: "". */
  password: string;
  /** Redis database index. Default: 0. */
  db: number;
  /** Key prefix for CostGuard session keys. Default: "cg:sess:". */
  keyPrefix: string;
  /** Session TTL in seconds. Default: 1800 (30 minutes). */
  ttlSeconds: number;
  /** Injection layer TTL override (seconds). Defaults to ttlSeconds. */
  injectionTtlSeconds?: number;
}

/** Per-Memory-instance input-token rate limiting. */
export interface RateLimitConfig {
  /** Input tokens per rolling minute. 0 disables the limiter. */
  tpm: number;
  /** Requests per rolling minute, using the same instance × model dimension. */
  qpm: number;
}

/**
 * Langfuse LLM observability configuration.
 *
 * Reports via the official Langfuse SDK. One trace = one turn (one user input);
 * tool-loop requests within the same turn merge into multiple generations under the same trace.
 */
export interface LangfuseConfig {
  enabled: boolean;
  /** Langfuse instance base URL, e.g. http://localhost:3000. */
  host: string;
  /** Langfuse public key (pk-lf-...). */
  publicKey: string;
  /** Langfuse secret key (sk-lf-...). */
  secretKey: string;
  /**
   * Debug mode: when reporting generations, keep the raw Anthropic body structure
   * (including `cache_control` markers / `thinking` blocks / native tool_use form)
   * instead of flattening through `flattenAnthropicMessagesForOpik`.
   *
   * Use case: diagnosing request classification (Fork vs SideQuery vs Main), cache hit rate,
   *      thinking signature validity, and other issues that can only be judged from the raw structure.
   *
   * Cost: reported payload grows 2-5x (cache_control blocks and thinking blocks are all carried over),
   *      increasing Langfuse storage cost. **Off by default in production**; turn on only while troubleshooting.
   */
  debug?: boolean;

  // ── Batch report tuning (avoid losing spans under high concurrency) ──

  /**
   * Max depth of the in-memory queue (overflow is dropped).
   * Maps to OTel BatchSpanProcessor's maxQueueSize. Default 8192.
   */
  maxQueueSize: number;
  /**
   * Max number of spans exported per batch.
   * Maps to LangfuseSpanProcessor's flushAt / OTel maxExportBatchSize. Default 256.
   */
  flushAt: number;
  /**
   * Scheduled flush interval (seconds).
   * Maps to LangfuseSpanProcessor's flushInterval / OTel scheduledDelayMillis. Default 2.
   */
  flushInterval: number;
}

/** Session initialization configuration. */
export interface SessionInitConfig {
  enabled: boolean;
  /** Max retries before degrading (bypass session init on next request). */
  maxRetries: number;
  /**
   * Whether to append the `[Agent]` section of the `<session_context>` block
   * (agent id / name / description / prompt) to the system prompt on every
   * request after session init completes.
   *
   * - `true`  (default): inject `[Agent]` — LLM sees agent identity/persona.
   * - `false`          : suppress `[Agent]` — the block loses the agent segment
   *   (and the entire block disappears if `injectTaskContext` is also false).
   *
   * Global toggle; not per-agent. Use to silence all agent descriptions.
   */
  injectAgentContext?: boolean;
  /**
   * Whether to append the `[Task]` section of the `<session_context>` block
   * (task id / name / description / goal) to the system prompt on every
   * request after session init completes.
   *
   * - `true`  (default): inject `[Task]` — LLM sees the task description.
   * - `false`          : suppress `[Task]` — the block loses the task segment
   *   (and the entire block disappears if `injectAgentContext` is also false).
   *
   * Global toggle; not per-task. Use to silence all task descriptions.
   */
  injectTaskContext?: boolean;
  /**
   * DEBUG-ONLY. When set, session init skips the interactive team → agent →
   * task form flow entirely and registers the session with the given identity
   * on the FIRST request that carries a conversation id. Useful for e2e tests
   * and local smoke checks where you want to exercise the injection pipeline
   * without stepping through the fake AskUserQuestion dialog turns.
   *
   * Leave undefined (or omit the block) in production. The identity is not
   * validated against the caller — it is trusted as-is because this is a
   * developer-facing bypass, not a security feature.
   */
  debugForceIdentity?: {
    team_id: string;
    agent_id: string;
    task_id?: string;
  };
  /**
   * DEBUG: force the userId recognized from the request (auth verify / x-user-id header etc.)
   * to be overridden with the given value. For local integration debugging when the client-sent
   * tokenhub-uid differs from the kernel-uid (kernel-side assets hang under another real user_id),
   * so assets can't be fetched via kernel /team/list, pushing the CB state machine down the
   * "no active agents, passing through" bypass.
   *
   * When this field is configured, the handler layer replaces the recognized value with this user_id,
   * letting the CB state machine fetch the asset list as the real kernel user and pop up the full
   * team→agent→task form flow.
   *
   * Local/e2e debugging only; must be left empty in production.
   */
  debugForceUserId?: string;
  /**
   * DEBUG: enable verbose diagnostic logging (including the request tools schema, system prompt summary,
   * user input text, etc.). Only for local debugging of session-init form interaction issues.
   * Keep false or unset in production (disabled by default).
   */
  debugVerboseLogging?: boolean;
  /**
   * Auto-preselect team/agent/task identity from request headers.
   *
   * When the first-round request header already carries identity fields, first validate them against
   * the (current authenticated user's visible) team/agent/task list: on a hit, skip the corresponding
   * interactive selection step; on missing / validation failure, handle per `onMismatch`. Coexists with
   * control-plane token reverse-lookup —— the header is only a "shortcut path", and does not change the
   * original form / reverse-lookup flow.
   *
   * Decision rules (see session/preset.ts):
   * - only team hit (no agent)              → jump to the agent selection stage
   * - team + agent hit (task optional)      → register directly, skip all forms
   * - any "provided" field not found in list → treat as mismatch, handle per onMismatch
   * - no team header                         → fully use the original flow (zero behavior change)
   */
  /**
   * When the user selects "skip" at the task_select stage, use this task_id as the default association.
   * This task_id does not need to actually exist in control-plane metadata —— it is recorded only as a
   * label and does not affect retrieval isolation (the primary dimensions are team/user/agent/session).
   *
   * Default "default" (enabled). To disable it, configure the empty string `defaultTaskId: ""` in YAML.
   */
  defaultTaskId?: string;
  headerAutoSelect?: {
    /** Whether header auto-preselect is enabled. Default true. */
    enabled: boolean;
    /** Header name carrying team_id (lowercase). Default "x-team-id". */
    teamHeader: string;
    /** Header name carrying agent_id (lowercase). Default "x-agent-id". */
    agentHeader: string;
    /** Header name carrying task_id (lowercase). Default "x-task-id". */
    taskHeader: string;
    /** When a header value isn't found in the user-visible list: 'form' falls back to the interactive form (default) | 'bypass' skips session init entirely. */
    onMismatch: "form" | "bypass";
  };
}

export interface TdaiConfig {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  serviceId: string;
  memory: {
    enabled: boolean;
    /** Master switch for all TDAI memory prompt injection. */
    inject: boolean;
    writeL0: boolean;
    recallL1: boolean;
    injectL2L3: boolean;
    l1Limit: number;
    l2Limit: number;
    timeoutMs: number;
  };
}

/**
 * Core skill data-plane configuration.
 *
 * The proxy talks to the openclaw-plugin gateway (the "core") for two purposes:
 *   1. RAG-driven `<cloud_skills>` injection (calls /v3/skill/search).
 *   2. Fire-and-forget skill extraction trigger (calls /v3/skill/extract?mode=async).
 *
 * The same `serviceToken` is also injected by the /skill-bridge reverse proxy
 * when the LLM curls skill operations, so that the token never appears in any
 * prompt the LLM sees.
 */
export interface CoreSkillConfig {
  /** Default `http://127.0.0.1:8420`. */
  endpoint: string;
  /** Bearer token for /v3/skill/* and /skill-bridge auth-injection. */
  serviceToken: string;
  /** `x-tdai-service-id` header value. Default `context-proxy`. */
  serviceId: string;
  /** Per-call timeout (ms). Default 1500 — RAG is on the session_init hot path. */
  timeoutMs: number;
}

/**
 * Knowledge tools injector configuration.
 *
 * Independent from `coreSkill` so knowledge gateway routing can diverge from
 * skill (e.g. skill via kernel direct-IP, knowledge via API Gateway).
 * Mirrors `CoreSkillConfig` fields — `CoreKnowledgeClient` accepts the same
 * Pick<endpoint | serviceToken | serviceId | timeoutMs>.
 */
export interface KnowledgeConfig {
  /** Master switch. `false` (default) → injector not registered, no injection. */
  enabled: boolean;
  endpoint: string;
  serviceToken: string;
  serviceId: string;
  timeoutMs: number;
}

/** Skill runtime-side configuration. */
export interface SkillRuntimeConfig {
  /**
   * Whether the main model is allowed to create/modify skills. Default false.
   * The main model's quality is not controllable, so write capability is off by default to avoid
   * low-quality skills being created. When explicitly set to true:
   *   - <skill_tools> injects all 10 tools (including write operations)
   *   - /skill-bridge allows write operations (create/update/patch/delete/files_write/files_remove)
   * When false:
   *   - <skill_tools> injects only read-only tools (search/list/view/files_read)
   *   - /skill-bridge rejects write operations with 403
   */
  allowLlmWrite: boolean;

  // Historical fields (deleted):
  //   extractToolCallThreshold / maxBucketCount:
  //     the legacy SkillExtractTrigger used these to control the threshold at which the proxy
  //     auto-fires /v3/skill/extract. The legacy path is fully retired; the core side now owns
  //     the archiving timing (judging on its own by tool_call ≥ 10 or bytes ≥ 40KB).
  //   conversationAddEnabled:
  //     used to be a mutually-exclusive gray rollout switch between the new and legacy paths.
  //     Now conversation/add on the new path is always used, so this switch is obsolete.
}

/**
 * Per-agent upstream override entry. When an agent (identified by URL path
 * prefix like "claude-code") needs a different upstream than the global
 * default, this struct provides the replacement `url` (and optional `apiKey`).
 *
 * Fallback semantics — three cases, matching the runtime `effectiveApiKey`
 * resolution in `handler.ts` / `anthropicHandler.ts`:
 *
 *   ┌──────────────────────────────┬────────────┬──────────────────────────┐
 *   │ agent config                 │ url used   │ apiKey used              │
 *   ├──────────────────────────────┼────────────┼──────────────────────────┤
 *   │ NOT in agents map            │ upstream.url│ upstream.apiKey (global)│
 *   │ in map, url only, no apiKey  │ agent.url  │ passthrough client key  │
 *   │ in map, url + apiKey         │ agent.url  │ agent.apiKey            │
 *   └──────────────────────────────┴────────────┴──────────────────────────┘
 *
 * The presence of an entry cuts the global `upstream.apiKey` fallback —
 * this is intentional so an operator can run some agents on a server-side
 * key and others on the client's own key from a single proxy config.
 *
 * Priority order (high → low):
 *   1. `costGuard`-provided `target.authHeaders` (the cheap-model fallback route's own credentials)
 *   2. `upstream.agents[agent].url` + `upstream.agents[agent].apiKey`
 *   3. `costGuard.anthropicUpstream.url` (Anthropic protocol only)
 *   4. `upstream.url` + `upstream.apiKey` (default when no agent matches)
 *
 * The same map serves both Anthropic and OpenAI protocols — the agent name
 * alone determines routing, matching how {@link ProxyConfig#upstream.url}
 * itself is protocol-agnostic.
 */
export interface AgentUpstreamEntry {
  /** Target upstream base URL. Required. */
  url: string;
  /**
   * Per-agent apiKey. When set (non-empty):
   *   - OpenAI: `Authorization: Bearer <apiKey>` is injected
   *   - Anthropic: `x-api-key: <apiKey>` is injected
   * When absent / empty: the client's own auth header is passed through
   * upstream untouched. This does NOT fall back to `upstream.apiKey` —
   * that fallback only applies when this agent has no entry at all.
   */
  apiKey?: string;
}

/** Top-level proxy configuration (merged from config file + CLI args). */
export interface ProxyConfig {
  server: {
    host: string; // default: "0.0.0.0"
    port: number; // default: 8096
    /** Upstream forward timeout in ms. 0 = no timeout. Default: 600_000 (10 min). */
    forwardTimeoutMs?: number;
  };
  upstream: {
    url: string; // OpenAI-compatible upstream URL
    apiKey: string; // if non-empty, replaces the API Key in requests
    /**
     * Per-agent overrides keyed by agent name (URL path prefix, e.g. "claude-code").
     * Empty / missing entry → agent falls back to `url` + `apiKey`.
     */
    agents: Record<string, AgentUpstreamEntry>;
  };
  log: {
    file: string;    // JSONL path; empty string disables file logging
    verbose: boolean;
    level: "info" | "debug"; // "debug" enables internal-debug.jsonl and requests-debug.jsonl
    /** Log backend type for structured logging (noop | console). Default: console. */
    backend: "noop" | "console";
    /** File rotation settings for structured log file (proxy.log). */
    rotate: {
      maxSizeBytes: number;
      backupLimit: number;
    };
  };
  opik: {
    enabled: boolean;
    url: string;    // Opik server base URL
    apiKey: string; // Opik server auth key (optional)
    /** When true, forked request_log traces/spans do not store message content. */
    stripRequestLogContent: boolean;
  };
  langfuse: LangfuseConfig;
  clickhouse: {
    enabled: boolean;
    url: string;         // ClickHouse HTTP endpoint
    database: string;    // Database name
    table: string;       // Table name for usage logs
    /** Raw usage traceability table (non-TokenHub / unrecognized format). */
    rawTable: string;
    user: string;        // Auth user
    password: string;    // Auth password
    flushIntervalMs: number; // Flush interval in ms
    flushThreshold: number;  // Buffer flush threshold in rows
    /** Data retention TTL in days. 0 = no TTL. Default: 0. */
    ttlDays: number;
  };
  redis: RedisConfig;
  rateLimit: RateLimitConfig;
  storage: StorageConfig;
  costGuard: CostGuardConfig;
  creditReport: CreditReportConfig;
  creditPricing: CreditPricingConfig;  // NEW: model pricing for credit calculation
  injection: InjectionConfig;
  extraction: ExtractionConfig;
  sessionInit: SessionInitConfig;
  tdai: TdaiConfig;
  coreSkill: CoreSkillConfig;
  knowledge: KnowledgeConfig;
  skillRuntime: SkillRuntimeConfig;
  auth: AuthConfig;
  /**
   * Internal service accounts allowed to passthrough the proxy without any
   * injection / session logic. Match is by `userKey` on inbound Authorization.
   * Empty array (default) disables the feature — every request goes through
   * the standard verifyUserKey pipeline.
   */
  systemUsers: SystemUserEntry[];
  /**
   * Ops-portal shared secret, only for admin endpoints like `/v3/instance/proxy-destroy`.
   *
   * Semantics match the core gateway's `server.apiKey`
   * (`tdai-memory-openclaw-plugin/src/gateway/server.ts:1078`):
   *   - empty string (default) = auth off, routes publicly accessible; logs a WARN at startup
   *   - non-empty = request must carry `Authorization: Bearer <apiKey>`, compared in constant time
   *
   * env override: `TDAI_PROXY_ADMIN_API_KEY`.
   *
   * Note: this key does **not** participate in the tenant `verifyUserKey` flow, nor is it related
   * to upstream.apiKey / tdai.apiKey. It only gates the ops-portal endpoints on the proxy side.
   */
  admin: {
    apiKey: string;
  };
  /**
   * `mem:` special command configuration.
   *
   * When enabled=false (default), the handler does not detect mem: commands and all requests go
   * through the original path. When enabled, after session init the handler checks whether the last
   * user message is a mem: command; on a hit it runs the corresponding operation and directly returns
   * a fake LLM response (no injection / no forwarding / no billing).
   *
   * allowedCommands is a command whitelist; an empty array allows all.
   */
  memCommand: MemCommandConfig;

  /**
   * CC request routing master switch.
   *
   * When enabled: requests are classified into main / fork / sidequery three types based on the
   * `cache_control` marker position + tools/thinking fallback, and routed on differentiated paths
   * (fork/sidequery skip session-init / mem interception / injection / L0 / skill buffer; credit is
   * still reported). When disabled: every request is treated as main and goes through the original
   * one-size-fits-all path, behavior 100% equivalent to today.
   *
   * Disabled by default. Before enabling, consider running an observation period of "classify but
   * don't change the path" first, see plan §7. See docs/design/2026-07-30-cc-request-routing-plan.md
   */
  ccRequestRouting: CcRequestRoutingConfig;

  /**
   * WorkBuddy request routing master switch (ops kill switch).
   *
   * When enabled (default): `classifyWorkbuddyRequest` classifies requests into main / auxiliary
   *   types, and auxiliary requests passthrough directly (skipping session-init / injection / L0 /
   *   skill archiving) while credit is still reported.
   * When disabled: every request is treated as main and goes through the full business path ——
   *   equivalent to the legacy path with aux routing disabled, used for a quick rollback when the
   *   aux classification rules misbehave.
   *
   * Enabled by default (unlike CC's `ccRequestRouting.enabled` default of false): WB's aux routing
   *   has already run in production with log verification, so this switch is a "conservative rollback"
   *   safety net rather than a "gray rollout" switch.
   */
  workbuddyRequestRouting: WorkbuddyRequestRoutingConfig;
}

export interface CcRequestRoutingConfig {
  /** Whether CC request routing is enabled. Default false —— when off, uses the legacy path fully equivalent to prior behavior. */
  enabled: boolean;
}

export interface WorkbuddyRequestRoutingConfig {
  /** Whether WB request routing is enabled. Default true —— when off, all requests are treated as main and aux routing is skipped. */
  enabled: boolean;
}

export interface MemCommandConfig {
  /** Whether mem: command interception is enabled. Default false. */
  enabled: boolean;
  /**
   * Command whitelist. Empty array = allow all.
   * e.g. ["sync", "help"] means only mem:sync and mem:help are allowed; other commands are unrecognized.
   */
  allowedCommands: string[];
  /**
   * LLM draft generator config used by mem:create-task / mem:update-task. Optional.
   * When unset or enabled=false, the task command family returns a "task_draft not configured" error.
   * Shape stays consistent with packages/cost-guard's LLMInferConfig.
   */
  taskDraft?: {
    enabled: boolean;
    model: string;
    url: string;
    apiKey: string;
    timeoutMs: number;
  };
}

/** Context injection configuration. */
export interface InjectionConfig {
  enabled: boolean;
  injectors: string[];  // List of injector names to enable (e.g. ["skill", "knowledge", "tdai-memory"])
  /**
   * Unified external gateway URL. The curl examples the LLM generates (paths embedded in the
   * <skill_tools> / <tdai_memory_tools> sections) all use this URL as their base.
   *
   * ⚠️ Required for multi-node deployments: when unset, each pod falls back to its own
   * `http://<hostIp>:<port>`, so pods overwrite the same shared hook cache in COS → md5
   * oscillation → every upstream Anthropic KV cache miss (costly + slow first token).
   *
   * Only fill in the gateway's external domain, **without a port** (the port the gateway uses
   * internally to route to the proxy is the gateway ops side's concern, unrelated to this). Example:
   *   externalGatewayUrl: "https://gateway.example.com"
   *
   * The gateway side must transparently pass through the following two prefixes to the proxy pod:
   *   `/skill-bridge/**`   → proxy /skill-bridge/**
   *   `/memory-bridge/**`  → proxy /memory-bridge/**
   *
   * When unset, fall back to `http://<local hostIp>:<config.server.port>` (only usable in
   * single-node / local development scenarios), warning once at startup.
   */
  externalGatewayUrl?: string;
  /**
   * Asset reflection mode (for internal effectiveness evaluation). **On by default**——so operators
   * can observe asset injection effectiveness with zero config via a URL marker. The marker itself
   * remains opt-in: requests without an `/analyse/` segment are completely unaffected.
   *
   * When enabled, if the request path carries the `/analyse` marker (structure same as `/cost-guard`:
   * wedged after `/{agent}/{spaceId}`, e.g. `/codebuddy/default/analyse/v1/messages`), the proxy
   * appends an `<asset_reflection>` block to the end of the system prompt, instructing the agent to
   * comment in its reply on "whether the cloud asset tools invoked this round actually helped".
   *
   * The marker-segment list is decided by the asset injectors actually registered on this node
   * (skill / tdai-memory / knowledge); when none are registered, no injector emits any block.
   *
   * Posture mirrors `costGuard.markerOptIn`, but the default is inverted:
   *   - `true` (default): injector registers; emits a block only when the URL carries an `/analyse/` segment
   *   - `false`: injector does not register and the top gate 404s any `/analyse/` segment
   */
  assetReflection?: {
    markerOptIn: boolean;
  };
}

/**
 * Extraction (write-side) configuration — dual of {@link InjectionConfig}.
 *
 * Governs whether the proxy is allowed to write back per-turn artifacts to
 * the kernel: skill conversation (fire /v3/skill/conversation/add per round
 * — core-side buffer + archive threshold decide extraction timing) and TDAI L0
 * conversation memory (`addConversation` after each turn).
 *
 * Legacy behavior (yaml missing this section entirely) is preserved by
 * `isExtractionAllowed`: it returns `true` when `config.extraction` is
 * absent. Default values `{enabled: true, extractors: ["skill","tdai-memory"]}`
 * also match the previous "always on" semantics.
 */
export interface ExtractionConfig {
  enabled: boolean;
  /** Asset whitelist. Assets NOT in this array are gated OFF, even if the
   *  underlying dependency (kernel token / tdai config) is present. */
  extractors: string[];
}

/** Auth service configuration — verify user_key and resolve user_id via auth/verify API. */
export interface AuthConfig {
  enabled: boolean;
  /** Auth service base URL (e.g. http://kernel.example.com:8420). */
  url: string;
  /** Request timeout in ms. Default: 5000. */
  timeoutMs: number;
}

/**
 * Internal / system user entry — a user id that identifies an internal
 * service (e.g. TDAI memory backend) rather than an end user.
 *
 * The request's Authorization / x-api-key is first resolved to a user_id
 * by the auth service (verifyUserKey). If that user_id equals this entry's
 * `userId`, the proxy short-circuits: session-init, injection, routing
 * decisions, and body rewriting are all skipped, and the request is forwarded
 * as-is to `config.upstream.url`. Usage / credit reporting still fires,
 * attributed to this entry's `userId` (memory instance / spaceId comes from
 * the request path).
 *
 * Auth must be enabled for the short-circuit to trigger — when it's off,
 * `verifyUserKey` returns an empty user_id and matching cannot happen.
 */
export interface SystemUserEntry {
  /** Short logical name — used for logging (e.g. "memory", "wiki", "skill"). */
  name: string;
  /**
   * User id attributed to this internal user. This is BOTH the match key
   * (against verifyUserKey's resolved user_id) and the attribution key for
   * usage/credit reporting. Required.
   */
  userId: string;
  /** Human-readable display name, for logs / dashboards only. */
  displayName: string;
  /**
   * Historical sk-mem key the internal service sends in Authorization /
   * x-api-key. Kept for log-only / operator-reference purposes; no longer
   * participates in matching (that's `userId`'s job now). Optional.
   */
  userKey?: string;
}

/** Credit usage reporting to external service (e.g. TDAI MemoryPlus). */
export interface CreditReportConfig {
  /** POST endpoint URL. */
  url: string;
  /** Request timeout in ms. */
  timeoutMs: number;
}

/** Credit pricing entry for a single model (Credit / 1K Token). */
export interface CreditPricingEntry {
  /**
   * Model ID for matching (case-insensitive full-word match against usage.model).
   * Semantics: a "unique ID", e.g. `ep-pksklwtb` / `deepseek-v4-pro`.
   */
  name: string;
  /**
   * Human-readable display name for UI/reports (e.g. "Claude Sonnet 4").
   * Optional. Falls back to `name` when absent or empty.
   * Written to usage_logs.model_name / usage_raw.model_name for the frontend to display.
   */
  modelName?: string;
  /** Standard input tokens (non-cache). */
  input: number;
  /** Output tokens. */
  output: number;
  /** Cache read (cache hit) tokens. */
  cacheRead: number;
  /** Cache write with 5-minute TTL (ephemeral). */
  cacheWrite5m: number;
  /** Cache write with 1-hour TTL (standard cache creation). */
  cacheWrite1h: number;
}

/** Credit pricing configuration section. */
export interface CreditPricingConfig {
  models: CreditPricingEntry[];
}

/** Raw YAML config file shape (all fields optional). */
export interface RawYamlConfig {
  server?: {
    host?: string;
    port?: number;
    forwardTimeoutMs?: number;
  };
  upstream?: {
    url?: string;
    apiKey?: string;
    /** Per-agent override map. See `AgentUpstreamEntry`. */
    agents?: Record<string, { url?: string; apiKey?: string } | null | undefined>;
  };
  log?: {
    file?: string;
    verbose?: boolean;
    level?: "info" | "debug";
    backend?: "noop" | "console";
    rotate?: {
      maxSizeBytes?: number;
      backupLimit?: number;
    };
  };
  opik?: {
    enabled?: boolean;
    url?: string;
    apiKey?: string;
    stripRequestLogContent?: boolean;
  };
  redis?: {
    enabled?: boolean;
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    keyPrefix?: string;
    ttlSeconds?: number;
    injectionTtlSeconds?: number;
  };
  rateLimit?: {
    tpm?: number;
    qpm?: number;
  };
  storage?: {
    enabled?: boolean;
    backend?: "cos" | "sqlite" | "fs" | "memory";
    ttlDays?: number;
    cos?: {
      rootPrefix?: string;
      endpointDomain?: string;
      shark?: {
        baseUrl?: string;
        timeoutMs?: number;
        retryCount?: number;
        refreshBufferMs?: number;
        maxSpaces?: number;
        graceCloseDelayMs?: number;
      };
    };
    sqlite?: { dbPath?: string };
    fs?: { fsRoot?: string };
  };
  costGuard?: {
    enabled?: boolean;
    agentProfile?: string;
    anthropicUpstream?: { url?: string };
    /** Opaque private options, kept unparsed and forwarded to the extension. */
    [key: string]: unknown;
  };
  clickhouse?: {
    enabled?: boolean;
    url?: string;
    database?: string;
    table?: string;
    rawTable?: string;
    user?: string;
    password?: string;
    flushIntervalMs?: number;
    flushThreshold?: number;
    ttlDays?: number;
  };
  langfuse?: {
    enabled?: boolean;
    host?: string;
    publicKey?: string;
    secretKey?: string;
    debug?: boolean;
    maxQueueSize?: number;
    flushAt?: number;
    flushInterval?: number;
  };
  creditReport?: { url?: string; timeoutMs?: number };
  creditPricing?: { models?: Partial<CreditPricingEntry>[] };
  /** Opaque private review options, forwarded to the extension untouched. */
  badcaseCollector?: Record<string, unknown>;
  injection?: {
    enabled?: boolean;
    endpoint?: string;
    injectors?: string[];
    externalGatewayUrl?: string;
    assetReflection?: {
      markerOptIn?: boolean;
    };
  };
  extraction?: {
    enabled?: boolean;
    extractors?: string[];
  };
  sessionInit?: {
    enabled?: boolean;
    maxRetries?: number;
    injectAgentContext?: boolean;
    injectTaskContext?: boolean;
    defaultTaskId?: string;
    debugForceIdentity?: {
      team_id?: string;
      agent_id?: string;
      task_id?: string;
    };
    debugForceUserId?: string;
    debugVerboseLogging?: boolean;
    headerAutoSelect?: {
      enabled?: boolean;
      teamHeader?: string;
      agentHeader?: string;
      taskHeader?: string;
      onMismatch?: "form" | "bypass";
    };
  };
  tdai?: {
    enabled?: boolean;
    endpoint?: string;
    apiKey?: string;
    serviceId?: string;
    memory?: Partial<TdaiConfig["memory"]>;
  };
  /**
   * Skill/Kernel bridge config. Historically named `coreSkill`; accepted under
   * either `skill:` or `coreSkill:` in YAML (see `buildConfig`). Internally
   * still stored as `coreSkill` on ProxyConfig — no code churn beyond the
   * YAML alias.
   */
  skill?: Partial<CoreSkillConfig>;
  coreSkill?: Partial<CoreSkillConfig>;
  knowledge?: Partial<KnowledgeConfig>;
  skillRuntime?: {
    allowLlmWrite?: boolean;
  };
  auth?: {
    enabled?: boolean;
    url?: string;
    timeoutMs?: number;
  };
  systemUsers?: Partial<SystemUserEntry>[];
  admin?: {
    apiKey?: string;
  };
  /**
   * mem: command family config (including the LLM draft generator for create-task / update-task).
   * Corresponds to ProxyConfig.memCommand; when unset, the command family follows its default disabled behavior.
   */
  memCommand?: {
    enabled?: boolean;
    allowedCommands?: unknown[];
    taskDraft?: {
      enabled?: unknown;
      model?: unknown;
      url?: unknown;
      apiKey?: unknown;
      timeoutMs?: unknown;
    };
  };
}

/** request event — written when a request is intercepted (metadata only, no messages). */
export interface RequestLogEntry {
  timestamp: string;
  event: "request";
  modelId: string;
  keyId: string; // SHA-256(apiKey).slice(0, 8)
  sessionKey?: string; // conversationId || keyId — per-conversation isolation key
  upstreamUrl: string;
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  routedFrom?: string;     // original model if routing was applied
  routingPercent?: number;  // routing rule percent that triggered
  /**
   * Upstream request id — read from the response header `x-request-id`
   * (typically set by tokenhub / OpenAI-compatible gateways). Empty when
   * upstream did not return one. Used for cross-system tracing/audit.
   */
  upstreamRequestId?: string;
}

/** usage event — written after LLM response is received. */
export interface UsageLogEntry {
  timestamp: string;
  event: "usage";
  modelId: string;
  keyId: string;
  sessionKey?: string; // conversationId || keyId — per-conversation isolation key
  /** Turn sequence number within the session (for per-turn aggregation). */
  turnSeq?: number;
  /** Denoised user input of the turn (non-empty only on the turn's first request). */
  userInput?: string;
  upstreamUrl: string;
  stream: boolean;
  usage: Record<string, unknown>; // raw LLM usage object, unmodified
  routedFrom?: string;     // original model if routing was applied
  /**
   * Scalar counters reported by the optional private request-preparation
   * stage, recorded verbatim. The host neither defines nor interprets the key
   * set — it varies with the extension version, and omitting the field means
   * the stage did not run. See `request-prepare-adapter.ts`.
   */
  extensionStats?: Record<string, unknown>;
  /** Space/tenant ID extracted from /proxy/<spaceId>/... path. */
  spaceId?: string;
  /**
   * Upstream request id — read from the response header `x-request-id`
   * (typically set by tokenhub / OpenAI-compatible gateways). Empty when
   * upstream did not return one. Used for cross-system tracing/audit.
   */
  upstreamRequestId?: string;
}

/**
 * Extension-emitted telemetry event.
 *
 * Emitted by the optional private extension (when loaded) via the injected
 * `writeLogEvent` callback. The host only forwards the payload to the log sink
 * — it does not interpret or generate this event on its own.
 *
 * The field set intentionally mirrors {@link UsageLogEntry} so downstream log
 * consumers can process both events with a single schema; `event` distinguishes
 * them at query time.
 */
export interface AnalyzerUsageLogEntry {
  timestamp: string;
  event: "analyzer_usage";
  modelId: string;
  keyId: string;
  sessionKey?: string;
  turnSeq?: number;
  upstreamUrl: string;
  stream: false;
  usage: Record<string, unknown>;
  /** Original model ID captured for correlation with the parent request. */
  routedFrom?: string;
  spaceId?: string;
  upstreamRequestId?: string;
}

export type LogEntry = RequestLogEntry | UsageLogEntry | AnalyzerUsageLogEntry;
