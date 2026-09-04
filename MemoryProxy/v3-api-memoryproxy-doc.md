# v3 API docs · Volume 3 MemoryProxy

> Service: MemoryProxy (LLM reverse proxy + injection proxy), port `8096`
> This volume covers all `/v3/*` endpoints exposed by MemoryProxy (**6 total**, all ops/admin). MemoryCore is in Volume 1, MemoryKnowledge in Volume 2.
> Maintenance convention: an endpoint change must update this document in the same PR.

---

## 1. Common conventions

### 1.1 Service and port

| Item | Value |
|---|---|
| Service | MemoryProxy |
| Port | 8096 |
| This volume's prefix | `/v3` (ops/admin plane only; **the main LLM path is `/v1/messages`, `/:agent/:spaceId/v1/*`, etc., which is outside the scope of the v3 docs**) |
| Health check | `GET /health` (non-v3, returns raw JSON with status/version/upstream/storage etc.) |
| `GET /whoami` | non-v3, API key → key ID (plain text) |

### 1.2 Envelope (**not uniform; two kinds**)

The v3 endpoint envelopes in MemoryProxy come in two kinds, **differing from both Volume 1 MemoryCore and Volume 2 MemoryKnowledge**:

| Endpoint group | Envelope | Description |
|---|---|---|
| `instance/proxy-destroy`, `admin/rate-limits` (3 methods) | `{ code, message, data }` | **no `request_id`** (KS style, same as Volume 2) |
| `session/refresh-cache`, `session/force-archive-skill` | `{ code, message, request_id, data }` | has `request_id`, valued `refresh-${Date.now()}` / `force-archive-${Date.now()}` |

On success, uniformly `code=0, message="ok"`.

### 1.3 Authentication (**only 1 endpoint has auth**)

| Endpoint | Auth |
|---|---|
| `POST /v3/instance/proxy-destroy` | `Authorization: Bearer <admin.apiKey>`; public when `admin.apiKey` is **not configured** (`checkAdminAuth` lets an empty key straight through). Uses `timingSafeEqual` constant-time comparison |
| `admin/rate-limits` (GET/PUT/DELETE) | **no auth** |
| `session/refresh-cache`, `session/force-archive-skill` | **no auth** |

> ⚠️ Implementation and comments diverge: the header comments in `session-refresh.ts` / `session-force-archive.ts` say "goes through admin auth (reusing the admin-auth.ts pattern)", but the handler **does not actually call `checkAdminAuth`**, so it is currently unauthenticated. This document records actual code behavior; frontend/ops that rely on auth must harden it separately.

### 1.4 Error code characteristics (**two groups**)

| Endpoint group | Failure code | HTTP status |
|---|---|---|
| `proxy-destroy`, `rate-limits` | standard 3-digit (400/401/503) | = code |
| `session/*` | **5-digit** (40001/40401/50001) | 3-digit (400/404/500), **code ≠ HTTP** |

> On `session/*` failure, `code` is a 5-digit number and `message` is plain text, but the HTTP status is a standard 3-digit code (`status = error.includes("not found") ? 404 : 400/500`). Frontends should note the decoupling of `code` from HTTP here.

### 1.5 Identity and auth headers

The ops endpoints in this volume **do not validate** `x-tdai-service-id` / `x-tdai-user-key` (unlike the Volume 1 data plane); only `proxy-destroy` accepts Bearer.

---

## 2. Endpoint catalog

| Method | Path | Description |
|---|---|---|
| POST | `/v3/instance/proxy-destroy` | ops: clear the proxy-side instance cache + STS pool (the only one with auth) |
| GET | `/v3/admin/rate-limits` | read rate-limit config (global / per-dimension override) |
| PUT | `/v3/admin/rate-limits` | set rate-limit config (global / per-dimension override) |
| DELETE | `/v3/admin/rate-limits` | delete rate-limit config (restore default / remove override) |
| POST | `/v3/session/refresh-cache` | refresh the session injection cache (re-pull agent/task detail + prewarm) |
| POST | `/v3/session/force-archive-skill` | manually force-archive the session skill buffer |

**6 endpoints total (4 routes, of which rate-limits spans 3 HTTP methods).**

---

## 3. Endpoint details

## 3.1 Instance destroy

### POST /v3/instance/proxy-destroy

