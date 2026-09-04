/**
 * Whitelist endpoint table: centrally manages the Anthropic/OpenAI endpoints that context-proxy can forward to.
 *
 * This table is the **single source of truth** for three pieces of logic — routing, URL joining, and handler dispatch:
 * - `server.ts` registers Hono routes from this table (exact matches are registered before the catch-all)
 * - `guard-adapter.ts:joinUrl` derives the upstream endpoint suffix from this table instead of a hardcoded two-way branch
 * - `auxiliaryHandler.ts` uses the table to decide whether to pass through and whether to take the stream branch
 *
 * To add an endpoint, just add one entry to `WHITELIST_ENDPOINTS`; no scattered changes needed.
 */

/** Metadata for a whitelist endpoint. */
export interface WhitelistEndpoint {
  /**
   * Suffix of the user request path (exact-matched after the `/proxy/{spaceId}` prefix is stripped).
   * e.g. `/v1/messages/count_tokens`
   */
  pathSuffix: string;
  /**
   * Endpoint portion appended after `upstream.url` when forwarding to upstream.
   * e.g. `/messages/count_tokens` (appended after `https://tokenhub.../v1`)
   */
  upstreamEndpoint: string;
  /**
   * Protocol type: determines the auth header format (anthropic → `x-api-key`, openai → `Authorization: Bearer`)
   * and stays consistent with credit-reporter's usage parsing branch.
   */
  protocol: "anthropic" | "openai";
  /** Whether the endpoint supports streaming responses (SSE). */
  supportsStream: boolean;
  /**
   * Whether this is a primary endpoint: primary endpoints are handled by the existing
   * `handleAnthropicMessages` / `handleChatCompletions` (including routing decisions);
   * non-primary endpoints go through the lightweight `handleAuxiliaryEndpoint`
   * (skips routing; only auth + forward + credit).
   */
  isPrimary: boolean;
}

/**
 * List of currently supported whitelist endpoints.
 *
 * Order doesn't matter — `matchWhitelistEndpoint` sorts internally by `pathSuffix` length
 * **from longest to shortest**, ensuring `/v1/messages/count_tokens` matches before `/v1/messages`.
 */
