/**
 * TcvdbSkillStore — TCVDB (Service mode) implementation for Skill storage layer
 *
 * Implements ISkillStore interface, providing VDB persistence for skill metadata/content.
 * Mirrors the 12 methods of SqliteSkillStore, refers to TcvdbMemoryStore's
 * Collection creation / upsert / query / search / hybridSearch modes.
 *
 * Schema: See docs/design/2026-06-29-skill-vdb-schema.md
 * Interface: src/core/skill/skill-store.interface.ts
 */

import { randomBase62 } from "../../utils/short-id.js";
import { TcvdbClient, TcvdbApiError, type QueryResponse } from "./tcvdb-client.js";
import type { BM25LocalEncoder } from "./bm25-local.js";
import type { SparseVector } from "@tencentdb-agent-memory/tcvdb-text";
import type { StoreLogger } from "./types.js";
import type {
  ISkillStore,
  SkillStoreCapabilities,
  SkillSearchResult,
  ExpiredVersionMeta,
} from "../skill/skill-store.interface.js";
import type {
  AppendVersionInput,
  ListSkillsOptions,
  SearchSkillsOptions,
  Skill,
  SkillManifestEntry,
  SkillStatus,
} from "../skill/types.js";
import { SkillStoreError } from "../skill/skill-store.js";

// ─── Config ─────────────────────────────────────────────────────────────

export interface TcvdbSkillStoreConfig {
  /** VDB Instance URL */
  url: string;
  /** Account name (default "root") */
  username: string;
  /** API Key */
  apiKey: string;
  /** Database name */
  database: string;
  /** Embedding model name (shared with L1 "bge-large-zh") */
  embeddingModel: string;
  /** Request timeout ms */
  timeout: number;
  /** CA certificate path */
  caPemPath?: string;
  logger?: StoreLogger;
  /** BM25 Encoder (shared instance) */
  bm25Encoder?: BM25LocalEncoder;
  /** Injected ulid factory */
  ulid?: () => string;
  /** Injected now */
  now?: () => number;
}

// ─── Constants ──────────────────────────────────────────────────────────

const TAG = "[tcvdb-skill-store]";
const SKILLS_COLLECTION_SUFFIX = "_skills";

/** VDB dense vector index (DISK_FLAT, HNSW fallback) */
const VECTOR_INDEX_DISK_FLAT: Record<string, unknown> = {
  fieldName: "vector",
  fieldType: "vector",
  indexType: "DISK_FLAT",
  dimension: 1024,
  metricType: "COSINE",
  params: { M: 16, efConstruction: 200 },
};
const VECTOR_INDEX_HNSW: Record<string, unknown> = {
  fieldName: "vector",
  fieldType: "vector",
  indexType: "HNSW",
  dimension: 1024,
  metricType: "COSINE",
  params: { M: 16, efConstruction: 200 },
};

/** Fields returned when querying (All, except vector/sparse_vector) */
const SKILL_OUTPUT_FIELDS: string[] = [
  "id", "skill_id", "version", "is_head",
  "team_id", "owner_agent_id", "user_id", "task_id",
  "name", "description", "content", "content_hash",
  "manifest_json", "storage_dir", "status", "metadata_json",
  "created_at_ms", "updated_at_ms",
];

/** Vector field name (VDB internal name) */
const DENSE_VECTOR_FIELD = "vector";
const SPARSE_VECTOR_FIELD = "sparse_vector";

// ─── Ulid helpers ───────────────────────────────────────────────────────

// row_id generator —— physical primary key of VDB doc (`id` primaryKey field).
// Separated from skill_id: skill_id is shared across versions, row_id is unique per row.
// base62 12 characters (~71 bit CSPRNG true entropy).
function defaultUlid(): string {
  return randomBase62(12);
}

// ─── Error helpers ──────────────────────────────────────────────────────

function isDiskFlatUnsupported(err: unknown): boolean {
  if (!(err instanceof TcvdbApiError)) return false;
  if (err.apiCode === 15113) return true;
  const msg = err.message.toLowerCase();
  return msg.includes("disk_flat") && msg.includes("not support");
}

// ─── Implementation ─────────────────────────────────────────────────────

export class TcvdbSkillStore implements ISkillStore {
  private readonly client: TcvdbClient;
  private readonly skillsCollection: string;
  private readonly embeddingModel: string;
  private readonly logger?: StoreLogger;
  private readonly bm25Encoder?: BM25LocalEncoder;
  private readonly ulid: () => string;
  private readonly now: () => number;

