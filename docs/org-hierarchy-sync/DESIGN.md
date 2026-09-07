# Org Hierarchy Sync — groupy → Agent Memory

**Status:** Design (approved by interview, not yet implemented)
**Branch:** `feat/org-hirarchy-sync`
**Scope modules:** MemoryCore (kernel) · MemoryKnowledge (KS) · MemoryPanel
**Acceptance:** decided in interview rounds; gaps marked ☐ (need company-net facts)

---

## 1. Background & goals

The org has a **matrix structure**: every team belongs to a product line *and* a profession branch
(group). HR data lives in **groupy**, an HR system exposing a simple API: send a group name → get its
members, each of which is either a **person** (username) or an **org node** (sub-group). The hierarchy
is therefore a **graph (DAG), not a tree**: a person sits in one leaf team but is conceptually "inside"
several chains (leaf team, branch chain, product-line chain).

Org changes are fast: people move teams every 2–3 years; teams split and groups form constantly.
Nodes themselves are stable (ids persist 3–7 years). Every node and every user has a stable unique id
(e.g. `123yonik`, `123teamA`, `123group`, `120data_branch`, `product_x`).

**Goals**

1. Groupy structure + membership changes reflected in agent-memory team management **within a day**.
2. Users can **share wikis, skills, code graphs and chat-memory assets to any groupy node** — access
   follows the matrix: a person sees a shared asset if any node on their ancestry is a share target
   (union reachability).
3. Sharing to an existing node takes effect **instantly (seconds)** — it must not wait for the nightly sync.
4. Groupy is the **single authority** for mirrored team structure and membership; deletions never destroy
   user records or content.

**Non-goals (v1)**

- No bidirectional sync (memory → groupy).
- No real-time push from groupy (webhooks are future work; polling cadence is fine, ≤ 24 h).
- No UI share dialog in v1 (API-first; UI phase 2).
- No i18n/RTL handling now — store `displayName` (often RTL), do not render/use it yet.
- No change to chat-memory pipeline semantics beyond grant mechanics.

## 2. Current-system facts (verified in code)

| Area | Today |
|---|---|
| Teams | Flat entity in kernel metadata: `/v3/meta/team/{create,get,update,delete,list}`; team = `id/name/description/owner_user_id`. No nesting. |
| Membership | `team-member` rows: `(team_id, user_id, role, status, joined_at)`; `status∈{active,…}`. |
| Users | `user/*` endpoints; identity by `user_key` (login) and `user_id`; lookups by `username`. |
| Agents | `AgentEntity`: `agent_id, team_id, owner_user_id, visibility, …` — an agent belongs to **one** team and is owned by a user. |
| Assets | Meta assets (`asset/*`): `asset_id, team_id, asset_type (skill|wiki|code-graph|chat_memory), owner_user_id, visibility ∈ {private, team, restricted, agent, task}`. A skill is a team-scoped asset (see `utils/env-config.ts`). |
| ACL | `acl/*` rows: `subject_type ∈ {user, team_role, agent}`, `effect`, `permission`. `restricted` visibility = explicit ACL only (owner + team admins bypass). See `metadata/service/permission-checker.ts`. |
| KS scoping | Wikis/code graphs keyed `(service_id, team_id, name)`; listing strictly filters `team_id` (`listWikis(serviceId, teamId)` in `store/sqlite-store.ts`); no cross-team visibility logic; get-by-id scoped by `service_id` only. |
| Panel | Hono backend; talks to kernel via `metaKernel.invoke`; to KS via `http-knowledge-client`; **no durable store** (`knowledge-task-registry` is in-memory, documented corner).
| Kernel optional deps | Precedent: ClickHouse/Redis/etc. are optional, env-gated backends — groupy sync follows this pattern. |

## 3. Architecture overview

```
       groupy (HR, corpnet)
              │  GET node → {id, name, displayName, members[]}  (member = {id, kind: user|org})
              │
              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ MemoryCore kernel — optional env-gated module "org-sync"                  │
│  ├─ groupy-client (abstract adapter; mock JSON fixture for dev)           │
│  ├─ sync-service: fetch → closure → diff → apply (teams/members/users)     │
│  ├─ snapshot & mapping store (groupy_node, groupy_edge, groupy_user_map)   │
│  └─ grant expansion: restricted-ACL recompute (users + their agents)       │
│  routes: /v3/meta/groupy/{sync,status,tree,summary}                        │
└────────────────────────────────────────────────────────────────────────────┘
              │ sync summary / tree / restricted assets
              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ MemoryPanel — control plane                                               │
│  ├─ POST /api/v1/groupy/sync (admin "Sync now") → kernel                  │
│  ├─ POST /api/v1/asset/grant {asset_id, node_id, action} → instant path   │
│  ├─ KS grant mirror (wiki/code-graph) via http-knowledge-client           │
│  └─ status/orphan warnings (archive → revoked grants list)                 │
└────────────────────────────────────────────────────────────────────────────┘
              │ grant rows
              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ MemoryKnowledge (KS) — new grant tables + list filter union               │
│  knowledge_wiki_grant(wiki_id, team_id), knowledge_code_graph_grant(…)     │
│  list/tools query: owner team OR grant_team == requester team              │
└────────────────────────────────────────────────────────────────────────────┘
```

