# Implementation Plan — Org Hierarchy Sync

Branch: `feat/org-hirarchy-sync` · Docs: `docs/org-hierarchy-sync/DESIGN.md`
No implementation yet — this plan is the contract for later phases.

## Legend

- **(N)** new file · **(M)** modified file · tests colocated with module unless noted.
- Each phase ends with acceptance checks that must pass before the next phase starts.

---

## P0 — Foundations (docs, scaffolding) ✅ doc-only, done when merged

- [x] `docs/org-hierarchy-sync/DESIGN.md`, `docs/org-hierarchy-sync/PLAN.md` (this file)
- [ ] Confirm repo test-convention locations (MemoryCore vitest root `npx vitest run`; MemoryKnowledge `pnpm test`; find existing `*.test.ts` colocation before writing tests)

**Acceptance:** branch exists; docs committed; no code changes.

---

## P1 — Kernel: groupy adapter + snapshot store + sync engine

### Files
- **(N)** `MemoryCore/src/metadata/groupy/types.ts` — `GroupyNode/GroupyMember/GroupyEdge/GroupyRun`
- **(N)** `MemoryCore/src/metadata/groupy/groupy-client.ts` — abstract `GroupyClient`:
  `fetchNode(id): Promise<GroupyNode>`; recursion walker util
- **(N)** `MemoryCore/src/metadata/groupy/mock-groupy-client.ts` — loads `GROUPY_MOCK_FILE` JSON
- **(N)** `MemoryCore/src/metadata/groupy/closure.ts` — ancestor-closure computation (multi-parent union, cycles, heads-included)
- **(N)** `MemoryCore/src/metadata/groupy/sync-service.ts` — fetch → closure → diff → apply + retry policy + run persistence
- **(N)** `MemoryCore/src/metadata/groupy/sync-config.ts` — env parsing (`GROUPY_*`), enabled flag
- **(M)** `MemoryCore/src/metadata/types.ts` — entities above
- **(M)** `MemoryCore/src/metadata/store/metadata-store.contract.ts` + `sqlite-adapter.ts` + `mongodb-adapter.ts` — groupy table CRUD (nodes/edges/runs/map)
- **(M)** `MemoryCore/src/metadata/service/metadata-service.ts` — wire module when enabled
- **(M)** `MemoryCore/src/config.ts` — `GROUPY_*` env declarations
- **(M)** `MemoryCore/src/metadata/router/v3-meta-router.ts` — `/v3/meta/groupy/{sync,status,tree,summary}` (admin auth)

### Behavior
- Teams created with `team_id = node id` verbatim + displayName as name + managed-by-groupy stamp.
- Membership = closure rows; removals flip `status=removed`; users auto-created by username.
- `groupy_run` rows: status, counters, last-good snapshot JSON; 3 retries/30 min then give up.
- Team-create guard: reject ids present in active groupy nodes.

### Acceptance
1. `GROUPY_MOCK_FILE` fixture (matrix org: 2 roots, nested groups, a person under two chains, a head person) →
   run sync → assert teams/members rows match closure by hand.
2. Re-run sync → zero changes (idempotent).
3. Move a person in fixture → re-run → only moved rows change (`removed` + `active`).
4. Delete a node in fixture → archived team, members `removed`, content untouched.
5. `/v3/meta/groupy/status` + `tree` return expected shape; manual `sync` route 202/200.
6. `npm test` (MemoryCore) green for new unit tests (closure/diff).
7. Team-create rejects a groupy-live id.

---

## P2 — Kernel: grant expansion (restricted ACL)

### Files
- **(N)** `MemoryCore/src/metadata/groupy/grant-service.ts` — expansion + recompute
- **(M)** `MemoryCore/src/metadata/groupy/sync-service.ts` — call grant recompute after membership apply
- **(M)** `MemoryCore/src/metadata/service/permission-checker.ts` — verify restricted+ACL path covers agent-context calls (user subject rows match agent-owned requests); adjust only if proven needed
- **(M)** `MemoryCore/src/metadata/router/v3-meta-router.ts` — end-to-end instant-grant helper route (or reuse existing `acl/grant` + `asset/update`; verify exact endpoint during implementation, §13 design)

### Behavior
- Assets flagged groupy-shared get `visibility=restricted`; ACL rows = owner ∪ home-team members ∪
  closure(granted nodes), each as `user` + owner-agent rows.
- Nightly: recompute all groupy-derived ACL sets; archived-node grants auto-revoked and listed in summary.