  private degraded = false;
  private initPromise?: Promise<void>;
  private initialized = false;

  constructor(config: TcvdbSkillStoreConfig) {
    this.client = new TcvdbClient({
      url: config.url,
      username: config.username,
      apiKey: config.apiKey,
      database: config.database,
      timeout: config.timeout,
      caPemPath: config.caPemPath,
    });
    this.skillsCollection = `${config.database}${SKILLS_COLLECTION_SUFFIX}`;
    this.embeddingModel = config.embeddingModel;
    this.logger = config.logger;
    this.bm25Encoder = config.bm25Encoder;
    this.ulid = config.ulid ?? defaultUlid;
    this.now = config.now ?? (() => Date.now());
  }

  // ── ISkillStore: Lifecycle ─────────────────────────────────────────────

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.initPromise = this._initAsync().catch((err) => {
      this.logger?.error(`${TAG} Init failed: ${err instanceof Error ? err.message : String(err)}`);
      this.degraded = true;
    });
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getCapabilities(): SkillStoreCapabilities {
    return {
      vectorSearch: !this.degraded,
      ftsSearch: !!this.bm25Encoder && !this.degraded,
      nativeHybridSearch: !!this.bm25Encoder && !this.degraded,
      sparseVectors: !!this.bm25Encoder,
    };
  }

  close(): void {
    this.degraded = true;
  }

  // ── ISkillStore: CRUD ─────────────────────────────────────────────────

  async appendVersion(input: AppendVersionInput): Promise<Skill> {
    await this._ensureInit();
    if (this.degraded) throw new Error("TcvdbSkillStore degraded");

    const tid = input.team_id ?? "default";
    const sid = input.skill_id;

    // 1. Query old head
    const head = await this._getHeadAsync(sid, tid);

    // 2. Name uniqueness validation (no head -> new skill, check for duplicate name)
    if (!head) {
      await this._assertNameUnique(input.name, tid, input.owner_agent_id ?? "default", sid);
    } else {
      // History exists -> name is immutable
      if (head.name !== input.name) {
        throw new SkillStoreError("SKILL_NAME_DUPLICATE", "name change is not allowed across versions");
      }
    }

    // 3. Version uniqueness validation
    const newVersion = head ? head.version + 1 : 1;
    const existing = await this._queryOneAsync(
      `skill_id="${this._escape(sid)}" and version=${newVersion} and team_id="${this._escape(tid)}"`,
    );
    if (existing) {
      // Same version already exists -> idempotent return
      return existing;
    }

    const ownerForRow = head ? head.owner_agent_id : (input.owner_agent_id ?? "default");
    const userIdForRow = input.user_id ?? "default";
    const ts = this.now();
    const rowId = this.ulid();
    const storageDir = `skills/${sid}/v${newVersion}`;

    // 4. Build new row document
    const doc: Record<string, unknown> = {
      id: rowId,
      skill_id: sid,
      version: newVersion,
      is_head: 1,
      team_id: tid,
      owner_agent_id: ownerForRow,
      user_id: userIdForRow,
      task_id: input.task_id ?? "default",
      name: input.name,
      description: input.description,
      content: input.content,
      content_hash: input.content_hash,
      manifest_json: JSON.stringify(input.manifest ?? []),
      storage_dir: storageDir,
      status: "active",
      metadata_json: input.metadata_json ?? "{}",
      created_at_ms: ts,
      updated_at_ms: ts,
    };

    // 5. BM25 sparse vector encoding
    if (this.bm25Encoder) {
      const sparse = this.bm25Encoder.encodeTexts([input.content]);
      if (sparse.length > 0 && sparse[0] && sparse[0].length > 0) {
        doc[SPARSE_VECTOR_FIELD] = sparse[0];
      }
    }

    // 6. INSERT new row first (compensates for VDB lack of transaction: new row written first, old row flipped after)
    await this.client.upsert(this.skillsCollection, [doc]);

    // 7. Then flip old head
    if (head) {
      try {
        await this._updateDocAsync(head.row_id, { is_head: 0 } as Record<string, unknown>);
      } catch (err) {
        this.logger?.warn(`${TAG} Failed to flip old head is_head for ${sid} v${head.version}: ${err instanceof Error ? err.message : String(err)}`);
        // Do not throw - new row already written, double head can be resolved by version DESC taking latest
      }
    }

    return this._docToSkill(doc);
  }