Clears the cache data of an instance (spaceId) on the proxy side + the STS backend in the kernel-sts pool. The contract field names align with Core's `/v3/instance/destroy`; the `proxy-destroy` action distinguishes the path.

**Auth**: `Authorization: Bearer <admin.apiKey>` (public if unconfigured).

**Request body**: `{ instance_id: string }` (non-empty + no `/` + no `..`, reusing the `assertKeySegment` validation).

**Response** `data`

| Field | Type | Description |
|---|---|---|
| instance_id | string | echo back |
| cleaned.storage_backend | string | `cos` / `sqlite` / `fs` / `memory` |
| cleaned.storage_ttl_deleted | number | count of `ttl/<id>/`-prefixed keys deleted; defaults to 0 |
| cleaned.storage_nottl_deleted | number | count of `nottl/<id>/`-prefixed keys deleted |
| cleaned.cos_pool_evicted | string | `evicted` / `not-cached` / `unsupported` / `error` |
| cleaned.redis_skipped | string | always `per-session-ttl-only` |

**Partial-failure policy**: a failing step does not abort the whole operation; `cleaned` carries the corresponding `storage_ttl_error` / `storage_nottl_error` / `cos_pool_error` fields (HTTP still 200).

**Errors**: `400` (invalid JSON / missing instance_id / illegal characters), `401` (auth enabled and Bearer missing or mismatched).

> The Redis session store (`cg:sess:*`) is **not cleaned**: sessionKey comes from `x-conversation-id` / `x-claude-code-session-id` and contains no spaceId, so it cannot be SCANned per space; the default TTL of 1800s expires naturally.

**Example**

```json
// Request
POST /v3/instance/proxy-destroy
Authorization: Bearer <admin.apiKey>
{ "instance_id": "mem-example001" }

// Response
{
  "code": 0,
  "message": "ok",
  "data": {
    "instance_id": "mem-example001",
    "cleaned": {
      "storage_backend": "cos",
      "storage_ttl_deleted": 3,
      "storage_nottl_deleted": 5,
      "cos_pool_evicted": "evicted",
      "redis_skipped": "per-session-ttl-only"
    }
  }
}
```

---

## 3.2 Rate-limit config (3 methods, all without auth)

> Rate limiting has two layers: **global** (`config.rateLimit`) and **per-dimension override** (`instance_id + model_id`). Dimension overrides take precedence over global.

### GET /v3/admin/rate-limits

Queries the rate-limit config.

**Query**: `instance_id` + `model_id` (**must appear as a pair**).

**Response** `data`:

- without params (query global): `{ enabled, tpm, qpm, window_seconds: 60, overrides: [...] }`
- with instance_id+model_id (query dimension): `{ enabled, instance_id, model_id, input_tpm, qpm, source: "global"|"override", global }`

**Errors**: `400` (passing only one of instance_id or model_id), `503` (store error).

### PUT /v3/admin/rate-limits

Sets the rate-limit config.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| input_tpm | number | yes | input tokens/minute, a **positive integer** |
| qpm | number | yes | requests/minute, a **positive integer** |
| instance_id | string | no | paired with model_id |
| model_id | string | no | paired with instance_id (≤256, no control characters) |

**Response** `data`: without a dimension it returns `{ tpm, qpm }`; with a dimension it returns `{ instance_id, model_id, input_tpm, qpm }`.

**Errors**: `400` (invalid JSON / non-positive integer / only one of a dimension passed / invalid model_id), `503`.

**Example**

```json
// Request (set global)
PUT /v3/admin/rate-limits
{ "input_tpm": 100000, "qpm": 300 }

// Response
{ "code": 0, "message": "ok", "data": { "tpm": 100000, "qpm": 300 } }
```

### DELETE /v3/admin/rate-limits

Deletes the rate-limit config (restores defaults).

**Request body**: optional `instance_id` + `model_id` (as a pair).

**Response** `data`: without a dimension it returns `{ tpm, qpm }` (falling back to the config defaults); with a dimension it returns `{ instance_id, model_id, deleted: true }`.

**Errors**: `400`, `503`.

---

## 3.3 Session management (2, both without auth)

> Both endpoints are the underlying implementation of the `mem:` command (function calls) and are also exposed over HTTP for the panel frontend to reuse.

### POST /v3/session/refresh-cache

