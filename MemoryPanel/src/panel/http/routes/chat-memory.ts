/**
 * /api/v1/chat-memory/* —— Chat Memory panel dedicated business route (stateless panel architecture).
 *
 Why a single layer instead of going to /meta/{action}:
 *   - New Panel §0 Decision 12.3: `asset/*` and `agent-fixed-asset/*` Phase 1 in meta pass-through
 *     501 (NOT_IN_SCOPE)。
 *   - But the 3-tab Chat Memory panel requires these asset operations. This file is that "12.3 Decision Exception"
 *     is the landing point: it business-wraps only the chat_memory asset class, keeping it isolated from skill/wiki/code_graph.
 *
 * Request conventions (same as /meta/*):
 *   - All POST
 *   - Header must include `X-Tdai-Service-Id` (instance selection) + `X-Tdai-User-Key` (caller identity)
 *   - Return envelope `{ code, message, request_id, data }`
 *
 * Kernel invocation:
 *    Metadata layer goes through `deps.metaKernel.invoke(action, body, ctx)` → kernel `/v3/meta/*`.
 *   Data layer (/layer, /import) goes through `deps.kernelHttp.postEnvelope('/v3/...', body, cred)`.
 *   Panel layer responsibilities: assemble caller header, aggregate multiple calls, validate permissions/type/borrow ≤ 2.
 *
 * 12 endpoints (corresponding to the 3 tabs in frontend web/src/components/ChatMemoryPanel.tsx):
 *   POST /chat-memory/team-assets      Team tab (visibility=team and not me owner)
 *   POST /chat-memory/agent-fixed      Fixed assets tab (fixed_assets of the selected agent)
 *   POST /chat-memory/my-agents        My assets allocation tab (list of agents I own)
 *   POST /chat-memory/mine            (old) asset list where owner=me
 *   POST /chat-memory/create           Create standalone UserAsset (mem-xxx)
 *   POST /chat-memory/patch-scope      Change scope (team ↔ private)
 *   POST /chat-memory/allocate         Allocate (borrow), including ≤ 2 validation
 *   POST /chat-memory/unbind           Unbind from agent
 *   POST /chat-memory/layer           L0/L1/L2/L3 layered lazy loading
 *   POST /chat-memory/layer-delete    Batch delete L0/L1 list (Owner-only)
 *   POST /chat-memory/clear            One-click clear content, keep assets (Owner-only)
 *   POST /chat-memory/import           Import historical conversations into the agent's L0
 */
import type { Hono } from "hono";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import { respondControlError, respondEnvelope } from "../envelope.js";
import type { PanelDeps } from "../../panel-deps.js";
import {
  toKernelCredentials,
  type MetaCallContext,
} from "../../kernel/types.js";
import type { MetaEnvelope } from "../../kernel/envelope.js";
import { MAX_IMPORTED_AGENTS } from "../../domain/chat-memory-governance.js";
import { newExternalAssetId } from "../../domain/asset-id.js";
import { fetchAllMetaListItems } from "./knowledge/common.js";

/**
 * Normalize the `time_start` / `time_end` passed from the time filter on the detail page.
 * Accept any string that can be parsed by `Date` (including `YYYY-MM-DDTHH:mm` from `datetime-local`),
 * Convert them uniformly to UTC ISO8601 and pass to the kernel; return `undefined` for non-strings or unparseable values (treated as no filtering).
 */
function normalizeTimeInput(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t).toISOString();
}

/**
 * Determine "the filtering range is too large, and VDB cannot support this paginated query."
 * Basis: The kernel statistics indicate that there is data in this range (total > 0) and the requested offset is still within the total,
 * but this page returns no records at all. The TCVDB paginated queries (queryL0Paginated / queryL1Paginated)
 * capture exceptions and silently return an empty set when exceeding the supported window (see MemoryCore/src/core/store/tcvdb.ts),
 * so this combination cannot be "truly no data"; it can only mean the query was rejected by VDB.
 * Upon a hit, prompt the user in the frontend to shorten the time range of the filter, rather than incorrectly displaying "No data available."
 */
function isRangeTooLarge(
  total: number,
  returned: number,
  offset: number,
): boolean {
  return total > 0 && returned === 0 && offset < total;
}

// ── Kernel raw type (only list the fields used in this file to avoid SDK dependencies) ────────────
interface AssetRaw {
  asset_id: string;
  team_id: string;
  asset_type: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  visibility: string;
  status: string;
  updated_at: string;
}
interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
}
interface FixedAssetRaw {
  asset_id: string;
  asset_type: string;
  injection_mode?: string;
  priority?: number;
  created_by?: string;
}
interface ListEnvelopeData<T> {
  items: T[];
  total?: number;
  limit?: number;
  offset?: number;
}

// ── Output shape (aligned with frontend MemoryBlock) ─────────────────────────
interface MemoryBlockOut {
  id: string;
  title: string;
  summary: string;
  uploaded_by_user_id: string;
  updated_at_ms: number;
  layer_counts: { L0_messages: number; L1: number; L2: number; L3: number };
  scope?: "team" | "private";
  bound_agent_count?: number;
  agent_id?: string;
}