  async getHead(skillId: string, teamId?: string): Promise<Skill | null> {
    await this._ensureInit();
    if (this.degraded) return null;

    return this._getHeadAsync(skillId, teamId);
  }

  /**
   * Internal use: gets current head but doesn't filter status. Archived head will also be returned.
   * Consistent semantics with `SqliteSkillStore.getHeadIncludingArchived`.
   * Used for `SkillCore.delete` idempotent reread, asset compensation tasks, console.
   */
  async getHeadIncludingArchived(skillId: string, teamId?: string): Promise<Skill | null> {
    await this._ensureInit();
    if (this.degraded) return null;

    return this._getHeadAsync(skillId, teamId, { includeArchived: true });
  }

  async getByVersion(skillId: string, version: number, teamId?: string): Promise<Skill | null> {
    await this._ensureInit();
    if (this.degraded) return null;

    const filter = teamId
      ? `skill_id="${this._escape(skillId)}" and version=${version} and team_id="${this._escape(teamId)}"`
      : `skill_id="${this._escape(skillId)}" and version=${version}`;

    return this._queryOneAsync(filter);
  }

  async archiveHead(skillId: string, teamId?: string): Promise<{ archived: boolean }> {
    await this._ensureInit();
    if (this.degraded) return { archived: false };

    const head = await this._getHeadAsync(skillId, teamId);
    if (!head) return { archived: false };

    try {
      await this._updateDocAsync(head.row_id, {
        status: "archived",
        updated_at_ms: this.now(),
      } as Record<string, unknown>);
      return { archived: true };
    } catch (err) {
      this.logger?.warn(`${TAG} archiveHead failed for ${skillId}: ${err instanceof Error ? err.message : String(err)}`);
      return { archived: false };
    }
  }

  // ── ISkillStore: Queries ─────────────────────────────────────────────────

  async listSkills(opts: ListSkillsOptions): Promise<{ items: Skill[]; total: number }> {
    await this._ensureInit();
    if (this.degraded) return { items: [], total: 0 };

    const conditions: string[] = ["is_head=1"];
    if (opts.team_id) conditions.push(`team_id="${this._escape(opts.team_id)}"`);
    if (opts.owner_agent_id) conditions.push(`owner_agent_id="${this._escape(opts.owner_agent_id)}"`);
    if (opts.user_id) conditions.push(`user_id="${this._escape(opts.user_id)}"`);
    if (opts.task_id) conditions.push(`task_id="${this._escape(opts.task_id)}"`);

    const statuses = opts.status?.length ? opts.status : (["active"] as SkillStatus[]);
    if (statuses.length === 1) {
      conditions.push(`status="${this._escape(statuses[0])}"`);
    } else {
      // VDB does not support `IN (...)` syntax, only supports `OR`; expand using `(status="a" or status="b")`.
      // Previously using IN would fail silently (VDB returned code=14000), causing empty results for status=["active","archived"].
      conditions.push(
        `(${statuses.map((s) => `status="${this._escape(s)}"`).join(" or ")})`,
      );
    }

    const filter = conditions.join(" and ");
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);

    // name_prefix: VDB filter syntax does not support LIKE / string prefix matching,
    // Change to fetching head rows matching other conditions, then filtering prefix in memory before pagination.
    // (Head rows are small in number, pulling up to 1000 at once is acceptable)
    if (opts.name_prefix) {
      const prefix = opts.name_prefix;
      try {
        const resp = await this.client.query(this.skillsCollection, {
          filter,
          limit: 1000,
          outputFields: SKILL_OUTPUT_FIELDS,
          sort: [{ fieldName: "updated_at_ms", direction: "desc" }],
        });
        const all = (resp.documents ?? [])
          .map((d) => this._docToSkill(d))
          .filter((s) => s.name.startsWith(prefix));
        return { items: all.slice(offset, offset + limit), total: all.length };
      } catch (err) {
        this.logger?.warn(`${TAG} listSkills(name_prefix) query failed: ${err instanceof Error ? err.message : String(err)}`);
        return { items: [], total: 0 };
      }
    }

    let total: number;
    try {
      total = await this.client.count(this.skillsCollection, filter);
    } catch {
      total = 0;
    }

