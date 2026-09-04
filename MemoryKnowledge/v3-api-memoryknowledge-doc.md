# v3 API Specification · Volume II MemoryKnowledge

> Service: MemoryKnowledge (Knowledge Service, KS), Port `8421`
> This volume covers all `/v3/*` endpoints exposed by MemoryKnowledge. See Volume I for MemoryCore and Volume III for MemoryProxy.
> Maintenance agreement: API changes must update this document in the same PR.

---

## 1. Common Conventions

### 1.1 Service and Ports

| Item | Value |
|---|---|
| Service | MemoryKnowledge (Knowledge Service, KS) |
| Port | 8421 (`PORT`, default `8421`) |
| API Prefix | `/v3` (`API_PREFIX`, default `/v3`) |
| Method | Except `GET /v3/auto-sync/status` and `GET /health`, **all remaining are `POST`** |
| Content-Type | `application/json` |
| Health Check | `GET /health` (**non-v3**, returns bare JSON `{ status, timestamp }`) |
| Swagger | `GET /docs` (UI), `GET /openapi.json` (spec, non-v3) |

### 1.2 Response Envelope

**Note: Unlike MemoryCore, the KS envelope does not contain a `request_id` field.**

```json
{ "code": 0, "message": "ok", "data": { } }
```

| Field | Type | Description |
|---|---|---|
| code | number | `0` for success; non-zero for failure, with **HTTP Status Code = code** (`wrapError(code, ...)` followed by `c.json(..., code)`) |
| message | string | Fixed to `"ok"` on success; **lowercase English sentence** on failure (non-enum, see §1.5) |
| data | any | Business payload; `null` on failure |

> In the `wrapOk` implementation, `request_id` is optional, but **no route passes it**, so the actual response always consists of `{ code, message, data }`.

> ⚠️ **isError Special Case (code-graph query tools / tools/call)**: When tool execution fails (`result.isError === true`), the HTTP status code is **500**, but the response body is still the **success envelope** of `wrapOk(result)` `{ code: 0, message: "ok", data: { text, isError: true } }`. That is, **`code=0` but HTTP=500**, violating the standard convention of "HTTP Status Code = code" in the table above. The sole indicator for frontend tool failure is **`data.isError === true`** (with error text in `data.text`), and client code must not inspect only the HTTP status or `code`.

### 1.3 Authentication

KS follows an **internal network trust model**, which differs from MemoryCore's user-key architecture:

| Item | Description |
|---|---|
| Sole Required Header | `x-tdai-service-id` (tenant/service identifier, i.e., kernel routing key) |
| Other Authentication | **None** (No Bearer, no user-key; service_id self-reported, trusted on internal network) |
| Exceptions | `POST /v3/internal/llm-binding/list` does not require `x-tdai-service-id` header (returns all bindings for Panel startup caching); `/v3/auto-sync/*` has no auth |

> `service_id` / `team_id` / resource IDs undergo **path segment whitelist validation** (`^[A-Za-z0-9_-]+$`, length ≤200) to prevent path traversal.

### 1.4 IDs and Multi-tenancy

| Item | Value |
|---|---|
| Wiki ID | `wiki-` + 8-char `[0-9a-z]` (e.g. `wiki-a1b2c3d4`) |
| Code-Graph ID | `cg-` + 8-char `[0-9a-z]` (e.g. `cg-e5f6g7h8`) |
| Multi-tenancy | All endpoints scoped by `service_id`; **id-only endpoints use `getById(service_id, id)`, returning 404 for cross-tenant resources (hiding existence)** |

### 1.5 Error message Format

Failure `message` is a **lowercase English sentence** (non-enum, non-`CODE: detail` format). The frontend branches on HTTP `code` and should not parse message text. Common examples:

