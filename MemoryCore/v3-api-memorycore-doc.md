# v3 API Documentation · Volume I — MemoryCore

> Service: MemoryCore (memory kernel), port `8420`
> This volume covers all `/v3/*` endpoints exposed by MemoryCore. MemoryKnowledge (`/v3/wiki`, `/v3/code-graph`, etc.) is in Volume II; MemoryProxy is in Volume III.
> Maintenance convention: any interface change (adding/altering fields or error codes) must update this document in the same PR.

---

## 1. Common conventions

### 1.1 Service and port

| Item | Value |
|---|---|
| Service | MemoryCore (memory kernel gateway) |
| Port | 8420 |
| Method | All `POST` (v3 is RPC-style, no GET) |
| Content-Type | `application/json` |
| Health check | `GET /health` (**not v3**, no auth, returns bare JSON `status/version/uptime/stores/services`; out of scope for this document) |

### 1.2 Response envelope

All v3 endpoints return a unified envelope:

```json
{ "code": 0, "message": "ok", "request_id": "abc-123", "data": { } }
```

| Field | Type | Description |
|---|---|---|
| code | number | `0` = success; non-zero = failure. **Note**: skill-module failure codes are 5-digit numbers (see §1.6) |
| message | string | Fixed `"ok"` on success; error description on failure (format in §1.6) |
| request_id | string | Request ID, from `x-request-id` or generated server-side |
| data | any | Business payload; usually missing or null on failure |

### 1.3 Pagination conventions

- Data-plane list/query endpoints: `limit` default `20`, cap `100`, `offset` default `0` (`paginationSchema`).
- meta list endpoints: `limit` default `20`, cap `100`, `offset` default `0` (`DEFAULT_PAGINATION`); output is uniformly `{ items, total, limit, offset }`.
- skill `list`: `limit` cap `1000`; skill `search`: `top_k` cap `50`.
- knowledge `list`: `pagination.limit` cap `1000` (`knowledgeListRequestSchema`, same as skill list).
- memory-prompt / generation-log list: `limit` default `20`, cap `100`.

### 1.4 Auth layers

v3 endpoints fall into four auth layers (all require `Authorization: Bearer <KERNEL_AUTH_TOKEN>` as the Layer-1 gateway gate; not enforced when `apiKey` is unconfigured):

| Layer | Route scope | Extra auth |
|---|---|---|
| Data plane | `/v3/conversation·atomic·scenario·core/*`, `/v3/skill/*`, `/v3/knowledge/*`, `/v3/chat-memory/*`, `/v3/memory-prompt/*`, `/v3/memory-generation-log/*` | `x-tdai-service-id` (instance ID) |
| Metadata plane | `/v3/meta/*` | `x-tdai-service-id` + `x-tdai-user-key` (`auth/verify` exempt from user-key) |
| Internal ops plane | `/v3/internal/meta/*` | Bearer only; user-key is **not** parsed |
| Instance destroy | `/v3/instance/destroy` | Bearer apiKey only (v1-style, ops endpoint) |

> Isolation-field note: on data-plane endpoints `team_id / agent_id / user_id / task_id` can come from the **body or Header** (`x-tdai-team-id` / `x-tdai-agent-id` / `x-tdai-user-id` / `x-tdai-task-id`); body wins. The v3 data plane **enforces** the team + agent + user triple for isolation (missing values fall back to the `default` bucket).

### 1.5 Error-code semantics (data-plane common)

| code | Meaning |
|---|---|
| 400 | Invalid parameters (missing ID, mutually exclusive fields, empty input) |
| 401 | Auth failure |
| 403 | Ownership consistency check failed (e.g. `(team_id, agent_id)` is not a valid ownership pair, or `task_id` does not belong to `team_id`) |
| 404 | Resource not found or not owned by the current call context (existence is not leaked) |
| 409 | Concurrent-conflict timeout |
| 422 | Schema passes but business rules fail |
| 429 | Rate-limit / quota exceeded |
| 500 | Internal error |
| 503 | Dependency unavailable (LLM / storage / VDB) |

### 1.6 Error message format (three kinds, important)

Different modules return different failure `message` formats; the frontend must handle each separately:

| Module | message format | HTTP-code trait | Example |
|---|---|---|---|
| meta / internal-meta | `"{error_code}: {detail}"` (error_code is UPPER_SNAKE_CASE) | Standard 4xx/5xx | `"team_not_found: not found: t_1"` |
| skill | `SkillCoreError.message` verbatim | **5-digit** (40001 etc.) | `"SKILL_NOT_FOUND: ..."` |
| data-plane / knowledge / chat-memory / memory-prompt / generation-log | Plain text or plain uppercase enum | Standard 4xx/5xx | `"Knowledge not found"`, `"MEMORY_PROMPT_NOT_FOUND"`, `"Store not available"` |

---

## 2. Endpoint directory

| Module | Endpoints | Prefix |
|---|---|---|
| L0–L3 data plane | 18 | `/v3/conversation·atomic·scenario·core/*` |
| Skill | 17 | `/v3/skill/*` |
| Knowledge details | 5 | `/v3/knowledge/*` |
| Chat-Memory | 1 | `/v3/chat-memory/*` |
| Memory-Prompt | 7 | `/v3/memory-prompt/*` |
| Memory-Generation-Log | 2 | `/v3/memory-generation-log/*` |
| Meta metadata | 55 | `/v3/meta/*` |
| Internal Meta | 2 | `/v3/internal/meta/*` |
| Instance Destroy | 1 | `/v3/instance/destroy` |

