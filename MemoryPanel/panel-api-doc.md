# MemoryPanel Interface Documentation

> Service: MemoryPanel (Control Panel), port `8125`

---

## 1. Common Conventions

### 1.1 Base URL and Port

| Item | Value |
|---|---|
| Base URL | `/api/v1` (except `/health`) |
| Port | 8125 |
| Method | All **except** `GET /health` and `GET /api/v1/meta/instances` are `POST` (RPC style) |
| Content-Type | `application/json` |

### 1.2 Authentication

The vast majority of business interfaces depend on the following Headers (validated by the middleware `validatePanelMetaHeaders`):

| Header | Required | Description |
|---|---|---|
| `x-tdai-service-id` | Yes | Instance ID, used to locate the target kernel gateway (`instanceRegistry.resolve`) |
| `x-tdai-user-key` | Yes* | Current user key, used for caller identity reverse lookup on the kernel side via `auth/verify` |
| `x-request-id` | No | Propagated to the response envelope `request_id`, used for log correlation |

> `*` Exception: `POST /meta/auth/verify` (no user-key, as it is itself a key verification); `POST /knowledge/status-callback` (S2S callback, no browser headers); `GET /health`, `GET /meta/instances` (no authentication).

### 1.3 Response Envelope

All business interfaces return uniformly:

```json
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { }
}
```

| Field | Type | Description |
|---|---|---|
| code | number | `0` success; non-0 failure |
| message | string | Fixed `"ok"` on success; uppercase underscore error enum on failure (stable contract, frontend branches on this) |
| request_id | string | Request ID, from `x-request-id` or server-generated |
| data | any | Business data; `null` on failure |

> Exception: `GET /health` and `GET /meta/instances` **do not return an envelope**, returning bare JSON directly (see §3.1).

### 1.4 HTTP Status Mapping

The mapping rule for `HTTP status = envelope.code`:

| envelope.code | HTTP status |
|---|---|
| `0` | `200` |
| `400 ~ 599` | same as `code` |
| others | `502` |

### 1.5 Pagination Convention

- The kernel list interface defaults to `DEFAULT_PAGINATION = { limit: 20 }`: **if the frontend directly calls the `meta/*` list action without passing `limit`, only the first 20 items are returned**.
- Panel-layer aggregation/business interfaces (such as `chat-memory/*`, `knowledge/*/team-assets`) have already pulled all data with pagination internally, so no frontend pagination is needed.
- The `limit` upper limit for `task/list-with-agents` is 200; when not passed, the kernel returns the default 20 items, but the response `limit` field echoes 50 (known inconsistency, see §3.5).

### 1.6 Idempotency Convention

- The knowledge-type `create` interface (`wiki/create`, `code-graph/create`) relies on idempotent reuse via same-name/same-resource: duplicate creation returns the existing resource instead of erroring.
- The creation-type `meta/*` actions (`user/create`, `team/create`, `agent/create`, `task/create`) first check for duplicates at the Panel layer, returning a `409` Chinese prompt for duplicate names.

### 1.7 Request ID Tracing

`x-request-id` (optional) → passed into the envelope `request_id` → also carried when forwarding to the kernel, for cross-service log correlation.

---

## 2. Interface Directory

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check (no authentication, bare JSON) |
| GET | `/api/v1/meta/instances` | Instance list (no authentication, bare JSON) |
| POST | `/api/v1/meta/*` | Transparent proxy for metadata (53 actions, see §3.2) |
| POST | `/api/v1/skill/*` | Transparent proxy for Skill data plane (15 actions, see §3.3) |
| POST | `/api/v1/chat-memory/team-assets` | Team memory assets list |
| POST | `/api/v1/chat-memory/agent-fixed` | Fixed assets memory for a specified Agent |
| POST | `/api/v1/chat-memory/my-agents` | My Agent memory (one agent, one block) |
| POST | `/api/v1/chat-memory/mine` | My owner's memory asset list |
| POST | `/api/v1/chat-memory/create` | Create standalone memory asset (mem-xxx) |
| POST | `/api/v1/chat-memory/import` | Import historical conversations into the Agent's L0 |
| POST | `/api/v1/chat-memory/patch-scope` | Change memory visibility (team ↔ private) |
| POST | `/api/v1/chat-memory/set-agent-fixed` | Batch set Agent fixed memory |
| POST | `/api/v1/chat-memory/allocate` | Allocate (borrow) memory to Agent |
| POST | `/api/v1/chat-memory/unbind` | Unbind memory from Agent |
| POST | `/api/v1/chat-memory/layer` | Layered lazy loading for L0/L1/L2/L3 |
| POST | `/api/v1/chat-memory/clear` | One-click clear of memory content (preserve assets) |
| POST | `/api/v1/chat-memory/layer-delete` | Batch delete by layer (L0/L1) |
| POST | `/api/v1/chat-memory/layer-update` | Layer editing (L1/L2/L3) |
| POST | `/api/v1/chat-memory/search` | Hierarchical Keyword Search (L0/L1) |
| POST | `/api/v1/task/list-with-agents` | Task List Aggregation (Including Linked Agents) |
| POST | `/api/v1/agent-overview/bootstrap` | Agent Overview Bootstrap Data Aggregation |
| POST | `/api/v1/agent/delete-cascade` | Delete Agent (Cascade Clean skill Then Archive) |
| POST | `/api/v1/knowledge/wiki/*` | Wiki Knowledge Base Business Routing (14, See §3.8) |
| POST | `/api/v1/knowledge/code-graph/*` | Code-Graph Business Routing (8, See §3.9) |
| POST | `/api/v1/knowledge/allocate` etc. | Knowledge allocation/Authorization (5, see §3.10) |
| POST | `/api/v1/knowledge/status-callback` | KS status callback (S2S) |
| POST | `/api/v1/knowledge/{type}/team-assets` | Team knowledge asset pool (2, see §3.12) |

---

## 3. Interface Details

## 3.1 Health Checks and Instances

### GET /health

Health check. No authentication, no request body, **return bare JSON (non-envelope)**.

Response

```json
{ "status": "ok" }
```

### GET /api/v1/meta/instances