export const WHITELIST_ENDPOINTS: readonly WhitelistEndpoint[] = [
  // ── Primary endpoints (handled by existing handlers, with routing)────────────────────────
  {
    pathSuffix: "/v1/messages",
    upstreamEndpoint: "/messages",
    protocol: "anthropic",
    supportsStream: true,
    isPrimary: true,
  },
  {
    pathSuffix: "/v1/chat/completions",
    upstreamEndpoint: "/chat/completions",
    protocol: "openai",
    supportsStream: true,
    isPrimary: true,
  },
  // ── Auxiliary endpoints (handled by handleAuxiliaryEndpoint, no routing)─────────
  {
    pathSuffix: "/v1/messages/count_tokens",
    upstreamEndpoint: "/messages/count_tokens",
    protocol: "anthropic",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/embeddings",
    upstreamEndpoint: "/embeddings",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/completions",
    upstreamEndpoint: "/completions",
    protocol: "openai",
    supportsStream: true,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/moderations",
    upstreamEndpoint: "/moderations",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  // ── Codex Responses API endpoints (handled by codexHandler)──────────────
  // Primary endpoint: see codexHandler.ts; joining upstream here keeps joinUrl from
  // falling back to /chat/completions (wrong protocol).
  //
  // The two groups of entries correspond to clients writing base_url with or without
  // /v1; see the codex routing comment in server.ts. matchWhitelistEndpoint matches by
  // pathSuffix length descending, so /v1/responses wins over /responses for clarity.
  {
    pathSuffix: "/v1/responses",
    upstreamEndpoint: "/responses",
    protocol: "openai",
    supportsStream: true,
    isPrimary: true,
  },
  {
    pathSuffix: "/v1/responses/compact",
    upstreamEndpoint: "/responses/compact",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/memories/trace_summarize",
    upstreamEndpoint: "/memories/trace_summarize",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/realtime/calls",
    upstreamEndpoint: "/realtime/calls",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/responses",
    upstreamEndpoint: "/responses",
    protocol: "openai",
    supportsStream: true,
    isPrimary: true,
  },
  {
    pathSuffix: "/responses/compact",
    upstreamEndpoint: "/responses/compact",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/memories/trace_summarize",
    upstreamEndpoint: "/memories/trace_summarize",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/realtime/calls",
    upstreamEndpoint: "/realtime/calls",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
] as const;

/** Cache sorted by suffix length descending, to avoid re-sorting on every match. */
const SORTED_BY_SUFFIX_LEN: readonly WhitelistEndpoint[] = [...WHITELIST_ENDPOINTS].sort(
  (a, b) => b.pathSuffix.length - a.pathSuffix.length,
);

/** `/proxy/{spaceId}` prefix regex: strips only one layer, to avoid mangling a "proxy" literal in the path. */
const PROXY_PREFIX_RE = /^\/proxy\/[^/]+/;
/**
 * Agent prefix regex: matches the `/{agent}[/{spaceId}]/{v1|responses|...}` shape.
 *   - `/claude-code/v1/messages`              → strips `/claude-code`
 *   - `/claude-code/{spaceId}/v1/messages`    → strips `/claude-code/{spaceId}`
 *   - `/codex/{spaceId}/responses`            → strips `/codex/{spaceId}` (codex clients
 *     don't assemble /v1/ themselves like CC/CB; the source endpoint constant is
 *     /responses, so without /v1 in base_url the prefix is immediately followed by
 *     /responses, /memories, etc.)
 * The lookahead allows `/v1/`, `/responses`, `/responses/`, `/memories/`, `/realtime/`
 * to immediately follow; `/v1/` must keep its trailing slash to avoid mangling future
 * `/v1foo`-like paths, while codex endpoints like responses allow an optional trailing
 * slash (e.g. `/responses` is a complete path).
 * Whitelist entries `/v1/messages` and `/responses` themselves are never stripped
 * (they don't match the agent segment — the agent segment is limited to known names).
 */
const AGENT_PREFIX_RE = /^\/(claude-code|codebuddy|codex|cursor|anthropic|openai)(?:\/[^/]+)?(?=\/v1\/|\/responses(?:\/|$)|\/memories\/|\/realtime\/)/i;

/**
 * `/cost-guard` marker regex: an independent segment after `/{agent}/{spaceId}`.
 *
 * Semantics (inverted from the earlier `/direct` marker): **pass-through by default**;
 * only when the request path explicitly carries the `/cost-guard` segment does the
 * primary handler take the cost-guard route.
 *
 * Match conditions (both must hold):
 *   1. lookahead `(?=/)` — the marker is an independent segment (more content follows),
 *      not restricted to immediately preceding `/v1/` or a bare tail. This decouples the
 *      marker from whatever tail the client appends:
 *        - `/codebuddy/{spaceId}/cost-guard/chat/completions` (CB bare tail)
 *        - `/claude-code/{spaceId}/cost-guard/v1/messages` (CC with /v1)
 *      both are recognized as the marker. Stems like `/cost-guarded/`, `/cost-guarding/`
 *      and `/pre-cost-guard/` are cut off because the lookahead requires `/` right after
 *      `/cost-guard`.
 *   2. lookbehind `(?<=(?:/[^/]+){2,})` — the marker must be preceded by ≥ 2 non-empty
 *      segments, so it only matches under `/{agent}/{spaceId}/cost-guard/...` or
 *      `/proxy/{spaceId}/cost-guard/...` structures; a spaceId that happens to be named
 *      "cost-guard" (three-segment structure `/agent/cost-guard/...`) won't false-positive.
 *
 * See `hasCostGuardMarker` for the primary handler to decide whether to **enable** the router;
 * `normalizeWhitelistRequestPath` strips it in sync so whitelist matching keeps working.
 */
const COST_GUARD_MARKER_RE = /(?<=(?:\/[^/]+){2,})\/cost-guard(?=\/)/;

/**
 * `/analyse` marker: structure fully mirrors `/cost-guard` — an independent segment after
 * `/{agent}/{spaceId}`, and a hit means "this request should go through the internal
 * asset-reflection mode".
 *
 * Gated by `injection.assetReflection.markerOptIn`; see `AssetReflectionInjector`. Unlike
 * cost-guard, `/analyse` does **not** register a dedicated Hono route — it is a fully
 * transparent marker: the normal business path keeps processing the request; the injector
 * only appends one more reflection prompt to the end of the system prompt once it detects
 * the marker.
 *
 * `normalizeWhitelistRequestPath` strips this marker so whitelist suffix matching keeps working.
 */
const ANALYSE_MARKER_RE = /(?<=(?:\/[^/]+){2,})\/analyse(?=\/)/;

/**
 * Whether the request path carries the `/cost-guard` marker (an independent segment before `/v1/`).
 * When present, the primary handler takes the full cost-guard route; when absent (default)
 * the request passes straight through to the default upstream.
 */
export function hasCostGuardMarker(requestPath: string): boolean {
  if (!requestPath) return false;
  const withoutQuery = requestPath.split("?", 1)[0] ?? "";
  return COST_GUARD_MARKER_RE.test(withoutQuery);
}

/**
 * Whether the request path carries the `/analyse` marker (same structure as `/cost-guard`).
 * On a hit, `AssetReflectionInjector` appends an `<asset_reflection>` block to the end of
 * the system prompt.
 */
export function hasAnalyseMarker(requestPath: string): boolean {
  if (!requestPath) return false;
  const withoutQuery = requestPath.split("?", 1)[0] ?? "";
  return ANALYSE_MARKER_RE.test(withoutQuery);
}

/**
 * Normalizes a request path for whitelist matching.
 *
 * 1. Strip the query string
 * 2. Strip the `/cost-guard` marker (if any, see `hasCostGuardMarker`)
 * 3. Strip the `/analyse` marker (if any, see `hasAnalyseMarker`)
 * 4. Strip the `/proxy/{spaceId}` prefix (if any)
 * 5. Strip the `/{agent}/{spaceId}` prefix (e.g. `/claude-code/{spaceId}/v1/messages`)
 */
export function normalizeWhitelistRequestPath(requestPath: string): string {
  if (!requestPath) return "";
  const withoutQuery = requestPath.split("?", 1)[0] ?? "";
  // Order matters: strip `/cost-guard` / `/analyse` markers FIRST while the
  // surrounding `/{prefix}/{spaceId}` context is still intact — the markers'
  // lookbehind requires ≥ 2 leading segments. Then AGENT/PROXY prefixes see
  // the canonical `/v1/...` tail (their lookahead needs it) and remove themselves.
  const withoutCostGuard = withoutQuery.replace(COST_GUARD_MARKER_RE, "");
  const withoutAnalyse = withoutCostGuard.replace(ANALYSE_MARKER_RE, "");
  const withoutProxy = withoutAnalyse.replace(PROXY_PREFIX_RE, "");
  return withoutProxy.replace(AGENT_PREFIX_RE, "");
}

/**
 * Matches a whitelist entry from a request path.
 *
 * Matching rules:
 * 1. `normalizeWhitelistRequestPath` normalizes the path (strips query / proxy prefix / agent+spaceId prefix)
 * 2. Try exact suffix matches by `pathSuffix` length **from longest to shortest**
 *
 * @returns the matched whitelist entry, or `null` if none matched
 */
export function matchWhitelistEndpoint(
  requestPath: string,
): WhitelistEndpoint | null {
  const normalized = normalizeWhitelistRequestPath(requestPath);
  if (!normalized) return null;

  for (const entry of SORTED_BY_SUFFIX_LEN) {
    if (normalized === entry.pathSuffix) return entry;
  }
  return null;
}