| code | message Example | Scenario |
|---|---|---|
| 400 | `x-tdai-service-id header is required` / `wiki_id is required` / `query is required` | Missing parameter |
| 400 | `invalid path: traversal detected` / `forbidden path (structural file or outside wiki/)` | Invalid path |
| 404 | `wiki not found` / `code graph not found` | Resource not found (including cross-tenant) |
| 409 | `wiki is processing; cannot write/delete` | Status conflict |
| 409 | `busy` | Concurrency rejection (ingest/sync) |
| 413 | `content exceeds size limit` / `too many files (max 10)` | Limit exceeded |
| 503 | `code graph instance not loaded` | Dependency not ready |

### 1.6 Resource Status Enums

| Resource | Status Values | Description |
|---|---|---|
| Wiki | `draft` → `pending` → `processing` → `ready` / `failed` | `draft` is the initial shell creation state |
| Code-Graph | `pending` / `processing` / `ready` / `failed` | No `draft` status |

> Common convention: For statuses prior to `ready`, query-type endpoints (graph/search/query tools) return **empty results rather than errors** (see §3.1/§3.2).

---

## 2. API Overview

| Module | Count | Prefix |
|---|---|---|
| Wiki | 16 | `/v3/wiki/*` |
| Code-Graph | 14 | `/v3/code-graph/*` |
| Tools (Agent Self-Discovery) | 2 | `/v3/tools/*` |
| Internal LLM-Binding | 3 | `/v3/internal/llm-binding/*` |
| Auto-Sync | 2 | `/v3/auto-sync/*` |

**Total: 37 Endpoints.**

---

## 3. Endpoint Details

## 3.1 Wiki (16)

> Code comments state "15 endpoints", actual implementation has 16 (includes `update-meta`).
> Two categories: **id-only** (only `x-tdai-service-id` + `wiki_id`, returns 404 across tenants) and **with-team** (requires `team_id`).

**Unified WikiDetail Output**:

| Field | Type | Description |
|---|---|---|
| wiki_id | string | Resource ID |
| team_id | string | Team ID |
| name | string | Name |
| service_url | string\|null | Tools self-discovery base URL |
| summary | string\|null | Summary |
| status | string | Status (see §1.6) |
| internal_status | string\|null | Internal fine-grained status |
| sync_error | string\|null | Sync error message |
| version | string | Version string |
| owner_user_id | string\|null | Owner user ID |
| page_count | number\|null | Page count |
| last_sync_at | string\|null | Last sync timestamp |
| created_at / updated_at | string | Timestamps |

### POST /v3/wiki/create

Create Wiki shell (`draft` status). **Idempotent**: Returns existing record for same name and team (HTTP 200); returns 201 for new creation.

**Request Body** (with-team)

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | Yes | Team ID |
| name | string | Yes | Name |
| user_id / agent_id / task_id | string | No | Ownership (owner_user_id = user_id) |

**Response** `data`: `WikiDetail`.

**Errors**: `400` (missing team_id or name).

**Example**

```json
// Request
POST /v3/wiki/create
{ "team_id": "t_1", "name": "Team Wiki" }

// Response (201)
{
  "code": 0,
  "message": "ok",
  "data": {
    "wiki_id": "wiki-a1b2c3d4",
    "team_id": "t_1",
    "name": "Team Wiki",
    "status": "draft",
    "version": "0",
    "owner_user_id": "u_1",
    "created_at": "2026-08-20T00:00:00Z",
    "updated_at": "2026-08-20T00:00:00Z"
  }
}
```

### POST /v3/wiki/list

Paginated list by team.

**Request Body**: `team_id` (required), `status?`, `limit?` (default 20), `offset?` (default 0).

**Response** `data`: `{ items: WikiDetail[], total }`.

### POST /v3/wiki/get

id-only single resource query.

**Request Body**: `wiki_id` (required).

**Response** `data`: `WikiDetail`.

**Errors**: `404` (wiki not found).

### POST /v3/wiki/update-meta

Update name / summary.

**Request Body**: `wiki_id` (required), `name?`, `summary?` (at least one required).

**Response** `data`: `WikiDetail`.

**Errors**: `400` (neither provided), `404`.

### POST /v3/wiki/delete

Batch delete (cascading cleanup of connections/metadata/disk + engine unregistration).

