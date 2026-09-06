/**
 * v3 WikiClient — thin wrapper around Knowledge Service POST /v3/wiki/* (15 endpoints).
 *
 * Asset layer: create / get / list / delete / update-meta / ingest.
 * File layer: raw/{ls,read,write,rm} + page/{ls,read,write,rm}.
 * Derived: graph / search.
 *
 * Auth: x-tdai-service-id always (V3HttpTransport); Bearer only if apiKey
 * given (KS standalone needs none). Team-scoped writes carry team_id
 * (+ optional user_id) in body; id-only reads address by wiki_id.
 *
 * End-to-end wiki flow with MetadataClient + SkillClient:
 *   meta.createUser / createTeam / addTeamMember (management plane :8420)
 *   skills.create (skill plane :8420)
 *   wiki.create (KS data plane, this client) -> rawWrite sources -> ingest
 *   meta.shareAssetWithTeam() to share wiki/skill assets within their team
 *   (asset_id === wiki_id / skill_id); meta.grantAcl for restricted sharing,
 *   meta.setAgentFixedAssets to allocate an asset to an agent.
 */
import { ParamError } from "../errors.js";
import { V3HttpTransport } from "./http.js";
import type { Transport } from "../client.js";
import { flatGraphOptions, requireNonEmpty, stripUndefined } from "./request-helpers.js";
import type {
  WikiBatchDeleteResult, WikiClientConfig, WikiDetail, WikiGraphData,
  WikiIngestResult, WikiListResult, WikiPageRmResult, WikiPageWriteResultItem,
  WikiPageReadItem, WikiRawReadItem, WikiRawRmResult, WikiRawWriteItem,
  WikiSearchResult, PageEntry, RawFileEntry,
} from "./wiki-types.js";
const V3 = "/v3/wiki";
function need(name: string, v: string | undefined): string {
  try {
    return requireNonEmpty(name, v);
  } catch {
    throw new ParamError("WikiClient requires non-empty " + name);
  }
}
export class WikiClient {
  private readonly http: Transport;
  constructor(config: WikiClientConfig);
  constructor(transport: Transport);
  constructor(configOrTransport: WikiClientConfig | Transport) {
    if ("post" in configOrTransport) { this.http = configOrTransport; return; }
    const cfg = configOrTransport;
    need("serviceId", cfg.serviceId);
    if (!cfg.endpoint || !cfg.endpoint.trim()) throw new ParamError("WikiClient requires non-empty endpoint");
    this.http = new V3HttpTransport({
      endpoint: cfg.endpoint, apiKey: cfg.apiKey, serviceId: cfg.serviceId,
      userKey: cfg.userKey, timeout: cfg.timeout, rejectUnauthorized: cfg.rejectUnauthorized,
    });
  }
  create(p: { team_id: string; name: string; user_id?: string }): Promise<WikiDetail> {
    need("team_id", p.team_id); need("name", p.name);
    return this.http.post(V3 + "/create", stripUndefined({ team_id: p.team_id, name: p.name, user_id: p.user_id }));
  }
  get(wikiId: string): Promise<WikiDetail> {
    return this.http.post(V3 + "/get", { wiki_id: need("wiki_id", wikiId) });
  }
  list(teamId: string, opts: { status?: string; limit?: number; offset?: number } = {}): Promise<WikiListResult> {
    return this.http.post(V3 + "/list", stripUndefined({ team_id: need("team_id", teamId), ...opts }));
  }
  delete(wikiIds: string[]): Promise<WikiBatchDeleteResult> {
    if (!wikiIds.length) throw new ParamError("delete requires non-empty wiki_ids");
    return this.http.post(V3 + "/delete", { wiki_ids: wikiIds });
  }
  updateMeta(wikiId: string, patch: { name?: string; summary?: string | null }): Promise<WikiDetail> {
    if (!patch.name && patch.summary === undefined) throw new ParamError("updateMeta requires name or summary");
    return this.http.post(V3 + "/update-meta", stripUndefined({ wiki_id: need("wiki_id", wikiId), ...patch }));
  }
  rawWrite(teamId: string, wikiId: string, files: Array<{ filename: string; content: string }>, userId?: string): Promise<{ items: WikiRawWriteItem[] }> {
    need("team_id", teamId); need("wiki_id", wikiId);
    if (!files.length) throw new ParamError("rawWrite requires non-empty files");
    return this.http.post(V3 + "/raw/write", stripUndefined({ team_id: teamId, user_id: userId, wiki_id: wikiId, files }));
  }
  rawLs(wikiId: string): Promise<{ items: RawFileEntry[] }> {
    return this.http.post(V3 + "/raw/ls", { wiki_id: need("wiki_id", wikiId) });
  }
  rawRead(wikiId: string, filenames: string[]): Promise<{ items: WikiRawReadItem[] }> {
    if (!filenames.length) throw new ParamError("rawRead requires non-empty filenames");
    return this.http.post(V3 + "/raw/read", { wiki_id: need("wiki_id", wikiId), filenames });
  }
  rawRm(teamId: string, wikiId: string, filenames: string[], userId?: string): Promise<WikiRawRmResult> {
    if (!filenames.length) throw new ParamError("rawRm requires non-empty filenames");
    return this.http.post(V3 + "/raw/rm", stripUndefined({ team_id: need("team_id", teamId), user_id: userId, wiki_id: need("wiki_id", wikiId), filenames }));
  }
  pageLs(wikiId: string): Promise<{ items: PageEntry[] }> {
    return this.http.post(V3 + "/page/ls", { wiki_id: need("wiki_id", wikiId) });
  }
  pageRead(wikiId: string, refs: string[]): Promise<{ items: WikiPageReadItem[] }> {
    if (!refs.length) throw new ParamError("pageRead requires non-empty refs");
    return this.http.post(V3 + "/page/read", { wiki_id: need("wiki_id", wikiId), refs });
  }
  pageWrite(teamId: string, wikiId: string, pages: Array<{ ref: string; content: string }>, userId?: string): Promise<{ items: WikiPageWriteResultItem[] }> {
    if (!pages.length) throw new ParamError("pageWrite requires non-empty pages");
    return this.http.post(V3 + "/page/write", stripUndefined({ team_id: need("team_id", teamId), user_id: userId, wiki_id: need("wiki_id", wikiId), pages }));
  }
  pageRm(teamId: string, wikiId: string, refs: string[], userId?: string): Promise<WikiPageRmResult> {
    if (!refs.length) throw new ParamError("pageRm requires non-empty refs");
    return this.http.post(V3 + "/page/rm", stripUndefined({ team_id: need("team_id", teamId), user_id: userId, wiki_id: need("wiki_id", wikiId), refs }));
  }
  ingest(wikiId: string, userId?: string): Promise<WikiIngestResult> {
    return this.http.post(V3 + "/ingest", stripUndefined({ wiki_id: need("wiki_id", wikiId), user_id: userId }));
  }
  graph(wikiId: string): Promise<WikiGraphData> {
    return this.http.post(V3 + "/graph", { wiki_id: need("wiki_id", wikiId) });
  }
  /**
   * BM25 search with optional graph expansion. Options are sent as flat
   * top-level fields (hop/decay/minScore) — the shape the server reads.
   */
  search(wikiId: string, query: string, limit = 20, graph?: { hop?: number; decay?: number; minScore?: number }): Promise<WikiSearchResult> {
    need("query", query);
    return this.http.post(V3 + "/search", stripUndefined({
      wiki_id: need("wiki_id", wikiId), query, limit, ...flatGraphOptions(graph),
    }));
  }
}
