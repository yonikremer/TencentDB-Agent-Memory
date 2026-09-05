/**
 * Knowledge Panel routing shared assistant.
 *
 * Same style as chat-memory.ts: reverse-lookup caller from panelMeta group ctx, auth/verify,
 * team-member/get gating, unified envelope. Map KS upstream errors (CoreUpstreamError/DomainError)
 * to Control envelope.
 */
import type { Context } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import { toKernelCredentials, type MetaCallContext } from '../../../kernel/types.js';
import type { MetaEnvelope } from '../../../kernel/envelope.js';
import { DomainError } from '../../../domain/errors.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';

export function buildCtx(c: Context): MetaCallContext {
  const panelMeta = c.get('panelMeta');
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get('reqId'),
  };
}

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function str(body: Record<string, unknown>, key: string): string | null {
  const v = body?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function strArray(body: Record<string, unknown>, key: string): string[] {
  const v = body?.[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

export function okEnvelope<T>(c: Context, data: T): MetaEnvelope<T> {
  return { code: 0, message: 'ok', request_id: c.get('reqId') ?? '', data };
}

export function extractListItems<T>(env: MetaEnvelope<unknown>): T[] {
  const d = env.data as { items?: unknown } | null;
  if (d && Array.isArray(d.items)) return d.items as T[];
  return [];
}

/** Reverse-lookup the caller's user_id via auth/verify. Return null on failure. */
export async function resolveCallerUserId(
  deps: PanelDeps,
  ctx: MetaCallContext,
): Promise<string | null> {
  if (!ctx.userKey) return null;
  const env = await deps.metaKernel.invoke('auth/verify', { user_key: ctx.userKey }, ctx);
  if (env.code !== 0) return null;
  const data = env.data as { valid?: boolean; user?: { user_id?: string } } | null;
  if (!data?.valid) return null;
  const uid = data.user?.user_id;
  return typeof uid === 'string' && uid.length > 0 ? uid : null;
}

/** Determine whether the current caller is system_admin (auth/verify returns user.user_type). Return false conservatively on failure. */
export async function isCallerSystemAdmin(
  deps: PanelDeps,
  ctx: MetaCallContext,
): Promise<boolean> {
  if (!ctx.userKey) return false;
  const env = await deps.metaKernel.invoke('auth/verify', { user_key: ctx.userKey }, ctx);
  if (env.code !== 0) return false;
  const data = env.data as { valid?: boolean; user?: { user_type?: string } } | null;
  return data?.valid === true && data.user?.user_type === 'system_admin';
}

/** Verify whether user is a member of team (team-member/get exists → member). Conservatively return false on exception. */
export async function isTeamMember(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  userId: string,
): Promise<boolean> {
  if (!teamId || !userId) return false;
  try {
    const env = await deps.metaKernel.invoke('team-member/get', { team_id: teamId, user_id: userId }, ctx);
    return env.code === 0 && !!env.data;
  } catch {
    return false;
  }
}

/**
 * team gate: requires that caller is a valid user and a member of the team.
 * returns { userId }; if not, returns { error: Response } (route directly returns).
 */
export async function requireTeamMember(
  deps: PanelDeps,
  c: Context,
  ctx: MetaCallContext,
  teamId: string,
): Promise<{ userId: string } | { error: Response }> {
  const userId = await resolveCallerUserId(deps, ctx);
  if (!userId) return { error: respondControlError(c, 401, 'INVALID_USER_KEY') };
  const member = await isTeamMember(deps, ctx, teamId, userId);
  if (!member) return { error: respondControlError(c, 403, 'NOT_TEAM_MEMBER') };
  return { userId };
}

/** id-only endpoint gating: only requires caller to be a valid user (KS isolated by service_id + team). */
export async function requireCaller(
  deps: PanelDeps,
  c: Context,
  ctx: MetaCallContext,
): Promise<{ userId: string } | { error: Response }> {
  const userId = await resolveCallerUserId(deps, ctx);
  if (!userId) return { error: respondControlError(c, 401, 'INVALID_USER_KEY') };
  return { userId };
}

/**
 * Wrap the KS call: success → okEnvelope; upstream/domain error → map Control envelope.
 */
export async function runKs<T>(
  c: Context,
  fn: () => Promise<T>,
): Promise<Response> {
  try {
    const data = await fn();
    return respondEnvelope(c, okEnvelope(c, data));
  } catch (err) {
    if (err instanceof DomainError) {
      return respondControlError(c, err.httpStatus, err.message || err.code);
    }
    return respondControlError(c, 502, 'UPSTREAM_ERROR');
  }
}

// ── meta_asset lifecycle (see design §0.6) ───────────────────────────
// asset_id == knowledge_id (wiki_id / cg_id), and asset_type mapping is as follows.
export const ASSET_TYPE_WIKI = 'llm_wiki';
export const ASSET_TYPE_CODE_GRAPH = 'code_graph';

/**
 * create idempotent registration of meta_asset (ForCaller) at time of (ForCaller): asset_id = knowledge_id returned by KS.
 * If already exists (same-name KS idempotent reuse) → skip; if not exists → asset/create.
 * On failure, return { ok:false, env }, and the route reports the error accordingly (user retries, KS idempotent self-heals).
 */
export async function ensureKnowledgeAsset(
  deps: PanelDeps,
  ctx: MetaCallContext,
  params: {
    assetId: string;
    teamId: string;
    assetType: typeof ASSET_TYPE_WIKI | typeof ASSET_TYPE_CODE_GRAPH;
    name: string;
    ownerUserId: string;
    serviceUrl?: string | null;
  },
): Promise<{ ok: true } | { ok: false; env: MetaEnvelope<unknown> }> {
  const log = deps.logger;
  const getEnv = await deps.metaKernel.invoke('asset/get', { asset_id: params.assetId }, ctx);
  if (getEnv.code === 0 && getEnv.data) {
    log.info('[ensure-knowledge-asset] already present; idempotent skip', {
      asset_id: params.assetId, asset_type: params.assetType, team_id: params.teamId,
    });
    return { ok: true }; // idempotent: already exists
  }
  log.info('[ensure-knowledge-asset] not present; creating', {
    asset_id: params.assetId, asset_type: params.assetType, team_id: params.teamId, owner: params.ownerUserId,
  });
  const createEnv = await deps.metaKernel.invoke(
    'asset/create',
    {
      asset_id: params.assetId,
      team_id: params.teamId,
      asset_type: params.assetType,
      name: params.name,
      owner_user_id: params.ownerUserId,
      source_type: 'manual',
      visibility: 'team',
      content_ref: params.serviceUrl ?? undefined,
    },
    ctx,
  );
  if (createEnv.code !== 0) {
    log.error('[ensure-knowledge-asset] asset/create rejected', {
      asset_id: params.assetId, code: createEnv.code, message: createEnv.message,
    });
    return { ok: false, env: createEnv };
  }
  log.info('[ensure-knowledge-asset] created', { asset_id: params.assetId, visibility: 'team' });
  return { ok: true };
}

/** Delete kernel detail entity_knowledge (S2S, /v3/knowledge/delete). best-effort, does not throw. */
export async function deleteKnowledgeDetail(
  deps: PanelDeps,
  ctx: MetaCallContext,
  ids: string[],
): Promise<void> {
  try {
    const cred = toKernelCredentials(ctx, { timeoutMs: deps.config.metadataRemoteTimeoutMs }, { omitUserKey: true });
    await deps.kernelHttp.postEnvelope('/v3/knowledge/delete', { knowledge_ids: ids }, cred);
  } catch {
    /* best-effort */
  }
}

/** Delete meta_asset (ForCaller, asset/delete). Best-effort, does not throw.
 *  kernel-side asset/delete cascades to clean up agent-fixed-asset bindings + ACL, no additional unbinding needed. */
export async function deleteKnowledgeAssets(
  deps: PanelDeps,
  ctx: MetaCallContext,
  ids: string[],
): Promise<void> {
  try {
    await deps.metaKernel.invoke('asset/delete', { asset_ids: ids }, ctx);
  } catch {
    /* best-effort */
  }
}

/** Remove the remote side cascade of knowledge: entity_knowledge details + meta_asset (including agent binding cascade).
 *  Deletion on the KS side is handled by the caller (return KS result to the frontend). Both steps are best-effort and do not throw. */
export async function deleteKnowledgeCascade(
  deps: PanelDeps,
  ctx: MetaCallContext,
  ids: string[],
): Promise<void> {
  await deleteKnowledgeDetail(deps, ctx, ids);
  await deleteKnowledgeAssets(deps, ctx, ids);
}

// ── meta list pagination + authentication + KS join ─────────────────────────────

const META_LIST_PAGE = 100;
const FILTERED_ASSET_STATUSES = new Set(['archived', 'deprecated', 'failed']);

export interface KnowledgeAssetMetaRaw {
  asset_id: string;
  team_id: string;
  asset_type: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  visibility: string;
  status: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Paginate and fetch all meta list items (no specific action limit — any returning `{items:[], total}`
 * All list interfaces can be reused, avoiding the silent truncation of DEFAULT_PAGINATION=20 on assets when there are many.
 *
 * Note: The kernel `DEFAULT_PAGINATION = {limit: 20}`, when the caller does not pass `limit`, only gets the first 20 items;
 * Any interface with the semantics of "list all → modify → set all replacement" (such as in knowledge/allocate's
 * agent-fixed-asset/list）must use this tool to get the full set, otherwise the later binding will be silently overwritten.
 *
 * Error handling: When a failure occurs mid-pagination, call `onError(env)` and return the collected data, letting the caller decide
 * whether to pass through the error or continue — silent ignoring is prohibited (on the write path, errors are treated as an "empty list" for full replacement,
 * causing data to be cleared).
 */
export async function fetchAllMetaListItems<T>(
  deps: PanelDeps,
  ctx: MetaCallContext,
  action: string,
  body: Record<string, unknown>,
  onError?: (env: MetaEnvelope<unknown>) => void,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  for (;;) {
    const env = await deps.metaKernel.invoke(action, { ...body, limit: META_LIST_PAGE, offset }, ctx);
    if (env.code !== 0) {
      onError?.(env);
      return all;
    }
    const batch = extractListItems<T>(env);
    all.push(...batch);
    const total = (env.data as { total?: number } | null)?.total;
    if (batch.length === 0) {
      // Empty page: end of the end (the only termination signal when there is no total interface). However, for interfaces with filtering semantics, intermediate pages
      // may be entirely empty (total is still the bound total), so continue advancing to avoid missing pulls.
      if (typeof total === 'number' && offset < total) {
        offset += META_LIST_PAGE;
        continue;
      }
      break;
    }
    if (typeof total === 'number' && offset + batch.length >= total) break;
    offset += META_LIST_PAGE;
  }
  return all;
}

export function isActiveMetaAsset(status: string | undefined): boolean {
  return !!status && !FILTERED_ASSET_STATUSES.has(status);
}

/** acl/check: whether caller has permission for specified action on asset. */
export async function checkAssetPermission(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  assetId: string,
  action: 'read' | 'write' | 'use' = 'read',
): Promise<boolean> {
  const env = await deps.metaKernel.invoke(
    'acl/check',
    { user_id: userId, asset_id: assetId, action },
    ctx,
  );
  if (env.code !== 0) return false;
  const data = env.data as { allowed?: boolean } | null;
  return !!data?.allowed;
}

/** @deprecated use checkAssetPermission */
export async function checkAssetReadPermission(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  assetId: string,
): Promise<boolean> {
  return checkAssetPermission(deps, ctx, userId, assetId, 'read');
}

/**
 * Knowledge resource gate: when meta asset exists, use acl/check;
 * When meta is absent during code-graph construction, only KS owner is allowed to read get (narrow exception).
 */
export async function requireKnowledgeRead(
  deps: PanelDeps,
  c: Context,
  ctx: MetaCallContext,
  knowledgeId: string,
  opts?: { allowInFlightCodeOwner?: boolean; action?: 'read' | 'write' | 'use' },
): Promise<{ userId: string; asset?: KnowledgeAssetMetaRaw } | { error: Response }> {
  const userId = await resolveCallerUserId(deps, ctx);
  if (!userId) return { error: respondControlError(c, 401, 'INVALID_USER_KEY') };
  const action = opts?.action ?? 'read';

  const assetEnv = await deps.metaKernel.invoke('asset/get', { asset_id: knowledgeId }, ctx);
  if (assetEnv.code === 0 && assetEnv.data) {
    const asset = assetEnv.data as KnowledgeAssetMetaRaw;
    const allowed = await checkAssetPermission(deps, ctx, userId, knowledgeId, action);
    if (!allowed) return { error: respondControlError(c, 403, 'FORBIDDEN') };
    const member = await isTeamMember(deps, ctx, asset.team_id, userId);
    if (!member) return { error: respondControlError(c, 403, 'NOT_TEAM_MEMBER') };
    return { userId, asset };
  }

  if (opts?.allowInFlightCodeOwner && (action === 'read' || action === 'write')) {
    try {
      const kc = deps.knowledgeClientFactory(ctx.instanceId);
      const detail = await kc.codeGraphGet(knowledgeId);
      if (detail.owner_user_id === userId) {
        const member = await isTeamMember(deps, ctx, detail.team_id, userId);
        if (!member) return { error: respondControlError(c, 403, 'NOT_TEAM_MEMBER') };
        return { userId };
      }
    } catch {
      /* fall through */
    }
  }

  return { error: respondControlError(c, 404, 'KNOWLEDGE_NOT_FOUND') };
}

export interface KnowledgeAssetListItem {
  knowledge_id: string;
  asset_type: string;
  name: string;
  description?: string | null;
  visibility: string;
  owner_user_id: string;
  meta_status: string;
  status: string;
  internal_status?: string | null;
  sync_error?: string | null;
  ks_missing?: boolean;
  team_id?: string;
  summary?: string | null;
  page_count?: number | null;
  last_sync_at?: string | null;
  repo_name?: string;
  repo_url?: string;
  branch?: string;
  commit_hash?: string | null;
  stats?: { files: number; nodes: number; edges: number } | null;
  created_at?: string;
  updated_at?: string;
}

async function joinWikiKs(
  kc: ReturnType<PanelDeps['knowledgeClientFactory']>,
  meta: KnowledgeAssetMetaRaw,
): Promise<KnowledgeAssetListItem> {
  const base: KnowledgeAssetListItem = {
    knowledge_id: meta.asset_id,
    asset_type: meta.asset_type,
    name: meta.name,
    description: meta.description ?? null,
    visibility: meta.visibility,
    owner_user_id: meta.owner_user_id,
    meta_status: meta.status,
    status: 'missing',
    ks_missing: true,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
  };
  try {
    const ks = await kc.wikiGet(meta.asset_id);
    return {
      ...base,
      team_id: ks.team_id,
      status: ks.status,
      internal_status: ks.internal_status ?? null,
      sync_error: ks.sync_error,
      summary: ks.summary,
      page_count: ks.page_count,
      last_sync_at: ks.last_sync_at,
      ks_missing: false,
      created_at: ks.created_at,
      updated_at: ks.updated_at,
    };
  } catch {
    return base;
  }
}

async function joinCodeKs(
  kc: ReturnType<PanelDeps['knowledgeClientFactory']>,
  meta: KnowledgeAssetMetaRaw,
): Promise<KnowledgeAssetListItem> {
  const base: KnowledgeAssetListItem = {
    knowledge_id: meta.asset_id,
    asset_type: meta.asset_type,
    name: meta.name,
    description: meta.description ?? null,
    visibility: meta.visibility,
    owner_user_id: meta.owner_user_id,
    meta_status: meta.status,
    status: 'missing',
    ks_missing: true,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
  };
  try {
    const ks = await kc.codeGraphGet(meta.asset_id);
    return {
      ...base,
      team_id: ks.team_id,
      name: ks.repo_name || meta.name,
      status: ks.status,
      sync_error: ks.sync_error,
      summary: ks.summary,
      repo_name: ks.repo_name,
      repo_url: ks.repo_url,
      branch: ks.branch,
      commit_hash: ks.commit_hash,
      stats: ks.stats,
      last_sync_at: ks.last_sync_at,
      ks_missing: false,
      created_at: ks.created_at,
      updated_at: ks.updated_at,
    };
  } catch {
    return base;
  }
}

export async function joinKnowledgeAssetsWithKs(
  deps: PanelDeps,
  ctx: MetaCallContext,
  assets: KnowledgeAssetMetaRaw[],
  assetType: typeof ASSET_TYPE_WIKI | typeof ASSET_TYPE_CODE_GRAPH,
): Promise<KnowledgeAssetListItem[]> {
  const kc = deps.knowledgeClientFactory(ctx.instanceId);
  const joiner = assetType === ASSET_TYPE_WIKI ? joinWikiKs : joinCodeKs;
  const settled = await Promise.allSettled(assets.map((a) => joiner(kc, a)));
  return settled.map((r, i) => {
    const meta = assets[i];
    if (r.status === 'fulfilled') return r.value;
    if (!meta) {
      return {
        knowledge_id: '',
        asset_type: assetType,
        name: '',
        visibility: 'team',
        owner_user_id: '',
        meta_status: 'unknown',
        status: 'missing',
        ks_missing: true,
      };
    }
    return {
      knowledge_id: meta.asset_id,
      asset_type: meta.asset_type,
      name: meta.name,
      visibility: meta.visibility,
      owner_user_id: meta.owner_user_id,
      meta_status: meta.status,
      status: 'missing',
      ks_missing: true,
    };
  });
}

// ── KS-only items (meta not registered, such as code-graph created/failed) ─────────

/** Query the list from the KS side and construct the unregistered KnowledgeAssetListItem for meta. */
async function fetchKsOnlyItems(
  kc: ReturnType<PanelDeps['knowledgeClientFactory']>,
  teamId: string,
  assetType: typeof ASSET_TYPE_WIKI | typeof ASSET_TYPE_CODE_GRAPH,
): Promise<KnowledgeAssetListItem[]> {
  try {
    if (assetType === ASSET_TYPE_WIKI) {
      const res = await kc.wikiList(teamId);
      return res.items.map((ks) => ({
        knowledge_id: ks.wiki_id,
        asset_type: ASSET_TYPE_WIKI,
        name: ks.name,
        description: null,
        visibility: 'team',
        owner_user_id: ks.owner_user_id ?? '',
        meta_status: 'unregistered',
        status: ks.status,
        team_id: ks.team_id,
        internal_status: ks.internal_status ?? null,
        sync_error: ks.sync_error,
        summary: ks.summary,
        page_count: ks.page_count,
        last_sync_at: ks.last_sync_at,
        ks_missing: false,
        created_at: ks.created_at,
        updated_at: ks.updated_at,
      }));
    }
    const res = await kc.codeGraphList(teamId);
    return res.items.map((ks) => ({
      knowledge_id: ks.code_graph_id,
      asset_type: ASSET_TYPE_CODE_GRAPH,
      name: ks.repo_name || ks.repo_url || ks.code_graph_id,
      description: null,
      visibility: 'team',
      owner_user_id: ks.owner_user_id ?? '',
      meta_status: 'unregistered',
      status: ks.status,
      team_id: ks.team_id,
      sync_error: ks.sync_error,
      summary: ks.summary,
      repo_name: ks.repo_name,
      repo_url: ks.repo_url,
      branch: ks.branch,
      commit_hash: ks.commit_hash,
      stats: ks.stats,
      last_sync_at: ks.last_sync_at,
      ks_missing: false,
      created_at: ks.created_at,
      updated_at: ks.updated_at,
    }));
  } catch {
    return [];
  }
}

/**
 * Merge the meta asset list with the KS-side list: meta takes precedence, and KS supplements items not registered in meta.
 * Used for the team-assets / my-assets endpoints, ensuring resources in "creating/failed" states are also displayed.
 *
 * Permission description: The permission check on the meta side has been done by asset/list-accessible;
 * The KS side returns team-level data, and the caller has verified team ownership through requireTeamMember.
 */
export async function mergeWithKsOnlyItems(
  deps: PanelDeps,
  ctx: MetaCallContext,
  teamId: string,
  joined: KnowledgeAssetListItem[],
  assetType: typeof ASSET_TYPE_WIKI | typeof ASSET_TYPE_CODE_GRAPH,
): Promise<KnowledgeAssetListItem[]> {
  const kc = deps.knowledgeClientFactory(ctx.instanceId);
  const ksItems = await fetchKsOnlyItems(kc, teamId, assetType);
  if (ksItems.length === 0) return joined;

  const knownIds = new Set(joined.map((j) => j.knowledge_id));
  const orphans = ksItems.filter((ks) => !knownIds.has(ks.knowledge_id));
  return [...joined, ...orphans];
}