**Request Body**: `wiki_ids` (1–100, non-empty array).

**Response** `data`: `BatchDeleteResult` = `{ deleted_ids: string[], failed: [{ id, reason }] }`.

> Individual failures do not fail the entire batch; they are recorded in `failed` (reasons: `invalid id` / `not found` / `delete failed`).

### POST /v3/wiki/ingest

Trigger Wiki extraction. **Prohibited for empty wikis (no source files)**.

**Request Body**: `wiki_id` (required), `user_id?`.

**Response** `data`: `{ wiki_id, status }` (HTTP `202`).

**Errors**: `400` (empty wiki), `404` (not found), `409` (busy, data contains `{ status, step }`).

### POST /v3/wiki/raw/ls

List raw source files (id-only).

**Request Body**: `wiki_id`.

**Response** `data`: `{ items: RawFile[] }`.

### POST /v3/wiki/raw/read

Batch read raw files (id-only).

**Request Body**: `wiki_id`, `filenames: string[]` (non-empty).

**Response** `data`: `{ items }`.

**Errors**: `400` (parameter error), `404` (wiki not found / file missing), `413` (too large).

### POST /v3/wiki/raw/write

Upload raw source files (with-team). **Must write raw before triggering ingest**.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | Yes | Team ID |
| wiki_id | string | Yes | Wiki ID |
| files | object[] | Yes | `[{ filename, content }]`, ≤10 files, single file ≤512KB, total ≤5MB |
| user_id / agent_id / task_id | string | No | Ownership |

**Response** `data`: `{ items }`.

**Errors**: `400` (invalid structure), `404`, `409` (processing), `413` (limit exceeded).

**Example**

```json
// Request
POST /v3/wiki/raw/write
{ "team_id": "t_1", "wiki_id": "wiki-a1b2c3d4", "files": [ { "filename": "README.md", "content": "# Home" } ] }

// Response
{ "code": 0, "message": "ok", "data": { "items": [ { "filename": "README.md", "status": "written" } ] } }
```

### POST /v3/wiki/raw/rm

Delete raw files (with-team).

**Request Body**: `team_id`, `wiki_id`, `filenames: string[]`.

**Response** `data`: Delete result.

**Errors**: `400`, `404`, `409` (processing).

### POST /v3/wiki/page/ls

List extracted pages (id-only).

**Request Body**: `wiki_id`.

**Response** `data`: `{ items: Page[] }` (`Page = { ref, title, path }`).

### POST /v3/wiki/page/read

Batch read pages (id-only).

**Request Body**: `wiki_id`, `refs: string[]` (non-empty).

**Response** `data`: `{ items }`.

**Errors**: `400`, `404`.

### POST /v3/wiki/page/write

Write page (with-team).

**Request Body**: `team_id`, `wiki_id`, `pages: [{ ref, content }]` (non-empty).

**Response** `data`: `{ items }`.

**Errors**: `400`, `404`, `409` (processing).

### POST /v3/wiki/page/rm

Delete page (with-team).

**Request Body**: `team_id`, `wiki_id`, `refs: string[]`.

**Response** `data`: Delete result.

**Errors**: `400`, `404`, `409` (processing).

### POST /v3/wiki/graph

Knowledge graph (id-only). **Returns empty graph if not `ready` (not an error)**.

**Request Body**: `wiki_id`.

**Response** `data`: `{ nodes: [], edges: [], communities: [] }` (empty when not ready; returns `wikiMgr.graph` result when ready).

### POST /v3/wiki/search

Full-text search (BM25, id-only). **Returns empty results if not `ready` (not an error)**.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| wiki_id | string | Yes | Wiki ID |
| query | string | Yes | Search query keywords |
| limit | number | No | Default 20 |
| hop | number | No | Graph expansion hops, integer 0–5 |
| decay | number | No | Decay factor 0–1 |
| minScore | number | No | Minimum relevance score (non-negative) |

**Response** `data`: `{ results, links, count }`.

**Errors**: `400` (missing query / hop/decay/minScore out of bounds), `404`.

**Example**

