/**
 * Wiki Source Manager — Manages document source registration, scanning, indexing, and query lifecycle
 *
 * Ingestion runs via ingest-v2/ engine.
 *
 * Index storage (Design 006): BM25 full-text search, knowledge graph, and page metadata are no longer resident in memory,
 * stored in each wiki's private `index.db` (SQLite: wiki_fts + page_meta + graph_edge). Writes use independent transaction connection
 * (rebuilding three tables), reads use LRU connection pool; memory is decoupled from total wiki count, resolving MiniSearch full-residency OOM.
 * Knowledge graph is small, temporarily constructed from graph_edge into memory graphology instance during queries to perform multi-hop BFS (reusing existing algorithm).
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join, basename, relative } from "path";
import Graph from "graphology";
import type DatabaseType from "better-sqlite3";
import pLimit, { type LimitFunction } from "p-limit";
import type {
  WikiPage,
  WikiSourceConfig,
  WikiSourceState,
  GraphNode,
  GraphEdge,
  CommunityInfo,
  SearchResult,
  SearchResponse,
  RelatedPage,
  ResultLink,
} from "./types.js";
import { graphMultiHopSearch } from "./graph-search.js";
import {
  initIndexDb,
  getReadDb,
  withWriteDb,
  evictWikiDb,
  readSourceStates,
  recordSourceIngestResult,
  deleteSources,
  classifySources,
  sha256,
  type SourceStatus,
} from "./index-db.js";
import { createLogger } from "../../logger.js";
import { withSpan } from "../../telemetry.js";
import {
  getIngestConcurrency,
  getWikiRetrievalEnabled,
  getWikiRetrievalTopK,
  getWikiRetrievalMaxChars,
  getWikiRetrievalQueryTerms,
} from "../../config.js";
import { buildSearchQuery, formatRetrievedPages, type RetrievedPage } from "./ingest-v2/retrieval.js";
import { slugify } from "./ingest-v2/slug.js";
import { DEFAULT_SCHEMA, DEFAULT_PURPOSE } from "./ingest-v2/template.js";
import { tokenize } from "./tokenize.js";

export { tokenize };

const log = createLogger("wiki-mgr");

// ── Inline frontmatter/wikilink parsing (no external module dependency, ensuring compilation) ──

function extractFrontmatter(content: string): { title: string; type: string; sources: string[]; description: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const typeMatch = fm.match(/^type:\s*["']?(.+?)["']?\s*$/m);
  const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  const sources: string[] = [];
  const sourcesBlockMatch = fm.match(/^sources:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (sourcesBlockMatch) {
    for (const line of sourcesBlockMatch[1].split("\n")) {
      const itemMatch = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/);
      if (itemMatch) sources.push(itemMatch[1]);
    }
  } else {
    const inlineMatch = fm.match(/^sources:\s*\[([^\]]*)\]/m);
    if (inlineMatch) {
      for (const item of inlineMatch[1].split(",")) {
        const trimmed = item.trim().replace(/^["']|["']$/g, "");
        if (trimmed) sources.push(trimmed);
      }
    }
  }
  let title = titleMatch ? titleMatch[1].trim() : "";
  if (!title) {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    title = headingMatch ? headingMatch[1].trim() : "";
  }
  return {
    title,
    type: typeMatch ? typeMatch[1].trim().toLowerCase() : "other",
    sources,
    description: descMatch ? descMatch[1].trim() : "",
  };
}

function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim());
  }
  return links;
}

// ── Manager Interface ──

export interface SearchOptions {
  /** Multi-hop expansion depth (PRD FR-3). 0 = pure BM25. Range 0~5. */
  hop?: number;
  /** Per-hop score decay factor (0~1). */
  decay?: number;
  /** Minimum score threshold; nodes below this are dropped. */
  minScore?: number;
}

/** ingest progress callback payload (KS -> Panel). */
export interface IngestProgress {
  phase: "extracting" | "merging" | "indexing";
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  percent: number;
}

export type ProgressFn = (progress: IngestProgress) => void;

/** Throttle interval during extracting phase; phase transitions (merging/indexing) are always reported immediately. */
export const PROGRESS_THROTTLE_MS = 500;

/**
 * Throttles onProgress: emits immediately on phase change; during same phase, emits only when percent increases and elapsed time >= minIntervalMs
 * (or reached tail of extracting phase percent >= 90), preventing concurrent multi-source ingest from flooding Panel.
 */
export function createThrottledProgressFn(
  onProgress: ProgressFn | undefined,
  minIntervalMs: number = PROGRESS_THROTTLE_MS,
): ProgressFn | undefined {
  if (!onProgress) return undefined;
  let lastPhase: IngestProgress["phase"] | undefined;
  let lastPercent = -1;
  let lastEmitAt = 0;
  return (p) => {
    const now = Date.now();
    const phaseChanged = p.phase !== lastPhase;
    if (!phaseChanged) {
      if (p.percent <= lastPercent) return;
      const nearExtractEnd = p.phase === "extracting" && p.percent >= 90;
      if (!nearExtractEnd && now - lastEmitAt < minIntervalMs) return;
    }
    lastPhase = p.phase;
    lastPercent = p.percent;
    lastEmitAt = now;
    onProgress(p);
  };
}

