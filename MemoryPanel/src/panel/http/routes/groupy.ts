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
import type { Hono, Context } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import { buildCtx, okEnvelope, isCallerSystemAdmin } from './knowledge/common.js';
import { knowledgeKindForAssetType } from '../../domain/asset-id.js';

export function registerGroupyRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  async function forward(c: Context, action: string) {
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

  // POST /api/v1/groupy/mirror-sync — heal KS grant rows from kernel shares.
  // DESIGN §5.6: kernel recompute heals kernel ACL nightly; this re-derives
  // the KS mirror (per-subtree-team rows with stored grant_types) on the same
  // cadence. Run manually or on a devops cron after the kernel nightly.
  api.post('/groupy/mirror-sync', mw, async (c) => {
    const ctx = buildCtx(c);
    if (!(await isCallerSystemAdmin(deps, ctx))) return respondControlError(c, 403, 'FORBIDDEN');
    const callKernel = (act: string, payload: Record<string, unknown>) =>
      deps.metaKernel.invoke(act, payload, ctx).catch(() => null);
    const sharesEnv = await callKernel('groupy/shares', {});
    if (!sharesEnv) return respondControlError(c, 502, 'KERNEL_UNREACHABLE');
    if (sharesEnv.code !== 0) return respondEnvelope(c, sharesEnv);
    const treeEnv = await callKernel('groupy/tree', {});
    if (!treeEnv) return respondControlError(c, 502, 'KERNEL_UNREACHABLE');
    if (treeEnv.code !== 0) return respondEnvelope(c, treeEnv);
    const shares = (sharesEnv.data ?? []) as Array<{
      asset_id: string; node_ids: string[]; grant_types?: Record<string, string>;
    }>;
    const tree = (treeEnv.data ?? { nodes: [], edges: [] }) as {
      nodes: Array<{ node_id: string; archived: boolean }>;
      edges: Array<{ parent_id: string; child_id: string; child_kind?: string }>;
    };
    const byId = new Map(tree.nodes.map((n) => [n.node_id, n]));
    const children = new Map<string, string[]>();
    for (const e of tree.edges) {
      // Org children only: user member edges would leak person ids into the
      // team set (kernel subtreeNodeIds filters kind === 'org' likewise).
      if (e.child_kind && e.child_kind !== "org") continue;
      const list = children.get(e.parent_id) ?? [];
      list.push(e.child_id);
      children.set(e.parent_id, list);
    }
    const subtreeOf = (root: string): string[] => {
      if (!byId.has(root)) return [];
      const out: string[] = [];
      const seen = new Set([root]);
      const queue = [root];
      while (queue.length > 0) {
        const cur = queue.pop()!;
        out.push(cur);
        for (const child of children.get(cur) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          queue.push(child);
        }
      }
      return out;
    };
    const kc = deps.knowledgeClientFactory(ctx.instanceId, ctx.userKey);
    const report: Array<{ asset_id: string; set: number; cleared: number; skipped?: string }> = [];
    for (const share of shares) {
      const live = (share.node_ids ?? []).filter((n) => {
        const node = byId.get(n);
        return node && !node.archived;
      });
      const desired = new Map<string, string>();
      for (const n of live) {
        // Kernel-stored types are validated: an invalid value skips the node
        // instead of aborting the whole heal (KS would 400 mid-loop).
        const gt = share.grant_types?.[n] ?? 'viewer';
        if (gt !== 'viewer' && gt !== 'editor' && gt !== 'owner') {
          report.push({ asset_id: share.asset_id, set: 0, cleared: 0, skipped: `bad grant_type for ${n}` });
          continue;
        }
        for (const t of subtreeOf(n)) desired.set(t, gt);
      }
      let assetEnv;
      try {
        assetEnv = await deps.metaKernel.invoke('asset/get', { asset_id: share.asset_id }, ctx);
      } catch {
        return respondControlError(c, 502, 'KERNEL_UNREACHABLE');
      }
      if (assetEnv.code !== 0) {
        report.push({ asset_id: share.asset_id, set: 0, cleared: 0, skipped: 'asset gone' });
        continue;
      }
      const asset = assetEnv.data as { asset_type: string } | null;
      const kind = asset ? knowledgeKindForAssetType(asset.asset_type) : null;
      if (!kind || !asset) {
        report.push({ asset_id: share.asset_id, set: 0, cleared: 0, skipped: 'kernel-only asset' });
        continue;
      }
      let current;
      try {
        current = await kc.grantsList(kind, share.asset_id);
      } catch {
        report.push({ asset_id: share.asset_id, set: 0, cleared: 0, skipped: 'KS unreachable' });
        continue;
      }
      const have = new Map((current.grants ?? []).map((g) => [g.team_id, g.grant_type]));
      const missing = [...desired.entries()].filter(([t, gt]) => have.get(t) !== gt);
      const extra = [...have.keys()].filter((t) => !desired.has(t));
      let set = 0;
      let cleared = 0;
      try {
        if (missing.length > 0) {
          const res = await kc.grantsSet(kind, share.asset_id,
            missing.map(([team_id, grant_type]) => ({ team_id, grant_type })));
          set = res.grants.length;
        }
        if (extra.length > 0) {
          cleared = (await kc.grantsClear(kind, share.asset_id, extra)).cleared;
        }
      } catch {
        report.push({ asset_id: share.asset_id, set, cleared, skipped: 'KS write failed' });
        continue;
      }
      report.push({ asset_id: share.asset_id, set, cleared });
    }
    return c.json(okEnvelope(c, { assets: report }));
  });
}