```json
// Request
POST /v3/wiki/search
{ "wiki_id": "wiki-a1b2c3d4", "query": "release", "limit": 10 }

// Response
{ "code": 0, "message": "ok", "data": { "results": [ { "ref": "page/ReleasePlan", "title": "Release Plan" } ], "links": [], "count": 1 } }
```

---

## 3.2 Code-Graph (14)

> Code comments state "13 endpoints", actual implementation has 14 (includes `update-meta`).
> Two categories: **Management** (6: create/list/get/update-meta/sync/delete) and **Query** (8: search/explore/callers/callees/impact/node/status/files).
> Query endpoints delegate to `engines/code executeTool`, returning `{ text, isError }` text blocks.

**Unified CodeGraphDetail Output**:

| Field | Type | Description |
|---|---|---|
| code_graph_id | string | Resource ID |
| team_id | string | Team ID |
| repo_name | string | Repository name |
| repo_url | string | Repository URL |
| branch | string | Branch (default `main`) |
| commit_hash | string\|null | Commit hash |
| service_url | string\|null | Tools self-discovery base URL |
| summary | string\|null | Summary |
| status | string | Status (see §1.6) |
| sync_error | string\|null | Sync error message |
| version | string | Version string |
| owner_user_id | string\|null | Owner user ID |
| stats | `{ files, nodes, edges }`\|null | Statistics |
| last_sync_at | string\|null | Last sync timestamp |
| created_at / updated_at | string | Timestamps |

### POST /v3/code-graph/create

Create Code-Graph (`pending`, triggers build automatically). **Idempotent**: Returns existing record for same repo_url+branch (200); returns 201 for new creation.

**Request Body** (with-team)

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | Yes | Team ID |
| repo_url | string | Yes | Repository URL |
| branch | string | No | Branch, default `main` |
| repo_name | string | No | Repository name |
| user_id / agent_id / task_id | string | No | Ownership |

**Response** `data`: `CodeGraphDetail`.

**Errors**: `400` (missing team_id/repo_url).

**Example**

```json
// Request
POST /v3/code-graph/create
{ "team_id": "t_1", "repo_url": "https://github.com/org/repo", "branch": "main" }

// Response (201)
{
  "code": 0,
  "message": "ok",
  "data": {
    "code_graph_id": "cg-e5f6g7h8",
    "team_id": "t_1",
    "repo_name": "repo",
    "repo_url": "https://github.com/org/repo",
    "branch": "main",
    "status": "pending",
    "version": "0",
    "owner_user_id": "u_1"
  }
}
```

### POST /v3/code-graph/list

Paginated list by team.

**Request Body**: `team_id` (required), `status?`, `limit?`, `offset?`.

**Response** `data`: `{ items: CodeGraphDetail[], total }`.

### POST /v3/code-graph/get

id-only single resource query.

**Request Body**: `code_graph_id`.

**Response** `data`: `CodeGraphDetail`.

**Errors**: `404`.

### POST /v3/code-graph/update-meta

Update repo_name / summary.

**Request Body**: `code_graph_id`, `repo_name?`, `summary?` (at least one required).

**Response** `data`: `CodeGraphDetail`.

**Errors**: `400`, `404`.

### POST /v3/code-graph/sync

Trigger sync (rebuild index).

**Request Body**: `code_graph_id`, `user_id?`.

**Response** `data`: `{ code_graph_id, status }` (HTTP `202`).

**Errors**: `404`, `409` (busy, data contains `{ status, step }`).

### POST /v3/code-graph/delete

Batch delete.

**Request Body**: `code_graph_ids` (1–100, non-empty array).

**Response** `data`: `BatchDeleteResult`.

---

### Query Tools (8 Endpoints, all id-only)