export interface IngestExecOptions {
  onProgress?: ProgressFn;
  globalLlmLimit?: LimitFunction;
}

export interface WikiSourceManager {
  register(config: WikiSourceConfig): WikiSourceState;
  sync(name: string): WikiSourceState;
  get(name: string): WikiSourceState | undefined;
  list(): WikiSourceState[];
  remove(name: string): void;
  search(name: string, query: string, limit?: number, options?: SearchOptions): SearchResponse;
  graph(name: string): { nodes: GraphNode[]; edges: GraphEdge[]; communities: CommunityInfo[] };
  readPage(name: string, relPath: string): string | null;
  getPages(name: string): WikiPage[];
  init(config: WikiSourceConfig): WikiSourceState;
  ingest(name: string, llmConfig: any, opts?: IngestExecOptions): Promise<any[]>;
}

/** Page types that do not participate in graph edge building/display (e.g. internal query pages). */
const HIDDEN_TYPES = new Set(["query"]);

// ── Graph cache structure (temporarily constructed from graph_edge in index.db during reads) ──

export interface PageGraph {
  /** Public view (filtered, with linkCount/community). */
  view: { nodes: GraphNode[]; edges: GraphEdge[]; communities: CommunityInfo[] };
  /** graphology instance — undirected, no multi-edges. Used for multi-hop BFS. */
  graph: Graph;
  /** Per-page directed wikilink adjacency (id -> outgoing target ids). */
  outAdj: Map<string, Set<string>>;
  /** Per-page reverse adjacency (id -> ids whose page links into this one). */
  inAdj: Map<string, Set<string>>;
  /** Degree (= linkCount in nodes view). */
  degree: Map<string, number>;
}

/** Page metadata (read model; body not stored in db, snippet is static summary pre-generated at write time). */
interface PageMeta {
  id: string;
  title: string;
  type: string;
  relPath: string;
  snippet: string;
}

/**
 * Parses wikilinks between pages, producing directed edges (source -> target) for writing to graph_edge.
 * Only builds edges between visible (non-hidden type) pages, filters self-loops and unresolvable bad links, deduplicating (source,target).
 */