**Principle:** runtime read paths never traverse the org graph. Access is precomputed into two artifacts
that existing readers already understand:

1. **Membership closure** → kernel `team-member` rows (person × every ancestor node).
2. **Grant expansion** → kernel ACL rows (per user + their agents) + KS grant rows (per team).

Nightly sync = full recomputation of both; instant share = partial recomputation for one asset.

## 4. Data model changes

### 4.1 Kernel (MemoryCore metadata store)

New entities (added to `metadata/types.ts` + both store adapters + contract):

```ts
GroupyNode      { id: string; name: string; display_name: string; kind: 'user' | 'org' }
GroupyEdge      { parent_id: string; child_id: string; child_kind: 'user' | 'org' }  // graph, not tree
GroupyRun       { id: string; started_at: string; finished_at?: string; status: 'ok' | 'failed';
                  nodes_seen: number; members_seen: number; error?: string;
                  last_good_snapshot_json: string }   // raw JSON for audit + last-good recovery
GroupyUserMap   { groupy_id: string; username: string; memory_user_id?: string }  // reconcile-by-username
```

Materializations (existing tables reused):

- **Team per org node**: `team_id = groupy node id verbatim` (e.g. `120data_branch`, `123teamA`).
  `team.name = displayName` (source of truth for future UI), `description` stamped `managed by groupy`.
  Guard: team-create endpoint rejects ids matching an active groupy node (no squatting).
- **Membership**: `team-member` row for every (person, ancestor-node) pair in the closure; role `member`,
  status `active`; removed people get status `removed` (kept for audit, filtered from "active member" views).
- **Users**: auto-created if `username` unknown, flagged `source: groupy`; reconciled with SSO login by username.
- **display_name**: stored in `groupy_node`, **not rendered anywhere yet**.

### 4.2 KS (MemoryKnowledge)

New tables (drizzle migration, registers with existing DDL in `db/client.ts`):

```sql
knowledge_wiki_grant      (wiki_id TEXT NOT NULL, team_id TEXT NOT NULL,
                           grant_type TEXT NOT NULL DEFAULT 'viewer',  -- owner | editor | viewer
                           PRIMARY KEY(wiki_id, team_id))
knowledge_code_graph_grant(knowledge_id TEXT NOT NULL, team_id TEXT NOT NULL,
                           grant_type TEXT NOT NULL DEFAULT 'viewer',  -- owner | editor | viewer
                           PRIMARY KEY(knowledge_id, team_id))
```


**Grant-type semantics** (enforced at KS routes; owning team of the asset is implicit `owner` and outranks explicit grants):

| grant_type | wiki / code-graph capability |
|---|---|
| `viewer` | list + retrieve (search / tools) only |
| `editor` | viewer + trigger ingest/update/replace (async builds), edit metadata |
| `owner`  | editor + delete asset, rename/re-home, change grants (incl. grant_type) |

Default for new grants: `viewer`. `grants/set` accepts `grant_type`; `grants/clear` removes rows.
Kernel-side parallel for skills/chat-memory already exists as ACL `permission` values (read = viewer, write = editor, manage = owner) — no kernel schema change; Panel mirror maps kernel ACL permission → KS `grant_type` so both planes stay consistent.

Listing semantics change: wiki/code-graph visible to team T if `owner.team_id = T` **or** `EXISTS grant(row, T)`.
Get-by-id keeps existing service-scoped behavior (audit in implant phase).

### 4.3 Env (kernel container)

```sh
GROUPY_ENABLED=false
GROUPY_BASE_URL=            # set inside corporate net
GROUPY_TOKEN=
GROUPY_ROOTS=               # comma-separated root node ids, e.g. product_x,120data_branch
GROUPY_CRON=0 2 * * *       # nightly 02:00
GROUPY_MOCK_FILE=           # JSON fixture for dev/testing outside corpnet; when set, adapter = mock
```

## 5. Sync pipeline (nightly + on-boot + manual)