> The 8 query endpoints are registered dynamically via `CODEGRAPH_QUERY_TOOL_NAMES`, sharing a common handler:
> - Resolves ownership via `getById(service_id, code_graph_id)`, returning `404` if missing/cross-tenant;
> - **Non-`ready` status returns `{ text: "", isError: false }` (HTTP 200, not an error)**;
> - Parameters strictly validated against `QUERY_SPECS` whitelist; **undeclared fields trigger 400** (`unexpected field: xxx`);
> - Delegates to `executeTool`; when `isError=true`, returns HTTP 500 while body is still a `code=0` success envelope (`data.isError=true`, see §1.2 isError special case).

| Endpoint | Parameters (Default / Range) | Description |
|---|---|---|
| `POST /search` | `query` (req), `kind?` (function/method/class/interface/type/variable/route/component), `limit?` (def 10, 1–100) | Search symbols by name, returning locations only (no source code) |
| `POST /explore` | `query` (req), `maxFiles?` (def 12, 1–200) | **Primary tool**: Returns complete source code grouped by file for relevant symbols |
| `POST /callers` | `symbol` (req), `limit?` (def 20, 1–200) | List functions calling symbol |
| `POST /callees` | `symbol` (req), `limit?` (def 20, 1–200) | List functions called by symbol |
| `POST /impact` | `symbol` (req), `depth?` (def 2, 1–10) | Impact analysis |
| `POST /node` | `symbol` (req), `includeCode?` (def false), `file?`, `line?` (≥1) | Detailed information for a single symbol (optional verbatim code) |
| `POST /status` | No parameters | Index health check |
| `POST /files` | `path?`, `pattern?`, `format?` (tree/flat/grouped, def tree), `includeMetadata?` (def true), `maxDepth?` (≥1) | Indexed file tree |

**Unified Request Body**: `code_graph_id` (required) + parameters above.

**Unified Response** `data`: `{ text: string, isError: boolean }`.

**Unified Errors**: `400` (parameter error), `404` (code graph not found), `500` (tool execution failure, `data.isError=true`, body `code=0`), `503` (instance not loaded).

**Example** (explore)

```json
// Request
POST /v3/code-graph/explore
{ "code_graph_id": "cg-e5f6g7h8", "query": "user auth logic", "maxFiles": 12 }

// Response
{
  "code": 0,
  "message": "ok",
  "data": { "text": "```src/auth.ts\n...\n```", "isError": false }
}
```

---

## 3.3 Tools — Agent Self-Discovery (2)

> v7 progressive-exposure: LLM Agent calls `tools/list` to discover available tools, then calls `tools/call` to execute.
> Only exposes **read-only query tools**; management operations (create/delete/ingest/sync) are omitted.
> `knowledge_id` determines resource type: `wiki-*` → Wiki toolset (7), `cg-*` → Code-Graph toolset (9).

### POST /v3/tools/list

List available tools for a knowledge resource.

**Request Body**: `knowledge_id` (required).

**Response** `data`

| Field | Type | Description |
|---|---|---|
| knowledge_id | string | Echoed resource ID |
| type | string | `wiki` / `code-graph` |
| name | string | Resource name |
| summary | string\|null | Summary |
| status | string | Resource status |
| tools | object[] | `[{ name, description, params }]` |

**Errors**: `400` (knowledge_id missing / invalid format), `404` (resource not found).

**Example**

```json
// Request
POST /v3/tools/list
{ "knowledge_id": "wiki-a1b2c3d4" }

// Response
{
  "code": 0,
  "message": "ok",
  "data": {
    "knowledge_id": "wiki-a1b2c3d4",
    "type": "wiki",
    "name": "Team Wiki",
    "status": "ready",
    "tools": [
      { "name": "search", "description": "BM25 full-text search across wiki pages", "params": { "query": { "type": "string", "required": true } } }
    ]
  }
}
```

### POST /v3/tools/call

Execute tool.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| knowledge_id | string | Yes | Resource ID |
| tool_name | string | Yes | Tool name |
| params | object | Yes | Tool parameters (as defined in tools/list) |

**Response** `data`: Tool execution result (wiki tools return structured data; code-graph tools return `{ text, isError }`).

**Errors**: `400` (parameter error), `403` (unknown tool), `404` (resource not found), `500` (code-graph tool failure, `data.isError=true`, body `code=0`), `503` (instance not loaded).