Refreshes all the injection cache for the current session: re-pulls the Agent/Task detail and overwrites the SessionStore → re-runs `prewarmFromConfig` with `clearBefore=true` (clearing stale snapshots of already-unbound assets).

**Request body**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| session_key | string | yes | — | session key |
| agent_source | string | no | `claude-code` | agent source, used to build `compositeKey = ${agentSource}:${sessionKey}` |
| user_key | string | no | — | caller key passed to MetadataClient |
| space_id | string | no | — | fallback spaceId |

**Response** `data`

| Field | Type | Description |
|---|---|---|
| refreshed | string[] | hookIds successfully refreshed |
| skipped | string[] | hookIds skipped |
| agent_refreshed | boolean | whether the agent detail was re-pulled successfully |
| task_refreshed | boolean | whether the task detail was re-pulled successfully |
| took_ms | number | elapsed time |

**Errors**: `40001` (invalid JSON / missing session_key / `Session not initialized` / other argument errors), `40401` (session not found). Failure messages are plain text (`session_key is required`, `Session not initialized: xxx`, `Session not found: xxx`).

**Example**

```json
// Request
POST /v3/session/refresh-cache
{ "session_key": "sess_1", "agent_source": "claude-code", "space_id": "mem-example001" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "refresh-1724112000000",
  "data": {
    "refreshed": ["memory", "knowledge"],
    "skipped": ["skill"],
    "agent_refreshed": true,
    "task_refreshed": false,
    "took_ms": 120
  }
}
```

### POST /v3/session/force-archive-skill

Manually force-archives the current session's skill buffer (bypassing the third trigger condition of the threshold check).

**Request body**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| session_key | string | yes | — | session key |
| agent_source | string | no | `claude-code` | agent source |
| reason | string | no | — | archive reason (passed through to Core) |
| space_id | string | no | — | fallback spaceId |

**Response** `data`

| Field | Type | Description |
|---|---|---|
| status | string | `archived` / `empty` |
| task_id | string? | archive task ID (archived only) |
| archive_key | string? | archive key |
| archived_at_ms | number? | archive time (ms) |

**Errors**: `40001` (invalid JSON / missing session_key), `40401` (session not found), `50001` (calling Core `forceArchive` failed).

**Example**

```json
// Request
POST /v3/session/force-archive-skill
{ "session_key": "sess_1", "reason": "manual" }

// Response
{
  "code": 0,
  "message": "ok",
  "request_id": "force-archive-1724112000000",
  "data": { "status": "archived", "task_id": "skl_1", "archive_key": "archive/xxx", "archived_at_ms": 1724112000000 }
}
```

---

## 4. Appendix

### 4.1 Cross-service differences across the three volumes

| Dimension | MemoryCore (Volume 1) | MemoryKnowledge (Volume 2) | MemoryProxy (this volume) |
|---|---|---|---|
| Port | 8420 | 8421 | 8096 |
| Envelope | `{ code, message, request_id, data }` | `{ code, message, data }` | **mix of both** (see §1.2) |
| Auth | layered Bearer + service-id + user-key | `x-tdai-service-id` only | only proxy-destroy accepts Bearer, the rest have no auth |
| Methods | all POST | all POST except auto-sync status | **includes GET/PUT/DELETE** (rate-limits) |
| Failure codes | three kinds (enum / 5-digit / CODE:detail) | standard 3-digit | proxy-destroy/rate-limits 3-digit; session/* 5-digit |

### 4.2 Known implementation deviations (documented per actual code)

| File | Claimed in comment | Actual implementation |
|---|---|---|
| `session-refresh.ts` | "goes through admin auth" | `checkAdminAuth` not called; no auth |
| `session-force-archive.ts` | same as above (comment not explicit, but same family) | no auth |
| `admin/rate-limits` | — | no auth (hardening recommended if it needs protection) |

### 4.3 Boundary with the main LLM path

This volume only covers the `/v3/*` ops endpoints. MemoryProxy's core is the **LLM reverse proxy** (`/v1/messages`, `/v1/chat/completions`, `/:agent/:spaceId/v1/*`, `/codex·workbuddy·dsh/:spaceId/*`, etc.) and the **bridge** (`/skill-bridge/*`, `/memory-bridge/*`); these are **outside the scope of the v3 endpoint docs** and should be documented separately if needed.