### Acceptance
1. Unit: expansion output for fixture node (users + their agents, home-team preserved).
2. Integration: grant asset via kernel route → `asset/get` shows restricted + correct ACL rows.
3. Agent-context permission check (permission-checker with agentId) passes for a home/granted user's agent.
4. Archived node → next sync revokes its ACL contribution; summary records it.

---

## P3 — KS: grant tables + list-union

### Files
- **(M)** `MemoryKnowledge/src/db/schema.ts`, `MemoryKnowledge/src/db/client.ts` — DDL for grant tables
- **(M)** `MemoryKnowledge/src/store/types.ts`, `MemoryKnowledge/src/store/sqlite-store.ts` — `setGrants/clearGrants/listByTeamUnion` for wiki + code-graph
- **(M)** `MemoryKnowledge/src/store/wiki-service.ts`, `MemoryKnowledge/src/store/code-graph-service.ts` — pass-through
- **(N)** `MemoryKnowledge/src/routes/grants.ts` — `POST /v3/grants/set|clear` (service-scoped, admin)
- **(M)** `MemoryKnowledge/src/routes/wiki.ts`, `MemoryKnowledge/src/routes/tools.ts` — union filter in list/tools
- **(M)** `MemoryKnowledge/src/middleware/response-envelope.ts` or `api-helpers.ts` as needed for grants validation

### Acceptance
1. `pnpm db:generate` migration output includes both tables.
2. Wiki visible to owner team and to each granted team; invisible to non-granted team.
3. `grants/clear` removes rows; tools list drops tool immediately.
4. `pnpm test` (MemoryKnowledge) green.

---

## P4 — Panel: sync-now, asset grant route, KS mirror, orphans

### Files
- **(N)** `MemoryPanel/src/panel/http/routes/groupy.ts` — `/api/v1/groupy/{sync,status,tree,orphans}`
- **(N)** `MemoryPanel/src/panel/http/routes/asset-grant.ts` — `POST /api/v1/asset/grant` (skills, wikis, code-graph, chat-memory)
- **(M)** `MemoryPanel/src/panel/http/app.ts` — mount routes
- **(M)** `MemoryPanel/src/panel/kernel/adapters/http-knowledge-client.ts` — `setGrants/clearGrants` mirror for wiki/code-graph
- **(M)** `MemoryPanel/src/panel/kernel/types.ts` (+ kernel port) — groupy client port for kernel calls
- **(M)** `MemoryPanel/src/panel/domain/asset-id.ts` or grant validation — asset-type routing to KS vs kernel-only
- **(M)** `deploy/global-images/.env.example` — `GROUPY_*` documented

### Behavior
- Grant flow synchronous: kernel ACL write + KS mirror in one request (seconds). Revoke symmetric.
- Orphans endpoint = assets whose granted node was archived (from kernel summary).
- No durable Panel state added (mirror is computed on demand from kernel tree/grant state).

### Acceptance
1. E2E: grant wiki to branch node → instantly visible in KS tools list for a leaf-team agent (seconds, no nightly).
2. Revoke → gone instantly.
3. Skill/chat-memory grant → kernel ACL updates, no KS call made.
4. Orphans list reflects archived-node revokes.
5. Panel route auth: non-admin 401/403.

---

## P5 — Hardening & rollout checks

### Files
- **(M)** docs: README section + `deploy/global-images/.env.example` final pass
- **(M)** MemoryCore + KS changelogs
- **(? )** small admin status page in `MemoryPanel/web` (or defer to UI phase) — API-first decision keeps this optional

### Acceptance
1. Full stack boot with `GROUPY_ENABLED=false` → zero behavior change (regression: existing tests/hand smoke).
2. Enable with mock in dev stack → nightly runs, status healthy, orphans/revokes visible.
3. Swap in real adapter on corpnet (after user supplies ☐ sample + creds) → first real sync passes acceptance
   of P1.4–P1.7 and P2.2.
4. `MemoryPanel npm run test:knowledge:e2e` + `MemoryCore npm test` + `MemoryKnowledge pnpm test` all green.

---

## Sequence & dependencies

```
P0 ──▶ P1 ──▶ P2 ──▶ P4 (needs P3 for mirror writes)
              │         ▲
              └── P3 ───┘
P5 after P1–P4 green; real-adapter swap gated on user's groupy facts (§13 DESIGN).
```

## Out of scope (later phases)

- Share UI dialog (node picker) — phase 2
- groupy webhooks / push
- displayName i18n rendering
- Bidirectional sync
- Auto-migration of pre-existing manual teams (prod has none today)