> **Tool Whitelist** (`tool_name`):
> - Wiki (7): `get_info`, `search`, `list_pages`, `read_page`, `get_graph`, `list_raw`, `read_raw`
> - Code-Graph (9): `get_info`, `search`, `explore`, `callers`, `callees`, `impact`, `node`, `status`, `files`

---

## 3.4 Internal LLM-Binding (3)

> Per-instance LLM routing configuration for control plane (TMC / operator curl). `api_key` is never echoed back.

### POST /v3/internal/llm-binding/set

Upsert binding (`proxy`\|`byo`). **Idempotent**: Re-posting overwrites existing configuration.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| mode | string | Yes | `proxy` / `byo` |
| proxy_base_url | string | Req for proxy | Proxy LLM URL |
| base_url | string | Req for byo | Custom LLM URL |
| api_key | string | Req on initial set | If omitted on existing record, previous value is retained |
| enabled | boolean | No | Default `true` |

**Response** `data`: `{ service_id, mode, enabled, updated_at }` (**excludes api_key**).

**Errors**: `400` (invalid mode / missing URL / missing api_key on initial set).

### POST /v3/internal/llm-binding/status

Read binding status (excludes api_key).

**Response** `data`

| Field | Type | Description |
|---|---|---|
| bound | boolean | Whether binding is configured |
| mode | string\|null | `proxy` / `byo`; `null` if unconfigured |
| enabled | boolean | Whether binding is enabled; `false` if unconfigured |

> Returns `{ bound: false, mode: null, enabled: false }` when unconfigured.

### POST /v3/internal/llm-binding/list

List all bindings (**does not require `x-tdai-service-id` header**).

**Response** `data`: `{ items: [{ service_id, mode, proxy_base_url, base_url, has_api_key, enabled }] }`.

---

## 3.5 Auto-Sync (2)

> Periodic sync scheduler status query and manual trigger. **Unauthenticated**. Rare module in v3 containing a GET endpoint.

### GET /v3/auto-sync/status

Query scheduler running status + configuration.

**Response** `data`: `{ running, activeSyncs, scanning, ..., config: { enabled, scanIntervalMs, maxConcurrentSyncs } }`.

### POST /v3/auto-sync/trigger

Manually trigger a full scan cycle (fire-and-forget, returns immediately).

**Response** `data`: `{ triggered: boolean, reason? }` (when `KNOWLEDGE_AUTO_SYNC_ENABLED` is disabled, returns `triggered=false` + reason).

---

## 4. Appendix

### 4.1 Key Differences from MemoryCore (Essential for Cross-Volume Integration)

| Dimension | MemoryCore (Volume I) | MemoryKnowledge (This Volume) |
|---|---|---|
| Envelope | `{ code, message, request_id, data }` | `{ code, message, data }` (**No request_id**) |
| Auth | Layered Bearer + service-id + user-key | `x-tdai-service-id` only (internal network trust) |
| Error message | Three formats (enum / 5-digit code / `CODE: detail`) | Lowercase English sentences (branching on HTTP code) |
| Pagination Output | `{ items, total, limit, offset }` | `{ items, total }` (no limit/offset echo) |
| ID Prefix | skill `skl-`, etc. | wiki `wiki-`, code-graph `cg-` |

### 4.2 API Count Correction Summary

| File | Comment Claim | Actual Count | Difference |
|---|---|---|---|
| `wiki.ts` | 15 endpoints | 16 | Extra `update-meta` |
| `code-graph.ts` | 13 endpoints | 14 | Extra `update-meta` |

### 4.3 Idempotency Summary

| Endpoint | Idempotent Behavior |
|---|---|
| `wiki/create` | Same name and team returns existing record (200, not an error) |
| `code-graph/create` | Same repo_url+branch returns existing record (200) |
| `llm-binding/set` | Re-posting overwrites (omitting api_key retains existing value) |
| `wiki/delete`, `code-graph/delete` | Individual failures do not fail entire request; recorded in `failed` array |