Return the instance list. No authentication, no request body, **return bare JSON (not an envelope)**.

Response

```json
{
  "instances": [
    {
      "instance_id": "inst_1",
      "name": "Test Instance",
      "gateway_endpoint": "https://memory.ap-beijing.tencenttdai.com"
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| instances | object[] | Public instance information list (`instanceRegistry.listPublic()`, **`api_key` is a secret and is not sent**) |
| instances[].instance_id | string | Instance ID |
| instances[].name | string | Instance name |
| instances[].gateway_endpoint | string | Panel → Kernel forwarding address (not a secret, used by the frontend to construct client access addresses) |
| instances[].proxy_endpoint | string? | Optional, client access baseUrl; if not configured, the frontend falls back to `gateway_endpoint` |

---

## 3.2 Metadata Transparent Proxy

### POST /meta/*

Forward `{ action, ...payload }` to the kernel `/v3/meta/{action}`, passing the envelope through as-is. This is Panel's unified entry point for the kernel metadata surface (user/team/agent/task/asset/acl, etc.).

**Auth**: `x-tdai-service-id` + `x-tdai-user-key` (only `auth/verify` is exempt from user-key).

**Forwarding semantics**:
- The entire request body is transparently forwarded to the corresponding action in the kernel; the response envelope is returned as-is.
- The last segment of the path is the action name (e.g., `POST /meta/agent/list` → kernel `agent/list`).
- Actions outside the whitelist return `404 UNKNOWN_META_ACTION`; `agent-fixed-asset/*` returns `501 NOT_IN_SCOPE` (this type of operation is directly invoked internally by the Panel business routing, see §3.4/§3.10).

**Open action list (53 items):**

| Entity | action |
|---|---|
| user | create、create-with-key、get、delete、list |
| user-key | create、list、get、revoke、update |
| team | create、get、update、delete、list |
| team-member | add、remove、list、get |
| agent | create、get、update、delete、list、archive、set-default-template、get-default-template |
| task | create、get、update、delete、list、archive |
| task-agent | link、unlink、list |
| participation-log | append、list |
| asset | create、get、update、delete、list、list-accessible、touch-usage |
| acl | grant、revoke、list、check |
| auth | verify |
| instance-quota | get |
| config/user | get、set |

**Not open (`501 NOT_IN_SCOPE`)**: `agent-fixed-asset/set`, `agent-fixed-asset/list`, `agent-fixed-asset/list-with-detail`, `agent-fixed-asset/summary-by-agents`.

**Special handling for Panel layer (not pure pass-through)**:

| action | action |
|---|---|
| `user/create`, `user/create-with-key`, `team/create`, `agent/create`, `task/create` | First check for duplicates by `name`/`username`/`title`; return `409` with Chinese message if duplicate |
| `agent/set-default-template` | **Not forwarded to kernel**, Panel writes template file locally; requires `system_admin` permission, otherwise `403 permission_denied`; missing `team_id`/`template` returns `400 INVALID_PARAM` |
| `agent/get-default-template` | **Not forwarded to kernel**, Panel reads template file locally |
| `team-member/add` | After success, asynchronously copy template assets to default Agent (best-effort) |
| `user/list` | Hide internal `knowledge-service` billing users |

**Example**（`agent/create`）：

```json
// Request
POST /api/v1/meta/agent/create
{ "team_id": "t_1", "owner_user_id": "u_1", "name": "Release Assistant" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "agent_id": "agt_xxx", "name": "Release Assistant" }
}
```

---

## 3.3 Skill Data Surface Transparent Proxy

### POST /skill/*

Forward `{ action, ...payload }` to the kernel `/v3/skill/{action}`, passing the envelope through as-is.

**Authentication**: `x-tdai-service-id` + `x-tdai-user-key` (mandatory, skill requires owner identity).

**Differences from `/meta/*`**:
- The Skill data plane has independent storage (with `skl-` prefix for `skill_id`): readable within the team, writable by the owner agent.
- Identity fields (`user_id` / `team_id` / `agent_id` / `task_id`) are placed in **body**, not in Header.
- Pagination uses nested `pagination.{limit, offset}`, passed through as-is in body.

**Open action list (15 items):**

| action | description |
|---|---|
| create | create skill |
| update | full update |
| patch | partial update |
| delete | delete |
| get | single query |
| list | paginated list |
| search | Search |
| versions | Version List |
| files/write | Write File |
| files/remove | Remove File |
| files/read | Read File |
| listing | Directory Listing |
| extract | Extract |
| export | Export |
| conversation/add | Conversation Add (main extraction pipeline for skills, newly added to whitelist in 2026-08) |

**Error**: Unknown action returns `404 UNKNOWN_SKILL_ACTION`.

**Example**（`list`）：

```json
// Request
POST /api/v1/skill/list
{
  "user_id": "u_1",
  "team_id": "t_1",
  "filters": { "status": ["active"] },
  "pagination": { "limit": 50, "offset": 0 }
}

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [ { "skill_id": "skl_1", "name": "code-review", "owner_agent_id": "agt_1" } ],
    "total": 1
  }
}
```

---

## 3.4 Chat-Memory

> The unified output structure of the MemoryBlock:

| Field | Type | Description |
|---|---|---|
| id | string | Asset ID (`chat_memory-{team}-{agent}` or self-built `mem-xxx`) |
| title | string | Block title |
| summary | string | Summary (currently placeholder text) |
| uploaded_by_user_id | string | Owner user ID |
| updated_at_ms | number | Update time (ms epoch) |
| layer_counts | object | `{ L0_messages, L1, L2, L3 }` (currently placeholder all 0) |
| scope | string | `team` / `private` |
| agent_id | string | Associated agent (returned by some interfaces) |

### POST /chat-memory/team-assets

The list of shared memory assets for the team (`visibility=team`, not distinguishing owners). **Note: the MemoryBlock returned by this interface does not contain the `scope` field** (team asset tabs are semantically all shared).

Request body

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | Yes | Team ID |

**Response** `data`

| Field | Type | Description |
|---|---|---|
| items | MemoryBlock[] | Team shared memory blocks (excluding `scope`) |
| total | number | Total |

**Example**

```json
// Request
{ "team_id": "t_1" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [ { "id": "chat_memory-t_1-agt_1", "title": "Release Assistant", "summary": "0 L1 · 0 L2 · 0 L3" } ],
    "total": 1
  }
}
```

### POST /chat-memory/agent-fixed

Specify the binding list of fixed assets of type `chat_memory` under the specified Agent. **Only visible to Agent owner**.

Request body

| Field | Type | Required | Description |
|---|---|---|---|
| agent_id | string | Yes | Agent ID |

**Response** `data`: `{ items: MemoryBlock[], total }`, where each contains `scope` (`team`/`private`) for the frontend to gray out entries "set private by owner".

**Error**: `MISSING_AGENT_ID`, `INVALID_USER_KEY`, `AGENT_NOT_FOUND`, `NOT_YOUR_AGENT`.

### POST /chat-memory/my-agents

"My asset allocation" tab: returns all Agents owned by me, where each Agent corresponds to a memory (`block.id = chat_memory-{team}-{agent}`).

**Request body**: `{ team_id: string }`

**Response** `data`: `{ items: MemoryBlock[], total }`, each containing `agent_id`, `scope` (from the agent's own memory visibility).

**Error**: `MISSING_TEAM_ID`, `INVALID_USER_KEY`.

### POST /chat-memory/mine

The list of memory assets under my (owner) name.

**Request body**: `{ team_id: string }`

**Response** `data`: `{ items: MemoryBlock[], total }`.

**Error**: `MISSING_TEAM_ID`, `INVALID_USER_KEY`.

### POST /chat-memory/create

Create an independent memory asset (UserAsset, `mem-xxx`).

Request body

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | Yes | Team ID |
| title | string | Yes | Title, ≤ 200 characters |
| scope | string | No | `team` (default) / `private` |
| description | string | No | Description |

**Response** `data`: `MemoryBlock` (`id` is the newly created `mem-xxx`).

**Error**: `MISSING_TEAM_ID`, `INVALID_TITLE`, `INVALID_USER_KEY`.

**Example**

```json
// Request
{ "team_id": "t_1", "title": "Product Requirement Notes", "scope": "team" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "id": "mem_xxx", "title": "Product Requirements Notes", "scope": "team" }
}
```

### POST /chat-memory/import

Import historical conversation into the Agent memory pool's L0 (via data plane `/v3/conversation/add`, without creating new assets).

Request body

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | Yes | Team ID |
| agent_id | string | Yes | Target Agent |
| messages | object[] | Yes | `[{ role, content, ts? }]`, ≤ 100 items |
| session_id | string | No | Session ID, auto-generated as `imported-{ts}` if missing |

**Response** `data`

| Field | Type | Description |
|---|---|---|
| imported | boolean | fixed to `true` |
| block_id | string | `chat_memory-{team}-{agent}` |
| session_id | string | actual session |
| accepted_count | number | number of successfully written entries |

**Error**: `MISSING_TEAM_ID`, `MISSING_AGENT_ID`, `MISSING_MESSAGES`, `TOO_MANY_MESSAGES`, `NO_VALID_MESSAGES`, `AGENT_NOT_FOUND`, `AGENT_NOT_IN_TEAM`, `NOT_YOUR_AGENT`.

**Example**

```json
// Request
{
  "team_id": "t_1",
  "agent_id": "agt_1",
  "messages": [ { "role": "user", "content": "Help me look at this bug" } ]
}

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "imported": true, "block_id": "chat_memory-t_1-agt_1", "accepted_count": 1 }
}
```

### POST /chat-memory/patch-scope

Modify memory visibility (team ↔ private).

**Request body**: `{ block_id: string, scope: "team" | "private" }`

**Response** `data`: `{ updated: true, id, scope }`.

**Error**: `MISSING_BLOCK_ID`, `INVALID_SCOPE`, `BLOCK_NOT_FOUND`, `NOT_CHAT_MEMORY`.

### POST /chat-memory/set-agent-fixed

Batch-set the Agent's fixed memory (atomic validation + single full set).

Request body

| Field | Type | Required | Description |
|---|---|---|---|
| agent_id | string | Yes | Target Agent |
| team_id | string | Yes | Team ID |
| block_ids | string[] | Yes | Memory block IDs to bind (including `chat_memory-{team}-{agent}`) |

**Response** `data`: `{ updated: true, agent_id, block_ids }`.

**Error**: `MISSING_AGENT_ID`, `MISSING_TEAM_ID`, `IMPORT_LIMIT_EXCEEDED`, `AGENT_NOT_FOUND`, `AGENT_NOT_IN_TEAM`, `NOT_YOUR_AGENT`, `BLOCK_NOT_FOUND`, `NOT_CHAT_MEMORY`, `TEAM_MISMATCH`, `ASSET_NOT_SHARED`.

### POST /chat-memory/allocate

Allocate a block of shared memory (borrow) to the specified Agent. Includes validation of "borrow ≤ 2".

Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| block_id | string | Yes | Memory Block ID |
| agent_id | string | Yes | Target Agent |
| team_id | string | Yes | Team ID |

**Response** `data`: `{ allocated: true, agent_id, block_id }`.

**Error**: `MISSING_BLOCK_ID`, `MISSING_AGENT_ID`, `MISSING_TEAM_ID`, `BLOCK_NOT_FOUND`, `NOT_CHAT_MEMORY`, `TEAM_MISMATCH`, `AGENT_NOT_FOUND`, `AGENT_NOT_IN_TEAM`, `NOT_YOUR_AGENT`, `ASSET_NOT_SHARED`, `IMPORT_LIMIT_EXCEEDED`; returning `409` with a Chinese prompt for duplicate allocation; returning `400` with a Chinese prompt ("`Cannot re-allocate this Agent's own memory to itself`") when an agent's own `chat_memory-{team}-{agent}` is re-allocated to itself.

**Example**

```json
// Request
{ "block_id": "chat_memory-t_1-agt_2", "agent_id": "agt_1", "team_id": "t_1" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "allocated": true, "agent_id": "agt_1", "block_id": "chat_memory-t_1-agt_2" }
}
```

### POST /chat-memory/unbind

Unbind the memory borrowed from the Agent.

**Request body**: `{ block_id: string, agent_id: string, team_id: string }`

**Response** `data`: `{ unbound: true, agent_id, block_id }`.

**Error**: `MISSING_BLOCK_ID`, `MISSING_AGENT_ID`, `MISSING_TEAM_ID`, `CANNOT_UNBIND_SELF_CHAT_MEMORY`, `AGENT_NOT_FOUND`, `AGENT_NOT_IN_TEAM`, `NOT_YOUR_AGENT`, `BLOCK_NOT_FOUND`, `NOT_CHAT_MEMORY`, `BINDING_NOT_FOUND`.

### POST /chat-memory/layer

Layered lazy-loaded memory content. Reverse-engineer team/agent from `block_id` and call kernel data plane.

Request body

| Field | Type | Required | Description |
|---|---|---|---|
| block_id | string | Yes | Memory block ID |
| layer | string | Yes | `L0` / `L1` / `L2` / `L3` |
| limit | number | No | Valid value `(0, 200]`; if not passed, passed a value ≤ 0, or > 200, falls back to 50 (not clamped, different from the clamp semantics of task/search) |
| offset | number | No | Default 0 |
| before_ts | string | No | L0 cursor pagination (ISO8601, pass the time of the last item of the previous page when paging) |
| time_start | string | No | Time filter start (only for L0/L1) |
| time_end | string | No | End of time filter (L0/L1 only) |
| path | string | No | Specify file path when reading a single L2 record |

**Data sources for each layer**: L0 → `/v3/conversation/query`; L1 → `/v3/atomic/query`; L2 → `/v3/scenario/ls` (list) / `/v3/scenario/read` (with `path`); L3 → `/v3/core/read`.

**Response** `data`: `{ layer, items, total, limit, offset }`, each item in `items` has the structure:

| Field | Type | Description |
|---|---|---|
| id | string | Entry ID (L3 fixed `"core"`) |
| title | string | Title (L0 is role@session, L1 is type, L2 is path, L3 fixed `"core memory"`) |
| role | string? | Only present in L0: message role (`user`/`assistant`/`tool`, etc.) |
| body | string | Content |
| tags | string[] | Tags |
| refs | string[] | References (currently always empty) |
| created_at | string | Time (ISO) |

**Read permission**: owner / `visibility=team` / borrowed by an agent under caller; any one suffices; otherwise `403 ASSET_NOT_ACCESSIBLE`.

**Error**: `MISSING_BLOCK_ID`, `INVALID_LAYER`, `BLOCK_NOT_FOUND`, `NOT_CHAT_MEMORY`, `ASSET_NOT_ACCESSIBLE`, `RANGE_TOO_LARGE` (Time filter range too large, VDB cannot support), `LAYER_FETCH_ERROR`.

**Example**（L1）

```json
// Request
{ "block_id": "chat_memory-t_1-agt_1", "layer": "L1", "limit": 20, "offset": 0 }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "layer": "L1",
    "items": [ { "id": "rec_1", "title": "atomic", "body": "release next Monday", "tags": [], "refs": [] } ],
    "total": 1,
    "limit": 20,
    "offset": 0
  }
}
```

### POST /chat-memory/clear

Clear all contents of several memories with one click, while preserving the assets themselves (ownership/bindings/ACL unchanged). **Only the asset Owner**.

**Request body**: `{ memory_ids: string[] }` (deduplicated, ≤ 100 items).

Pass through the kernel `/v3/chat-memory/clear` result.

**Error**: `MISSING_MEMORY_IDS`, `TOO_MANY_MEMORY_IDS`, `BLOCK_NOT_FOUND`, `NOT_CHAT_MEMORY`, `NOT_ASSET_OWNER`, `CLEAR_FAILED`.

### POST /chat-memory/layer-delete

L0/L1 batch delete list. **Asset Owner only**.

Request body

| Field | Type | Required | Description |
|---|---|---|---|
| block_id | string | Yes | Memory block ID |
| layer | string | Yes | `L0` / `L1` |
| message_ids | string[] | Used in L0 | Message ID, ≤ 5000 |
| session_ids | string[] | Used in L0 | Session ID, ≤ 100 |
| ids | string[] | Used in L1 | Record ID, ≤ 5000 |

**Response**: Pass through the kernel `/v3/conversation/delete` or `/v3/atomic/delete` results (including `deleted_count`).

**Error**: `MISSING_BLOCK_ID`, `INVALID_LAYER`, `NOT_AGENT_MEMORY`, `BLOCK_NOT_FOUND`, `NOT_CHAT_MEMORY`, `NOT_ASSET_OWNER`, `TOO_MANY_IDS`, `MISSING_IDS`, `LAYER_DELETE_FAILED`.

### POST /chat-memory/layer-update

Edit single-layer memory content. **Only asset Owner**.

Request body

| Field | Type | Required | Description |
|---|---|---|---|
| block_id | string | Yes | Memory block ID |
| layer | string | Yes | `L1` / `L2` / `L3` |
| id | string | L1/L2 required | L1 primary key / L2 file path |
| content | string | Yes | New content |
| summary | string | No | L2 summary |

**Data sources for each layer**: L1 → `/v3/atomic/update`; L2 → `/v3/scenario/write` (auto-strips META headers); L3 → `/v3/core/write`.

Pass through the kernel's corresponding write interface result.

**Error**: `MISSING_BLOCK_ID`, `INVALID_LAYER`, `MISSING_CONTENT`, `MISSING_ITEM_ID`, `NOT_AGENT_MEMORY`, `BLOCK_NOT_FOUND`, `NOT_CHAT_MEMORY`, `NOT_ASSET_OWNER`, `LAYER_UPDATE_FAILED`.

### POST /chat-memory/search

Hierarchical keyword retrieval (agent dimension cross-session recall).

Request body

| Field | Type | Required | Description |
|---|---|---|---|
| block_id | string | Yes | Memory block ID |
| layer | string | No | `L0` / `L1`, default `L1` |
| query | string | Yes | Search term |
| limit | number | No | Default 30, max 100 |
| type | string | No | L1 type filter |

**Response** `data`: `{ items, total }`, where each `items` entry contains `score` (relevance); L1's `id` can be used directly for `layer-update`.

**Error**: `MISSING_BLOCK_ID`, `MISSING_QUERY`, `BLOCK_NOT_FOUND`, `NOT_CHAT_MEMORY`, `ASSET_NOT_ACCESSIBLE`, `SEARCH_FAILED`.

**Example**

```json
// Request
{ "block_id": "chat_memory-t_1-agt_1", "layer": "L1", "query": "Release" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [ { "id": "rec_1", "title": "atomic", "body": "Release next Monday", "score": 0.92 } ],
    "total": 1
  }
}
```

---

## 3.5 Task

### POST /task/list-with-agents

Aggregate `task/list` + batch `task-agent/list`, returning tasks and their associated agents in one go, eliminating the frontend N+1 (which would otherwise require 2N+1 requests).

**Upstream**: `meta/task/list`、`meta/task-agent/list`。

Request body

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| team_id | string | Yes | — | Team ID |
| limit | number | No | — | Page limit, max 200. **Note**: When `limit` is not passed, the response `limit` field echoes 50, but the kernel `task/list` actually returns 20 items by default |
| offset | number | No | 0 | Offset |
| status | string | No | — | Filter by status |
| title | string | No | — | Title filter |

**Response** `data`

| Field | Type | Description |
|---|---|---|
| items | TaskWithAgents[] | task list, each containing an `agents` subarray |
| total | number | total count |
| limit | number | actual limit for this time |
| offset | number | actual offset for this time |

**TaskWithAgents**: task field (`task_id`, `team_id`, `title`, `description?`, `status`, `source_type?`, `risk_level?`, `created_at`, `updated_at`) + `agents: TaskAgent[]` (`agent_id`, `task_id`, `team_id`, `status`, `created_at`).

**Error**: `MISSING_TEAM_ID`.

**Example**

```json
// Request
{ "team_id": "t_1", "limit": 10 }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [
      { "task_id": "tsk_1", "title": "Gray validation", "status": "active", "agents": [ { "agent_id": "agt_1" } ] }
    ],
    "total": 1,
    "limit": 10,
    "offset": 0
  }
}
```

---

## 3.6 Agent Overview

### POST /agent-overview/bootstrap

Aggregate all asset guidance data required for the Agent overview page (skill / code-graph / wiki / chat-memory asset pool + each agent's mount count).

**Upstream**: `meta/asset/list-accessible` (4 asset types), `meta/agent/list`, `skill/list`, `meta/agent-fixed-asset/summary-by-agents`.

Request body

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | Yes | Team ID |
| agent_ids | string[] | No | The agents to be included in the statistics; defaults to all active agents under the team |

**Response** `data`

| Field | Type | Description |
|---|---|---|
| assets.skills | Mountable[] | Team shared skill assets |
| assets.codeGraphs | Mountable[] | Team code-graph assets |
| assets.wikis | Mountable[] | Team wiki assets |
| assets.chatMemories | Mountable[] | Team shared memory assets |
| counts | object | `{ [agent_id]: { skills, code_graph, llm_wiki, chat_memory } }` (mount counts) |

> `Mountable`: `{ key, title, group, slug, status }`. `counts` is marked as `@deprecated`, and internally it has been switched to `summary-by-agents`.

**Error**: `MISSING_TEAM_ID`, `INVALID_USER_KEY`, `NOT_TEAM_MEMBER`.

**Example**

```json
// Request
{ "team_id": "t_1" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "assets": { "skills": [], "codeGraphs": [], "wikis": [], "chatMemories": [] },
    "counts": { "agt_1": { "skills": 2, "code_graph": 1, "llm_wiki": 0, "chat_memory": 1 } }
  }
}
```

---

## 3.7 Agent Lifecycle

### POST /agent/delete-cascade

Remove Agent: first cascade-delete all active skills under it, then call the kernel `agent/archive` (archive will also clean chat_memory).

**Upstream**: `skill/list`、`skill/delete`、`meta/agent/archive`。

`{ agent_id: string }`

**Response** `data`

| Field | Type | Description |
|---|---|---|
| archived | boolean | fixed `true` |
| agent_id | string | archived agent |
| deleted_skill_count | number | number of deleted skills |
| deleted_skill_ids | string[] | list of deleted skill IDs |

**Error**: `MISSING_AGENT_ID`, `INVALID_USER_KEY`, `AGENT_NOT_FOUND`, `NOT_YOUR_AGENT`; if any skill deletion fails, return `500 SKILL_DELETE_FAILED` (including `failed_skill_id`, `deleted_skill_ids`); in this case, the agent will not be archived.

**Example**

```json
// Request
{ "agent_id": "agt_1" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "archived": true, "agent_id": "agt_1", "deleted_skill_count": 2, "deleted_skill_ids": ["skl_1", "skl_2"] }
}
```

---

## 3.8 Knowledge - Wiki

> Gate convention: endpoints with `team_id` (list/create/raw/write) require team members; id-only endpoints (get/ingest/delete/graph/page/search/raw/ls, etc.) require a valid caller + read/write permissions (`requireKnowledgeRead`).
> Unified passthrough of KS (Knowledge Service) `/v3/wiki/*`, with the envelope assembled by Panel.

### POST /knowledge/wiki/list

**@deprecated** (Panel UI has been switched to `team-assets`/`my-assets`).

`{ team_id: string, status?: string, limit?: number, offset?: number }`

**Error**: `MISSING_TEAM_ID`, `INVALID_USER_KEY`, `NOT_TEAM_MEMBER`.

### POST /knowledge/wiki/create

Create a Wiki knowledge base, and idempotently register meta_asset (`asset_id = wiki_id`).

**Request body**: `{ team_id: string, name: string }`

**Response** `data`: KS wiki details (including `wiki_id`, `service_url`, etc.).

**Error**: `MISSING_TEAM_ID`, `MISSING_NAME`, `INVALID_USER_KEY`, `NOT_TEAM_MEMBER`.

**Example**

```json
// Request
{ "team_id": "t_1", "name": "Team wiki" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "wiki_id": "wiki_1", "name": "Team wiki", "status": "processing" }
}
```

### POST /knowledge/wiki/ingest

Trigger Wiki extraction (requires write permission, reject empty wiki).

Request body: `{ wiki_id: string }`

**Error**: `MISSING_WIKI_ID`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`, `WIKI_EMPTY_NO_SOURCES`.

### POST /knowledge/wiki/get

Query Wiki details (aggregate Panel memory ingest progress into the `progress` field).

Request body: `{ wiki_id: string }`

**Response** `data`: KS wiki details + `progress` (ingest progress).

**Error**: `MISSING_WIKI_ID`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`.

### POST /knowledge/wiki/delete

Remove Wiki (three places: KS + kernel details + meta_asset cascade).

**Request body**: `{ wiki_ids: string[] }`

**Response** `data`: KS delete result.

**Error**: `MISSING_WIKI_ID`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`.

### POST /knowledge/wiki/graph

Query the Wiki knowledge graph.

`{ wiki_id: string }`

**Error**: `MISSING_WIKI_ID`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`.

### POST /knowledge/wiki/page/ls

List Wiki pages.

Request body: `{ wiki_id: string }`

**Error**: `MISSING_WIKI_ID`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`.

### POST /knowledge/wiki/page/read

Read the specified page.

**Request body**: `{ wiki_id: string, refs: string[] }`

**Error**: `MISSING_WIKI_ID`, `MISSING_REFS`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`.

**Example**

```json
// Request
{ "wiki_id": "wiki_1", "refs": ["page/Home"] }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "pages": [ { "ref": "page/Home", "content": "..." } ] }
}
```

### POST /knowledge/wiki/page/rm

Delete page (requires write permission).

**Request body**: `{ wiki_id: string, refs: string[] }`

**Error**: `MISSING_WIKI_ID`, `MISSING_REFS`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`, `MISSING_TEAM_ID`.

### POST /knowledge/wiki/search

Search Wiki.

**Request body**: `{ wiki_id: string, query: string, limit?: number }`

**Error**: `MISSING_WIKI_ID`, `MISSING_QUERY`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`.

### POST /knowledge/wiki/raw/ls

Lists the raw source files.

Request body: `{ wiki_id: string }`

**Error**: `MISSING_WIKI_ID`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`.

### POST /knowledge/wiki/raw/read

Read the original source file content.

**Request body**: `{ wiki_id: string, filenames: string[] }`

**Error**: `MISSING_WIKI_ID`, `MISSING_FILENAMES`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`.

### POST /knowledge/wiki/raw/rm

Delete the original source file (requires write permission).

**Request body**: `{ wiki_id: string, filenames: string[] }`

**Error**: `MISSING_WIKI_ID`, `MISSING_FILENAMES`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`, `MISSING_TEAM_ID`.

### POST /knowledge/wiki/raw/write

Upload source file (team gating + size limit).

Request Body

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | Yes | Team ID |
| wiki_id | string | Yes | Wiki ID |
| files | object[] | Yes | `[{ path, content, ... }]`, single file ≤ 512KB, single batch ≤ 10, total ≤ 5MB |

**Error**: `MISSING_TEAM_ID`, `MISSING_WIKI_ID`, `MISSING_FILES`, `TOO_MANY_FILES`, `FILE_TOO_LARGE`, `TOTAL_TOO_LARGE`, `INVALID_USER_KEY`, `NOT_TEAM_MEMBER`.

---

## 3.9 Knowledge - Code-Graph

### POST /knowledge/code-graph/list

**@deprecated** (Panel UI has been switched to `team-assets`/`my-assets`).

`{ team_id: string, status?: string, limit?: number, offset?: number }`

**Error**: `MISSING_TEAM_ID`, `INVALID_USER_KEY`, `NOT_TEAM_MEMBER`.

### POST /knowledge/code-graph/create

Create Code-Graph (automatically built after KS is created, and registered in meta when ready callback is triggered).

Request body

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | Yes | Team ID |
| repo_url | string | Yes | Repository URL |
| branch | string | No | Branch |
| repo_name | string | No | Repository Name |

**Response** `data`: KS code-graph details (including `code_graph_id`).

**Error**: `MISSING_TEAM_ID`, `MISSING_REPO_URL`, `INVALID_USER_KEY`, `NOT_TEAM_MEMBER`.

**Example**

```json
// Request
{ "team_id": "t_1", "repo_url": "https://github.com/org/repo", "branch": "main" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "code_graph_id": "cg_1", "repo_url": "https://github.com/org/repo", "status": "building" }
}
```

### POST /knowledge/code-graph/register-meta

After Code-Graph is ready, the owner registers meta_asset (frontend fallback path, idempotent).

**Request body**: `{ team_id: string, code_graph_id: string }`

**Response** `data`: `{ registered: true, code_graph_id }`.

**Error**: `MISSING_TEAM_ID`, `MISSING_CODE_GRAPH_ID`, `INVALID_USER_KEY`, `NOT_TEAM_MEMBER`, `FORBIDDEN`, `KNOWLEDGE_NOT_FOUND`, `CODE_GRAPH_NOT_READY`, `NOT_RESOURCE_OWNER`.

### POST /knowledge/code-graph/get

Query Code-Graph details (owner readable when no meta in build).

**Request body**: `{ code_graph_id: string }`

**Error**: `MISSING_CODE_GRAPH_ID`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`.

### POST /knowledge/code-graph/sync

Trigger Code-Graph sync (requires write permission).

**Request body**: `{ code_graph_id: string }`

**Error**: `MISSING_CODE_GRAPH_ID`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`.

### POST /knowledge/code-graph/delete

Remove Code-Graph (three cascades).

**Request body**: `{ code_graph_ids: string[] }`

**Error**: `MISSING_CODE_GRAPH_ID`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`.

### POST /knowledge/code-graph/search

Code-Graph code retrieval.

**Request body**: `{ code_graph_id: string, query: string, kind?: string, limit?: number }`

**Response** `data`: The `{ text, isError }` text block returned by KS.

**Error**: `MISSING_CODE_GRAPH_ID`, `MISSING_QUERY`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`.

**Example**

```json
// Request
{ "code_graph_id": "cg_1", "query": "User login logic" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "text": "...", "isError": false }
}
```

### POST /knowledge/code-graph/explore

Code-Graph code exploration.

**Request body**: `{ code_graph_id: string, query: string, maxFiles?: number }`

**Response** `data`: The `{ text, isError }` text block returned by KS.

**Error**: `MISSING_CODE_GRAPH_ID`, `MISSING_QUERY`, `INVALID_USER_KEY`, `FORBIDDEN`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`.

---

## 3.10 Knowledge - Allocation and Authorization

### POST /knowledge/allocate

Bind the knowledge asset to the Agent (`injection_mode = 'tool'`).

Request body

| Field | Type | Required | Description |
|---|---|---|---|
| knowledge_id | string | Yes | Asset ID (wiki_id / cg_id) |
| agent_id | string | Yes | Target Agent |
| team_id | string | Yes | Team ID |

**Response** `data`: `{ allocated: true, agent_id, knowledge_id }`.

`MISSING_KNOWLEDGE_ID`, `MISSING_AGENT_ID`, `MISSING_TEAM_ID`, `INVALID_USER_KEY`, `NOT_TEAM_MEMBER`, `KNOWLEDGE_NOT_FOUND`, `NOT_KNOWLEDGE_ASSET`, `TEAM_MISMATCH`, `AGENT_NOT_FOUND`, `AGENT_NOT_IN_TEAM`, `ALREADY_ALLOCATED`

**Example**

```json
// Request
{ "knowledge_id": "wiki_1", "agent_id": "agt_1", "team_id": "t_1" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "allocated": true, "agent_id": "agt_1", "knowledge_id": "wiki_1" }
}
```

### POST /knowledge/unbind

Unbind the knowledge asset from the Agent (only the agent owner).

**Request body**: `{ knowledge_id: string, agent_id: string }`

**Response** `data`: `{ unbound: true, agent_id, knowledge_id }`.

**Error**: `MISSING_KNOWLEDGE_ID`, `MISSING_AGENT_ID`, `INVALID_USER_KEY`, `AGENT_NOT_FOUND`, `NOT_YOUR_AGENT`, `BINDING_NOT_FOUND`.

### POST /knowledge/agent-fixed

List the Agent-bound wiki/code_graph fixed assets.

Request body: `{ agent_id: string }`

**Response** `data`: `{ items: FixedAsset[], total }`, each containing `knowledge_id`, `asset_type`, `name`, `description`, `status`, `visibility`, `agent_id`.

**Error**: `MISSING_AGENT_ID`, `INVALID_USER_KEY`, `AGENT_NOT_FOUND`, `NOT_TEAM_MEMBER`.

### POST /knowledge/set-visibility

Set asset visibility (via `meta/asset/update`, owner-only is guaranteed by the kernel).

**Request body**: `{ knowledge_id: string, visibility: string }`（`private`/`team`/`restricted`/`agent`/`task`）

**Error**: `MISSING_KNOWLEDGE_ID`, `INVALID_VISIBILITY`.

### POST /knowledge/grant

Grant asset authorization (via `meta/acl/grant`, owner-only is guaranteed by the kernel).

**Request body**: `{ knowledge_id: string, subject_type: string, subject_id: string, permission: string }`

**Error**: `MISSING_KNOWLEDGE_ID`, `MISSING_GRANT_FIELDS`.

---

## 3.11 Knowledge - State Callback

### POST /knowledge/status-callback

KS → Panel's S2S status callback (ingest/sync complete or progress update). **No authentication** (S2S, no browser header).

Request body (two forms):

Terminal callback (`status = ready | failed`):

| Field | Type | Required | Description |
|---|---|---|---|
| knowledge_id | string | Yes | Resource ID |
| type | string | Yes | `wiki` / `code-graph` |
| status | string | Yes | `ready` / `failed` |
| summary | string | No | Summary carried when ready |
| service_id | string | No | Instance ID (used to resolve kernel credentials) |
| sync_error | string | No | Error when failed |
| run_id | string | No | Ingest Generation |

② Progress callback (`event = ingest_progress`):

| Field | Type | Required | Description |
|---|---|---|---|
| event | string | Yes | `ingest_progress` |
| wiki_id | string | Yes | Wiki ID |
| progress | object | Yes | `{ phase, total, completed, failed, skipped, percent }` |

**Response** `data`: `null` (`code=0` fixed ack).

When `ready`, the Panel writes the kernel details `entity_knowledge` (`/v3/knowledge/create`) and registers `meta_asset`; when `failed`, it does not.

**Example**

```json
// Request (terminal state ready)
{
  "knowledge_id": "wiki_1",
  "type": "wiki",
  "status": "ready",
  "summary": "Team wiki summary"
  "service_id": "inst_1"
}

// Response
{ "code": 0, "message": "ok", "request_id": "", "data": null }
```

---

## 3.12 Knowledge - Team Assets

### POST /knowledge/wiki/team-assets

Team Wiki asset pool (meta `list-accessible` + KS get to supplement operational status, and merge "in creation/failed" resources from unregistered metas on the KS side).

**Request body**: `{ team_id: string }`

**Response** `data`: `{ items: KnowledgeAssetListItem[], total }`.

**Error**: `MISSING_TEAM_ID`, `INVALID_USER_KEY`, `NOT_TEAM_MEMBER`.

**Example**

```json
// Request
{ "team_id": "t_1" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [ { "knowledge_id": "wiki_1", "asset_type": "llm_wiki", "name": "Team wiki", "status": "ready" } ]
    "total": 1
  }
}
```

### POST /knowledge/code-graph/team-assets

Team Code-Graph asset pool (structure same as `wiki/team-assets`, `asset_type = code_graph`).

`{ team_id: string }`

**Response** `data`: `{ items, total }`.

**Error**: `MISSING_TEAM_ID`, `INVALID_USER_KEY`, `NOT_TEAM_MEMBER`.

---

## 4. Appendix

### 4.1 Deprecated Interfaces

| Interface | Status | Replacement |
|---|---|---|
| `POST /knowledge/wiki/list` | @deprecated | `POST /knowledge/wiki/team-assets` |
| `POST /knowledge/code-graph/list` | @deprecated | `POST /knowledge/code-graph/team-assets` |
| `POST /agent-overview/bootstrap` `counts` field | @deprecated | internally uses `agent-fixed-asset/summary-by-agents` |

### 4.2 Summary of Error message Enumerations

`message` is a stable contract, and the frontend branches based on it; new error codes must be synchronized with this table.
>
> Note the three `message` format exceptions (all Panel assembly, not pure enums):
> 1. **Data plane failure types** (`LAYER_FETCH_ERROR` / `CLEAR_FAILED` / `LAYER_DELETE_FAILED` / `LAYER_UPDATE_FAILED` / `SEARCH_FAILED`): actual value is `"<CODE>: <err.message>"` (with `: detail` suffix), frontend should `startsWith(CODE)` instead of exact equality matching.
> 2. **400 for `POST /knowledge/status-callback`**: `message` is a lowercase English sentence (`"wiki_id and progress fields are required"` / `"knowledge_id, type, status are required"`), not an enum. This interface is an S2S callback, not directly consumed by the frontend, so it can be ignored.
> 3. **Free-form sentence messages** (plain English sentences assembled directly by `respondControlError`, not enums; `startsWith(CODE)` cannot match either): 409 for `meta/*` duplicate-create check ("an item with the same name already exists…please rename and retry"), 409 for `chat-memory/allocate` duplicate allocation ("this memory has already been assigned to the agent"), 400 for self-allocation ("cannot reassign this agent's own memory to itself"). The frontend must fall back on the message text or HTTP status; it cannot branch on the CODE enum.

**General (Header / Authentication / Framework)**

| HTTP | message | Description |
|---|---|---|
| 400 | MISSING_INSTANCE_ID | Missing `x-tdai-service-id` |
| 400 | INVALID_INSTANCE | Instance does not exist/invalid |
| 400 | MISSING_USER_KEY | Missing `x-tdai-user-key` |
| 401 | INVALID_USER_KEY | user_key is invalid (auth/verify failed) |
| 403 | NOT_TEAM_MEMBER | Not a team member |
| 403 | FORBIDDEN | No access permission to the resource |
| 404 | KNOWLEDGE_NOT_FOUND | Knowledge resource does not exist |
| 500 | INTERNAL | Uncaught exception |
| 502 | UPSTREAM_ERROR | Upstream KS error |

**Meta / Skill Agent**

| HTTP | message | Description |
|---|---|---|
| 404 | UNKNOWN_META_ACTION | Unknown meta action |
| 404 | UNKNOWN_SKILL_ACTION | Unknown skill action |
| 501 | NOT_IN_SCOPE | action not open for panel (agent-fixed-asset/*) |
| 403 | permission_denied | non system_admin operation default template |
| 400 | INVALID_PARAM | `agent/set-default-template` missing `team_id`/`template` |

**Chat-Memory**

| HTTP | message | description |
|---|---|---|
| 400 | MISSING_TEAM_ID / MISSING_AGENT_ID / MISSING_BLOCK_ID / MISSING_QUERY | Missing required fields |
| 400 | INVALID_TITLE / INVALID_SCOPE / INVALID_LAYER | Invalid parameters |
| 400 | MISSING_MESSAGES / TOO_MANY_MESSAGES / NO_VALID_MESSAGES | Invalid import messages |
| 400 | MISSING_MEMORY_IDS / TOO_MANY_MEMORY_IDS | clear parameter invalid |
| 400 | MISSING_IDS / TOO_MANY_IDS | Batch delete parameter invalid |
| 400 | MISSING_CONTENT / MISSING_ITEM_ID | layer-update parameter invalid |
| 400 | NOT_CHAT_MEMORY / NOT_AGENT_MEMORY / TEAM_MISMATCH / AGENT_NOT_IN_TEAM | Resource type / ownership mismatch |
| 400 | CANNOT_UNBIND_SELF_CHAT_MEMORY / IMPORT_LIMIT_EXCEEDED | Business rule interception |
| 400 | RANGE_TOO_LARGE | Time filter range too large (VDB cannot support) |
| 403 | NOT_YOUR_AGENT / NOT_ASSET_OWNER / ASSET_NOT_SHARED / ASSET_NOT_ACCESSIBLE | Permission denied |
| 404 | BLOCK_NOT_FOUND / AGENT_NOT_FOUND / BINDING_NOT_FOUND | Resource does not exist |
| 500 | LAYER_FETCH_ERROR / CLEAR_FAILED / LAYER_DELETE_FAILED / LAYER_UPDATE_FAILED / SEARCH_FAILED | Data plane exception |

**Knowledge**

| HTTP | message | Description |
|---|---|---|
| 400 | MISSING_NAME / MISSING_WIKI_ID / MISSING_REFS / MISSING_FILENAMES / MISSING_FILES | Missing required fields |
| 400 | MISSING_CODE_GRAPH_ID / MISSING_REPO_URL / MISSING_QUERY | Missing required fields |
| 400 | MISSING_KNOWLEDGE_ID / MISSING_AGENT_ID / MISSING_GRANT_FIELDS | Missing required fields |
| 400 | NOT_KNOWLEDGE_ASSET / TEAM_MISMATCH / AGENT_NOT_IN_TEAM / INVALID_VISIBILITY | Invalid resource type / ownership |
| 400 | WIKI_EMPTY_NO_SOURCES | Ingesting empty wiki is prohibited |
| 403 | NOT_RESOURCE_OWNER / NOT_YOUR_AGENT | Permission denied |
| 409 | ALREADY_ALLOCATED / CODE_GRAPH_NOT_READY | Status Conflict |
| 404 | AGENT_NOT_FOUND / BINDING_NOT_FOUND | Resource Does Not Exist |
| 413 | TOO_MANY_FILES / FILE_TOO_LARGE / TOTAL_TOO_LARGE | Upload Limit Exceeded |

**Agent / Task**

| HTTP | message | Description |
|---|---|---|
| 400 | MISSING_AGENT_ID / MISSING_TEAM_ID | Missing required field |
| 403 | NOT_YOUR_AGENT | Not agent owner |
| 404 | AGENT_NOT_FOUND | Agent does not exist |
| 500 | SKILL_DELETE_FAILED | Failed to cascade delete skill |
