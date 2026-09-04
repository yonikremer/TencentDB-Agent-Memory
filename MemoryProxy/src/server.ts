/** Hono app factory — registers all routes. */

import { Hono } from "hono";
import { handleChatCompletions } from "./handler.js";
import { handleAnthropicMessages } from "./anthropicHandler.js";
import { handleAuxiliaryEndpoint } from "./auxiliaryHandler.js";
import { handleCodexEndpoint } from "./codexHandler.js";
import { handleWorkbuddyEndpoint } from "./workbuddyHandler.js";
import { apiKeyToKeyId, extractBearerToken } from "./opik.js";
import { createSkillBridgeHandler } from "./skill/skill-bridge.js";
import { createMemoryBridgeHandler } from "./memory/memory-bridge.js";
import { createInstanceDestroyHandler } from "./routes/instance-destroy.js";
import { createRateLimitHandlers } from "./routes/rate-limits.js";
import { hasAnalyseMarker, hasCostGuardMarker } from "./routes/whitelist.js";
import { tryActivateStorage, tryActivateRedis } from "./injection/index.js";
import { getEffectiveBackend } from "./storage/factory.js";
import type { ProxyConfig } from "./types.js";

export function createApp(config: ProxyConfig): Hono {
  const app = new Hono();

  // Eagerly activate storage/bindingRepo so bridge-only requests (no main
  // /v1/messages hits yet) can still recover session state via L2 fallthrough
  // (memory-bridge.ts / skill-bridge.ts §6.1 fix). Idempotent; the injection
  // pipeline will still call these later when the first main request lands.
  if (!tryActivateStorage(config)) {
    tryActivateRedis(config);
  }

  // `/cost-guard` marker gating (P0 gate):
  // When markerOptIn=false the marker is completely disabled — any request whose path
  // carries a `/cost-guard/` segment gets a direct 404, avoiding the catch-all `POST /*`
  // catching it and routing it as the default route (which would be confusing: the client
  // thinks it "enabled the marker", but the proxy handles it as default_passthrough).
  // Placed at the very front, before all business routes.
  if (!config.costGuard.markerOptIn) {
    app.use("*", async (c, next) => {
      if (hasCostGuardMarker(c.req.path)) {
        return c.json(
          {
            error: "cost_guard_marker_disabled",
            message:
              "The /cost-guard URL marker is disabled on this deployment. " +
              "Remove the /cost-guard segment from the path, or set costGuard.markerOptIn=true.",
          },
          404,
        );
      }
      await next();
    });
  }

  // `/analyse` marker gating (structure fully aligned with cost-guard):
  // When assetReflection.markerOptIn=false any request carrying an `/analyse/` segment
  // returns 404, preventing the catch-all from silently catching marker requests and
  // treating them as default routes. Previously there was only a registration switch on
  // the primary routes, lacking this top-level rejection — CC/CB-side `/analyse` marker
  // requests would fall through to the catch-all `POST /*` when markerOptIn=false,
  // letting upstream receive a raw body (the marker client thinks it "enabled" the marker
  // but the injector was never actually hit); codex side shows the same symptom (the
  // `/analyse` variant beyond `/cost-guard` reported in P1-6). Fix both together so the
  // two marker gates behave symmetrically.
  if (!config.injection?.assetReflection?.markerOptIn) {
    app.use("*", async (c, next) => {
      if (hasAnalyseMarker(c.req.path)) {
        return c.json(
          {
            error: "analyse_marker_disabled",
            message:
              "The /analyse URL marker is disabled on this deployment. " +
              "Remove the /analyse segment from the path, or set " +
              "injection.assetReflection.markerOptIn=true.",
          },
          404,
        );
      }
      await next();
    });
  }

  // Health check
  //
  // Multi-node scenario: when storage requests cos but degrades to in-process
  // (fs / memory / sqlite), return 503 + degraded=true so the k8s LB removes that pod,
  // avoiding data-consistency incidents like "each node writes to its own memory".
  // sqlite also counts as process-local — each node's local files are not shared either.
  // See docs/design/2026-07-13-proxy-multinode-state-audit.md P0-2.
  app.get("/health", (c) => {
    const eff = getEffectiveBackend();
    const wantsShared = config.storage?.enabled && eff.requested === "cos";
    const degraded = wantsShared && eff.effective !== eff.requested;
    const body = {
      status: degraded ? "degraded" : "ok",
      version: "0.2.0",
      upstream: config.upstream.url,
      opik: config.opik.enabled ? config.opik.url : "disabled",
      costGuard: config.costGuard.enabled ? "enabled" : "disabled",
      rateLimit: config.rateLimit.tpm > 0 || config.rateLimit.qpm > 0 ? "enabled" : "disabled",
      storage: {
        enabled: !!config.storage?.enabled,
        requested: eff.requested,
        effective: eff.effective,
        degraded,
        ...(eff.error ? { lastError: eff.error } : {}),
      },
    };
    return c.json(body, degraded ? 503 : 200);
  });

  // Whoami: resolve API key → key ID (plain text, easy to use with curl)
  app.get("/whoami", (c) => {
    // Support: Authorization header (Bearer), x-api-key header, or ?key= query param
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
    const bearerToken = extractBearerToken(authHeader);
    const xApiKey = c.req.header("x-api-key") ?? "";
    const queryKey = c.req.query("key") ?? "";

    const apiKey = bearerToken || xApiKey || queryKey;

    if (!apiKey) {
      return c.text("Error: No API key provided. Use ?key=YOUR_KEY\n", 400);
    }

    const keyId = apiKeyToKeyId(apiKey);
    return c.text(keyId + "\n");
  });

// Skill bridge: LLM curls land here, proxy injects auth + identity, forwards to core.
  // MUST be registered before the agent-prefixed `/:agent/v1/*` routes below.
  const bridgeHandler = createSkillBridgeHandler(config);
  app.post("/skill-bridge/*", (c) => bridgeHandler(c));

  // Memory bridge: same pattern but reverse-proxying the tdai L0/L1/L2/L3 read-only
  // endpoints. Lets the LLM call <proxy>/memory-bridge/v3/atomic/search etc. via Bash;
  // the proxy injects identity.
  const memoryBridgeHandler = createMemoryBridgeHandler(config);
  app.post("/memory-bridge/*", (c) => memoryBridgeHandler(c));

  // ── Ops endpoint (registered before catch-all `POST /*`) ─────────────────
  // /v3/instance/proxy-destroy — cleans up the proxy-side COS cache + kernel-sts pool
  // when shark destroys an instance. Contract fields align with core `/v3/instance/destroy`;
  // the path is distinguished from core via the `proxy-destroy` action. Auth uses
  // config.admin.apiKey (public when empty).
  const instanceDestroyHandler = createInstanceDestroyHandler(config);
  app.post("/v3/instance/proxy-destroy", (c) => instanceDestroyHandler(c));

  const rateLimitHandlers = createRateLimitHandlers(config);
  app.get("/v3/admin/rate-limits", rateLimitHandlers.get);
  app.put("/v3/admin/rate-limits", rateLimitHandlers.put);
  app.delete("/v3/admin/rate-limits", rateLimitHandlers.delete);

  // ── Session management endpoints (underlying interface for the mem: command, reusable by the panel frontend) ──
  app.post("/v3/session/refresh-cache", (c) => {
    return import("./routes/session-refresh.js").then(({ createSessionRefreshHandler }) =>
      createSessionRefreshHandler(config)(c),
    );
  });
  app.post("/v3/session/force-archive-skill", (c) => {
    return import("./routes/session-force-archive.js").then(({ createSessionForceArchiveHandler }) =>
      createSessionForceArchiveHandler(config)(c),
    );
  });

  // ── Whitelisted primary endpoints ────────────────────────────────────────
  // Anthropic Messages API
  app.post("/v1/messages", (c) => handleAnthropicMessages(c, config));

  // ── Whitelisted auxiliary endpoints (must precede catch-all) ─────────────
  // These endpoints go through a lightweight passthrough handler (they don't enter the
  // route module and don't form a conversation turn).
  // See docs/design/2026-07-02-arbitrary-path-passthrough-design.md
  app.post("/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));

  // Agent-prefixed routes with spaceId — client standard config format:
  //   CC:  ANTHROPIC_BASE_URL=http://<proxy>:8096/claude-code/<spaceId>
  //   CB:  OPENAI_BASE_URL=http://<proxy>:8096/codebuddy/<spaceId>
  // Path examples: /claude-code/mem-example001/v1/messages
  //          /codebuddy/mem-example001/v1/chat/completions
  // `/cost-guard` marker: the primary handler enables the cost-guard route when it
  // detects this segment; the default path (without the marker) skips the router and
  // passes through to upstream directly.
  //
  // The marker mechanism is gated by `config.costGuard.markerOptIn`:
  //   - false (default / production): these two routes are not registered — all requests
  //     go through `/:agent/:spaceId/v1/...` and useGuard in the handler is always true,
  //     behavior equals the historical "route via router by default". In this state any
  //     `/cost-guard/...` request hits no route and reaches the final catch-all or a 404
  //     (the catch-all `/*` exists and would fall through to handleChatCompletions; a
  //     top-level marker→404 rejection was added above, see handler / anthropicHandler).
  //   - true (test environment): register the following two marker routes; the handler
  //     decides whether to go through the router based on the marker.
  // See `hasCostGuardMarker`.
  // Hono prefers matching more precise paths, so these must be registered before the
  // generic `/:agent/:spaceId/v1/...` routes.
  if (config.costGuard.markerOptIn) {
    app.post("/:agent/:spaceId/cost-guard/v1/messages", (c) => handleAnthropicMessages(c, config));
    app.post("/:agent/:spaceId/cost-guard/v1/chat/completions", (c) => handleChatCompletions(c, config));
  }

  // `/analyse` marker (asset-reflection internal effect evaluation) — fully symmetric
  // with cost-guard: gated by `injection.assetReflection.markerOptIn`. The marker is
  // just a transparent tag; when the handler (AssetReflectionInjector) detects it, it
  // appends <asset_reflection> at the end of the system prompt; requests without the
  // marker take the original normal route.
  //
  // ⚠️ Key: when these two routes are not registered, `/{agent}/{spaceId}/analyse/v1/messages`
  // (5 segments) would fall through to the bottom catch-all `POST /*` →
  // handleChatCompletions (OpenAI handler), sending the Anthropic body to the OpenAI
  // endpoint → upstream 400. So whenever markerOptIn=true these two anthropic/openai
  // 5-segment routes must be explicitly registered.
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/:agent/:spaceId/analyse/v1/messages", (c) => handleAnthropicMessages(c, config));
    app.post("/:agent/:spaceId/analyse/v1/chat/completions", (c) => handleChatCompletions(c, config));
  }

  // ── Codex endpoints (must precede generic /:agent/:spaceId routes) ────────
  // Codex CLI clients use the OpenAI Responses API — the third independent protocol path.
  //
  // Client behavior difference: in codex-rs core/src/client.rs the endpoint constant is
  // `/responses` (without /v1), while the CC/CB client constants are `/v1/messages`
  // `/v1/chat/completions` (with /v1). User base_url conventions:
  //   - CC/CB: base without /v1; the client auto-appends /v1/messages etc.
  //   - Codex: base must include /v1 itself; the client appends /responses
  //
  // To unify the three agents' connection style for users (base is always filled in as
  // `/<agent>/<spaceId>` without /v1), the proxy accepts both **with v1** and
  // **without v1** path forms:
  //   /codex/<spaceId>/v1/responses  ← hit when the codex client base includes v1
  //   /codex/<spaceId>/responses     ← hit when the codex client base has no /v1 (aligned with CC/CB usage)
  // Both paths map to handleCodexEndpoint with identical behavior.
  app.post("/codex/:spaceId/v1/responses/compact", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/v1/memories/trace_summarize", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/v1/realtime/calls", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/v1/responses", (c) => handleCodexEndpoint(c, config));
  // Compatible with base_url configured without /v1 (aligned with the CC/CB user experience)
  app.post("/codex/:spaceId/responses/compact", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/memories/trace_summarize", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/realtime/calls", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/responses", (c) => handleCodexEndpoint(c, config));

  // ── Workbuddy endpoints (must precede generic /:agent/:spaceId routes) ────
  // WorkBuddy CLI/Desktop clients use the OpenAI Responses API (same protocol as Codex),
  // but client behavior differs from codex-cli (more sub-paths: compact / trace_summarize
  // / realtime / memories belong to aux; the main endpoint is /v1/responses).
  //
  // Like CC/CB/Codex, both base_url forms with/without /v1 are supported.
  app.post("/workbuddy/:spaceId/v1/responses/compact", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/v1/memories/trace_summarize", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/v1/realtime/calls", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/v1/responses", (c) => handleWorkbuddyEndpoint(c, config));
  // Compatible with base_url configured without /v1
  app.post("/workbuddy/:spaceId/responses/compact", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/memories/trace_summarize", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/realtime/calls", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/responses", (c) => handleWorkbuddyEndpoint(c, config));

  // Codex-side `/cost-guard` / `/analyse` marker routes — fully aligned with CC/CB:
  // the marker is an independent URL segment (after `/{agent}/{spaceId}`) with the same
  // gating switch. When these routes are not registered, the 5-segment path
  // `/codex/{spaceId}/cost-guard/responses` matches neither the 8 exact codex routes
  // above nor any agent-prefixed route, so it falls through to the catch-all
  // `POST /*` → handleChatCompletions, sending the Responses API body to the OpenAI
  // /chat/completions upstream and returning 200 chatcmpl-* which crashes the client.
  //
  // `/cost-guard` semantics: the primary handler enables the cost-guard route when it
  // detects this segment; the codex-side handler must read hasCostGuardMarker when
  // forwarding to upstream to decide whether to go through the router. (codexHandler.ts
  // doesn't yet hook up resolveForwardTarget — see the P1-6 report; this commit only
  // fixes the route registration and the fall-through silent-200 problem so requests
  // reach codexHandler first. Actual support for the cost-guard router split is handled
  // in a separate commit.)
  //
  // `/analyse` semantics: when AssetReflectionInjector detects this segment it appends
  //   the `<asset_reflection>` reflection block at the end of the system prompt;
  //   codexHandler.ts already passes requestPath to the injection pipeline (see the
  //   `requestPath: c.req.path` line in the codexHandler.ts injection section), so once
  //   the routes are registered the `/analyse` marker takes effect for codex immediately.
  if (config.costGuard.markerOptIn) {
    app.post("/codex/:spaceId/cost-guard/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/codex/:spaceId/cost-guard/responses", (c) => handleCodexEndpoint(c, config));
  }
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/codex/:spaceId/analyse/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/codex/:spaceId/analyse/responses", (c) => handleCodexEndpoint(c, config));
  }

  // ── deepseek-harness (dsh) endpoints ──────────────────────────────────────
  // dsh is the official DeepSeek agent harness; protocol = standard OpenAI Chat
  // Completions (POST /chat/completions + SSE), body/messages shape is 100% compatible
  // with the existing CB handler.
  //
  // Client behavior differences (proven by capturing fixtures/*.req.json,
  // see docs/dsh-recon/2026-08-14-dsh-capture-analysis.md):
  //   - dsh source endpoint constant: `${baseURL}/chat/completions` (**without /v1**,
  //     see packages/llm/llm-deepseek/src/adapter.ts:301)
  //   - Recommended user config: OPENAI_BASE_URL=http://<proxy>:8096/dsh/<spaceId>
  //   - Aligned with CC/CB/Codex/Workbuddy conventions, accepting both **with v1**
  //     and **without v1** path forms; users may configure baseURL as `.../dsh/<spaceId>`
  //     or `.../dsh/<spaceId>/v1`
  //
  // main / title / compaction request classification is not done at the route layer;
  // agent-adapters/dsh.ts's classifyRequest decides based on header + body features
  // (see its doc).
  app.post("/dsh/:spaceId/v1/chat/completions", (c) => handleChatCompletions(c, config));
  app.post("/dsh/:spaceId/chat/completions", (c) => handleChatCompletions(c, config));
  // dsh captures so far show no embeddings/moderations/completions; reserve aux endpoints (symmetric with CC/CB)
  app.post("/dsh/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/dsh/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/dsh/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));

  // dsh cost-guard / analyse marker routes — fully symmetric with CC/CB/Codex.
  // Per the codex comments: these four 5-segment paths must be explicitly registered,
  // otherwise they fall through to the catch-all POST /* (default path) and the marker
  // silently stops working.
  if (config.costGuard.markerOptIn) {
    app.post("/dsh/:spaceId/cost-guard/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/dsh/:spaceId/cost-guard/chat/completions", (c) => handleChatCompletions(c, config));
  }
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/dsh/:spaceId/analyse/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/dsh/:spaceId/analyse/chat/completions", (c) => handleChatCompletions(c, config));
  }

  // opencode cost-guard / analyse marker routes — fully symmetric with CC/CB/Codex/dsh.
  // opencode clients use standard OpenAI Chat Completions (POST /v1/chat/completions),
  // same path family as CB/dsh; so the marker-segment route shape matches dsh:
  //   /opencode/{spaceId}/cost-guard/v1/chat/completions
  //   /opencode/{spaceId}/cost-guard/chat/completions (when the client base has no /v1)
  // When these 5-segment paths are not explicitly registered they fall through to the
  // catch-all POST /* and the marker silently stops working. The Router split is already
  // passed to resolveForwardTarget in handler.ts via agentName=agentFromPath("opencode");
  // as long as a route matches, the Router can branch its decision on agentSource=opencode.
  if (config.costGuard.markerOptIn) {
    app.post("/opencode/:spaceId/cost-guard/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/opencode/:spaceId/cost-guard/chat/completions", (c) => handleChatCompletions(c, config));
  }
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/opencode/:spaceId/analyse/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/opencode/:spaceId/analyse/chat/completions", (c) => handleChatCompletions(c, config));
  }

  app.post("/:agent/:spaceId/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/:agent/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/chat/completions", (c) => handleChatCompletions(c, config));

  // Agent-prefixed routes without spaceId (deprecated: no credit reporting)
  app.post("/:agent/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/:agent/v1/chat/completions", (c) => handleChatCompletions(c, config));

  // Legacy /proxy/<spaceId>/ prefix — no agent info, defaults to codebuddy.
  // Kept for compatibility with clients that don't include an agent prefix.
  app.post("/proxy/:spaceId/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/proxy/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/*", (c) => handleChatCompletions(c, config));

  // OpenAI-compatible chat completions (catch-all for any remaining POST paths)
  app.post("/*", (c) => handleChatCompletions(c, config));

  return app;
}
