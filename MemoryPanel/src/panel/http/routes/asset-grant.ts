/**
 * POST /api/v1/asset/grant — instant share/revoke of any asset type to a
 * groupy org node (PLAN P4, DESIGN §6).
 *
 * Synchronous flow (seconds): kernel ACL write via groupy/asset-grant +
 * KS grant mirror (wiki/code-graph only) for every affected subtree team.
 * The kernel returns the affected team set atomically with the grant, so the
 * mirror cannot drift from a concurrent org change mid-request.
 *
 * Auth: any authenticated caller may attempt (missing identity → 401);
 * the kernel enforces owner / home-team-admin / system-admin (→ 403).
 *
 * Partial failure is reported, not hidden: if the kernel write lands but the
 * KS mirror fails, the response is 502 KS_UNREACHABLE with kernel state live —
 * rerun (or /groupy/mirror-sync) heals the mirror. Mirror-before-kernel would
 * leave the symmetric window (KS rows without kernel ACL), so kernel-first stands.
 * POST-only by Panel convention (DESIGN §7 lists GETs; Panel uses POST).
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import { buildCtx, readJson, str, okEnvelope, resolveCallerUserId } from './knowledge/common.js';
import { knowledgeKindForAssetType } from '../../domain/asset-id.js';

const GRANT_TYPES = ['viewer', 'editor', 'owner'] as const;
type GrantTypeParam = (typeof GRANT_TYPES)[number];

export function registerAssetGrantRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  api.post('/asset/grant', mw, async (c) => {
    const ctx = buildCtx(c);
    // Any authenticated caller may attempt; the kernel enforces owner /
    // home-team-admin / system-admin (DESIGN §6). Missing identity → 401.
    if (!(await resolveCallerUserId(deps, ctx))) return respondControlError(c, 401, 'UNAUTHORIZED');
    const body = await readJson(c);
    const assetId = str(body, 'asset_id');
    const nodeId = str(body, 'node_id');
    const action = str(body, 'action');
    const grantType = str(body, 'grant_type') ?? 'viewer';
    if (!assetId || !nodeId) return respondControlError(c, 400, 'MISSING_PARAM');
    if (action !== 'grant' && action !== 'revoke') return respondControlError(c, 400, 'BAD_ACTION');
    if (!(GRANT_TYPES as readonly string[]).includes(grantType)) return respondControlError(c, 400, 'BAD_GRANT_TYPE');

    const callKernel = (act: string, payload: Record<string, unknown>) =>
      deps.metaKernel.invoke(act, payload, ctx).catch(() => null);

    const assetEnv = await callKernel('asset/get', { asset_id: assetId });
    if (!assetEnv) return respondControlError(c, 502, 'KERNEL_UNREACHABLE');
    if (assetEnv.code !== 0) return respondEnvelope(c, assetEnv);
    const asset = assetEnv.data as { asset_id: string; team_id: string; asset_type: string } | null;
    if (!asset) return respondControlError(c, 404, 'ASSET_NOT_FOUND');

    const grantEnv = await callKernel('groupy/asset-grant', { asset_id: assetId, node_id: nodeId, action, grant_type: grantType });
    if (!grantEnv) return respondControlError(c, 502, 'KERNEL_UNREACHABLE');
    if (grantEnv.code !== 0) return respondEnvelope(c, grantEnv);
    const grant = grantEnv.data as { visibility: string; nodes: string[]; teams: string[] } | null;
    const teams = grant?.teams ?? [];
    // Full revoke (no nodes left, e.g. archived node dropped from the graph)
    // clears the whole mirror: per-team clear with an empty set would no-op
    // and leave stale KS rows behind.

    // KS mirror (wiki/code-graph only): kernel asset types map 1:1, and the
    // kernel asset_id doubles as the KS knowledge_id (see allocate flow).
    const kind = knowledgeKindForAssetType(asset.asset_type);
    let mirror: unknown = null;
    if (kind) {
      const kc = deps.knowledgeClientFactory(ctx.instanceId);
      try {
        mirror =
          action === 'grant'
            ? await kc.grantsSet(kind, assetId, teams.map((t) => ({ team_id: t, grant_type: grantType })))
            : (grant?.nodes.length
              ? await kc.grantsClear(kind, assetId, teams)
              : await kc.grantsClear(kind, assetId));
      } catch {
        return respondControlError(c, 502, 'KS_UNREACHABLE');
      }
    }
    return c.json(okEnvelope(c, { asset: grantEnv.data, ks_mirror: mirror }));
  });
}
