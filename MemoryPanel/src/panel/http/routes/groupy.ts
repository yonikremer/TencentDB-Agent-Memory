/**
 * Groupy control-plane routes (PLAN P4, DESIGN §7).
 *
 *   POST /api/v1/groupy/sync     admin "Sync now" → kernel
 *   POST /api/v1/groupy/status    last run, last-good, health
 *   POST /api/v1/groupy/tree      nodes+edges snapshot
 *   POST /api/v1/groupy/orphans   shared assets whose node was archived
 *
 * POST-only by Panel convention (DESIGN §7 lists GETs for status/tree/orphans).
 * Thin forwards over metaKernel.invoke; kernel owns authz + state.
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import { buildCtx, okEnvelope, isCallerSystemAdmin } from './knowledge/common.js';

export function registerGroupyRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  async function forward(c: Parameters<Parameters<typeof api.post>[1]>[0], action: string) {
    const ctx = buildCtx(c);
    if (!(await isCallerSystemAdmin(deps, ctx))) return respondControlError(c, 403, 'FORBIDDEN');
    let env;
    try {
      env = await deps.metaKernel.invoke(action, {}, ctx);
    } catch {
      return respondControlError(c, 502, 'KERNEL_UNREACHABLE');
    }
    return respondEnvelope(c, env);
  }

  api.post('/groupy/sync', mw, async (c) => forward(c, 'groupy/sync'));
  api.post('/groupy/status', mw, async (c) => forward(c, 'groupy/status'));
  api.post('/groupy/tree', mw, async (c) => forward(c, 'groupy/tree'));

  api.post('/groupy/orphans', mw, async (c) => {
    const ctx = buildCtx(c);
    if (!(await isCallerSystemAdmin(deps, ctx))) return respondControlError(c, 403, 'FORBIDDEN');
    let sharesEnv;
    let treeEnv;
    try {
      [sharesEnv, treeEnv] = await Promise.all([
        deps.metaKernel.invoke('groupy/shares', {}, ctx),
        deps.metaKernel.invoke('groupy/tree', {}, ctx),
      ]);
    } catch {
      return respondControlError(c, 502, 'KERNEL_UNREACHABLE');
    }
    if (sharesEnv.code !== 0) return respondEnvelope(c, sharesEnv);
    if (treeEnv.code !== 0) return respondEnvelope(c, treeEnv);
    const shares = (sharesEnv.data ?? []) as Array<{ asset_id: string; node_ids: string[] }>;
    const tree = (treeEnv.data ?? { nodes: [] }) as { nodes: Array<{ node_id: string; archived: boolean }> };
    const archived = new Set(tree.nodes.filter((n) => n.archived).map((n) => n.node_id));
    const orphans = shares
      .map((s) => ({
        asset_id: s.asset_id,
        archived_nodes: (s.node_ids ?? []).filter((n) => archived.has(n)),
      }))
      .filter((o) => o.archived_nodes.length > 0);
    return c.json(okEnvelope(c, { items: orphans, total: orphans.length }));
  });
}