1. **Fetch** — walk from `GROUPY_ROOTS` recursively via `fetchNode(id)`; dedupe by id; guard cycles.
   Each node yields `{id, name, displayName, members[{id, kind: user|org}]}`.
2. **Closure** — for every person, compute the full ancestor set (union over all parent chains). A person
   ends up in ~4–7 teams. Branch heads are persons too and are members of their branch node team.
3. **Diff vs last snapshot** (idempotent, re-runnable):
   - nodes new → create team (+ edge rows); nodes gone → **archive** team (do NOT delete: content lives on),
     members cleared to `removed`; id re-used (rename = delete+create) → archive old, create new.
   - membership changes → add rows / flip status; users unknown → auto-create.
   - team desc stamp + display_name snapshot always refreshed.
4. **Grant recompute** — for every asset with `visibility=restricted` whose ACL carries groupy-derived rows:
   rewrite ACL to owner ∪ home-team members ∪ closure(granted nodes), **users and their agents** both.
   Grants whose node was archived are revoked and recorded in the sync summary.
5. **Persist run** — `groupy_run` with status + last-good snapshot JSON. On failure: 3 retries 30 min apart,
   then give up, keep last-good, admin alert (Panel status page / log error).
6. **Notify** — sync summary exposed via `/v3/meta/groupy/summary`; Panel reads it (on its own schedule)
   to recompute the KS grant mirror (see §6).

## 6. Sharing an asset to a node (instant path)

Trigger: `POST /api/v1/asset/grant {asset_id, node_id, action: 'grant'|'revoke'}`
Caller must be asset owner, asset home-team admin, or platform admin.

1. **Kernel**: load node graph snapshot (current); compute subtree teams of `node_id` from groupy edges;
   expand members = closure(node) users + their agents; call existing asset/acl endpoint to set
   `visibility=restricted` and rewrite ACL rows (owner, home-team members, expanded users+agents).
   Home-team members are always included — flipping to restricted never blinds the home team.
2. **KS mirror (wiki/code-graph only)**: Panel upserts/removes grant rows for every **subtree team** of the
   node (`knowledge_wiki_grant` / `knowledge_code_graph_grant`) via `http-knowledge-client`, carrying `grant_type` (default `viewer`, mapped from kernel ACL permission where present).
3. All of this happens **synchronously in the request** — a few seconds. Revoke is symmetric.
4. Nightly sync re-derives the same state from scratch, so minor drift (people moved since grant day) is
   healed within 24 h — consistent with the product SLA.

Rationale for **subtree-team expansion**: agents query KS with a single request `team_id` (their agent
team). Grant rows written for every team under the granted node mean a leaf-team request matches without
any runtime graph traversal or cross-service membership call. Retrograde: nightly recompute refreshes rows
after org changes.

## 7. API surface

### Kernel (new, admin-only, authz via existing meta auth + api keys)
```
POST /v3/meta/groupy/sync      # manual trigger; body: {} ; returns run summary (async → 202 + run id or sync)
GET  /v3/meta/groupy/status    # last run, last-good timestamp, health
GET  /v3/meta/groupy/tree      # graph (nodes+edges) for Panel mirror/UI breadcrumbs
GET  /v3/meta/groupy/summary   # last sync summary incl. archived nodes, revoked grants
```

### Panel (admin; header validation as existing routes, POST-only by Panel convention)
```
POST /api/v1/groupy/sync            # forwards to kernel; returns status
POST /api/v1/groupy/status
POST /api/v1/asset/grant            # {asset_id, node_id, action} — skills, wikis, code-graph, chat-memory
POST /api/v1/groupy/orphans         # assets whose granted node was archived
POST /api/v1/groupy/tree            # for future UI (phase 2)
```

### KS (admin/panel, service-scoped by x-tdai-service-id)
```
POST /v3/grants/set   # {kind: 'wiki'|'code-graph', knowledge_id, grants: [{team_id, grant_type?}]}  (default viewer)
POST /v3/grants/clear # {kind, knowledge_id, team_ids[]?}  (all rows when team_ids omitted)
```
List/tools queries transparently union owner + grants (no new request fields).

## 8. Failure handling, safety, idempotency

- **Sync failure**: 3 retries / 30 min → give up; state stays at last-good; next run heals (diff-based).
- **Partial failure mid-run**: diff is idempotent; re-run reconciles.
- **Content never deleted**: node archive keeps teams' assets; team delete is NOT called for groupy nodes.
- **Person leaves org**: membership rows → `removed`; user record and owned content untouched.
   Grant rows keep `grant_type` across recomputes; only membership/revocation changes.
