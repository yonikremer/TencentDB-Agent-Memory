/**
 * /api/v1/knowledge/status-callback —— KS → Panel status callback (S2S, no user-key).
 *
 * Callback after KS ingest/sync is complete. Design §0.6:
 *   - status=ready + summary → write kernel detail entity_knowledge (/v3/knowledge/create);
 *     This is the only gate for Proxy injection.
 *   - register meta_asset (/v3/meta/asset/create) as owner when code-graph is ready;
 *     callback is the S2S without user_key, stashed in the memory task table when using code-graph/create
 *     owner_user_key goes through the ForCaller path (caller===owner). Failure is best-effort,
 *      Frontend register-meta fallback (idempotent).
 *   - status=failed → do not write details, do not write meta (resource cannot be injected, UI reads KS status to display failure).
 *
 * Parse instance credentials (endpoint + api_key) from the registry using payload.service_id → assemble S2S credentials
 * → Retrieve KS details → POST /v3/knowledge/create.
 *
 * Do not attach validatePanelMetaHeaders (S2S, no browser session header).
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import type { KernelCredentials, MetaCallContext } from '../../../kernel/types.js';
import { ensureKnowledgeAsset, ASSET_TYPE_CODE_GRAPH } from './common.js';

interface CallbackBody {
  knowledge_id?: string;
  service_id?: string;
  type?: 'wiki' | 'code-graph';
  status?: 'ready' | 'failed';
  summary?: string | null;
  sync_error?: string | null;
  timestamp?: string;
  /** Fine-grained ingest progress (shares endpoint with final status callback) */
  event?: 'ingest_progress';
  wiki_id?: string;
  team_id?: string;
  /** Single ingest generation; shared with progress / terminal state, to prevent late packages after clear */
  run_id?: string;
  progress?: {
    phase?: string;
    total?: number;
    completed?: number;
    failed?: number;
    skipped?: number;
    percent?: number;
  };
}

async function safeJson(c: { req: { text: () => Promise<string> } }): Promise<CallbackBody> {
  try {
    const text = await c.req.text();
    if (!text?.trim()) return {};
    return JSON.parse(text) as CallbackBody;
  } catch {
    return {};
  }
}

function isProgressPhase(p: unknown): p is 'extracting' | 'merging' | 'indexing' {
  return p === 'extracting' || p === 'merging' || p === 'indexing';
}

/**
 * code-graph ready, then register the meta asset using the owner key stashed in the in-memory task table.
 * callback is S2S, has no user_key, and relies on the owner_user_key recorded at create time to call /v3/meta/asset/create in owner
 * identity (ForCaller routing requires caller===owner).
 * best-effort: on failure, only log, and the frontend register-meta will fall back (idempotent).
 */
async function registerCodeGraphAsset(
  deps: PanelDeps,
  log: PanelDeps['logger'],
  knowledgeId: string,
  detail: { code_graph_id: string; team_id: string; repo_name: string; repo_url: string; service_url: string | null },
  entry: { instance_id: string; gateway_endpoint: string; api_key: string },
): Promise<void> {
  const task = deps.knowledgeTaskRegistry.peek(knowledgeId);
  if (!task) {
    // Not in memory (process restart / non-panel creation path) — left to frontend register-meta as fallback
    log.info('[knowledge-callback] no in-memory task stash; skip S2S asset register (frontend fallback)', {
      knowledge_id: knowledgeId,
    });
    return;
  }
  log.info('[knowledge-callback] found in-memory task stash; registering meta asset as owner', {
    knowledge_id: knowledgeId, owner_user_id: task.owner_user_id, team_id: task.team_id,
  });
  const ownerCtx: MetaCallContext = {
    instanceId: entry.instance_id,
    gatewayEndpoint: entry.gateway_endpoint,
    gatewayApiKey: entry.api_key,
    userKey: task.owner_user_key,
    reqId: `cb-${knowledgeId}`,
  };
  try {
    const reg = await ensureKnowledgeAsset(deps, ownerCtx, {
      assetId: detail.code_graph_id,
      teamId: detail.team_id,
      assetType: ASSET_TYPE_CODE_GRAPH,
      name: detail.repo_name || detail.repo_url,
      ownerUserId: task.owner_user_id,
      serviceUrl: detail.service_url,
    });
    if (reg.ok) {
      deps.knowledgeTaskRegistry.take(knowledgeId);
      log.info('[knowledge-callback] meta asset registered (or already present); task cleared', {
        knowledge_id: knowledgeId, asset_id: detail.code_graph_id,
      });
    } else {
      log.error(`[knowledge-callback] asset register rejected for ${knowledgeId}: code=${(reg.env as { code?: number }).code}`);
    }
  } catch (err) {
    log.error(`[knowledge-callback] asset register error for ${knowledgeId}: ${(err as Error).message}`);
  }
}