export function registerChatMemoryRoutes(api: Hono, deps: PanelDeps): void {
  // 4.1 Team Assets tab
  //
  // This tab displays all shared memory assets within the current team.
  //   - visibility=team (shared)
  //   - No distinction is made for the owner; those shared by oneself should also be visible as team assets.
  api.post(
    "/chat-memory/team-assets",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const teamId = requiredTeamId(await readJson(c));
      if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");

      // Paginate to full: kernel DEFAULT_PAGINATION=20, single-page truncation will cause the list to be displayed incompletely
      let listError: MetaEnvelope<unknown> | null = null;
      const items = (
        await fetchAllMetaListItems<AssetRaw>(
          deps,
          ctx,
          "asset/list",
          { team_id: teamId, asset_type: "chat_memory", visibility: "team" },
          (env) => {
            listError = env;
          },
        )
      ).filter(isActive);
      if (listError) return respondEnvelope(c, listError);

      // perf: list interface no longer calculates bound_agent_count (old implementation N+1: M assets × each
      // one agent/list + one summary-by-agents, 20 asset scenario tested 41 kernel calls,
      // User real-world test 3.5s+ lag). The frontend does not display this field in the list UI (layer counts / bindings all
      // (only appears in the right-side detail panel), so it is directly omitted. If binding counts need to be displayed in the list later, go through a separate
      // Lazy-load endpoint, do not return to the main list loop.
      const out: MemoryBlockOut[] = items.map((a) => ({
        id: a.asset_id,
        title: a.name,
        summary: buildSummary(),
        uploaded_by_user_id: a.owner_user_id,
        updated_at_ms: toMs(a.updated_at),
        layer_counts: emptyLayers(),
      }));
      return respondEnvelope(
        c,
        okEnvelope(c, { items: out, total: out.length }),
      );
    },
  );

  // ── 4.2 Fixed Assets tab ─────────────────────────────────────
  //
  // POST /chat-memory/agent-fixed  body: { agent_id }
  //
  // Returns the bindings of asset_type=chat_memory in meta_agent_fixed_assets under this agent.
  // Get the asset details in one go via /v3/meta/agent-fixed-asset/list-with-detail.
  //
  // Permissions (product definition: "Fixed Assets" = assets bound to my owner's agent):
  //    1. agent.owner_user_id === me → can see all assets borrowed by my agent
  //   2. agent.owner_user_id !== me → 403 NOT_YOUR_AGENT
  //    3. No caller identity → 401
  api.post(
    "/chat-memory/agent-fixed",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const agentId = typeof body?.agent_id === "string" ? body.agent_id : "";
      if (!agentId) return respondControlError(c, 400, "MISSING_AGENT_ID");

      const meUserId = await resolveCallerUserId(deps, ctx);
      if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

      // Check agent to get owner to decide filtering strategy
      const agentEnv = await deps.metaKernel.invoke(
        "agent/get",
        { agent_id: agentId },
        ctx,
      );
      if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
        return respondControlError(c, 404, "AGENT_NOT_FOUND");
      }
      if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
      const agent = agentEnv.data as AgentRaw;
      if (agent.owner_user_id !== meUserId) {
        return respondControlError(c, 403, "NOT_YOUR_AGENT");
      }

      // Display strategy: return all physically bound (apply_visibility_filter=false), frontend based on
      // scope + owner gray out entries of "others have switched to private":
      //   - Memory content/details: not allowed to view (frontend display placeholder)
      //   - Unbind operation: allow (entry point for cleaning dirty bindings
      // If filter=true it will directly remove private items from items → users can never
      // Know/clean these residual bindings; filter=false + frontend marking as "perception + cleanable" is a better experience.
      // Pagination note: list-with-detail defaults to limit=20 (DEFAULT_PAGINATION), sorting
      // priority DESC, created_at DESC. When agent binds many assets (skill/wiki/code_graph/
      // when chat_memory is mixed, the chat_memory binding with lower priority will be ranked outside 20
      // Truncating the entire page makes the fixed-asset memory tab lose memory blocks. Here we do pagination aggregation (align
      // MetadataClient.getAgentFixedAssets FA_PAGE_SIZE loop mode), set the agent's
      // Bind all fixed assets back first and then filter, to avoid "capping the limit" causing skills to be lost as they accumulate.
      // items returned by list-with-detail (AgentAssetView) do not include owner_user_id
      interface FixedAssetDetailRaw {
        asset_id: string;
        asset_type: string;
        name: string;
        status: string;
        visibility: string;
        created_at: string;
      }
      const FA_PAGE_SIZE = 100;
      const FA_PAGE_HARD_LIMIT = 500;
      const fixedAssets: FixedAssetDetailRaw[] = [];
      let offset = 0;
      while (true) {
        const listEnv = await deps.metaKernel.invoke(
          "agent-fixed-asset/list-with-detail",
          {
            agent_id: agentId,
            apply_visibility_filter: false,
            touch_usage: false,
            limit: FA_PAGE_SIZE,
            offset,
          },
          ctx,
        );
        if (listEnv.code !== 0) return respondEnvelope(c, listEnv);
        const data =
          listEnv.data as ListEnvelopeData<FixedAssetDetailRaw> | null;
        const page = Array.isArray(data?.items) ? data.items : [];
        fixedAssets.push(...page);
        const total =
          typeof data?.total === "number" ? data.total : fixedAssets.length;
        offset += FA_PAGE_SIZE;
        if (
          fixedAssets.length >= total ||
          page.length === 0 ||
          offset >= FA_PAGE_HARD_LIMIT
        )
          break;
      }

      const items = fixedAssets
        .filter((it) => it.asset_type === "chat_memory")
        .filter(
          (it) =>
            it.status !== "archived" &&
            it.status !== "deprecated" &&
            it.status !== "failed",
        );

      // Get real owner_user_id and updated_at (these two fields are not returned in list-with-detail)
      const out: MemoryBlockOut[] = await Promise.all(
        items.map(async (it) => {
          let ownerUserId = "";
          let updatedAt = it.created_at; // Fallback: use created_at when asset/get fails
          try {
            const aEnv = await deps.metaKernel.invoke(
              "asset/get",
              { asset_id: it.asset_id },
              ctx,
            );
            if (aEnv.code === 0 && aEnv.data) {
              const a = aEnv.data as AssetRaw;
              ownerUserId = a.owner_user_id;
              updatedAt = a.updated_at || it.created_at;
            }
          } catch {
            /* fallback empty */
          }
          return {
            id: it.asset_id,
            title: it.name,
            summary: buildSummary(),
            uploaded_by_user_id: ownerUserId,
            updated_at_ms: toMs(updatedAt),
            // Pass through to frontend for graying out: team displays normally, private is grayed out + tagged as "Set as private by owner"
            scope: it.visibility === "private" ? "private" : "team",
            // TEMP: For local testing display; should be lazy-loaded in production
            layer_counts: emptyLayers(),
            agent_id: agentId,
          };
        }),
      );
      return respondEnvelope(
        c,
        okEnvelope(c, { items: out, total: out.length }),
      );
    },
  );

  // ── 4.3b My Assets Allocation tab (new semantics)─────────────────────────
  //
  // POST /chat-memory/my-agents  body: { team_id }
  //
  // Product semantics: one agent = one memory, the "My Asset Allocation" tab displays all agents owned by me,
  // Each agent has a "Team Visible" switch (scope). Here we return the block view corresponding to each agent's chat_memory
  // block (block.id = chat_memory-{team}-{agent}, title = agent.name,
  // scope comes from the visibility of the agent's own chat_memory).
  api.post(
    "/chat-memory/my-agents",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const teamId = requiredTeamId(body);
      if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");

      const meUserId = await resolveCallerUserId(deps, ctx);
      if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

      // Pull all agents from the team, then filter by owner=me in the panel layer
      // (tdai /v3/meta/agent/list ignores owner_user_id when team_id is passed, so you need to filter it yourself)
      // Pull the full list with pagination: truncating to 20 per page will cause the "My Agents" list to be incomplete when the team has more than 20 agents
      let agentListError: MetaEnvelope<unknown> | null = null;
      const agents = (
        await fetchAllMetaListItems<AgentRaw & { name: string; description?: string }>(
          deps,
          ctx,
          "agent/list",
          { team_id: teamId, status: "active" },
          (env) => {
            agentListError = env;
          },
        )
      ).filter((a) => a.owner_user_id === meUserId);
      if (agentListError) return respondEnvelope(c, agentListError);

      // Each agent corresponds to a block of memory: check the chat_memory asset (if already auto-minted) to get the visibility
      const out: MemoryBlockOut[] = await Promise.all(
        agents.map(async (a) => {
          const assetId = `chat_memory-${teamId}-${a.agent_id}`;
          let visibility: "team" | "private" = "private";
          let updated_at_ms = 0;
          try {
            const assetEnv = await deps.metaKernel.invoke(
              "asset/get",
              { asset_id: assetId },
              ctx,
            );
            if (assetEnv.code === 0 && assetEnv.data) {
              const asset = assetEnv.data as AssetRaw;
              visibility = asset.visibility === "team" ? "team" : "private";
              updated_at_ms = toMs(asset.updated_at);
            }
          } catch {
            /* asset does not exist → keep private + 0 */
          }
          return {
            id: assetId,
            title: a.name, // ← Use agent name as block title, consistent with "one agent, one block memory"
            summary: buildSummary(),
            uploaded_by_user_id: meUserId,
            updated_at_ms,
            layer_counts: emptyLayers(),
            scope: visibility,
            agent_id: a.agent_id,
          };
        }),
      );
      return respondEnvelope(
        c,
        okEnvelope(c, { items: out, total: out.length }),
      );
    },
  );

  // 4.3 My Assets tab
  api.post("/chat-memory/mine", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = requiredTeamId(body);
    if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");

    // caller = the user_id corresponding to the current user_key (looked up via auth/verify reverse lookup, frontend-provided parameters are not trusted)
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

    // Paginate to full: truncating 20 items per page will cause the "My Assets" list to be incomplete when there are more than 20 items
    let listError: MetaEnvelope<unknown> | null = null;
    const items = (
      await fetchAllMetaListItems<AssetRaw>(
        deps,
        ctx,
        "asset/list",
        { team_id: teamId, asset_type: "chat_memory", owner_user_id: meUserId },
        (env) => {
          listError = env;
        },
      )
    ).filter(isActive);
    if (listError) return respondEnvelope(c, listError);

    const out: MemoryBlockOut[] = await Promise.all(
      items.map(async (a) => ({
        id: a.asset_id,
        title: a.name,
        summary: buildSummary(),
        uploaded_by_user_id: a.owner_user_id,
        updated_at_ms: toMs(a.updated_at),
        // TEMP: For local testing display; in production, change to lazy loading or pull on demand when clicked by the frontend
        layer_counts: emptyLayers(),
        scope: (a.visibility === "private" ? "private" : "team") as
          | "team"
          | "private",
      })),
    );
    return respondEnvelope(c, okEnvelope(c, { items: out, total: out.length }));
  });

  // 4.7 Create UserAsset
  //
  // tdai asset/create schema requires asset_id + owner_user_id to be required (cannot be looked up from header),
  // so the panel layer needs to:
  //   1. auth/verify to get caller user_id
  //   2. generate mem-xxx id with newExternalAssetId('chat_memory')
  //   3. then asset/create
  api.post("/chat-memory/create", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = requiredTeamId(body);
    if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 200) {
      return respondControlError(c, 400, "INVALID_TITLE");
    }
    const scope = body?.scope === "private" ? "private" : "team";
    const description =
      typeof body?.description === "string" ? body.description : undefined;

    // Reverse lookup caller user_id
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

    const createEnv = await deps.metaKernel.invoke(
      "asset/create",
      {
        asset_id: newExternalAssetId("chat_memory"),
        team_id: teamId,
        asset_type: "chat_memory",
        name: title,
        description,
        owner_user_id: meUserId,
        source_type: "uploaded",
        visibility: scope,
      },
      ctx,
    );
    if (createEnv.code !== 0) return respondEnvelope(c, createEnv);
    const asset = createEnv.data as AssetRaw;
    return respondEnvelope(
      c,
      okEnvelope(c, {
        id: asset.asset_id,
        title: asset.name,
        summary: buildSummary(),
        uploaded_by_user_id: asset.owner_user_id,
        updated_at_ms: toMs(asset.updated_at),
        layer_counts: emptyLayers(),
        scope: asset.visibility === "private" ? "private" : "team",
      } satisfies MemoryBlockOut),
    );
  });

  // ── 4.10 Import historical conversations into the agent memory pool ──────────────────────
  //
  // POST /chat-memory/import  body: { team_id, agent_id, session_id?, messages: [{role, content, ts?}] }
  //
  // Semantics: "Insert this historical conversation as L0 into the selected agent's memory pool", allowing the tdai pipeline to proceed subsequently
  // Automatically distill L1/L2/L3. **No new asset** —— the agent's chat_memory asset has been
  // ensureChatMemoryAsset auto-registration, this interface only writes data plane L0.
  //
  // Permissions: agent.owner = me (can only import into your own agent)
  //
  // go tdai /v3/conversation/add:
  //   body: { team_id, user_id (=agent.owner), agent_id, session_id, messages }
  api.post("/chat-memory/import", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = requiredTeamId(body);
    const agentId = typeof body?.agent_id === "string" ? body.agent_id : "";
    const rawMessages = body?.messages;
    if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");
    if (!agentId) return respondControlError(c, 400, "MISSING_AGENT_ID");
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return respondControlError(c, 400, "MISSING_MESSAGES");
    }
    // tdai conversationAddRequestSchema limit 100, exceeding it will be blocked by the kernel → panel layer also 100
    if (rawMessages.length > 100) {
      return respondControlError(c, 400, "TOO_MANY_MESSAGES");
    }

    // Normalize messages
    interface Msg {
      role: string;
      content: string;
      ts?: string;
    }
    const messages: Msg[] = [];
    for (const raw of rawMessages) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const role = typeof m.role === "string" ? m.role : "";
      const content = typeof m.content === "string" ? m.content : "";
      if (!role || !content) continue;
      messages.push({
        role,
        content,
        ts: typeof m.ts === "string" ? m.ts : undefined,
      });
    }
    if (messages.length === 0) {
      return respondControlError(c, 400, "NO_VALID_MESSAGES");
    }

    // Permission: agent.owner = me
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");
    const agentEnv = await deps.metaKernel.invoke(
      "agent/get",
      { agent_id: agentId },
      ctx,
    );
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, "AGENT_NOT_FOUND");
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;
    if (agent.team_id !== teamId)
      return respondControlError(c, 400, "AGENT_NOT_IN_TEAM");
    if (agent.owner_user_id !== meUserId)
      return respondControlError(c, 403, "NOT_YOUR_AGENT");

    // session_id fallback: can be passed by the caller, or generated as imported-{ts}
    const sessionId =
      typeof body?.session_id === "string" && body.session_id.trim()
        ? body.session_id.trim()
        : `imported-${Date.now().toString(36)}`;

    // go to data plane conversation/add; user_id uses agent.owner_user_id (data plane isolated by owner)
    const cred = toKernelCredentials(ctx, { timeoutMs: 15_000 });
    const addEnv = await deps.kernelHttp.postEnvelope<{
      accepted_ids?: string[];
    }>(
      "/v3/conversation/add",
      {
        team_id: teamId,
        user_id: agent.owner_user_id,
        agent_id: agentId,
        session_id: sessionId,
        messages,
      },
      cred,
    );
    if (addEnv.code !== 0) return respondEnvelope(c, addEnv);
    const acceptedCount =
      (addEnv.data as { accepted_ids?: string[] } | null)?.accepted_ids
        ?.length ?? 0;

    return respondEnvelope(
      c,
      okEnvelope(c, {
        imported: true,
        block_id: `chat_memory-${teamId}-${agentId}`,
        session_id: sessionId,
        accepted_count: acceptedCount,
      }),
    );
  });

  // 4.8 Change scope
  //
  // Dual validation:
  //   1. Panel layer: asset_type === 'chat_memory' (to prevent the chat-memory route from being used to modify
  //       the visibility of other types of assets, this route is dedicated to chat-memory)
  //   2. tdai layer: `updateAssetForCaller` goes through `assertCallerIsAssetOwner`, non-owner
  //       directly permission_denied
  api.post(
    "/chat-memory/patch-scope",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const blockId = requiredBlockId(body);
      if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
      const scope =
        body?.scope === "private"
          ? "private"
          : body?.scope === "team"
            ? "team"
            : undefined;
      if (!scope) return respondControlError(c, 400, "INVALID_SCOPE");

      // Verify that the target asset is chat_memory
      const preEnv = await deps.metaKernel.invoke(
        "asset/get",
        { asset_id: blockId },
        ctx,
      );
      if (preEnv.code === 404 || (preEnv.code === 0 && !preEnv.data)) {
        return respondControlError(c, 404, "BLOCK_NOT_FOUND");
      }
      if (preEnv.code !== 0) return respondEnvelope(c, preEnv);
      const preAsset = preEnv.data as AssetRaw;
      if (preAsset.asset_type !== "chat_memory") {
        return respondControlError(c, 400, "NOT_CHAT_MEMORY");
      }

      const env = await deps.metaKernel.invoke(
        "asset/update",
        { asset_id: blockId, visibility: scope },
        ctx,
      );
      if (env.code !== 0) return respondEnvelope(c, env);
      const asset = env.data as AssetRaw;
      // After making private: no longer prune bindings of other agents proactively by backend
      //   1. Kernel permission model requires caller = agent.owner to set; owner can only set their own agent
      //   2. Keeping dirty bindings is harmless: downstream injection / memory-bridge will call on the read side
      //      apply_visibility_filter=true filters out items where canBindAsset=false;
      //      Details page will also be filtered and will not be displayed
      //   3. Frontend shows a confirm prompt to the user when switching to the private button, stating "Other agents have been bound and cannot be used"
      return respondEnvelope(
        c,
        okEnvelope(c, {
          updated: true,
          id: asset.asset_id,
          scope: asset.visibility === "private" ? "private" : "team",
        }),
      );
    },
  );

  // 4.5a Batch set fixed memory (atomic check + single set, avoiding multiple allocate concurrent overwrites)
  api.post(
    "/chat-memory/set-agent-fixed",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const agentId = typeof body?.agent_id === "string" ? body.agent_id : "";
      const teamId = typeof body?.team_id === "string" ? body.team_id : "";
      const rawBlockIds = Array.isArray(body?.block_ids) ? body.block_ids : [];
      if (!agentId) return respondControlError(c, 400, "MISSING_AGENT_ID");
      if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");

      const blockIds = Array.from(
        new Set(
          rawBlockIds.filter(
            (id): id is string =>
              typeof id === "string" && id.trim().length > 0,
          ),
        ),
      );
      const selfChatMemoryId = `chat_memory-${teamId}-${agentId}`;
      const importedIds = blockIds.filter((id) => id !== selfChatMemoryId);
      if (importedIds.length > MAX_IMPORTED_AGENTS) {
        return respondControlError(c, 400, "IMPORT_LIMIT_EXCEEDED");
      }

      const meUserId = await resolveCallerUserId(deps, ctx);
      if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

      const agentEnv = await deps.metaKernel.invoke(
        "agent/get",
        { agent_id: agentId },
        ctx,
      );
      if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
        return respondControlError(c, 404, "AGENT_NOT_FOUND");
      }
      if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
      const agent = agentEnv.data as AgentRaw;
      if (agent.team_id !== teamId)
        return respondControlError(c, 400, "AGENT_NOT_IN_TEAM");
      if (agent.owner_user_id !== meUserId)
        return respondControlError(c, 403, "NOT_YOUR_AGENT");

      for (const blockId of importedIds) {
        const assetEnv = await deps.metaKernel.invoke(
          "asset/get",
          { asset_id: blockId },
          ctx,
        );
        if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
          return respondControlError(c, 404, "BLOCK_NOT_FOUND");
        }
        if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
        const asset = assetEnv.data as AssetRaw;
        if (asset.asset_type !== "chat_memory")
          return respondControlError(c, 400, "NOT_CHAT_MEMORY");
        if (asset.team_id !== teamId)
          return respondControlError(c, 400, "TEAM_MISMATCH");
        if (asset.visibility !== "team" && asset.owner_user_id !== meUserId) {
          return respondControlError(c, 403, "ASSET_NOT_SHARED");
        }
      }

      // Pagination to fetch full data: kernel DEFAULT_PAGINATION=20, without passing limit only fetch the first 20 items,
      // The following set is a full replacement → when there are ≥21 items, the old binding will be silently cleared.
      let bindListError: MetaEnvelope<unknown> | null = null;
      const existing = await fetchAllMetaListItems<FixedAssetRaw>(
        deps,
        ctx,
        "agent-fixed-asset/list",
        { agent_id: agentId },
        (env) => {
          bindListError = env;
        },
      );
      if (bindListError) return respondEnvelope(c, bindListError);
      const nonMemoryBindings = existing.filter(
        (b) => b.asset_type !== "chat_memory",
      );
      const selfBinding = existing.find(
        (b) =>
          b.asset_type === "chat_memory" && b.asset_id === selfChatMemoryId,
      );
      const newBindings = [
        ...nonMemoryBindings.map((b) => ({
          asset_id: b.asset_id,
          asset_type: b.asset_type,
          injection_mode: b.injection_mode ?? "direct",
          priority: b.priority ?? 50,
          created_by: b.created_by,
        })),
        ...(selfBinding
          ? [
              {
                asset_id: selfBinding.asset_id,
                asset_type: selfBinding.asset_type,
                injection_mode: selfBinding.injection_mode ?? "summary",
                priority: selfBinding.priority ?? 50,
                created_by: selfBinding.created_by ?? agent.owner_user_id,
              },
            ]
          : []),
        ...importedIds.map((blockId) => ({
          asset_id: blockId,
          asset_type: "chat_memory",
          injection_mode: "summary",
          priority: 50,
          created_by: agent.owner_user_id,
        })),
      ];

      const setEnv = await deps.metaKernel.invoke(
        "agent-fixed-asset/set",
        { agent_id: agentId, bindings: newBindings },
        ctx,
      );
      if (setEnv.code !== 0) return respondEnvelope(c, setEnv);
      return respondEnvelope(
        c,
        okEnvelope(c, {
          updated: true,
          agent_id: agentId,
          block_ids: [selfChatMemoryId, ...importedIds],
        }),
      );
    },
  );

  // 4.5 Allocation (Borrowing) + ≤ 2 Validation
  api.post(
    "/chat-memory/allocate",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const blockId = requiredBlockId(body);
      const agentId = typeof body?.agent_id === "string" ? body.agent_id : "";
      const teamId = typeof body?.team_id === "string" ? body.team_id : "";
      if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
      if (!agentId) return respondControlError(c, 400, "MISSING_AGENT_ID");
      if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");

      // Verify asset exists + type + team are consistent
      const assetEnv = await deps.metaKernel.invoke(
        "asset/get",
        { asset_id: blockId },
        ctx,
      );
      if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
        return respondControlError(c, 404, "BLOCK_NOT_FOUND");
      }
      if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
      const asset = assetEnv.data as AssetRaw;
      if (asset.asset_type !== "chat_memory") {
        return respondControlError(c, 400, "NOT_CHAT_MEMORY");
      }
      if (asset.team_id !== teamId) {
        return respondControlError(c, 400, "TEAM_MISMATCH");
      }

      // Verify agent exists + same team
      const agentEnv = await deps.metaKernel.invoke(
        "agent/get",
        { agent_id: agentId },
        ctx,
      );
      if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
        return respondControlError(c, 404, "AGENT_NOT_FOUND");
      }
      if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
      const agent = agentEnv.data as AgentRaw;
      if (agent.team_id !== teamId) {
        return respondControlError(c, 400, "AGENT_NOT_IN_TEAM");
      }

      // Permission check (normal user perspective): can only borrow assets from "owners of their own agents"
      // The target asset must be visibility=team (shared by the team), or owned by themselves (self-use is also OK)
      const meUserId = await resolveCallerUserId(deps, ctx);
      if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");
      if (agent.owner_user_id !== meUserId) {
        return respondControlError(c, 403, "NOT_YOUR_AGENT");
      }
      if (asset.visibility !== "team" && asset.owner_user_id !== meUserId) {
        return respondControlError(c, 403, "ASSET_NOT_SHARED");
      }

      // Prohibit reassigning agent's own chat_memory back to itself; its own memory is fixedly stored by auto-mint,
      // The allocation entry is only used to borrow shared memory from other agents into the current agent.
      const selfChatMemoryId = `chat_memory-${teamId}-${agentId}`;
      if (blockId === selfChatMemoryId) {
        return respondControlError(
          c,
          400,
          "Cannot reassign this Agent's own memory to itself.",
        );
      }

      // Pull existing bindings (pull all in full pagination, reason same as 4.4 borrowing: set is a full replacement,
      // single-page 20-item truncation will silently clear bindings from the 21st onwards, and the imported count will also be distorted)
      let bindListError: MetaEnvelope<unknown> | null = null;
      const bindings = await fetchAllMetaListItems<FixedAssetRaw>(
        deps,
        ctx,
        "agent-fixed-asset/list",
        { agent_id: agentId },
        (env) => {
          bindListError = env;
        },
      );
      if (bindListError) return respondEnvelope(c, bindListError);
      if (bindings.some((b) => b.asset_id === blockId)) {
        return respondControlError(
          c,
          409,
          "This memory has been assigned to the Agent and does not need to be reassigned.",
        );
      }

      // Borrow ≤ 2 validation: non-owned chat_memory count
      const imported = bindings.filter(
        (b) =>
          b.asset_type === "chat_memory" && b.asset_id !== selfChatMemoryId,
      );
      if (imported.length >= MAX_IMPORTED_AGENTS) {
        return respondControlError(c, 400, "IMPORT_LIMIT_EXCEEDED");
      }

      // Combination: list → append → set (tdai has no append endpoint)
      const newBindings = [
        ...bindings.map((b) => ({
          asset_id: b.asset_id,
          asset_type: b.asset_type,
          injection_mode: b.injection_mode ?? "summary",
          priority: b.priority ?? 50,
          created_by: b.created_by,
        })),
        {
          asset_id: blockId,
          asset_type: "chat_memory",
          injection_mode: "summary",
          priority: 50,
          created_by: agent.owner_user_id, // using agent owner as the bound created_by
        },
      ];
      const setEnv = await deps.metaKernel.invoke(
        "agent-fixed-asset/set",
        { agent_id: agentId, bindings: newBindings },
        ctx,
      );
      if (setEnv.code !== 0) return respondEnvelope(c, setEnv);
      return respondEnvelope(
        c,
        okEnvelope(c, {
          allocated: true,
          agent_id: agentId,
          block_id: blockId,
        }),
      );
    },
  );

  // 4.6 Unbind
  api.post("/chat-memory/unbind", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const blockId = requiredBlockId(body);
    const agentId = typeof body?.agent_id === "string" ? body.agent_id : "";
    const teamId = typeof body?.team_id === "string" ? body.team_id : "";
    if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
    if (!agentId) return respondControlError(c, 400, "MISSING_AGENT_ID");
    if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");

    // Prohibit unbinding the agent's "own" chat_memory (created by auto-mint)
    const selfChatMemoryId = `chat_memory-${teamId}-${agentId}`;
    if (blockId === selfChatMemoryId) {
      return respondControlError(c, 400, "CANNOT_UNBIND_SELF_CHAT_MEMORY");
    }

    // Permission check (normal user perspective): can only unbind the borrowed agent on "their own owner's" agent
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");
    const agentEnv = await deps.metaKernel.invoke(
      "agent/get",
      { agent_id: agentId },
      ctx,
    );
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw | null;
    if (!agent) return respondControlError(c, 404, "AGENT_NOT_FOUND");
    if (agent.team_id !== teamId) {
      return respondControlError(c, 400, "AGENT_NOT_IN_TEAM");
    }
    if (agent.owner_user_id !== meUserId) {
      return respondControlError(c, 403, "NOT_YOUR_AGENT");
    }

    // Verify that asset is chat_memory (to prevent this route from being used as a general fixed-asset unbind entry)
    const assetEnv = await deps.metaKernel.invoke(
      "asset/get",
      { asset_id: blockId },
      ctx,
    );
    if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
      return respondControlError(c, 404, "BLOCK_NOT_FOUND");
    }
    if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
    const asset = assetEnv.data as AssetRaw;
    if (asset.asset_type !== "chat_memory") {
      return respondControlError(c, 400, "NOT_CHAT_MEMORY");
    }

    // Fetch the agent's bindings: besides the current target, also filter out stale bindings
    // where canBindAsset=false (e.g., someone made the asset private but never cleared the
    // binding); otherwise the next full rewrite triggers kernel asset_not_bindable 409.
    // Here list-with-detail pulls every binding at once and filters locally by each one's
    // asset visibility, avoiding N asset/get calls. Fetch pages fully: set replaces everything, so a 20-row page would not silently drop bindings 21+.
    let bindListError: MetaEnvelope<unknown> | null = null;
    interface BindingWithDetail {
      asset_id: string;
      asset_type: string;
      injection_mode?: string;
      priority?: number;
      created_by?: string;
      visibility?: string;
      status?: string;
    }
    const detailBindings = await fetchAllMetaListItems<BindingWithDetail>(
      deps,
      ctx,
      "agent-fixed-asset/list-with-detail",
      { agent_id: agentId, apply_visibility_filter: true, touch_usage: false },
      (env) => {
        bindListError = env;
      },
    );
    if (bindListError) return respondEnvelope(c, bindListError);

    // If blockId is not in the items after filtering, it means it was not bound in the first place, or the kernel determined that caller cannot bind
    // Both cases are treated as "the current actually resolvable bindings do not contain blockId" → 404 for clear UI semantics
    // But also handle the scenario where "binding exists but was filtered out due to privacy" — in this scenario, unbinding should also be allowed,
    // and need to confirm the original binding exists using a list without filter.
    const targetInFilteredList = detailBindings.some(
      (b) => b.asset_id === blockId,
    );
    if (!targetInFilteredList) {
      // Confirmation pagination also fetches the full list: if the target binding is ranked 21+, a single-page list will miss it and falsely judge a 404
      let rawListError: MetaEnvelope<unknown> | null = null;
      const raw = await fetchAllMetaListItems<FixedAssetRaw>(
        deps,
        ctx,
        "agent-fixed-asset/list",
        { agent_id: agentId },
        (env) => {
          rawListError = env;
        },
      );
      if (rawListError) return respondEnvelope(c, rawListError);
      const exists = raw.some((b) => b.asset_id === blockId);
      if (!exists) return respondControlError(c, 404, "BINDING_NOT_FOUND");
      // Exists but filtered out due to visibility —— belongs to "dirty bindings to be cleaned up", allow to continue
    }

    // set remaining filtered by apply_visibility_filter=true (excluding the target blockId),
    // to ensure all canBindAsset pass.
    const remaining = detailBindings.filter((b) => b.asset_id !== blockId);
    const setEnv = await deps.metaKernel.invoke(
      "agent-fixed-asset/set",
      {
        agent_id: agentId,
        bindings: remaining.map((b) => ({
          asset_id: b.asset_id,
          asset_type: b.asset_type,
          injection_mode: b.injection_mode ?? "summary",
          priority: b.priority ?? 50,
          created_by: b.created_by ?? meUserId,
        })),
      },
      ctx,
    );
    if (setEnv.code !== 0) return respondEnvelope(c, setEnv);
    return respondEnvelope(
      c,
      okEnvelope(c, { unbound: true, agent_id: agentId, block_id: blockId }),
    );
  });

  // ── 4.4 Layered Lazy Loading ─────────────────────────────────────────
  //
  // POST /chat-memory/layer  body: { block_id, layer, limit?, offset? }
  //   layer ∈ 'L0' | 'L1' | 'L2' | 'L3'
  //
  // Reverse-engineer team_id/agent_id from asset_id, call the tdai data plane (not /v3/meta/*):
  //   L0 → /v3/conversation/query
  //   L1 → /v3/atomic/query
  //   L2 → /v3/scenario/ls
  //   L3 → /v3/core/read
  //
  // Only supports system auto-registered chat_memory-{team}-{agent} (agent_id can be reverse-resolved);
  // User-built UserAsset (mem-xxx) has no associated agent, return empty directly.
  api.post("/chat-memory/layer", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const blockId = requiredBlockId(body);
    const layerRaw =
      typeof body?.layer === "string" ? body.layer.toUpperCase() : "";
    const limit =
      typeof body?.limit === "number" && body.limit > 0 && body.limit <= 200
        ? body.limit
        : 50;
    const offset =
      typeof body?.offset === "number" && body.offset >= 0 ? body.offset : 0;
    // before_ts: L0 cursor pagination parameter (ISO8601). Starting from the second page, the frontend passes the "created_at of the last message",
    // the backend converts it to time_end (-1ms exclusive) and passes it to the kernel /v3/conversation/query, with offset reset to zero.
    // This way, VDB only needs to filter recorded_at_ms < cursor, without skipping a large number of records.
    const beforeTs =
      typeof body?.before_ts === "string" ? body.before_ts.trim() : undefined;
    // time_start / time_end: detail page time filter (ISO8601), only applies to L0 / L1 stored by time;
    // L2 (scenario/ls) and L3 (core/read) are aggregation products, the kernel has no time dimension, ignore this filter.
    const timeStart = normalizeTimeInput(body?.time_start);
    const timeEnd = normalizeTimeInput(body?.time_end);

    if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
    if (!["L0", "L1", "L2", "L3"].includes(layerRaw))
      return respondControlError(c, 400, "INVALID_LAYER");
    const layer = layerRaw as "L0" | "L1" | "L2" | "L3";

    // Invert team_id / agent_id
    const parsed = parseChatMemoryAssetId(blockId);
    if (!parsed) {
      // User-created UserAsset —— No associated agent, no layer data to fetch, return empty directly
      return respondEnvelope(
        c,
        okEnvelope(c, { layer, items: [], total: 0, limit, offset }),
      );
    }

    // Data plane calls require additional team_id / agent_id / user_id / session_id
    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

    // ── ACL check: prevent reading private content by knowing asset_id ─────────────
    // Conditions for allowing read (any one):
    //   a) caller is the asset's owner (self-use)
    //   b) asset.visibility='team' (team has shared it)
    //   c) asset is bound to some agent under caller's name (borrowed relationship)
    //
    // asset metadata is fetched from asset/get; c needs to iterate over the fixed-list of the caller's agent.
    const assetEnv = await deps.metaKernel.invoke(
      "asset/get",
      { asset_id: blockId },
      ctx,
    );
    if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
      return respondControlError(c, 404, "BLOCK_NOT_FOUND");
    }
    if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
    const asset = assetEnv.data as AssetRaw;
    if (asset.asset_type !== "chat_memory") {
      return respondControlError(c, 400, "NOT_CHAT_MEMORY");
    }

    // Read permission (owner / team-shared / borrowed, any one) - extracted
    // authorizeChatMemoryRead reused, shares the same ACL with /chat-memory/search to avoid
    // Inconsistent permission criteria caused by two logical branches.
    const canRead = await authorizeChatMemoryRead(
      deps,
      ctx,
      asset,
      meUserId,
      blockId,
    );
    if (!canRead) return respondControlError(c, 403, "ASSET_NOT_ACCESSIBLE");

    // chat_memory data is written by asset owner (isolated by its user_id), and caller may not be the owner
    // (in borrowing scenarios). Use asset.owner_user_id as the data-plane user_id.
    const ownerUserId = asset.owner_user_id;

    const cred = toKernelCredentials(ctx, { timeoutMs: 15_000 });

    // v3 strict isolation: session_id is required. 'default' is passed for management plane aggregation scenarios
    const idFields = {
      team_id: parsed.teamId,
      agent_id: parsed.agentId,
      user_id: ownerUserId,
      session_id: "default",
    };

    try {
      if (layer === "L0") {
        // Key: do not pass session_id, tdai aggregates and returns all messages (team,user,agent) across sessions
        // tdai returns { messages: [...], total } instead of { items: [...] }
        const { session_id: _drop, ...noSid } = idFields;
        void _drop;

        // Cursor pagination: before_ts → time_end (-1ms exclusive).
        // The kernel /v3/conversation/query time_end is recorded_at_ms <= timeEndMs (inclusive),
        // but the cursor semantics need to be exclusive (< beforeTs), otherwise the last item would be returned repeatedly.
        // Subtracting 1ms converts the inclusive condition to an exclusive one. Millisecond precision is sufficient (duplicates within the same ms are extremely rare and the frontend has id deduplication as a fallback).
        const l0Query: Record<string, unknown> = { ...noSid };
        if (timeStart) l0Query.time_start = timeStart;
        // The upper bound of the cursor (before_ts) and the filter upper bound (time_end) take the earlier one (intersection): pagination cannot exceed the user's selected time range.
        let l0TimeEnd = timeEnd;
        if (beforeTs) {
          const d = new Date(beforeTs);
          if (Number.isFinite(d.getTime())) {
            const cursorEnd = new Date(d.getTime() - 1).toISOString();
            l0TimeEnd =
              !l0TimeEnd || cursorEnd < l0TimeEnd ? cursorEnd : l0TimeEnd;
            l0Query.offset = 0; // In cursor mode, offset is reset to zero
          }
        } else {
          l0Query.offset = offset;
        }
        if (l0TimeEnd) l0Query.time_end = l0TimeEnd;
        l0Query.limit = limit;

        const env = await deps.kernelHttp.postEnvelope<{
          messages?: unknown[];
          total?: number;
        }>("/v3/conversation/query", l0Query, cred);
        if (env.code !== 0) return respondEnvelope(c, env);
        const data = (env.data as {
          messages?: Array<Record<string, unknown>>;
          total?: number;
        } | null) ?? { messages: [] };
        // Range too large detection: total > 0 and offset still within total, but this page returns empty —— TCVDB pagination query when exceeding
        // When supporting the window, silently return an empty set (see MemoryCore tcvdb.ts), this combination cannot be "truly no data"
        // Only when the query is rejected by VDB, prompt the user to shorten the time range of the filter.
        if (
          isRangeTooLarge(data.total ?? 0, (data.messages ?? []).length, offset)
        ) {
          return respondControlError(c, 400, "RANGE_TOO_LARGE");
        }
        return respondEnvelope(
          c,
          okEnvelope(c, {
            layer,
            items: (data.messages ?? []).map((m) => ({
              id: m.id ?? "",
              role: typeof m.role === "string" ? m.role : "msg",
              title: `${m.role ?? "msg"} @ ${m.session_id ?? ""}`,
              body:
                typeof m.content === "string"
                  ? m.content
                  : JSON.stringify(m.content ?? ""),
              tags: m.role ? [String(m.role)] : [],
              refs: [],
              // L0 Time source (v3 kernel actual return):
              //   - timestamp (ISO string) —— standard field of kernel conversation/query
              //   - recorded_at_ms / timestamp numeric ms —— some old data/internal fields
              created_at:
                (typeof m.timestamp === "string" && m.timestamp) ||
                msToIso(m.recorded_at_ms) ||
                msToIso(m.timestamp) ||
                undefined,
            })),
            total: data.total ?? (data.messages ?? []).length,
            limit,
            offset,
          }),
        );
      }

      if (layer === "L1") {
        const l1Query: Record<string, unknown> = { ...idFields, limit, offset };
        if (timeStart) l1Query.time_start = timeStart;
        if (timeEnd) l1Query.time_end = timeEnd;
        const env = await deps.kernelHttp.postEnvelope<{
          items?: unknown[];
          total?: number;
        }>("/v3/atomic/query", l1Query, cred);
        if (env.code !== 0) return respondEnvelope(c, env);
        const data = (env.data as {
          items?: Array<Record<string, unknown>>;
          total?: number;
        } | null) ?? { items: [] };
        // Same as L0: total > 0 but this page is empty = filter range is too large, VDB cannot support this query.
        if (
          isRangeTooLarge(data.total ?? 0, (data.items ?? []).length, offset)
        ) {
          return respondControlError(c, 400, "RANGE_TOO_LARGE");
        }
        return respondEnvelope(
          c,
          okEnvelope(c, {
            layer,
            items: (data.items ?? []).map((r) => ({
              id: r.record_id ?? r.id,
              title: (r.type ?? "atomic") as string,
              body: r.content ?? "",
              tags: r.tags ?? [],
              refs: [],
              // L1 Time source (v3 kernel actual return):
              //   - created_at (ISO string) —— standard field returned by kernel atomic/query
              //   - created_time_ms (numeric ms) / timestamp_str —— legacy data compatibility
              created_at:
                (typeof r.created_at === "string" && r.created_at) ||
                msToIso(r.created_time_ms) ||
                (typeof r.timestamp_str === "string" && r.timestamp_str
                  ? r.timestamp_str
                  : undefined),
            })),
            total: data.total ?? (data.items ?? []).length,
            limit,
            offset,
          }),
        );
      }

      if (layer === "L2") {
        const requestedPath =
          typeof body?.path === "string" ? body.path.trim() : "";
        if (requestedPath) {
          const readEnv = await deps.kernelHttp.postEnvelope<{
            content?: string | null;
          }>("/v3/scenario/read", { ...idFields, path: requestedPath }, cred);
          if (readEnv.code !== 0) return respondEnvelope(c, readEnv);
          const readData = readEnv.data as { content?: string | null } | null;
          const content =
            typeof readData?.content === "string" ? readData.content : "";
          const readTime =
            (
              readData as
                | {
                    updated_at?: string;
                    modified_at?: string;
                    created_at?: string;
                  }
                | null
                | undefined
            )?.updated_at ??
            (readData as { modified_at?: string } | null | undefined)
              ?.modified_at ??
            (readData as { created_at?: string } | null | undefined)
              ?.created_at;
          return respondEnvelope(
            c,
            okEnvelope(c, {
              layer,
              items: [
                {
                  id: requestedPath,
                  title: requestedPath,
                  body: content,
                  tags: content ? ["markdown"] : [],
                  refs: [],
                  created_at: readTime,
                },
              ],
              total: content ? 1 : 0,
              limit: 1,
              offset: 0,
            }),
          );
        }

        // scenario/ls only returns the L2 title list; the specific Markdown original is handled by the frontend after clicking a single item
        // Also pass path back to this interface to trigger scenario/read, avoiding opening all md at once.
        const env = await deps.kernelHttp.postEnvelope<{
          entries?: unknown[];
          total?: number;
        }>("/v3/scenario/ls", idFields, cred);
        if (env.code !== 0) return respondEnvelope(c, env);
        const data = (env.data as {
          entries?: Array<Record<string, unknown>>;
          total?: number;
        } | null) ?? { entries: [] };
        const entries = data.entries ?? [];
        return respondEnvelope(
          c,
          okEnvelope(c, {
            layer,
            items: entries.map((r) => {
              const path =
                typeof r.path === "string" ? r.path : String(r.id ?? "");
              // L2 Time Source (scenario/ls): updated_at / modified_at / updated_time_ms
              const t =
                (typeof r.updated_at === "string" && r.updated_at) ||
                (typeof r.modified_at === "string" && r.modified_at) ||
                msToIso(r.updated_time_ms) ||
                undefined;
              return {
                id: path,
                title: path,
                body: "",
                tags: [],
                refs: [],
                created_at: t,
              };
            }),
            total: data.total ?? entries.length,
            limit,
            offset,
          }),
        );
      }

      // L3
      const env = await deps.kernelHttp.postEnvelope<{
        content?: string;
        version?: string;
        updated_at?: string;
      }>("/v3/core/read", idFields, cred);
      if (env.code !== 0) return respondEnvelope(c, env);
      const data =
        (env.data as {
          content?: string;
          version?: string;
          updated_at?: string;
        } | null) ?? {};
      const content = stripL3SceneTail(data.content ?? "");
      return respondEnvelope(
        c,
        okEnvelope(c, {
          layer,
          items: content
            ? [
                {
                  id: "core",
                  title: "core memory",
                  body: content,
                  tags: [],
                  refs: [],
                  created_at: data.updated_at,
                },
              ]
            : [],
          total: content ? 1 : 0,
          limit,
          offset,
        }),
      );
    } catch (err) {
      return respondControlError(
        c,
        500,
        `LAYER_FETCH_ERROR: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // ==========================================================================
  // POST /chat-memory/clear  body: { memory_ids: string[] }
  //
  // One-click clear the **entire content** of several chat_memory, but preserve the assets themselves: asset_id,
  // Team/Agent ownership, Agent binding, ACL, Owner, name, visibility remain unchanged, after clearing
  // Agent continues to write with the original memory_id, no rebuild needed.
  //
  // Permission: only Asset Owner. The panel only does "must be chat_memory and caller is owner"
  // Fast pre-interception (provides readable error code), final authoritative validation in kernel
  // `/v3/chat-memory/clear` (that side is also Owner-only, and the entire batch is rejected if any id is invalid).
  //==========================================================================
  api.post("/chat-memory/clear", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);

    const rawIds = body?.memory_ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return respondControlError(c, 400, "MISSING_MEMORY_IDS");
    }
    // Deduplicate and discard empty strings; align the limit with the kernel CHAT_MEMORY_CLEAR_MAX.
    const memoryIds = [
      ...new Set(
        rawIds
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0),
      ),
    ];
    if (memoryIds.length === 0)
      return respondControlError(c, 400, "MISSING_MEMORY_IDS");
    if (memoryIds.length > MAX_CLEAR_MEMORY_IDS) {
      return respondControlError(c, 400, "TOO_MANY_MEMORY_IDS");
    }

    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

    // Pre-check the entire batch: if any id does not exist / is not chat_memory / is not owner → reject the entire batch,
    // do not clear any one. Consistent with kernel semantics, to avoid "reporting an error after clearing half".
    for (const memoryId of memoryIds) {
      const assetEnv = await deps.metaKernel.invoke(
        "asset/get",
        { asset_id: memoryId },
        ctx,
      );
      if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
        return respondControlError(c, 404, "BLOCK_NOT_FOUND");
      }
      if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
      const asset = assetEnv.data as AssetRaw;
      if (asset.asset_type !== "chat_memory") {
        return respondControlError(c, 400, "NOT_CHAT_MEMORY");
      }
      if (asset.owner_user_id !== meUserId) {
        return respondControlError(c, 403, "NOT_ASSET_OWNER");
      }
    }

    const cred = toKernelCredentials(ctx, { timeoutMs: 60_000 });
    try {
      const env = await deps.kernelHttp.postEnvelope<unknown>(
        "/v3/chat-memory/clear",
        { memory_ids: memoryIds },
        cred,
      );
      return respondEnvelope(c, env);
    } catch (err) {
      return respondControlError(
        c,
        500,
        `CLEAR_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // ==========================================================================
  // POST /chat-memory/layer-delete
  //   body: { block_id, layer: 'L0' | 'L1', message_ids?, session_ids?, ids? }
  //
  // Batch delete entry for the detail page list:
  //   L0 → /v3/conversation/delete （message_ids up to 5000 / session_ids up to 100）
  //   L1 → /v3/atomic/delete       （ids up to 5000）
  //
  // Permissions: only the asset Owner — read can be borrowed (see the ACL in /chat-memory/layer),
  // but deletion is only allowed for the Owner, to prevent borrowers from clearing others' memories.
  // ==========================================================================
  api.post(
    "/chat-memory/layer-delete",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const blockId = requiredBlockId(body);
      const layerRaw =
        typeof body?.layer === "string" ? body.layer.toUpperCase() : "";

      if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
      if (layerRaw !== "L0" && layerRaw !== "L1")
        return respondControlError(c, 400, "INVALID_LAYER");
      const layer = layerRaw as "L0" | "L1";

      const parsed = parseChatMemoryAssetId(blockId);
      // User-built UserAsset (mem-xxx) is not associated with an agent, and there is no data plane content to delete.
      if (!parsed) return respondControlError(c, 400, "NOT_AGENT_MEMORY");

      const meUserId = await resolveCallerUserId(deps, ctx);
      if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

      const assetEnv = await deps.metaKernel.invoke(
        "asset/get",
        { asset_id: blockId },
        ctx,
      );
      if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
        return respondControlError(c, 404, "BLOCK_NOT_FOUND");
      }
      if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
      const asset = assetEnv.data as AssetRaw;
      if (asset.asset_type !== "chat_memory")
        return respondControlError(c, 400, "NOT_CHAT_MEMORY");
      if (asset.owner_user_id !== meUserId)
        return respondControlError(c, 403, "NOT_ASSET_OWNER");

      // Data plane is isolated by asset owner's user_id (consistent with /chat-memory/layer).
      const idFields = {
        team_id: parsed.teamId,
        agent_id: parsed.agentId,
        user_id: asset.owner_user_id,
        session_id: "default",
      };

      const cred = toKernelCredentials(ctx, { timeoutMs: 60_000 });
      try {
        if (layer === "L0") {
          const messageIds = normalizeIdList(
            body?.message_ids,
            MAX_L0_DELETE_MESSAGE_IDS,
          );
          const sessionIds = normalizeIdList(
            body?.session_ids,
            MAX_L0_DELETE_SESSION_IDS,
          );
          if (messageIds === null || sessionIds === null) {
            return respondControlError(c, 400, "TOO_MANY_IDS");
          }
          if (messageIds.length === 0 && sessionIds.length === 0) {
            return respondControlError(c, 400, "MISSING_IDS");
          }
          // No session_id passed: takes effect across sessions based on (team, user, agent),
          // consistent with the aggregation criteria of /chat-memory/layer reading L0.
          const { session_id: _drop, ...noSid } = idFields;
          void _drop;
          const env = await deps.kernelHttp.postEnvelope<{
            deleted_count?: number;
          }>(
            "/v3/conversation/delete",
            {
              ...noSid,
              ...(messageIds.length > 0 ? { message_ids: messageIds } : {}),
              ...(sessionIds.length > 0 ? { session_ids: sessionIds } : {}),
            },
            cred,
          );
          return respondEnvelope(c, env);
        }

        const ids = normalizeIdList(body?.ids, MAX_L1_DELETE_IDS);
        if (ids === null) return respondControlError(c, 400, "TOO_MANY_IDS");
        if (ids.length === 0) return respondControlError(c, 400, "MISSING_IDS");
        const env = await deps.kernelHttp.postEnvelope<{
          deleted_count?: number;
        }>("/v3/atomic/delete", { ...idFields, ids }, cred);
        return respondEnvelope(c, env);
      } catch (err) {
        return respondControlError(
          c,
          500,
          `LAYER_DELETE_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // ==========================================================================
  // POST /chat-memory/layer-update
  //   body: { block_id, layer: 'L1'|'L2'|'L3', id?, content, summary? }
  //
  // Edit single-layer memory content (Owner-only —— same scope as layer-delete / clear: reads can be borrowed in,
  // but content modification is only allowed by the asset Owner, to prevent the borrower from altering others' memories):
  //   L1 → /v3/atomic/update   { id, content }         (id = record primary key record_id)
  //   L2 → /v3/scenario/write  { path, content, summary? } (path = file path; content
  //         strips the META header first, and the kernel automatically rebuilds it using the existing META)
  //   L3 → /v3/core/write      { content }              (kernel automatically strips scene navigation)
  // ==========================================================================
  api.post(
    "/chat-memory/layer-update",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const ctx = buildCtx(c);
      const body = await readJson(c);
      const blockId = requiredBlockId(body);
      const layerRaw =
        typeof body?.layer === "string" ? body.layer.toUpperCase() : "";
      const content = typeof body?.content === "string" ? body.content : null;
      const itemId = typeof body?.id === "string" ? body.id.trim() : "";
      const summary =
        typeof body?.summary === "string" ? body.summary : undefined;

      if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
      if (layerRaw !== "L1" && layerRaw !== "L2" && layerRaw !== "L3")
        return respondControlError(c, 400, "INVALID_LAYER");
      const layer = layerRaw as "L1" | "L2" | "L3";
      if (content === null) return respondControlError(c, 400, "MISSING_CONTENT");
      // L1 (records primary key) / L2 (file path) both need to locate a single record; L3 is the entire persona, no id needed.
      if ((layer === "L1" || layer === "L2") && !itemId)
        return respondControlError(c, 400, "MISSING_ITEM_ID");

      const parsed = parseChatMemoryAssetId(blockId);
      // User-built UserAsset (mem-xxx) is not associated with an agent, and there is no data plane content to modify.
      if (!parsed) return respondControlError(c, 400, "NOT_AGENT_MEMORY");

      const meUserId = await resolveCallerUserId(deps, ctx);
      if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

      const assetEnv = await deps.metaKernel.invoke(
        "asset/get",
        { asset_id: blockId },
        ctx,
      );
      if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
        return respondControlError(c, 404, "BLOCK_NOT_FOUND");
      }
      if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
      const asset = assetEnv.data as AssetRaw;
      if (asset.asset_type !== "chat_memory")
        return respondControlError(c, 400, "NOT_CHAT_MEMORY");
      if (asset.owner_user_id !== meUserId)
        return respondControlError(c, 403, "NOT_ASSET_OWNER");

      // Data plane is isolated by asset owner's user_id (consistent with /chat-memory/layer).
      const idFields = {
        team_id: parsed.teamId,
        agent_id: parsed.agentId,
        user_id: asset.owner_user_id,
        session_id: "default",
      };

      const cred = toKernelCredentials(ctx, { timeoutMs: 30_000 });
      try {
        if (layer === "L1") {
          const env = await deps.kernelHttp.postEnvelope<unknown>(
            "/v3/atomic/update",
            { ...idFields, id: itemId, content },
            cred,
          );
          return respondEnvelope(c, env);
        }
        if (layer === "L2") {
          const env = await deps.kernelHttp.postEnvelope<unknown>(
            "/v3/scenario/write",
            {
              ...idFields,
              path: itemId,
              content: stripScenarioMeta(content),
              ...(summary !== undefined ? { summary } : {}),
            },
            cred,
          );
          return respondEnvelope(c, env);
        }
        // L3
        const env = await deps.kernelHttp.postEnvelope<unknown>(
          "/v3/core/write",
          { ...idFields, content },
          cred,
        );
        return respondEnvelope(c, env);
      } catch (err) {
        return respondControlError(
          c,
          500,
          `LAYER_UPDATE_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // ==========================================================================
  // POST /chat-memory/search
  //   body: { block_id, layer: 'L0'|'L1', query, limit?, type? }
  //
  // Layered semantic / keyword retrieval (agent dimension cross-session recall):
  //   L0 → kernel /v3/conversation/search (conversation messages, returns messages with score)
  //   L1 → kernel /v3/atomic/search (atomic memory, returns items with score)
  // Permission: read permission (owner / team-shared / borrowed, consistent with /chat-memory/layer,
  // search is a read operation). Unified return { items, total }, item includes score (relevance).
  // ==========================================================================
  api.post("/chat-memory/search", validatePanelMetaHeaders(deps), async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const blockId = requiredBlockId(body);
    const layerRaw =
      typeof body?.layer === "string" ? body.layer.toUpperCase() : "L1";
    // Currently only L0 (conversation) / L1 (atomic memory) are supported; all others are treated as L1.
    const layer: "L0" | "L1" = layerRaw === "L0" ? "L0" : "L1";
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    const rawLimit = typeof body?.limit === "number" ? body.limit : 30;
    const limit = Math.min(100, Math.max(1, Math.floor(rawLimit)));
    const type =
      typeof body?.type === "string" && body.type.trim()
        ? body.type.trim()
        : undefined;

    if (!blockId) return respondControlError(c, 400, "MISSING_BLOCK_ID");
    if (!query) return respondControlError(c, 400, "MISSING_QUERY");

    const parsed = parseChatMemoryAssetId(blockId);
    // Self-built UserAsset with no associated agent → no L1 data to search, return empty directly (consistent with layer semantics).
    if (!parsed)
      return respondEnvelope(c, okEnvelope(c, { items: [], total: 0 }));

    const meUserId = await resolveCallerUserId(deps, ctx);
    if (!meUserId) return respondControlError(c, 401, "INVALID_USER_KEY");

    const assetEnv = await deps.metaKernel.invoke(
      "asset/get",
      { asset_id: blockId },
      ctx,
    );
    if (assetEnv.code === 404 || (assetEnv.code === 0 && !assetEnv.data)) {
      return respondControlError(c, 404, "BLOCK_NOT_FOUND");
    }
    if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
    const asset = assetEnv.data as AssetRaw;
    if (asset.asset_type !== "chat_memory")
      return respondControlError(c, 400, "NOT_CHAT_MEMORY");

    const canRead = await authorizeChatMemoryRead(
      deps,
      ctx,
      asset,
      meUserId,
      blockId,
    );
    if (!canRead) return respondControlError(c, 403, "ASSET_NOT_ACCESSIBLE");

    const idFields = {
      team_id: parsed.teamId,
      agent_id: parsed.agentId,
      user_id: asset.owner_user_id,
      session_id: "default",
    };
    const cred = toKernelCredentials(ctx, { timeoutMs: 30_000 });
    try {
      if (layer === "L0") {
        // L0: Dialogue message retrieval. The kernel returns { messages }, mapped to a unified { items }.
        // No session_id is passed (global cross-session retrieval, consistent with reading L0 from /chat-memory/layer).
        const { session_id: _drop, ...noSid } = idFields;
        void _drop;
        const env = await deps.kernelHttp.postEnvelope<{
          messages?: unknown[];
        }>("/v3/conversation/search", { ...noSid, query, limit }, cred);
        if (env.code !== 0) return respondEnvelope(c, env);
        const data =
          (env.data as { messages?: Array<Record<string, unknown>> } | null) ??
          { messages: [] };
        const items = (data.messages ?? []).map((m) => ({
          id: (m.id ?? "") as string,
          role: typeof m.role === "string" ? m.role : "msg",
          title: (typeof m.role === "string" ? m.role : "msg") as string,
          body:
            typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content ?? ""),
          tags: typeof m.role === "string" ? [m.role] : [],
          refs: [] as string[],
          score: typeof m.score === "number" ? m.score : undefined,
          created_at:
            (typeof m.timestamp === "string" && m.timestamp) ||
            msToIso(m.recorded_at) ||
            msToIso(m.timestamp) ||
            undefined,
        }));
        return respondEnvelope(
          c,
          okEnvelope(c, { items, total: items.length }),
        );
      }

      // L1: Atomic Memory Retrieval
      const env = await deps.kernelHttp.postEnvelope<{ items?: unknown[] }>(
        "/v3/atomic/search",
        { ...idFields, query, limit, ...(type ? { type } : {}) },
        cred,
      );
      if (env.code !== 0) return respondEnvelope(c, env);
      const data =
        (env.data as { items?: Array<Record<string, unknown>> } | null) ?? {
          items: [],
        };
      const items = (data.items ?? []).map((r) => ({
        // The search result id is the L1 record primary key (can be used directly for /chat-memory/layer-update).
        id: (r.id ?? r.record_id ?? "") as string,
        title: (r.type ?? "atomic") as string,
        body: (r.content ?? "") as string,
        tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
        refs: [] as string[],
        score: typeof r.score === "number" ? r.score : undefined,
        created_at:
          (typeof r.created_at === "string" && r.created_at) ||
          msToIso(r.created_time_ms) ||
          (typeof r.updated_at === "string" ? r.updated_at : undefined),
      }));
      return respondEnvelope(
        c,
        okEnvelope(c, { items, total: items.length }),
      );
    } catch (err) {
      return respondControlError(
        c,
        500,
        `SEARCH_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

/**
 * Extract team_id / agent_id from chat_memory-{team_id}-{agent_id}
 * Rely on the stable prefix starting with `agt` for the agent id.
 */ function parseChatMemoryAssetId(
  assetId: string,
): { teamId: string; agentId: string } | null {
  if (!assetId.startsWith("chat_memory-")) return null;
  const idx = assetId.lastIndexOf("-agt");
  if (idx < 0) return null;
  const inner = assetId.slice("chat_memory-".length);
  const dashAgt = inner.lastIndexOf("-agt");
  if (dashAgt < 0) return null;
  return {
    teamId: inner.slice(0, dashAgt),
    agentId: inner.slice(dashAgt + 1),
  };
}

// ============================================================================
// Helper
// ============================================================================

function buildCtx(c: import("hono").Context): MetaCallContext {
  const panelMeta = c.get("panelMeta");
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get("reqId"),
  };
}

async function readJson(
  c: import("hono").Context,
): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function requiredTeamId(body: Record<string, unknown>): string | null {
  const t = body?.team_id;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

function requiredBlockId(body: Record<string, unknown>): string | null {
  const t = body?.block_id;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

// ── Batch delete limit (consistent with MemoryCore/src/gateway/v2-schemas.ts) ──
/** Number of memory entries that can be cleared in a single /chat-memory/clear operation. */
const MAX_CLEAR_MEMORY_IDS = 100;
/** L0 Batch delete: message_ids limit. */
const MAX_L0_DELETE_MESSAGE_IDS = 5000;
/** L0 Batch delete: session_ids limit. */
const MAX_L0_DELETE_SESSION_IDS = 100;
/** L1 Batch delete: id limit. */
const MAX_L1_DELETE_IDS = 5000;

/**
 * Normalize the id list sent from the frontend: keep only non-empty strings, remove duplicates, and maintain the original order.
 *
 * @returns The normalized array; returns null if it exceeds max (converted to 400 by the caller).
 *           Non-array / missing defaults to "not selected", returning an empty array.
 */
function normalizeIdList(raw: unknown, max: number): string[] | null {
  if (!Array.isArray(raw)) return [];
  const ids = [
    ...new Set(
      raw
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    ),
  ];
  return ids.length > max ? null : ids;
}

function extractListItems<T>(env: MetaEnvelope<unknown>): T[] {
  const d = env.data as unknown;
  if (
    d &&
    typeof d === "object" &&
    Array.isArray((d as ListEnvelopeData<T>).items)
  ) {
    return (d as ListEnvelopeData<T>).items;
  }
  return [];
}

function isActive(a: AssetRaw): boolean {
  return (
    a.status !== "archived" &&
    a.status !== "deprecated" &&
    a.status !== "failed"
  );
}

function emptyLayers(): MemoryBlockOut["layer_counts"] {
  return { L0_messages: 0, L1: 0, L2: 0, L3: 0 };
}

function buildSummary(): string {
  return "0 L1 · 0 L2 · 0 L3";
}

/**
 * Remove the META header from scenario markdown.
 * `scenario/read` returns content with `-----META-START-----...-----META-END-----`
 * headers (created / updated / summary and other system fields), while `scenario/write`
 * expects the body
 * to **not** contain META (the kernel will automatically rebuild it using the existing META). Strip META before writing back to avoid META being treated as body content and wrapped again, causing nesting.
 */
function stripScenarioMeta(content: string): string {
  return content
    .replace(/^-----META-START-----\n[\s\S]*?\n-----META-END-----\n?/, "")
    .replace(/^\n+/, "");
}

function stripL3SceneTail(content: string): string {
  const withFooter = content.search(
    /\n---\s*\n\s*> \*\*Last Updated\*\*[\s\S]*?\n---\s*\n## 🗺️ Scene Navigation/,
  );
  if (withFooter >= 0) return content.slice(0, withFooter).trimEnd();
  const sceneIndex = content.search(
    /\n---\s*\n## 🗺️ Scene Navigation|\n## 🗺️ Scene Navigation/,
  );
  if (sceneIndex >= 0) return content.slice(0, sceneIndex).trimEnd();
  return content;
}

function toMs(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * The kernel chat_memory L0/L1 layers store (recorded_at_ms / created_time_ms) using millisecond timestamps;
 * The frontend display requires an ISO string (can be presented using Date.toLocaleString), and this is uniformly converted here.
 * Only accept values that "look like ms epoch" (greater than 10^12, after approximately 2001-09), and return undefined for the rest
 * Let the caller fallback to other fields (such as timestamp_str / updated_at).
 */
function msToIso(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1e12)
    return undefined;
  try {
    return new Date(v).toISOString();
  } catch {
    return undefined;
  }
}

function okEnvelope<T>(c: import("hono").Context, data: T): MetaEnvelope<T> {
  return { code: 0, message: "ok", request_id: c.get("reqId") ?? "", data };
}

/**
 * Look up the caller's user_id by reverse-referencing auth/verify.
 * Return null if envelope.data.user.user_id is empty or invalid.
 */
async function resolveCallerUserId(
  deps: PanelDeps,
  ctx: MetaCallContext,
): Promise<string | null> {
  if (!ctx.userKey) return null;
  const env = await deps.metaKernel.invoke(
    "auth/verify",
    { user_key: ctx.userKey },
    ctx,
  );
  if (env.code !== 0) return null;
  const data = env.data as {
    valid?: boolean;
    user?: { user_id?: string };
  } | null;
  if (!data?.valid) return null;
  const uid = data.user?.user_id;
  return typeof uid === "string" && uid.length > 0 ? uid : null;
}

/**
 * Verify whether user is a member of the team.
 * Call tdai `/v3/meta/team-member/get` (exists → member; 404 → non-member).
 * Conservatively return false (reject) when the kernel throws an exception (avoid fail-open).
 */
async function isTeamMember(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  userId: string,
): Promise<boolean> {
  if (!teamId || !userId) return false;
  try {
    const env = await deps.metaKernel.invoke(
      "team-member/get",
      { team_id: teamId, user_id: userId },
      ctx,
    );
    if (env.code === 0 && env.data) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * chat_memory asset's **read permission** determination (any of owner / team-shared / borrowed is sufficient):
 *   a) caller is the asset's owner (self-retained and self-used)
 *   b) asset.visibility='team' and caller ∈ team (team has shared it; external team users, even if they know
 *      asset_id, are not considered readable, to prevent unauthorized reading of chat_memory content)
 *   c) asset has been bound to one of caller's agents (borrowing relationship)
 * Reused by /chat-memory/layer and /chat-memory/search to ensure consistent read criteria.
 */
async function authorizeChatMemoryRead(
  deps: PanelDeps,
  ctx: MetaCallContext,
  asset: AssetRaw,
  meUserId: string,
  blockId: string,
): Promise<boolean> {
  if (asset.owner_user_id === meUserId) return true;
  if (asset.visibility === "team") {
    if (await isTeamMember(deps, ctx, asset.team_id, meUserId)) return true;
  }
  // Inheritance check: iterate through the agents owned by caller in this team, and check if any have been bound to this asset.
  try {
    // Paginate to full data: truncating single page of 20 items causes borrowing determination to miss agents ranked 21+, leading to false permission denial
    const myAgents = (
      await fetchAllMetaListItems<AgentRaw>(
        deps,
        ctx,
        "agent/list",
        { team_id: asset.team_id, status: "active" },
      )
    ).filter((a) => a.owner_user_id === meUserId);
    for (const a of myAgents) {
      // Pagination to fetch full list: if this asset is ranked 21+ in agent binding, the single-page list will miss it and incorrectly judge no permission.
      // On error, it remains consistent with the original (continue to skip this agent), without blocking the judgment of other agents.
      const bindings = await fetchAllMetaListItems<FixedAssetRaw>(
        deps,
        ctx,
        "agent-fixed-asset/list",
        { agent_id: a.agent_id },
      );
      if (bindings.some((b) => b.asset_id === blockId)) return true;
    }
  } catch {
    /* fallthrough → deny */
  }
  return false;
}

// countBindings has been removed with the N+1 optimization of team-assets; in the future, if the right-side detail panel needs to be fetched on demand
// Single binding count, implemented via an independent endpoint (body: {team_id, block_id}), don't put it back into the list loop.