- **Team id squatting**: kernel team-create validates against active groupy node ids.
- **Duplicate identities**: reconcile strictly by username; auto-create only when missing.
- **No silent data-loss on grants**: archive/revoke produces an Orphan list, surfaced in Panel.

## 9. Security

- Kernel sync + share endpoints: existing meta auth (admin + api keys), same envelope/error conventions.
- `GROUPY_TOKEN` never logged; requests over corpnet TLS.
- ACL grant writes go through the existing permission-checker path — no bypass added.
- Mock adapter only active when `GROUPY_MOCK_FILE` set (explicit opt-in; never in prod default).

## 10. Testing strategy

- **Unit**: closure computation (matrix multi-parent cases, cycles, heads), diff algorithm (create/archive/
  remove/move), ACL expansion (user+agent rows, home-team preservation).
- **Grant types**: viewer/editor/owner enforcement at KS (view vs ingest vs delete), grant_type default, owner-team precedence over explicit grants.
- **Adapter**: mock client from fixture JSON (works outside corpnet); contract test for fetchNode shape.
- **KS**: grant table migration, list union (owner + grant), revoke removes rows, tools list refreshed.
- **Integration (kernel)**: nightly-style run against fixture → team/member rows in store; instant grant path
  via HTTP → ACL rows + tree expansion correct.
- **E2E (Panel↔KS)**: grant wiki to branch node → leaf-team agent sees wiki in KS tools list within seconds;
  nightly drift scenario heals moved person within one run.

## 11. Rollout

1. Kernel module behind `GROUPY_ENABLED=false` default — no behavior change until enabled.
2. KS migration via existing `pnpm db:generate` path; grant tables empty → zero behavior change.
3. Panel routes behind env-flagged admin availability.
4. Enable with mock → real adapter sequentially; observe `groupy_run` health after each nightly.

## 12. Risks & mitigation

| Risk | Mitigation |
|---|---|
| groupy API contract differs (fields/pagination/auth) | abstract adapter + fixture; adapter swap without touching pipeline (☐ sample needed, see §13) |
| KS agent queries use a team not in subtree (e.g. custom manual team) | grants only expand to groupy teams; manual teams keep team-visibility semantics |
| Org reshuffle floods team-member writes (500 people × ~6 teams) | diff-based writes; status transitions (not delete) bound row churn |
| displayName RTL breaks layouts later | explicitly not rendered in v1 |
| nightly container down when scheduled | on-boot sync + manual trigger; missing night caught next run |

## 13. Open facts (company-net; non-blocking)

- ☐ Exact groupy response shape: fields per node/member (id, name, displayName, kind marker), pagination,
  recursion convention, auth method (header/token).
- ☐ Prod topology: kernel container → groupy reachability + real `GROUPY_*` values.
- ☐ Confirm no existing prod teams (stated) — then no name-link migration needed.
- ☐ Existing `acl/grant` endpoint exact request/response (verify during P2; design assumes it accepts
  user/agent subject rows and asset visibility update atomically).

## Appendix A — locked decisions (traceability to interview)

1. Full one-way mirror; deletions remove memberships + grants only, never content/users. *(R1Q1)*
2. Every groupy node → memory team (id verbatim); membership = ancestor closure; heads included. *(R1Q2/R2Q1)*
3. Nightly + manual; ≤24h chain. *(R1Q3)*
4. Union reachability semantics. *(R1Q4)*
5. Mirrored teams read-only in UI; manual teams coexist; archive + auto-revoke + orphan warnings. *(R1Q5/R2Q3)*
6. Username-based identity reconcile; auto-create flagged users. *(R1Q6/R2Q2)*
7. Node kinds are only `user|org` — teams/groups/branches all treated the same; displayName stored, unused. *(R4Q6)*
8. Grants = restricted + ACL rows (user + agents); home team preserved. *(R3Q1/R4Q2/Q3)*
9. KS grant tables + list-filter union; skills via kernel ACL (skills don't live in KS). *(R3Q2)*
10. Sync engine in kernel as optional env-gated module; groupy client abstract adapter + mock. *(R3Q3/R4Q6)*
11. Instant synchronous share/revoke; nightly only heals drift. *(R3Q4/R4Q1)*
12. Asset types shareable: skills, wikis, code-graph, chat-memory. *(R4Q4)*
13. API-first surface; UI phase 2. *(R4Q5)*
14. Failure: 3 retries/30 min → give up, last-good retained, alert. *(R2Q7)*
15. KS grant rows carry `grant_type` = owner | editor | viewer (default viewer); owner team implicit owner; skills via kernel ACL permission parity. *(R5)*