    let rows: Skill[] = [];
    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        limit,
        offset,
        outputFields: SKILL_OUTPUT_FIELDS,
        sort: [{ fieldName: "updated_at_ms", direction: "desc" }],
      });
      rows = (resp.documents ?? []).map((d) => this._docToSkill(d));
    } catch (err) {
      this.logger?.warn(`${TAG} listSkills query failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { items: rows, total };
  }

  async searchSkills(opts: SearchSkillsOptions): Promise<SkillSearchResult[]> {
    await this._ensureInit();
    if (this.degraded) return [];

    const topK = Math.min(Math.max(opts.topK ?? 10, 1), 50);
    const filter = this._buildSearchFilter(opts);
    const mode = opts.mode ?? "bm25";

    try {
      if (mode === "hybrid" && this.bm25Encoder) {
        return this._searchHybridAsync(opts.query, topK, filter);
      }
      if (mode === "embedding") {
        return this._searchEmbeddingAsync(opts.query, topK, filter);
      }
      // bm25 (default)
      return this._searchBm25Async(opts.query, topK, filter);
    } catch (err) {
      this.logger?.warn(`${TAG} searchSkills failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async listVersions(
    skillId: string,
    teamId?: string,
    pagination?: { limit?: number; offset?: number },
  ): Promise<Skill[]> {
    await this._ensureInit();
    if (this.degraded) return [];

    const filter = teamId
      ? `skill_id="${this._escape(skillId)}" and team_id="${this._escape(teamId)}"`
      : `skill_id="${this._escape(skillId)}"`;

    const limit = Math.min(Math.max(pagination?.limit ?? 50, 1), 1000);
    const offset = Math.max(pagination?.offset ?? 0, 0);

    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        limit,
        offset,
        outputFields: SKILL_OUTPUT_FIELDS,
        sort: [{ fieldName: "version", direction: "desc" }],
      });
      return (resp.documents ?? []).map((d) => this._docToSkill(d));
    } catch (err) {
      this.logger?.warn(`${TAG} listVersions query failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async countVersions(skillId: string, teamId?: string): Promise<number> {
    await this._ensureInit();
    if (this.degraded) return 0;

    const filter = teamId
      ? `skill_id="${this._escape(skillId)}" and team_id="${this._escape(teamId)}"`
      : `skill_id="${this._escape(skillId)}"`;

    try {
      return await this.client.count(this.skillsCollection, filter);
    } catch {
      return 0;
    }
  }

  // ── ISkillStore: TTL Cleanup ─────────────────────────────────────────

  async findExpiredVersions(cutoffMs: number): Promise<ExpiredVersionMeta[]> {
    await this._ensureInit();
    if (this.degraded) return [];

    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter: `is_head=0 and status="active" and created_at_ms<${cutoffMs}`,
        limit: 10000,
        outputFields: ["skill_id", "version", "is_head", "status", "storage_dir", "created_at_ms"],
        // VDB requires sort field to be uint64; skill_id is string and cannot be sorted (code 15143).
        // Use created_at_ms ascending (oldest first), matching TTL cleanup semantics.
        sort: [{ fieldName: "created_at_ms", direction: "asc" }],
      });
      return (resp.documents ?? []).map((d) => ({
        skill_id: d.skill_id as string,
        version: d.version as number,
        is_head: (d.is_head as number) === 1,
        status: d.status as SkillStatus,
        storage_dir: d.storage_dir as string,
        created_at_ms: d.created_at_ms as number,
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} findExpiredVersions failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async deleteVersion(skillId: string, version: number): Promise<boolean> {
    await this._ensureInit();
    if (this.degraded) return false;

    try {
      const filter = `skill_id="${this._escape(skillId)}" and version=${version} and is_head=0`;
      const affected = await this.client.deleteDoc(this.skillsCollection, { query: { filter } });
      return affected > 0;
    } catch (err) {
      this.logger?.warn(`${TAG} deleteVersion failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Physically delete all version rows under the same skill_id. `SkillCore.delete` uses this path.
   * Permission validation is handled by the caller SkillCore; this method only calls deleteDoc once by (skill_id, team_id).
   */
  async deleteAllVersions(skillId: string, teamId?: string): Promise<number> {
    await this._ensureInit();
    if (this.degraded) return 0;

    try {
      const filter = teamId
        ? `skill_id="${this._escape(skillId)}" and team_id="${this._escape(teamId)}"`
        : `skill_id="${this._escape(skillId)}"`;
      const affected = await this.client.deleteDoc(this.skillsCollection, { query: { filter } });
      return affected;
    } catch (err) {
      this.logger?.warn(`${TAG} deleteAllVersions failed for ${skillId}: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  // ─── Private: Init ────────────────────────────────────────────────────

  private async _initAsync(): Promise<void> {
    try {
      const dbCreated = await this.client.createDatabase();
      if (dbCreated) {
        this.logger?.debug?.(`${TAG} Database created, waiting 5s...`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    } catch (err) {
      if (err instanceof TcvdbApiError && err.apiCode === 15201) {
        this.logger?.debug?.(`${TAG} Database already exists (benign)`);
      } else {
        throw err;
      }
    }

    // Create skills collection with DISK_FLAT → HNSW fallback
    await this._createCollectionWithVectorFallback(
      {
        collection: this.skillsCollection,
        shardNum: 1,
        replicaNum: 2,
        description: "Skill storage",
        embedding: {
          status: "enabled",
          field: "content",
          vectorField: DENSE_VECTOR_FIELD,
          model: this.embeddingModel,
        },
      },
      [
        { fieldName: "skill_id",       fieldType: "string", indexType: "filter" },
        { fieldName: "version",        fieldType: "uint64", indexType: "filter" },
        { fieldName: "is_head",        fieldType: "uint64", indexType: "filter" },
        { fieldName: "team_id",        fieldType: "string", indexType: "filter" },
        { fieldName: "owner_agent_id", fieldType: "string", indexType: "filter" },
        { fieldName: "user_id",        fieldType: "string", indexType: "filter" },
        { fieldName: "task_id",        fieldType: "string", indexType: "filter" },
        { fieldName: "name",           fieldType: "string", indexType: "filter" },
        { fieldName: "status",         fieldType: "string", indexType: "filter" },
        { fieldName: "created_at_ms",  fieldType: "uint64", indexType: "filter" },
        { fieldName: "updated_at_ms",  fieldType: "uint64", indexType: "filter" },
      ],
    );

    this.logger?.info(`${TAG} Initialized: collection=${this.skillsCollection}, model=${this.embeddingModel}`);
  }

  private async _createCollectionWithVectorFallback(
    params: Record<string, unknown>,
    filterIndexes: Array<Record<string, unknown>>,
  ): Promise<void> {
    const buildIndexes = (vectorIndex: Record<string, unknown>) => [
      { fieldName: "id", fieldType: "string", indexType: "primaryKey" },
      vectorIndex,
      { fieldName: SPARSE_VECTOR_FIELD, fieldType: "sparseVector", indexType: "inverted", metricType: "IP", diskSwapEnabled: true },
      ...filterIndexes,
    ];

    try {
      await this.client.createCollection({ ...params, indexes: buildIndexes(VECTOR_INDEX_DISK_FLAT) });
    } catch (err) {
      if (isDiskFlatUnsupported(err)) {
        this.logger?.debug?.(`${TAG} DISK_FLAT not supported, falling back to HNSW`);
        await this.client.createCollection({ ...params, indexes: buildIndexes(VECTOR_INDEX_HNSW) });
      } else {
        throw err;
      }
    }
  }

  private async _ensureInit(): Promise<void> {
    if (this.initPromise) {
      try { await this.initPromise; } catch { /* degraded already set */ }
    }
  }

  // ─── Private: Query helpers ───────────────────────────────────────────

  /**
   * Query head row. Defaults to enforcing `status="active"`; when `includeArchived=true`, no status filter is added,
   * used for `getHeadIncludingArchived` (idempotent reread / compensation tasks for archived head).
   */
  private async _getHeadAsync(
    skillId: string,
    teamId?: string,
    opts?: { includeArchived?: boolean },
  ): Promise<Skill | null> {
    const statusClause = opts?.includeArchived ? "" : ' and status="active"';
    const filter = teamId
      ? `skill_id="${this._escape(skillId)}" and team_id="${this._escape(teamId)}" and is_head=1${statusClause}`
      : `skill_id="${this._escape(skillId)}" and is_head=1${statusClause}`;

    return this._queryOneAsync(filter);
  }

  /** Fetch one by filter */
  private async _queryOneAsync(filter: string): Promise<Skill | null> {
    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        limit: 1,
        outputFields: SKILL_OUTPUT_FIELDS,
      });
      return resp.documents && resp.documents.length > 0
        ? this._docToSkill(resp.documents[0])
        : null;
    } catch (err) {
      this.logger?.warn(`${TAG} queryOne failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ─── Private: Write helpers ───────────────────────────────────────────

  /** Upsert updates some fields of a document (preserving unpassed fields) */
  private async _updateDocAsync(rowId: string, partial: Record<string, unknown>): Promise<void> {
    // VDB upsert requires full document or at least id + changed fields
    // First read existing document, merge, then upsert
    const existing = await this._queryByIdAsync(rowId);
    if (!existing) return;

    const doc = this._skillToDoc(existing);
    Object.assign(doc, partial);
    await this.client.upsert(this.skillsCollection, [doc]);
  }

  /**
   * Fetch one by primary key (id / row_id).
   * Note: id is primaryKey, not a filter index, cannot use `filter: id="..."` to query
   * (VDB will report Field Not Found:id which is caught as null). Must query by documentIds primary key,
   * aligning with memory production implementation (tcvdb.ts "Primary key lookup: use documentIds").
   */
  private async _queryByIdAsync(rowId: string): Promise<Skill | null> {
    try {
      const resp = await this.client.query(this.skillsCollection, {
        documentIds: [rowId],
        limit: 1,
        retrieveVector: false,
        outputFields: SKILL_OUTPUT_FIELDS,
      });
      return resp.documents && resp.documents.length > 0
        ? this._docToSkill(resp.documents[0])
        : null;
    } catch (err) {
      this.logger?.warn(`${TAG} queryById failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Name uniqueness validation (same team + agent + name and is_head=1 and status=active) */
  private async _assertNameUnique(
    name: string,
    teamId: string,
    ownerAgentId: string,
    excludeSkillId: string,
  ): Promise<void> {
    const filter =
      `team_id="${this._escape(teamId)}" and owner_agent_id="${this._escape(ownerAgentId)}" ` +
      `and name="${this._escape(name)}" and is_head=1 and status="active"`;

    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        limit: 1,
        outputFields: ["skill_id"],
      });
      if (resp.documents && resp.documents.length > 0) {
        const dupId = resp.documents[0].skill_id as string;
        if (dupId !== excludeSkillId) {
          throw new SkillStoreError("SKILL_NAME_DUPLICATE", `name '${name}' already exists for agent in team`);
        }
      }
    } catch (err) {
      if (err instanceof SkillStoreError) throw err;
      this.logger?.warn(`${TAG} name uniqueness check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Private: Search ─────────────────────────────────────────────────

  private _buildSearchFilter(opts: SearchSkillsOptions): string {
    const conditions: string[] = ["is_head=1", 'status="active"'];
    if (opts.team_id) conditions.push(`team_id="${this._escape(opts.team_id)}"`);
    if (opts.agent_id) conditions.push(`owner_agent_id="${this._escape(opts.agent_id)}"`);
    if (opts.task_id) conditions.push(`task_id="${this._escape(opts.task_id)}"`);
    if (opts.user_id) conditions.push(`user_id="${this._escape(opts.user_id)}"`);
    return conditions.join(" and ");
  }

  /**
   * bm25 mode: TCVDB does not have a pure sparse retrieval channel (/document/search is dense-only;
   * ann is required for hybridSearch). The skill collection's server-side embedding is always enabled,
   * so bm25 mode degrades to hybrid (dense + sparse) in Service mode,
   * which is semantically equivalent and retrieval quality is not inferior to pure BM25. standalone(SQLite) is true pure BM25.
   */
  private async _searchBm25Async(
    queryText: string,
    topK: number,
    filter: string,
  ): Promise<SkillSearchResult[]> {
    this.logger?.debug?.(
      `${TAG} bm25 mode on TCVDB → degrade to hybrid (server-side embedding always enabled, no pure-sparse channel)`,
    );
    return this._searchHybridAsync(queryText, topK, filter);
  }

  /**
   * embedding mode: dense-only. Uses /document/search + embeddingItems,
   * VDB server-side performs embedding on the query text (collection.embedding.field=content).
   * Note: /document/search does not accept ann/match, server-side embedding uses embeddingItems to pass original text.
   */
  private async _searchEmbeddingAsync(
    queryText: string,
    topK: number,
    filter: string,
  ): Promise<SkillSearchResult[]> {
    const resp = await this.client.search(this.skillsCollection, {
      embeddingItems: [queryText],
      filter,
      limit: topK,
      retrieveVector: false,
      outputFields: SKILL_OUTPUT_FIELDS,
    });

    return this._parseSearchResponse(resp, topK);
  }

  /**
   * hybrid mode: dense(server-side embedding) + sparse(BM25) + RRF fusion.
   * Aligns with memory production implementation (tcvdb.ts searchL1HybridAsync):
   *   - ann / match are both arrays
   *   - ann.fieldName = server-side embedding source field "content", data passes original query text
   *   - sparse vector on query side uses encodeQueries (IDF weight), distinct from encodeTexts (TF) on write side
   *   - rerank: { method: "rrf", k: 60 }
   *
   * Degrades to dense-only (embedding) if no BM25 encoder is present.
   */
  private async _searchHybridAsync(
    queryText: string,
    topK: number,
    filter: string,
  ): Promise<SkillSearchResult[]> {
    const sparse = this.bm25Encoder?.encodeQueries([queryText]) ?? [];
    const sparseVec: SparseVector | undefined =
      sparse.length > 0 && sparse[0] && sparse[0].length > 0 ? sparse[0] : undefined;

    if (!sparseVec) {
      // No sparse signal -> dense-only
      return this._searchEmbeddingAsync(queryText, topK, filter);
    }

    const searchParams: Record<string, unknown> = {
      filter,
      limit: topK,
      retrieveVector: false,
      outputFields: SKILL_OUTPUT_FIELDS,
      ann: [{
        fieldName: "content",
        data: [queryText],
        limit: topK * 2,
      }],
      match: [{
        fieldName: SPARSE_VECTOR_FIELD,
        data: [sparseVec],
        limit: topK * 2,
      }],
      rerank: {
        method: "rrf",
        k: 60,
      },
    };

    const resp = await this.client.hybridSearch(this.skillsCollection, searchParams);
    return this._parseSearchResponse(resp, topK);
  }

  private _parseSearchResponse(
    resp: { documents: Array<Array<Record<string, unknown>>> },
    topK: number,
  ): SkillSearchResult[] {
    const results: SkillSearchResult[] = [];
    const docs = resp.documents?.[0] ?? [];

    for (const d of docs) {
      if (results.length >= topK) break;
      const skill = this._docToSkill(d);
      const score = (d.score as number) ?? 0;
      let snippet: string | undefined;
      if (d.text !== undefined && typeof d.text === "string") {
        snippet = d.text.slice(0, 200);
      }
      results.push({ skill, score, snippet });
    }

    return results;
  }

  // ─── Private: Doc ↔ Skill mapping ─────────────────────────────────────

  private _docToSkill(doc: Record<string, unknown>): Skill {
    let manifest: SkillManifestEntry[] = [];
    try {
      const raw = doc.manifest_json as string | undefined;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) manifest = parsed;
      }
    } catch { /* ignore */ }

    return {
      row_id: (doc.id ?? doc.row_id) as string,
      skill_id: doc.skill_id as string,
      version: (doc.version as number) ?? 0,
      is_head: (doc.is_head as number) === 1,
      user_id: doc.user_id as string,
      owner_agent_id: doc.owner_agent_id as string,
      team_id: doc.team_id as string,
      task_id: doc.task_id as string,
      name: doc.name as string,
      description: doc.description as string,
      content: doc.content as string,
      content_hash: doc.content_hash as string,
      manifest,
      storage_dir: doc.storage_dir as string,
      status: (doc.status as SkillStatus) ?? "active",
      metadata_json: (doc.metadata_json as string) ?? "{}",
      created_at_ms: (doc.created_at_ms as number) ?? 0,
      updated_at_ms: (doc.updated_at_ms as number) ?? 0,
    };
  }

  /** Skill -> VDB doc (used for rewrite during update) */
  private _skillToDoc(skill: Skill): Record<string, unknown> {
    return {
      id: skill.row_id,
      skill_id: skill.skill_id,
      version: skill.version,
      is_head: skill.is_head ? 1 : 0,
      team_id: skill.team_id,
      owner_agent_id: skill.owner_agent_id,
      user_id: skill.user_id,
      task_id: skill.task_id,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      content_hash: skill.content_hash,
      manifest_json: JSON.stringify(skill.manifest),
      storage_dir: skill.storage_dir,
      status: skill.status,
      metadata_json: skill.metadata_json,
      created_at_ms: skill.created_at_ms,
      updated_at_ms: skill.updated_at_ms,
    };
  }

  // ─── Private: String escape ───────────────────────────────────────────

  private _escape(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
}