**108 endpoints in total.**

---

## 3. Endpoint details

## 3.1 L0–L3 data plane (18)

> Memory layering: L0 raw conversations (conversation), L1 memory atoms (atomic; episodic/persona/instruction), L2 scene files (scenario), L3 core persona (core).
> All endpoints accept the 4-ID isolation fields (`team_id/agent_id/user_id/task_id`, body or Header).
> Delete endpoints such as `conversation/delete` and `atomic/delete` trust Bearer + `x-tdai-service-id` and do not do user-level auth (consistent with the panel's forward-time checks).

### POST /v3/conversation/add

Writes L0 raw conversation messages. On success it asynchronously triggers the L1 extraction pipeline (`notifyPipeline`).

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| session_id | string | Yes | Business session ID |
| messages | object[] | Yes | 1–100 entries, `{ role: "user"\|"assistant", content: 1–8192 chars, timestamp?, recorded_at? }` |
| team_id / agent_id / user_id / task_id | string | No* | Isolation fields (*v3 enforces team+agent+user; falls back to the default bucket) |

**Response** `data`

| Field | Type | Description |
|---|---|---|
| accepted_ids | string[] | IDs of accepted messages |
| accepted_versions | string[] | Same order as accepted_ids; new entries are always `v1` |
| total_count | number | Total accepted |

**Example**

```json
// Request
{ "session_id": "sess_1", "messages": [ { "role": "user", "content": "Help me look at this bug" } ] }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "accepted_ids": ["msg_1"], "accepted_versions": ["v1"], "total_count": 1 }
}
```

### POST /v3/conversation/query

Paginated query of L0 messages.

**Request body**: `session_id?`, `limit?` (default 20 / cap 100), `offset?`, `time_start?`, `time_end?` + isolation fields.

**Response** `data`: `{ messages: ConversationItem[], total }`, ConversationItem = `{ id, version, role, content, timestamp?, recorded_at?, session_id?, team_id?, user_id?, agent_id? }`.

### POST /v3/conversation/search

Keyword search over L0 messages.

**Request body**: `query` (1–2048), `limit?` (default 5 / cap 100), `session_id?`, `time_start?`, `time_end?` + isolation fields.

**Response** `data`: `{ messages: (ConversationItem & { score })[] }`.

### POST /v3/conversation/delete

Batch-deletes L0 by message_ids or session_ids.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| message_ids | string[] | one of the two | up to 5000 |
| session_ids | string[] | one of the two | up to 100 |
| session_id | string | No | @deprecated, use session_ids |

**Response** `data`: `{ deleted_count: number }`.

**Errors**: `400` (at least one of the two must be provided).

### POST /v3/conversation/count

L0 count (**v3 only, no v2 entry**).

**Request body**: `session_id?`, `time_start?`, `time_end?`.

**Response** `data`: `{ total: number }`.

---

### POST /v3/atomic/update

Updates a single L1 memory atom (version auto-increments).

**Request body**: `id`, `content` (≤8192), `background?` + isolation fields.

**Response** `data`: `{ id, version, updated_at }`, where `version` is a **string** `"v{n}"` (e.g. `"v2"`).

> ⚠️ Version-type inconsistency: `update` returns a string `"v{n}"`, but `query`/`search` return a **number** (`r.version ?? 0`). The root cause is in code (`generated/types.ts` declares `string "v1"`, but `v2-schemas.ts` overrides it to `number`); one document cannot satisfy both, so the frontend must handle each endpoint separately.

### POST /v3/atomic/query

Paginated query of L1.

**Request body**: `type?` (episodic/persona/instruction), `time_start?`, `time_end?`, `limit?`, `offset?` + isolation fields.

**Response** `data`: `{ items: AtomicDetail[], total }`.

**AtomicDetail** fields:

| Field | Type | Description |
|---|---|---|
| id | string | Atom ID |
| version | number | Current version (**query/search return a number**; note `update` returns a string `"v{n}"` — types are inconsistent) |
| type | string | `episodic` / `persona` / `instruction` |
| background | string? | Background |
| content | string | Body |
| created_at / updated_at | string | ISO time |
| team_id / agent_id / user_id / task_id | string? | Isolation fields |

**Example**

```json
// Request
{ "type": "episodic", "limit": 20, "offset": 0 }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [ { "id": "rec_1", "version": 1, "type": "episodic", "content": "Release next Monday", "created_at": "2026-08-20T00:00:00Z", "updated_at": "2026-08-20T00:00:00Z" } ],
    "total": 1
  }
}
```

### POST /v3/atomic/search

Keyword search over L1.

**Request body**: `query` (1–2048), `limit?` (default 5 / cap 100), `type?`, `time_start?`, `time_end?` + isolation fields.

**Response** `data`: `{ items: (AtomicDetail & { score })[] }`.

### POST /v3/atomic/delete

Batch-deletes L1 by id.

**Request body**: `ids: string[]` (≤5000).

**Response** `data`: `{ deleted_count: number }`.

### POST /v3/atomic/count

L1 count (**v3 only**).

**Request body**: `type?`, `time_start?`, `time_end?`.

**Response** `data`: `{ total: number }`.

---

### POST /v3/scenario/ls

L2 scene-file list (one-shot full listing, no pagination).

**Request body**: `path_prefix?` (empty/omitted = recursive listing from root) + isolation fields.

**Response** `data`: `{ entries: ScenarioEntry[], total }`.

**ScenarioEntry**: `{ path, summary?, version, team_id?, agent_id?, created_at, updated_at }` (directories have `version=0`, path ends with `/`).

### POST /v3/scenario/read

Reads a single L2 file.

**Request body**: `path` (relative path, traversal-checked), `version?` + isolation fields.

**Response** `data`: `{ path, version?, content, created_at, updated_at }`. **A missing file returns 200 with null content/created_at/updated_at (not 404)**.

### POST /v3/scenario/write

Writes an L2 file (META header is stripped automatically).

**Request body**: `path`, `content`, `summary?` + isolation fields.

**Response** `data`: `{ path, version, updated_at }`.

### POST /v3/scenario/rm

Deletes an L2 file/directory.

**Request body**: `path` (ends with `/` = delete directory, otherwise delete a single file) + isolation fields.

**Response** `data`: none (`successEnvelope(undefined)`).

### POST /v3/scenario/count

L2 count (**v3 only**).

**Request body**: `path_prefix?`.

**Response** `data`: `{ total: number }`.

---

### POST /v3/core/read

Reads L3 core memory (persona.md).

**Request body**: `version?` + isolation fields (body may be empty).

**Response** `data`: `{ content, version?, team_id?, agent_id?, created_at, updated_at }`. **A missing file returns 200 with null content**.

### POST /v3/core/write

Writes L3 core memory (Scene Navigation and leading/trailing whitespace are stripped automatically).

**Request body**: `content` + isolation fields.

**Response** `data`: `{ version, updated_at }`.

### POST /v3/core/count

L3 count (**v3 only**).

**Request body**: `{}` (empty object).

**Response** `data`: `{ total: number }`.

---

## 3.2 Skill (17)

> Skill data plane is stored separately (`skill_id` prefix `skl-`); team-readable, owner-writable. Identity fields go in the body.
> Failure codes are **5-digit numbers** (see §1.6); error-code mapping is in Appendix §4.2.

### POST /v3/skill/create

Creates a skill (on success it auto-registers a meta_asset and binds it to the owner agent).

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| name | string | Yes | ≤64 chars; must equal frontmatter.name |
| content | string | Yes | Full SKILL.md content |
| resources | object[] | No | ≤100 entries, `{ path ≤512, content, encoding: "utf-8"\|"base64", mime_type?, is_executable? }` |
| metadata | object | No | Custom metadata |
| team_id / agent_id / user_id / task_id | string | see below | write endpoints require team+agent+user |

> Constraint: `agent_id` must be namespaced by `team_id` (an agent requires a team).

**Response** `data`: `SkillSummary` (unified description at the end of §3.2).

**Errors**: `40001` (params/frontmatter mismatch), `42201` (duplicate name), `4291` (quota exceeded), `50304` (skill_id collision on consecutive attempts).

**Example**

```json
// Request
{ "team_id": "t_1", "agent_id": "agt_1", "user_id": "u_1", "name": "code-review", "content": "---\nname: code-review\n---\n# Code Review" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "skill_id": "skl_1", "name": "code-review", "version": 1, "status": "active", "owner_user_id": "u_1", "owner_agent_id": "agt_1", "team_id": "t_1" }
}
```

### POST /v3/skill/update

Full update (optimistic lock).

**Request body**: `skill_id`, `expected_version` (≥1), `content` + id fields.

**Response** `data`: `SkillSummary`.

**Errors**: `40901` (version stale; data carries `current_version`), `40401`, `40301`.

### POST /v3/skill/patch

Partial replace (optimistic lock, string patch).

**Request body**: `skill_id`, `expected_version`, `old_string`, `new_string`, `replace_all?` + id fields.

**Response** `data`: `SkillSummary`.

**Errors**: `40901`, `42202` (patch not unique), `40401`.

### POST /v3/skill/delete

Hard delete (**changed 2026-07; previously soft-delete**): removes all versions + storage, and cascades meta_asset / ACL / agent binding cleanup.

**Request body**: `skill_id`, `expected_version`, `team_id?` + id fields.

**Response** `data`: `{ skill_id, archived: boolean }`; `archived` here means "deleted successfully" (`deleted > 0`) — **not an archived state**; the field is reused for real deletes.

**Errors**: `40401`, `40901`, `40301`, `40302`.

### POST /v3/skill/get

Fetches details by skill_id (content / manifest optional).

**Request body**: `skill_id`, `version?`, `include_content?` (default true), `include_manifest?` (default true) + id fields.

**Response** `data`: `SkillSummary + { content?, manifest?, content_hash?, storage_dir? }`.

**Errors**: `40401`.

### POST /v3/skill/get-by-name

Fetches details uniquely by `(team_id, agent_id, skill_name)` (so an agent tool call can get the full text in one round trip).

**Request body**: `team_id` (required), `agent_id` (required), `skill_name` (≤64), `version?`, `include_content?`, `include_manifest?`.

**Response** `data`: same as `get`.

**Errors**: `40401` (uniformly returned when a name is not found; does not reveal whether name or id is missing).

### POST /v3/skill/list

Paginated list (only active by default; pass `filters.status` explicitly for archived).

**Request body**: `filters?` (`{ owner_agent_id?, name_prefix?, status?: ["active"\|"archived"] }`), `pagination?` (`{ limit ≤1000, offset }`) + id fields.

**Response** `data`: `{ items: SkillSummary[], total }`.

### POST /v3/skill/search

Searches skills.

**Request body**: `query` (≤2048), `top_k?` (≤50), `mode?` (bm25/embedding/hybrid), `scope?` (= "team" searches team-wide without an owner filter) + id fields.

**Response** `data`: `{ items: (SkillSummary & { score, snippet })[] }`.

### POST /v3/skill/versions

Version list.

**Request body**: `skill_id`, `pagination?` + id fields.

**Response** `data`: `{ items: (SkillSummary & { is_expired })[], total }`.

**Errors**: `40401` (skill does not exist).

### POST /v3/skill/files/write

Writes script/resource files.

**Request body**: `skill_id`, `expected_version`, `files` (1–100, structure same as create's resources) + id fields.

**Response** `data`: `SkillSummary`.

### POST /v3/skill/files/remove

Removes files.

**Request body**: `skill_id`, `expected_version`, `paths` (1–100) + id fields.

**Response** `data`: `SkillSummary`.

### POST /v3/skill/files/read

Reads a single file.

**Request body**: `skill_id`, `path`, `version?`, `encoding?` + id fields.

**Response** `data`: `{ content, version, size_bytes, encoding, ... }`.

### POST /v3/skill/export

Exports a skill (zip).

**Request body**: `skill_id`, `version?`, `format?` (only "zip") + id fields.

**Response** `data`: `{ version, file_count, total_bytes, ... }`.

**Errors**: `41301` (too large).

### POST /v3/skill/listing

Generates the `<available_skills>` injection block (for agent prompts).

**Request body**: `query?` (≤2048), `char_budget?` (0–64000, default 8000) + id fields.

**Response** `data`: `{ mode: "full"\|"search", listing: string, hits: [{ skill_id, version, name }] }`.

### POST /v3/skill/extract

direct-trigger: manually archives one session slice (equivalent to one independent skill extraction).

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| user_id / team_id / agent_id | string | Yes | none may contain `\|` |
| messages | object[] | Yes | 1–500 entries, `{ role: user\|assistant\|tool_call\|tool_result\|system, content, timestamp?, tool_name?, tool_call_id? }` |
| session_id | string | No | defaults to a generated `sx-` prefix |
| space_id | string | No | defaults to auth.serviceId |
| task_id / reason / options | — | No | `options.max_iterations` (1–64) |

**Response** `data`: `{ ok: true, task_id, archived_at_ms, archive_key }`.

### POST /v3/skill/conversation/add

Called synchronously at the end of each conversation turn; does concatenation + threshold check + archiving (the main skill-extraction path).

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| session_id / user_id / team_id / agent_id | string | Yes | none may contain `\|` |
| messages | object[] | Yes | 1–500 entries (roles same as extract; `tool_call`/`tool_result` must carry tool_name + tool_call_id) |
| space_id / task_id | string | No | — |

**Response** `data`: `{ status: "ok"\|"archived", archived?: { task_id, archived_at_ms, archive_key, reason } }`, `archived.reason ∈ tool_calls\|bytes\|compressed\|oversize`.

**Errors**: `40001` (schema/validation), `404` (module not enabled), `50001`.

### POST /v3/skill/conversation/force-archive

Manually force-archives the current session buffer (skips thresholds).

**Request body**: `space_id`, `user_id`, `team_id`, `agent_id`, `session_id` (all required), `reason?` (≤2000), `task_id?`.

**Response** `data`: `{ status: "empty" \| "archived", task_id?, archived_at_ms?, archive_key?, message? }`.

---

**SkillSummary unified output** (returned by list/create/update etc.):

| Field | Type | Description |
|---|---|---|
| skill_id | string | Globally unique, `skl-` prefix |
| name | string | Name |
| description | string? | Description |
| version | number | Version (monotonic) |
| is_head | boolean | Whether it is the head version |
| status | string | `active` / `archived` |
| owner_user_id | string | Owner user |
| owner_agent_id | string | Owner agent |
| team_id / task_id | string? | Ownership |
| created_at_ms / updated_at_ms | number | ms epoch |
| metadata | object? | Custom metadata (if any) |

---

## 3.3 Knowledge details (5)

> Kernel-side knowledge **metadata-detail** CRUD (team-scoped management plane). wiki/code-graph actual storage and operation live in MemoryKnowledge (Volume II); only detail metadata is recorded here. No binding endpoints (TODO).

### POST /v3/knowledge/create

Upserts a knowledge detail (idempotent).

**Request body**: `knowledge_id`, `type` ("wiki"\|"code-graph"), `service_url` (url), `name`, `summary?` (≤256), `team_id`, `user_id?`, `repo_url?`, `branch?`.

**Response** `data`: `KnowledgeEntity`.

### POST /v3/knowledge/get

Fetches a single detail.

**Request body**: `knowledge_id`, `team_id?` (if passed, ownership is validated).

**Response** `data`: `KnowledgeEntity`.

**Errors**: `404` (not found), `403` (team mismatch).

### POST /v3/knowledge/update

Partial update.

**Request body**: `knowledge_id`, `team_id?`, `name?`, `summary?`, `service_url?`, `repo_url?`, `branch?`.

**Response** `data`: `KnowledgeEntity`.

**Errors**: `404`, `403`.

### POST /v3/knowledge/delete

Batch delete.

**Request body**: `knowledge_ids` (1–100), `team_id?`.

**Response** `data`: `BatchDeleteResult` (`{ deleted_ids, failed: [{ id, reason }] }`).

### POST /v3/knowledge/list

Team-scoped paginated list.

**Request body**: `team_id`, `type?`, `knowledge_ids?` (≤200), `pagination?` (`{ limit ≤1000, offset }`).

**Response** `data`: `KnowledgeListResult`.

**Common errors**: `503` (store unavailable), `400` (schema failure).

**Example** (create)

```json
// Request
{ "knowledge_id": "wiki_1", "type": "wiki", "service_url": "https://ks.example.com/wiki_1", "name": "team wiki", "team_id": "t_1" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "knowledge_id": "wiki_1", "type": "wiki", "name": "team wiki", "team_id": "t_1" }
}
```

---

## 3.4 Chat-Memory (1)

### POST /v3/chat-memory/clear

Clears the **content** of several memories (L0/L1/L2/L3) while **keeping the assets** (ownership/bindings/ACL unchanged).

> Auth: Bearer + `x-tdai-service-id` is treated as trusted admin-level credentials; **no user-level Owner check** (Owner checks are done by the panel before forwarding).

**Request body**: `memory_ids: string[]` (1–100, auto-deduped and empty strings dropped).

**Response** `data`

| Field | Type | Description |
|---|---|---|
| items | object[] | Per-memory clear result |
| all_cleared | boolean | true if all succeeded |

**items[] fields**: `memory_id`, `cleared`, `l0_deleted`, `l1_deleted`, `profile_deleted`, `reason?`, `retryable?`, `attempts?`.

**Errors**: `400` (schema), `503` (store/storage/metadata unavailable); a single-memory failure does not fail the whole request — it is written into `items[]` with `cleared=false`.

**Example**

```json
// Request
{ "memory_ids": ["chat_memory-t_1-agt_1"] }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [ { "memory_id": "chat_memory-t_1-agt_1", "cleared": true, "l0_deleted": 10, "l1_deleted": 3, "profile_deleted": 1 } ],
    "all_cleared": true
  }
}
```

---

## 3.5 Memory-Prompt (7)

> Memory prompt management (L1/L2/L3 prompts); `layer` is lowercase `l1`/`l2`/`l3`.

### POST /v3/memory-prompt/create

Creates a prompt.

**Request body**: `name` (≤100 chars), `layer` ("l1"\|"l2"\|"l3"), `prompt` (≤10000 chars).

**Response** `data`: `{ memory_prompt_id: "mp-xxx", version: 1, created_at_ms }`.

**Errors**: `409` (PROMPT_LIMIT_EXCEEDED; per-instance cap 500).

### POST /v3/memory-prompt/get

Three modes (mutually exclusive):
1. `memory_prompt_id` → returns a single prompt (returns 404 if not active).
2. `layer` + (`team_id`/`agent_id`) → resolves the effective prompt (returns the built-in fallback if none).
3. `layer` only → returns a list `{ items }`.

**Request body**: `memory_prompt_id?`, `team_id?`, `agent_id?`, `layer?`, `limit?` (default 20), `offset?`, `time_order?` (default desc).

**Errors**: `404` (MEMORY_PROMPT_NOT_FOUND).

### POST /v3/memory-prompt/update

Updates name/prompt.

**Request body**: `memory_prompt_id`, `name?`, `prompt?` (at least one).

**Response** `data`: `{ memory_prompt_id, version, updated_at_ms }`.

**Errors**: `404`.

### POST /v3/memory-prompt/delete

Batch delete (each id must exist).

**Request body**: `memory_prompt_ids` (1–100, deduped).

**Response** `data`: delete result.

**Errors**: `404` (some id does not exist).

### POST /v3/memory-prompt/set

Sets the effective prompt (apply / clear).

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| action | string | Yes | `apply` / `clear` |
| layer | string | Yes | l1/l2/l3 |
| memory_prompt_id | string | required for apply | prompt ID |
| team_id | string | No | target team (used with agent_ids) |
| agent_ids | string[] | No | 1–100, requires team_id |

**Response** `data`: `{ affected: number }`.

**Errors**: `404` (prompt does not exist), `400` (PROMPT_LAYER_MISMATCH; prompt layer mismatch).

### POST /v3/memory-prompt/setting/list

Effective-setting list.

**Request body**: `memory_prompt_id?`, `target_type?` (instance/team/agent), `team_id?`, `agent_id?`, `layer?`, `limit?`, `offset?`, `time_order?`.

**Response** `data`: `{ items }`.

### POST /v3/memory-prompt/log

Operation log (last 7 days by default).

**Request body**: `memory_prompt_id?`, `start_time?`, `end_time?`, `team_id?`, `agent_id?`, `action?` (apply/replace/clear), `limit?`, `offset?`, `time_order?`.

**Response** `data`: `{ items }`.

> Constraint: `start_time`/`end_time` must come in pairs; time range ≤90 days.

---

## 3.6 Memory-Generation-Log (2)

> Memory generation logs (L1/L2/L3 generation traceability); `layer` lowercase l1/l2/l3.

### POST /v3/memory-generation-log/list

Log list (last 7 days by default, cursor pagination).

**Request body**: `layer?`, `status?` (succeeded/failed), `start_time?`, `end_time?`, `limit?` (default 20 / cap 100), `cursor?` (≤512).

**Response** `data`: list result.

**Errors**: `503` (GENERATION_LOG_STORE_UNAVAILABLE), `400` (INVALID_GENERATION_LOG_CURSOR).

### POST /v3/memory-generation-log/get

Two modes:
1. `log_id` → fetch the log directly.
2. `memory_id` + `layer` → look up the generation log by memory.

**Request body**: `log_id?`, `memory_id?`, `layer?` (log_id and memory_id are mutually exclusive; memory_id requires layer).

**Response** `data`: the log object.

**Errors**: `404` (MEMORY_GENERATION_LOG_NOT_FOUND), `503`.

---

## 3.7 Meta metadata (55)

> Metadata plane `/v3/meta/*`, auth `Bearer + x-tdai-service-id + x-tdai-user-key` (`auth/verify` exempt from user-key).
> Failure message format `"{error_code}: {detail}"`; HTTP status mapped by mapErrorCode (see §4.2).
> All list endpoints output uniformly `{ items, total, limit, offset }`.

### 3.7.1 User (5)

| Endpoint | Auth | Description |
|---|---|---|
| `POST /user/create` | system_admin | Creates a normal user; returns `{ user_id, user_type, created_at, default_user_key }` |
| `POST /user/create-with-key` | system_admin | Sister endpoint; can explicitly set user_key |
| `POST /user/get` | self/admin | Looks up by user_id or user_key |
| `POST /user/delete` | admin | Batch delete |
| `POST /user/list` | admin | Paginated list |

**create request body**: `username`, `user_id?` (may specify a deterministic ID).
**create-with-key request body**: `username`, `user_key`.
**get request body**: `user_id` or `user_key` (one of the two).
**list request body**: `team_id?`, `user_ids?` (≤100), `username?` + pagination.

**UserPublic response**: `{ user_id, user_type: "normal"\|"system_admin", username, created_at }`.

**Example** (create)

```json
// Request
{ "username": "zhangsan" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "user_id": "usr_1", "user_type": "normal", "created_at": "2026-08-20T00:00:00Z", "default_user_key": "tk_xxx" }
}
```

### 3.7.2 User-Key (5)

| Endpoint | Description |
|---|---|
| `POST /user-key/create` | Creates a key; `user_id` defaults to the current caller |
| `POST /user-key/list` | Paginated list |
| `POST /user-key/get` | Looks up by key_id (masked) |
| `POST /user-key/revoke` | Revokes |
| `POST /user-key/update` | Updates name/expires_at |

**create request body**: `user_id?`, `name?` (≤128), `expires_at?`.

**UserKeyPublic response**: `{ key_id, user_id, key_prefix, name?, status: "active"\|"revoked", is_default, last_used_at?, expires_at?, created_at, revoked_at? }`. create additionally returns `key_value` (the only time the full key is returned).

### 3.7.3 Team (5)

| Endpoint | Description |
|---|---|
| `POST /team/create` | Creates a team |
| `POST /team/get` | Looks up by team_id |
| `POST /team/update` | Updates (owner cannot be changed) |
| `POST /team/delete` | Batch delete |
| `POST /team/list` | Lists the teams a user belongs to |

**create request body**: `name`, `owner_user_id`, `description?`, `status?` (active/archived), `metadata_json?`.
**update request body**: `team_id`, `name?`, `description?`, `status?`, `metadata_json?` (owner passed is stripped).
**list request body**: `user_id`/`user_key` (one of the two) + `name?` + pagination.

**TeamEntity response**: `{ team_id, name, description?, owner_user_id, status, created_at, updated_at, metadata_json }`.

### 3.7.4 Team-Member (4)

| Endpoint | Description |
|---|---|
| `POST /team-member/add` | Adds a member |
| `POST /team-member/remove` | Removes a member |
| `POST /team-member/list` | Member list |
| `POST /team-member/get` | Single member lookup |

**add request body**: `team_id`, `user_id`, `role?` (admin/member/reviewer), `status?`.
**list request body**: `team_id` + pagination.

**TeamMemberView response**: `{ id, team_id, user_id, role, joined_at, status, username }` (username obtained via JOIN).

### 3.7.5 Agent (6)

| Endpoint | Description |
|---|---|
| `POST /agent/create` | Creates an agent |
| `POST /agent/get` | Looks up by agent_id |
| `POST /agent/update` | Updates (owner cannot be changed) |
| `POST /agent/delete` | Batch delete |
| `POST /agent/list` | Lists by team or owner |
| `POST /agent/archive` | Archives |

**create request body**: `team_id`, `owner_user_id`, `name`, `description?`, `prompt?`, `visibility?`, `status?`, `metadata_json?`.
**list request body**: `team_id`/`owner_user_id`/`owner_user_key` (at least one) + `status?`, `name?` + pagination.

**AgentEntity response**: `{ agent_id, team_id, owner_user_id, name, description?, prompt?, visibility, status, created_at, updated_at, metadata_json }`.

**Example** (create)

```json
// Request
{ "team_id": "t_1", "owner_user_id": "u_1", "name": "release-helper" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "agent_id": "agt_1", "team_id": "t_1", "name": "release-helper", "status": "active" }
}
```

### 3.7.6 Task (6)

| Endpoint | Description |
|---|---|
| `POST /task/create` | Creates a task (may carry linked_agents) |
| `POST /task/get` | Looks up by task_id |
| `POST /task/update` | Updates |
| `POST /task/delete` | Batch delete |
| `POST /task/list` | Lists by team or creator |
| `POST /task/archive` | Archives |

**create request body**: `team_id`, `creator_user_id`, `title`, `description?`, `source_type?` (manual/tapd/github/other), `source_url?`, `status?` (running/completed), `auto_assign_floating_assets?`, `risk_level?`, `metadata_json?`, `linked_agents?` (`[{ agent_id, role_in_task? }]`).

**TaskEntity response**: `{ task_id, team_id, creator_user_id, title, description?, source_type, source_url?, status, auto_assign_floating_assets, risk_level?, created_at, updated_at, metadata_json }`.

### 3.7.7 Task-Agent (3)

| Endpoint | Description |
|---|---|
| `POST /task-agent/link` | Links an agent to a task |
| `POST /task-agent/unlink` | Unlinks |
| `POST /task-agent/list` | Lists a task's agents |

**link request body**: `task_id`, `agent_id`, `role_in_task?`.

**TaskAgentEntity response**: `{ id, task_id, agent_id, role_in_task?, status, created_at }`.

### 3.7.8 Participation-Log (2)

| Endpoint | Description |
|---|---|
| `POST /participation-log/append` | Appends a participation event |
| `POST /participation-log/list` | List (time/entity filters + dedupe) |

**append request body**: `team_id`, `task_id`, `agent_id`, `user_id` (all required), `created_at?`, `source?`, `metadata_json?`.
**list request body**: `team_id` + `task_id?`, `agent_id?`, `user_id?`, `created_after?`, `created_before?`, `dedupe?` + pagination.

### 3.7.9 Asset (7)

| Endpoint | Description |
|---|---|
| `POST /asset/create` | Registers an asset (asset_id provided by caller) |
| `POST /asset/get` | Looks up by asset_id |
| `POST /asset/update` | Updates |
| `POST /asset/delete` | Batch delete |
| `POST /asset/list` | Lists by team |
| `POST /asset/list-accessible` | Lists assets accessible under permissions |
| `POST /asset/touch-usage` | Touches usage (updates last_used_at) |

**create request body**: `asset_id`, `team_id`, `asset_type` (skill/llm_wiki/code_graph/chat_memory), `name`, `owner_user_id`, `source_type`, `description?`, `source_ref?`, `visibility?`, `status?`, `confidence?`, `expires_at?`, `content_ref?`, `metadata_json?`.
**list request body**: `team_id`, `asset_type?`, `status?`, `owner_user_id?`, `visibility?` + pagination.
**list-accessible request body**: `user_id`/`user_key` (one of the two) + `team_id?`, `action?`, `asset_type?`, `agent_id?`, `visibility?` (single value or array) + pagination.

**AssetEntity response**: `{ asset_id, team_id, asset_type, name, description?, owner_user_id, source_type, source_ref?, version, visibility, status, confidence?, expires_at?, last_used_at?, usage_count, content_ref?, created_at, updated_at, metadata_json }`.

### 3.7.10 Agent-Fixed-Asset (4)

| Endpoint | Description |
|---|---|
| `POST /agent-fixed-asset/set` | Fully sets an agent's fixed-asset bindings |
| `POST /agent-fixed-asset/list` | Paginated binding list |
| `POST /agent-fixed-asset/list-with-detail` | With details + visibility filtering |
| `POST /agent-fixed-asset/summary-by-agents` | Aggregated per-type counts across multiple agents |

**set request body**: `agent_id`, `bindings: [{ asset_id, asset_type, injection_mode?, priority?, created_by }]`.
**list-with-detail request body**: `agent_id`, `apply_visibility_filter?`, `touch_usage?` + pagination.
**summary-by-agents request body**: `agent_ids` (1–100, deduped), `asset_id?`.

**summary response**: `{ items: [{ agent_id, counts: { skill, code_graph, llm_wiki, chat_memory }, total }], total }`.

### 3.7.11 ACL (4)

| Endpoint | Description |
|---|---|
| `POST /acl/grant` | Grants permission |
| `POST /acl/revoke` | Revokes |
| `POST /acl/list` | Lists ACLs by asset |
| `POST /acl/check` | Permission check |

**grant request body**: `asset_id`, `subject_type` (user/team_role/agent), `subject_id`, `permission` (read/write/delete/assign/share/use), `effect?` (allow/deny), `granted_by`/`granted_by_key` (one of the two).
**revoke request body**: `id` (**note: the ACL entry `id`, not `asset_id`**, `aclRevokeSchema`).
**list request body**: `asset_id` + pagination.
**check request body**: `asset_id`, `action`, `user_id`/`user_key` (one of the two), `agent_id?`.

**AclEntity response**: `{ id, asset_id, subject_type, subject_id, permission, effect, granted_by, created_at, updated_at }`.

### 3.7.12 Auth (1)

### POST /v3/meta/auth/verify

Validates a user_key and returns the caller identity. **Exempt from user-key** (verifying the key is its job; it is on the `V3_NO_USER_KEY_ROUTES` whitelist and runs in the handler rather than the auth middleware).

**Request body**: `{ user_key: string }` (`authVerifySchema`; a missing user_key fails Zod validation → `400`).

**Response** `data`: `{ valid: boolean, user: UserPublic | null }` (**nested structure, not flat**).

- Valid key: `{ valid: true, user: { user_id, user_type, username, created_at } }`
- Invalid key: `{ valid: false, user: null }` (**HTTP is still 200, code=0, no 401**)

> ⚠️ The frontend must check `data.valid`; it must **not** branch on 401 for an invalid key. `401 unauthorized: invalid_user_key` is what **other meta endpoints** return when they go through the auth middleware (the `x-tdai-user-key` header check); it is not `auth/verify`'s own behavior.

**Example**

```json
// Request
{ "user_key": "tk_xxx" }

// Response (valid)
{ "code": 0, "message": "ok", "request_id": "abc-123", "data": { "valid": true, "user": { "user_id": "usr_1", "user_type": "normal", "username": "zhangsan", "created_at": "2026-08-20T00:00:00Z" } } }

// Response (invalid key; note code is still 0)
{ "code": 0, "message": "ok", "request_id": "abc-123", "data": { "valid": false, "user": null } }
```

### 3.7.13 Instance-Quota & Config (3)

| Endpoint | Description |
|---|---|
| `POST /instance-quota/get` | Fetches instance quota limits |
| `POST /config/user/get` | Fetches user config (requires owner) |
| `POST /config/user/set` | Sets user config (requires owner) |

**config get request body**: `user_id`, `module`, `param_name?`.
**config set request body**: `user_id`, `module`, `params: Record<string, string>`.

---

## 3.8 Internal Meta (2)

> `/v3/internal/meta/*` — ops/control plane, Bearer only (user-key not parsed).

### POST /v3/internal/meta/user/init-admin

Initializes the system_admin user (first-run bootstrap).

**Request body**: `username`, `user_key?`.

**Response** `data`: `{ user_id, user_key }`.

**Errors**: `409` (already_initialized).

### POST /v3/internal/meta/user/list-by-instance

Lists users by instance (supports status/user_type filters).

**Request body**: `instance_id?`, `status?`, `user_type?` (normal/system_admin), `user_ids?` (≤100) + pagination.

**Response** `data`: `{ items, total, limit, offset }`.

---

## 3.9 Instance Destroy (1)

### POST /v3/instance/destroy

Thoroughly cleans up all instance data (state/store/COS/quota + v3 metadata DBs). **Bearer apiKey only (ops endpoint; does not use user-key)**.

**Request body**: `{ instance_id: string }`.

**Response** `data`: `{ instance_id, cleaned: { state, store_evicted, skill_store_evicted, ..., v3_metadata } }`.

**Errors**: `400` (missing instance_id).

---

## 4. Appendix

### 4.1 Deprecated endpoints (v1 / v2, not in this volume's main text)

| Category | Paths | Description |
|---|---|---|
| v1 legacy | `POST /recall`, `/capture`, `/search/memories`, `/search/conversations`, `/session/end`, `/seed` | Replaced by the v3 data-plane split (hermes migration doc lists the mapping) |
| v2 data plane | `/v2/conversation·atomic·scenario·core/*` (14) | Dual entry to the same handler as v3; no count endpoints; looser isolation checks (team optional, may use legacyCompat) |
| v2 entity | `/v2/team·user·agent·task/*` (16) | @deprecated; use `/v3/meta/*`; deletion planned |
| v2 ops | `/v2/pipeline/status`, `/v2/instance/destroy` | instance/destroy has a v3 version; pipeline/status is v2-only |

### 4.2 Error-code summary

#### Skill (5-digit codes)

| code | SkillCoreError | Description |
|---|---|---|
| 40001 | INVALID_FRONTMATTER / INVALID_PATH | frontmatter mismatch / invalid path |
| 40301 | SKILL_NOT_OWNER | not the owner |
| 40302 | SKILL_TEAM_MISMATCH | team mismatch |
| 40401 | SKILL_NOT_FOUND | skill does not exist |
| 40901 | SKILL_VERSION_STALE | version stale (data carries current_version) |
| 41002 | SKILL_VERSION_EXPIRED | version expired (data carries latest_version) |
| 41301 | RESOURCE_TOO_LARGE / SKILL_EXPORT_TOO_LARGE | resource too large |
| 42201 | SKILL_NAME_DUPLICATE | duplicate name |
| 42202 | SKILL_PATCH_NOT_UNIQUE | patch not unique |
| 42203 | SKILL_FRONTMATTER_INVALID | invalid frontmatter |
| 4291 | — | quota exceeded (memory limit exceeded) |
| 50001 | Other | internal error |
| 50301 | STORAGE_NOT_FOUND | storage/version-dir GC missing |
| 50302 | LLM_UNAVAILABLE | LLM unavailable |
| 50303 / 50304 | SKILL_COS_REQUIRED / SKILL_ID_COLLISION | COS missing / ID collision |

#### Meta / Internal-Meta (standard HTTP code; message carries error_code)

| HTTP | error_code | Description |
|---|---|---|
| 400 | missing_instance_id / invalid_instance_id / missing_team_id / filter_not_allowed / invalid_user_ids | invalid params/instance |
| 401 | invalid_credentials / invalid_password / unauthorized | auth failure |
| 403 | permission_denied / agent_team_mismatch / task_agent_not_linked / user_inactive | permission/ownership |
| 404 | `*_not_found` (team/agent/task/asset/user_key etc.) | resource not found |
| 409 | duplicate_entry / duplicate_user_key / key_limit_exceeded / user_limit_exceeded / team_limit_exceeded / last_key_cannot_revoke / already_initialized / last_system_admin / member_already_exists / asset_not_bindable | conflict/limit |

#### Data-plane / knowledge / chat-memory / memory-prompt / generation-log (standard HTTP code; message plain text or enum)

| HTTP | message example | Description |
|---|---|---|
| 400 | field-validation failure text | Zod schema failure |
| 403 | Knowledge team_id mismatch | ownership mismatch |
| 404 | Knowledge not found / MEMORY_PROMPT_NOT_FOUND / MEMORY_GENERATION_LOG_NOT_FOUND | resource not found |
| 409 | PROMPT_LIMIT_EXCEEDED | limit exceeded |
| 503 | Store not available / Storage not available / Metadata service not available / GENERATION_LOG_STORE_UNAVAILABLE | dependency unavailable |