function resolveEdges(pages: WikiPage[]): Array<{ source: string; target: string }> {
  const visible = pages.filter((p) => !HIDDEN_TYPES.has(p.type));
  const out: Array<{ source: string; target: string }> = [];
  if (visible.length === 0) return out;

  const nodeIds = new Set(visible.map((p) => p.id));
  // title slug -> page id mapping: supports wikilinks referencing page titles (rather than filenames).
  const titleSlugToId = new Map<string, string>();
  for (const p of visible) {
    const ts = slugify(p.title);
    if (ts && !titleSlugToId.has(ts)) titleSlugToId.set(ts, p.id);
  }

  const seen = new Set<string>();
  for (const page of visible) {
    for (const targetRaw of page.links) {
      const targetId = resolveTarget(targetRaw, nodeIds, titleSlugToId);
      if (!targetId || targetId === page.id) continue;
      const key = `${page.id}\u0000${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ source: page.id, target: targetId });
    }
  }
  return out;
}

/**
 * Builds in-memory PageGraph from page_meta + graph_edge (read path).
 * Nodes = non-hidden type pages; Edges = graph_edge directed edges, public view is undirected and deduplicated.
 */
function buildPageGraphFromDb(
  metaById: Map<string, PageMeta>,
  edgeRows: Array<{ source_id: string; target_id: string }>,
): PageGraph {
  const graph = new Graph({ multi: false, type: "undirected" });
  const outAdj = new Map<string, Set<string>>();
  const inAdj = new Map<string, Set<string>>();
  const degree = new Map<string, number>();

  const visible: PageMeta[] = [];
  for (const m of metaById.values()) {
    if (!HIDDEN_TYPES.has(m.type)) visible.push(m);
  }

  for (const m of visible) {
    outAdj.set(m.id, new Set());
    inAdj.set(m.id, new Set());
    degree.set(m.id, 0);
    graph.addNode(m.id, { label: m.title, type: m.type, path: m.relPath });
  }

  const seenEdges = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const { source_id: s, target_id: t } of edgeRows) {
    // Endpoints must both be visible nodes (guaranteed at write time; defensive against bad data on read side).
    if (!outAdj.has(s) || !inAdj.has(t)) continue;
    outAdj.get(s)!.add(t);
    inAdj.get(t)!.add(s);
    const key = [s, t].sort().join(":::");
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ source: s, target: t, weight: 1 });
    if (!graph.hasEdge(s, t)) graph.addEdge(s, t, { weight: 1 });
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(t, (degree.get(t) ?? 0) + 1);
  }

  const nodes: GraphNode[] = visible.map((m) => ({
    id: m.id,
    label: m.title,
    type: m.type,
    path: m.relPath,
    linkCount: degree.get(m.id) ?? 0,
    community: 0,
  }));

  return { view: { nodes, edges, communities: [] }, graph, outAdj, inAdj, degree };
}

function resolveTarget(
  raw: string,
  nodeIds: Set<string>,
  titleSlugToId: Map<string, string>,
): string | null {
  if (nodeIds.has(raw)) return raw;

  // Wikilink target can be in various formats (.md suffix, slash paths, mixed Chinese/English, case differences).
  // Uses slugify with same origin as filename for unified comparison against page id basename (single source of truth,
  // avoiding duplicate normalization logic here). slugify treats `/`, spaces, punctuation as segment boundaries,
  // so "/v3/wiki/create endpoint" and "v3-wiki-create-endpoint" align after normalization.
  const target = slugify(raw.replace(/\.md$/i, ""));
  if (!target) return null;

  const rawLower = raw.toLowerCase();
  for (const id of nodeIds) {
    if (id.toLowerCase() === rawLower) return id;
    const idBasename = id.split("/").pop() ?? id;
    if (slugify(idBasename) === target) return id;
  }
  // Fallback: match by page title slug (when wikilink references page title rather than filename).
  const byTitle = titleSlugToId.get(target);
  if (byTitle) return byTitle;
  return null;
}

// ── Search Engine (SQLite FTS5) ──

const SNIPPET_CONTEXT = 80;

/**
 * Pre-generates page summary (written to page_meta.snippet): prioritizes frontmatter description,
 * otherwise takes first SNIPPET_CONTEXT characters of body (excluding frontmatter/headings).
 * Body is not stored in DB; search returns static snippet directly (primary consumer is AI, no dynamic highlighting needed).
 */
function makeSnippet(page: WikiPage): string {
  if (page.description) return page.description;
  const body = page.content
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/^#+\s+.*$/gm, "")
    .trim();
  return [...body].slice(0, SNIPPET_CONTEXT).join("").replace(/\n/g, " ").trim();
}

/**
 * FTS5 Search: query -> tokenize -> add `*` prefix to each token -> OR join -> MATCH.
 * bm25() returns negative values for higher relevance; negated to positive score ("larger = more relevant") for graph expansion decay/minScore.
 * title_tok weight 5.0, content_tok weight 1.0 (aligning with original MiniSearch boost title x 5).
 */
function ftsSearch(db: DatabaseType.Database, query: string, limit: number): Array<{ id: string; score: number }> {
  const toks = tokenize(query);
  if (toks.length === 0) return [];
  const expr = toks.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
  const rows = db
    .prepare(
      "SELECT page_id, bm25(wiki_fts, 5.0, 1.0) AS score FROM wiki_fts WHERE wiki_fts MATCH ? ORDER BY score LIMIT ?",
    )
    .all(expr, limit) as Array<{ page_id: string; score: number }>;
  return rows.map((r) => ({ id: r.page_id, score: -r.score }));
}

/** Rebuilds three index tables (wiki_fts + page_meta + graph_edge) inside transaction. Called by withWriteDb. */
function writeIndex(db: DatabaseType.Database, pages: WikiPage[]): void {
  db.prepare("DELETE FROM wiki_fts").run();
  db.prepare("DELETE FROM page_meta").run();
  db.prepare("DELETE FROM graph_edge").run();

  const insFts = db.prepare("INSERT INTO wiki_fts(page_id, title_tok, content_tok) VALUES (?,?,?)");
  const insMeta = db.prepare(
    "INSERT INTO page_meta(page_id, title, type, rel_path, snippet) VALUES (?,?,?,?,?)"
  );
  const insEdge = db.prepare("INSERT OR IGNORE INTO graph_edge(source_id, target_id) VALUES (?,?)");

  for (const p of pages) {
    // wiki_fts + page_meta include all pages (including hidden types, for search).
    insFts.run(p.id, tokenize(p.title).join(" "), tokenize(p.content).join(" "));
    insMeta.run(p.id, p.title, p.type, p.relPath, makeSnippet(p));
  }
  // graph_edge only connects visible pages.
  for (const e of resolveEdges(pages)) insEdge.run(e.source, e.target);
}

/** Loads read model from read connection: page metadata table + graph (in-memory graph constructed from graph_edge). */
function loadReadModel(db: DatabaseType.Database): { pg: PageGraph; metaById: Map<string, PageMeta> } {
  const metaRows = db
    .prepare("SELECT page_id, title, type, rel_path, snippet FROM page_meta ORDER BY page_id")
    .all() as Array<{ page_id: string; title: string | null; type: string | null; rel_path: string | null; snippet: string | null }>;
  const metaById = new Map<string, PageMeta>();
  for (const r of metaRows) {
    metaById.set(r.page_id, {
      id: r.page_id,
      title: r.title ?? "",
      type: r.type ?? "other",
      relPath: r.rel_path ?? "",
      snippet: r.snippet ?? "",
    });
  }
  const edgeRows = db.prepare("SELECT source_id, target_id FROM graph_edge").all() as Array<{
    source_id: string;
    target_id: string;
  }>;
  const pg = buildPageGraphFromDb(metaById, edgeRows);
  return { pg, metaById };
}

// ── Search Constants & Helpers ──

const HOP_LIMIT = 5;
const DEFAULT_LIMIT = 20;
const DEFAULT_HOP = 0;
const DEFAULT_DECAY = 0.5;
const DEFAULT_MIN_SCORE = 0.1;
const RELATED_CAP = 10;
const EXPANSION_CAP = 200;

/**
 * Build the `related` field for one result page (PRD FR-1).
 *
 * Out-link (this → other), in-link (other → this), or both. Same neighbour
 * keeps a single entry. Sort by neighbour degree descending, cap at RELATED_CAP.
 */
function buildRelated(
  pageId: string,
  pg: PageGraph,
  metaById: Map<string, PageMeta>,
): RelatedPage[] {
  const out = pg.outAdj.get(pageId) ?? new Set<string>();
  const inn = pg.inAdj.get(pageId) ?? new Set<string>();
  const all = new Set<string>([...out, ...inn]);
  const items: RelatedPage[] = [];
  for (const nbId of all) {
    const nbMeta = metaById.get(nbId);
    if (!nbMeta) continue;
    const isOut = out.has(nbId);
    const isIn = inn.has(nbId);
    const direction: RelatedPage["direction"] = isOut && isIn ? "both" : isOut ? "out" : "in";
    items.push({ title: nbMeta.title, path: nbMeta.relPath, type: nbMeta.type, direction });
  }
  items.sort((a, b) => {
    const da = pg.degree.get(idFromPath(a.path)) ?? 0;
    const db = pg.degree.get(idFromPath(b.path)) ?? 0;
    return db - da;
  });
  return items.slice(0, RELATED_CAP);
}

function idFromPath(relPath: string): string {
  return relPath.replace(/^wiki\//, "").replace(/\.md$/, "");
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

/**
 * Build inter-result wikilink edges (PRD FR-2).
 *
 * Only edges where both endpoints are in `resultIds`. Undirected dedup
 * via sorted-pair key. Self-loops were already excluded at graph-build time.
 */
function buildResultLinks(resultIds: string[], pg: PageGraph, metaById: Map<string, PageMeta>): ResultLink[] {
  const inResults = new Set(resultIds);
  const seen = new Set<string>();
  const links: ResultLink[] = [];
  for (const id of resultIds) {
    const meta = metaById.get(id);
    if (!meta) continue;
    const out = pg.outAdj.get(id) ?? new Set<string>();
    for (const target of out) {
      if (!inResults.has(target)) continue;
      const key = [id, target].sort().join(":::");
      if (seen.has(key)) continue;
      seen.add(key);
      const targetMeta = metaById.get(target);
      links.push({
        source: meta.relPath,
        target: targetMeta ? targetMeta.relPath : target,
        weight: 1,
      });
    }
  }
  return links;
}

// ── Initialize Template ──

function initWikiProject(projectPath: string): void {
  const dirs = ["raw/sources", "wiki/entities", "wiki/concepts", "wiki/sources", "wiki/comparisons", "wiki/synthesis", ".llm-wiki"];
  for (const dir of dirs) mkdirSync(join(projectPath, dir), { recursive: true });
  const defaultFiles: [string, string][] = [
    ["wiki/schema.md", `---\ntype: schema\ntitle: Wiki Schema\n---\n\n${DEFAULT_SCHEMA}\n`],
    ["wiki/purpose.md", `---\ntype: purpose\ntitle: Wiki Purpose\n---\n\n${DEFAULT_PURPOSE}\n`],
    ["wiki/index.md", "---\ntype: index\ntitle: Index\n---\n\n# Index\n\n## Entities\n\n## Concepts\n\n## Sources\n"],
  ];
  for (const [rel, content] of defaultFiles) {
    const full = join(projectPath, rel);
    if (!existsSync(full)) writeFileSync(full, content, "utf-8");
  }
}

// ── Ingest (ingest-v2; incremental extraction see Design 003) ──

/** Single-source extraction result (used for recording source.status in transaction). */
interface ProcessedSource {
  filename: string;
  sha256: string;
  size: number;
  ok: boolean;
  error: string | null;
}

interface IngestOutcome {
  /** Compatible with legacy return: {source, filesWritten, error} for each extracted source. */
  results: any[];
  /** Source results attempted in this run (used for recording source status). */
  processed: ProcessedSource[];
  /** Present in database table but missing on disk -> source rows to be deleted. */
  deletedSources: string[];
}

/**
 * Incremental ingestion (Design 003 §3.6 + wiki-ingest-optimization):
 * Stage 1 parallel LLM extraction -> deleted source cascade cleanup -> Stage 2 serial merge disk commit -> overview.
 * Does not update source table / rebuild index here — those are performed by ingest() in the same transaction (strong consistency).
 * All-failed detection is not thrown here; handled by upper WikiSourceManager.ingest after write transaction.
 *
 * Exported for orchestration unit testing (progress phase / skipped / all-failed no throw).
 */
export async function runIngestIncremental(
  projectPath: string,
  oldStates: Map<string, { sha256: string; status: SourceStatus }>,
  llmConfig: any,
  onProgress?: ProgressFn,
  globalLlmLimit?: LimitFunction,
  retrieveContext?: (sourceText: string) => string,
): Promise<IngestOutcome> {
  const { extractSource, commitCandidates, scanExistingPages } = await import("./ingest-v2/index.js");
  const report = createThrottledProgressFn(onProgress);
  const sourcesDir = join(projectPath, "raw", "sources");
  if (!existsSync(sourcesDir)) {
    log.warn("runIngest: raw/sources does not exist, skipping", { projectPath });
    return { results: [], processed: [], deletedSources: [...oldStates.keys()] };
  }

  // Scan disk sources and compute sha. filename = posix path relative to sourcesDir (aligned with rawWrite's filename).
  const disk = findMdFiles(sourcesDir).map((abs) => {
    const content = readFileSync(abs, "utf-8");
    return {
      abs,
      filename: relative(sourcesDir, abs).replace(/\\/g, "/"),
      sha256: sha256(content),
      size: Buffer.byteLength(content, "utf-8"),
    };
  });

  const { toIngest, skipped, deleted } = classifySources(disk, oldStates);
  const skippedCount = skipped.length;
  const toIngestSet = new Set(toIngest);
  const toIngestDisk = disk.filter((d) => toIngestSet.has(d.filename));
  log.info("runIngest incremental classification", {
    projectPath,
    disk: disk.length,
    toIngest: toIngest.length,
    skipped: skipped.length,
    deleted: deleted.length,
  });

  const existingPages = scanExistingPages(projectPath);
  const concurrency = getIngestConcurrency();
  const wikiLimit = pLimit(concurrency);

  // ── Phase 1: parallel LLM extraction ──
  report?.({
    phase: "extracting",
    total: toIngestDisk.length,
    completed: 0,
    failed: 0,
    skipped: skippedCount,
    percent: 0,
  });

  let completed = 0;
  let failed = 0;

  const tasks = toIngestDisk.map((d) =>
    wikiLimit(async () => {
      const t0 = Date.now();
      try {
        const candidates = await withSpan("ingest-source", async (span) => {
          span.setAttribute("source.name", d.filename);
          // RAG ingest: inject retrieval function into extractSource to retrieve relevant existing 
          // pages per chunk (both internal logic and extractSource are degraded to non-RAG if 
          // retriever is missing, without blocking ingest).
          const run = () => extractSource(projectPath, d.abs, llmConfig, existingPages, { retrieveContext });
          return globalLlmLimit ? globalLlmLimit(run) : run();
        });
        completed++;
        report?.({
          phase: "extracting",
          total: toIngestDisk.length,
          completed,
          failed,
          skipped: skippedCount,
          percent: Math.round(((completed + failed) / Math.max(toIngestDisk.length, 1)) * 90),
        });
        log.info("runIngest per-source extraction complete", {
          source: d.filename,
          candidates: candidates.size,
          ms: Date.now() - t0,
        });
        return { ...d, ok: true as const, candidates, error: null };
      } catch (err) {
        failed++;
        report?.({
          phase: "extracting",
          total: toIngestDisk.length,
          completed,
          failed,
          skipped: skippedCount,
          percent: Math.round(((completed + failed) / Math.max(toIngestDisk.length, 1)) * 90),
        });
        log.error("runIngest per-source extraction failed", {
          source: d.filename,
          ms: Date.now() - t0,
          error: String(err),
        });
        return {
          ...d,
          ok: false as const,
          candidates: new Map<string, string>(),
          error: String(err),
        };
      }
    }),
  );

  const extractResults = await Promise.all(tasks);

  // ── Cascade cleanup of deleted sources (aligned with existing logic) ──
  if (deleted.length > 0) {
    try {
      const { deleteSourceFiles } = await import("./ingest-v2/cascade.js");
      await deleteSourceFiles(
        projectPath,
        deleted.map((fn) => join(sourcesDir, fn)),
        { logReason: "wiki/ingest/removed-source" },
      );
    } catch (err) {
      log.warn("cascade cleanup of deleted sources failed", { error: String(err) });
    }
  }

  // ── Phase 2: serial disk merge ──
  report?.({
    phase: "merging",
    total: toIngestDisk.length,
    completed,
    failed,
    skipped: skippedCount,
    percent: 90,
  });

  const successResults = extractResults.filter((r) => r.ok);
  const allCandidates = successResults.map((r) => ({
    sourceFilename: r.filename,
    candidates: r.candidates,
  }));

  // B-1: Only create client when there are candidates needing merge/overview; failures don't throw, so the caller can still write source status.
  // Don't create client when it is a pure no-op (toIngest=0) or all extractions failed (commit only rebuilds index, no LLM call).
  let llm: import("./ingest-v2/llm.js").LlmClient | undefined;
  if (allCandidates.length > 0) {
    try {
      const { createLlmClient } = await import("./ingest-v2/llm.js");
      llm = createLlmClient(llmConfig);
    } catch (err) {
      log.error("failed to create LLM client (phase 2 merge/overview will degrade, source status will still be persisted)", {
        error: String(err),
      });
    }
  }

  // With no successful extraction, index.md may still need rebuilding after cascade deletion; skipLog avoids empty-batch logs
  const { written, mergeErrors } = await commitCandidates(projectPath, allCandidates, llm, {
    globalLlmLimit,
    skipLog: allCandidates.length === 0,
  });

  if (mergeErrors.length > 0) {
    log.warn("phase 2 failed to merge some pages", { count: mergeErrors.length, errors: mergeErrors });
  }

  // ── Source status determination (must run after commitCandidates) ──
  const processed: ProcessedSource[] = extractResults.map((r) => {
    if (!r.ok) {
      return { filename: r.filename, sha256: r.sha256, size: r.size, ok: false, error: r.error };
    }
    const sourcePages = [...r.candidates.keys()];
    const allMergeFailed =
      sourcePages.length > 0 &&
      sourcePages.every((p) => mergeErrors.some((e) => e.source === r.filename && e.relPath === p)) &&
      !sourcePages.some((p) => written.includes(p));
    return {
      filename: r.filename,
      sha256: r.sha256,
      size: r.size,
      ok: !allMergeFailed,
      error: allMergeFailed ? "all candidates merge failed" : null,
    };
  });

  // ── Phase 3: overview (FTS index built by the upper-layer ingest write transaction) ──
  report?.({
    phase: "indexing",
    total: toIngestDisk.length,
    completed,
    failed,
    skipped: skippedCount,
    percent: 98,
  });

  if (successResults.length > 0) {
    if (!llm) {
      log.warn("overview skipped: LLM client unavailable (does not affect ingestion)");
    } else {
      try {
        const { generateOverview } = await import("./ingest-v2/overview.js");
        const runOverview = () => generateOverview(projectPath, llm);
        await (globalLlmLimit ? globalLlmLimit(runOverview) : runOverview());
      } catch (err) {
        log.warn("overview generation failed (does not affect ingestion)", { error: String(err) });
      }
    }
  }

  const results = extractResults.map((r) => {
    if (!r.ok) return { source: r.filename, filesWritten: [] as string[], error: r.error };
    const sourcePages = [...r.candidates.keys()];
    const filesWritten = sourcePages.filter((p) => written.includes(p));
    return { source: r.filename, filesWritten, error: null };
  });

  const okCount = processed.filter((p) => p.ok).length;
  log.info("runIngest complete", {
    total: results.length,
    ok: okCount,
    failed: results.length - okCount,
    written: written.length,
  });

  // All-failure detection: don't throw here (the upper-layer write transaction decides afterwards, ensuring source status is persisted).
  return { results, processed, deletedSources: deleted };
}

function findMdFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...findMdFiles(full));
    else if (entry.endsWith(".md") || entry.endsWith(".txt")) files.push(full);
  }
  return files;
}

// ── Factory ──

export function createWikiSourceManager(dataDir: string): WikiSourceManager {
  const sources = new Map<string, WikiSourceState>();
  const stateFile = join(dataDir, "wiki-sources.json");

  mkdirSync(dataDir, { recursive: true });

  function persist() {
    writeFileSync(stateFile, JSON.stringify(Object.fromEntries(sources.entries()), null, 2), "utf-8");
  }

  function loadState() {
    if (!existsSync(stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf-8"));
      for (const [name, state] of Object.entries<any>(raw)) {
        if (state.status === "scanning") { state.status = "error"; state.error = "Restart"; }
        sources.set(name, state);
      }
    } catch { /* fresh start */ }
  }

  function scanWikiDir(projectPath: string): WikiPage[] {
    const wikiDir = join(projectPath, "wiki");
    if (!existsSync(wikiDir)) throw new Error(`wiki/ not found: ${wikiDir}`);
    const pages: WikiPage[] = [];
    scanRecursive(wikiDir, wikiDir, pages);
    return pages;
  }

  function scanRecursive(baseDir: string, dir: string, pages: WikiPage[]) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) { if (entry !== "media") scanRecursive(baseDir, full, pages); }
      else if (entry.endsWith(".md")) {
        try {
          const content = readFileSync(full, "utf-8");
          const rel = full.slice(baseDir.length + 1);
          const id = rel.replace(/\.md$/, "").replace(/\\/g, "/");
          const fm = extractFrontmatter(content);
          pages.push({ id, title: fm.title || basename(entry, ".md").replace(/-/g, " "), type: fm.type, path: full, relPath: `wiki/${rel}`, content, sources: fm.sources, links: extractWikilinks(content), description: fm.description });
        } catch { /* skip */ }
      }
    }
  }

  /** Rebuilds wiki's index.db index (idempotent DB init -> transaction rebuild 3 tables -> evict read connections to prevent stale reads). */
  function rebuildIndex(name: string, pages: WikiPage[]) {
    const state = sources.get(name);
    if (!state) throw new Error(`rebuildIndex: unknown wiki ${name}`);
    initIndexDb(state.path); // Idempotent: first register creates DB + 4 tables; if already present, no-op
    withWriteDb(state.path, (db) => writeIndex(db, pages));
    evictWikiDb(name); // Drop read connections that may hold a stale snapshot; reopen on next query
  }

  function searchInternal(name: string, query: string, limit: number, options: SearchOptions): SearchResponse {
    const state = sources.get(name);
    if (!state) return { results: [], links: [], count: 0 };

    let db: DatabaseType.Database;
    try {
      db = getReadDb(name, state.path);
    } catch {
      // DB does not exist (wiki not ingested/indexed) -> return empty, consistent with legacy "no engine" behavior.
      return { results: [], links: [], count: 0 };
    }

    const hop = clamp(options.hop ?? DEFAULT_HOP, 0, HOP_LIMIT);
    const decay = clamp(options.decay ?? DEFAULT_DECAY, 0, 1);
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    const finalLimit = limit > 0 ? limit : DEFAULT_LIMIT;

    // Pull a slightly oversized seed pool so graph expansion still has something
    // to walk from when `limit` is small but `hop>0` is requested.
    const seedPoolSize = Math.max(finalLimit, hop > 0 ? finalLimit * 2 : finalLimit);
    const rawSeeds = ftsSearch(db, query, seedPoolSize);
    if (rawSeeds.length === 0) {
      return { results: [], links: [], count: 0 };
    }

    const { pg, metaById } = loadReadModel(db);

    let hits: { id: string; score: number; hop: number; via?: string }[];
    if (hop === 0) {
      hits = rawSeeds.slice(0, finalLimit).map((s) => ({ id: s.id, score: s.score, hop: 0 }));
    } else {
      hits = graphMultiHopSearch(pg.graph, rawSeeds, { hop, decay, minScore, maxNodes: EXPANSION_CAP });
      hits = hits.slice(0, finalLimit);
    }

    const results: SearchResult[] = [];
    const resultIds: string[] = [];
    for (const hit of hits) {
      const meta = metaById.get(hit.id);
      if (!meta) continue;
      const result: SearchResult = {
        path: meta.relPath,
        title: meta.title,
        snippet: meta.snippet,
        score: hit.score,
        type: meta.type,
        hop: hit.hop,
        related: buildRelated(meta.id, pg, metaById),
      };
      if (hit.hop > 0 && hit.via) result.via = hit.via;
      results.push(result);
      resultIds.push(meta.id);
    }

    const links = buildResultLinks(resultIds, pg, metaById);
    return { results, links, count: results.length };
  }

  loadState();
  // Restores BM25 search index on startup (rebuilds index.db / pagesMap / searchEngines for each ready wiki).
  // loadState only restores metadata (sources map); index data is persistent, but to align with disk text and avoid
  // search / pages / graph returning empty after restart, resubmits scan and rebuild from disk once.
  log.info("Restoring wiki indexes", { count: sources.size });
  let restored = 0;
  let failed = 0;
  for (const [name, state] of sources.entries()) {
    if (state.status !== "ready") {
      log.debug("Skip non-ready wiki source", { name, status: state.status });
      continue;
    }
    const wikiDir = join(state.path, "wiki");
    if (!existsSync(wikiDir)) {
      log.warn("Wiki dir missing on disk; mark error and skip restore", { name, path: state.path });
      state.status = "error";
      state.error = `wiki dir not found: ${wikiDir}`;
      failed++;
      continue;
    }
    try {
      const pages = scanWikiDir(state.path);
      rebuildIndex(name, pages);
      restored++;
      log.info("Restored wiki index", { name, pageCount: pages.length });
    } catch (err) {
      failed++;
      log.error("Failed to restore wiki index", { name, error: err instanceof Error ? err.message : String(err) });
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
    }
  }
  log.info("Wiki restore complete", { restored, failed, total: sources.size });

  function register(config: WikiSourceConfig): WikiSourceState {
    const existing = sources.get(config.name);
    if (existing) return existing;
    const state: WikiSourceState = { name: config.name, path: config.path, status: "scanning" };
    sources.set(config.name, state);
    try {
      const pages = scanWikiDir(config.path);
      rebuildIndex(config.name, pages);
      state.status = "ready"; state.pageCount = pages.length; state.lastSyncAt = new Date().toISOString();
    } catch (err) { state.status = "error"; state.error = String(err); }
    persist();
    return state;
  }

  function sync(name: string): WikiSourceState {
    const state = sources.get(name);
    if (!state) throw new Error(`Not found: ${name}`);
    state.status = "scanning";
    const t0 = Date.now();
    try {
      const pages = scanWikiDir(state.path);
      rebuildIndex(name, pages);
      state.status = "ready"; state.pageCount = pages.length; state.lastSyncAt = new Date().toISOString(); state.error = undefined;
      log.info("sync complete (index rebuilt)", { name, pageCount: pages.length, ms: Date.now() - t0 });
    } catch (err) {
      state.status = "error"; state.error = String(err);
      log.error("sync failed", { name, path: state.path, error: String(err) });
    }
    persist();
    return state;
  }

  function init(config: WikiSourceConfig): WikiSourceState {
    initWikiProject(config.path);
    return register(config);
  }

  async function ingest(name: string, llmConfig: any, opts?: IngestExecOptions): Promise<any[]> {
    const state = sources.get(name);
    if (!state) throw new Error(`Not found: ${name}`);
    const projectPath = state.path;
    initIndexDb(projectPath); // Ensure index.db exists (register usually creates it already; idempotent)

    // Read the last source states (baseline for incremental detection) - must be read before extraction.
    let oldStates = new Map<string, { sha256: string; status: SourceStatus }>();
    try {
      oldStates = readSourceStates(getReadDb(name, projectPath));
    } catch {
      /* DB just created / no source rows -> treat all as new */
    }

    // Retrieval-augmented ingestion: when enabled, build a "source doc -> related existing page body"
    // closure reusing searchInternal + readPage (same retrieval surface as /v3/search and agent tools).
    // Any failure degrades to no augmentation and never blocks ingestion.
    let retrieveContext: ((sourceText: string) => string) | undefined;
    if (getWikiRetrievalEnabled()) {
      const topK = getWikiRetrievalTopK();
      const maxChars = getWikiRetrievalMaxChars();
      const queryTerms = getWikiRetrievalQueryTerms();
      retrieveContext = (sourceText) => {
        try {
          const query = buildSearchQuery(sourceText, queryTerms);
          if (!query) return "";
          const res = searchInternal(name, query, topK, { hop: 0 });
          const pages: RetrievedPage[] = [];
          for (const r of res.results) {
            const content = readPageInternal(name, r.path);
            if (content) pages.push({ relPath: r.path, title: r.title, content });
          }
          return formatRetrievedPages(pages, maxChars);
        } catch (err) {
          log.warn("wiki retrieval-augmented ingestion failed, degrading to no augmentation", { wiki: name, error: err instanceof Error ? err.message : String(err) });
          return "";
        }
      };
    }

    const outcome = await withSpan("wiki-ingest", async (span) => {
      span.setAttribute("wiki.name", name);
      return runIngestIncremental(
        projectPath,
        oldStates,
        llmConfig,
        opts?.onProgress,
        opts?.globalLlmLimit,
        retrieveContext,
      );
    });

    // Rebuild index + record source status + delete removed source rows: **SAME WRITE TRANSACTION** (Design 003 §3.6 step 6, strong consistency).
    state.status = "scanning";
    const t0 = Date.now();
    try {
      const pages = scanWikiDir(projectPath);
      withWriteDb(projectPath, (db) => {
        writeIndex(db, pages);
        for (const p of outcome.processed) recordSourceIngestResult(db, p);
        if (outcome.deletedSources.length > 0) deleteSources(db, outcome.deletedSources);
      });
      evictWikiDb(name); // Evict read connections holding old snapshot

      const attempted = outcome.processed.length;
      const failed = outcome.processed.filter((p) => !p.ok);
      if (attempted > 0 && failed.length === attempted) {
        const first = failed[0];
        throw new Error(
          `all source documents failed to ingest${first ? `; first failure: ${first.filename}: ${first.error ?? "unknown"}` : ""}`,
        );
      }

      state.status = "ready";
      state.pageCount = pages.length;
      state.lastSyncAt = new Date().toISOString();
      state.error = undefined;
      log.info("ingest complete (incremental extraction + index/source status rebuilt in same transaction)", {
        name,
        pageCount: pages.length,
        extracted: outcome.processed.length,
        failed: failed.length,
        ms: Date.now() - t0,
      });
    } catch (err) {
      state.status = "error";
      state.error = String(err);
      log.error("ingest failed", { name, path: projectPath, error: String(err) });
      persist();
      throw err;
    }
    persist();
    return outcome.results;
  }

  /** Reads existing wiki page body (accepts id or relPath). Retrieval-augmented ingestion reuses same reading path. */
  function readPageInternal(name: string, relPath: string): string | null {
    const state = sources.get(name);
    if (!state) return null;

    // Supports raw/ prefix: read directly from project root
    if (relPath.startsWith("raw/")) {
      const fullPath = join(state.path, relPath);
      if (!fullPath.startsWith(join(state.path, "raw"))) return null; // Path traversal protection
      try { return readFileSync(fullPath, "utf-8"); } catch {}
      if (!relPath.endsWith(".md")) {
        try { return readFileSync(fullPath + ".md", "utf-8"); } catch {}
      }
      return null;
    }

    // Supports multiple formats:
    //   "wiki/concepts/l0-ingest.md" -> full relPath
    //   "concepts/l0-ingest.md"      -> remove wiki/ prefix
    //   "concepts/l0-ingest"         -> id format (without .md)
    const cleanPath = relPath.replace(/^wiki\//, "");
    const base = join(state.path, "wiki");
    let fullPath = join(base, cleanPath);
    if (!fullPath.startsWith(base)) return null;
    // Try directly first, then append .md
    try { return readFileSync(fullPath, "utf-8"); } catch {}
    if (!cleanPath.endsWith(".md")) {
      try { return readFileSync(fullPath + ".md", "utf-8"); } catch {}
    }
    return null;
  }

  return {
    register, sync, init, ingest,
    get: (name) => sources.get(name),
    list: () => [...sources.values()],
    remove: (name) => {
      const state = sources.get(name);
      sources.delete(name);
      // Close read connection first (internal checkpoint+close), directory rmSync handled by caller (wiki-service/route).
      evictWikiDb(name);
      if (state) { /* index.db cleaned up with directory deletion */ }
      persist();
    },
    search: (name, query, limit, options) => searchInternal(name, query, limit ?? DEFAULT_LIMIT, options ?? {}),
    graph: (name) => {
      const state = sources.get(name);
      if (!state) return { nodes: [], edges: [], communities: [] };
      try {
        const db = getReadDb(name, state.path);
        return loadReadModel(db).pg.view;
      } catch {
        return { nodes: [], edges: [], communities: [] };
      }
    },
    readPage: (name, relPath) => readPageInternal(name, relPath),
    getPages: (name) => {
      const state = sources.get(name);
      if (!state) return [];
      try { return scanWikiDir(state.path); } catch { return []; }
    },
  };
}