export function registerKnowledgeCallbackRoutes(api: Hono, deps: PanelDeps): void {
  const log = deps.logger;

  api.post('/knowledge/status-callback', async (c) => {
    const body = await safeJson(c);

    // ── ingest fine-grained progress (non-terminal) ──
    if (body.event === 'ingest_progress') {
      const wikiId = body.wiki_id?.trim();
      const p = body.progress;
      if (
        !wikiId ||
        !p ||
        !isProgressPhase(p.phase) ||
        typeof p.total !== 'number' ||
        typeof p.completed !== 'number' ||
        typeof p.failed !== 'number' ||
        typeof p.skipped !== 'number' ||
        typeof p.percent !== 'number'
      ) {
        log.warn('[knowledge-callback] ingest_progress rejected: bad payload', {
          wiki_id: body.wiki_id, has_progress: !!body.progress,
        });
        return c.json({ code: 400, message: 'wiki_id and progress fields are required', request_id: '', data: null }, 400);
      }
      deps.ingestProgressStore.update(wikiId, {
        phase: p.phase,
        total: p.total,
        completed: p.completed,
        failed: p.failed,
        skipped: p.skipped,
        percent: p.percent,
      }, body.run_id);
      log.info('[knowledge-callback] ingest_progress stored', {
        wiki_id: wikiId, phase: p.phase, percent: p.percent, run_id: body.run_id,
      });
      return c.json({ code: 0, message: 'ok', request_id: '', data: null });
    }

    if (!body.knowledge_id || !body.type || !body.status) {
      log.warn('[knowledge-callback] rejected: missing fields', {
        knowledge_id: body.knowledge_id, type: body.type, status: body.status,
      });
      return c.json({ code: 400, message: 'knowledge_id, type, status are required', request_id: '', data: null }, 400);
    }
    log.info('[knowledge-callback] received', {
      knowledge_id: body.knowledge_id,
      type: body.type,
      status: body.status,
      service_id: body.service_id,
      has_summary: !!body.summary,
      run_id: body.run_id,
    });

    // Terminal state: clear fine-grained progress and record run_id to reject late packets of this generation
    if (body.type === 'wiki' && (body.status === 'ready' || body.status === 'failed')) {
      deps.ingestProgressStore.clear(body.knowledge_id, body.run_id);
    }

    // ready means writing details (push even if no summary - users can delete it themselves if there are issues)
    if (body.status === 'ready') {
      if (!body.summary) {
        log.warn('[knowledge-callback] ready but no summary; pushing kernel entity anyway', { knowledge_id: body.knowledge_id });
      }
      try {
        const serviceId = body.service_id?.trim();
        if (!serviceId) {
          log.error(`[knowledge-callback] ${body.knowledge_id}: missing service_id, cannot resolve instance; skip`);
          return c.json({ code: 0, message: 'ok', request_id: '', data: null });
        }
        const entry = deps.instanceRegistry.resolve(serviceId); // throw → below catch
        const cred: KernelCredentials = {
          endpoint: entry.gateway_endpoint,
          apiKey: entry.api_key,
          instanceId: entry.instance_id,
          timeoutMs: deps.config.metadataRemoteTimeoutMs,
        };
        const kc = deps.knowledgeClientFactory(serviceId);

        if (body.type === 'wiki') {
          const detail = await kc.wikiGet(body.knowledge_id);
          if (!detail?.service_url) {
            log.error(`[knowledge-callback] wiki ${body.knowledge_id}: null service_url; skip kernel detail sync`);
          } else {
            log.info('[knowledge-callback] wiki → writing kernel entity', {
              knowledge_id: detail.wiki_id, team_id: detail.team_id, owner: detail.owner_user_id,
              has_summary: !!body.summary,
            });
            await deps.kernelHttp.postEnvelope('/v3/knowledge/create', {
              knowledge_id: detail.wiki_id,
              type: 'wiki',
              service_url: detail.service_url,
              name: detail.name,
              summary: body.summary ?? '',
              team_id: detail.team_id,
              user_id: detail.owner_user_id,
            }, cred);
            log.info('[knowledge-callback] wiki → kernel entity written', { knowledge_id: detail.wiki_id });
            // The wiki's meta assets are registered when created, so callback is no longer registered repeatedly.
          }
        } else {
          const detail = await kc.codeGraphGet(body.knowledge_id);
          log.info('[knowledge-callback] code-graph detail fetched from KS', {
            knowledge_id: detail?.code_graph_id, status: detail?.status,
            has_service_url: !!detail?.service_url, owner: detail?.owner_user_id,
          });
          if (!detail?.service_url) {
            log.error(`[knowledge-callback] code-graph ${body.knowledge_id}: null service_url; skip kernel detail sync`);
          } else {
            log.info('[knowledge-callback] code-graph → writing kernel entity', {
              knowledge_id: detail.code_graph_id, team_id: detail.team_id, owner: detail.owner_user_id,
              has_summary: !!body.summary,
            });
            await deps.kernelHttp.postEnvelope('/v3/knowledge/create', {
              knowledge_id: detail.code_graph_id,
              type: 'code-graph',
              service_url: detail.service_url,
              name: detail.repo_name || detail.repo_url,
              summary: body.summary ?? '',
              team_id: detail.team_id,
              user_id: detail.owner_user_id,
              repo_url: detail.repo_url,
              branch: detail.branch,
            }, cred);
            log.info('[knowledge-callback] code-graph → kernel entity written', { knowledge_id: detail.code_graph_id });
            // Register meta asset (primary path): use the owner key stashed at create time to register as owner
            // via /v3/meta/asset/create. The callback itself is S2S without user_key, relying on the in-memory task table to fill in.
            // Failure is best-effort—the frontend register-meta will fall back (idempotent).
            await registerCodeGraphAsset(deps, log, body.knowledge_id, detail, entry);
          }
        }
      } catch (err) {
        log.error(`[knowledge-callback] kernel detail sync error for ${body.knowledge_id}: ${(err as Error).message}`);
      }
    } else if (body.status === 'failed') {
      log.info('[knowledge-callback] failed; not writing entity/meta (UI reads KS status)', { knowledge_id: body.knowledge_id, sync_error: body.sync_error });
    }

    // TODO: WebSocket push to frontend for real-time UI update
    log.info('[knowledge-callback] done', { knowledge_id: body.knowledge_id, status: body.status });
    return c.json({ code: 0, message: 'ok', request_id: '', data: null });
  });
}
