# Fork differences — yonikremer vs upstream

This repo is a fork of [Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory),
maintained at [yonikremer/TencentDB-Agent-Memory](https://github.com/yonikremer/TencentDB-Agent-Memory).
Upstream stays the source of truth for releases; this fork layers on operational hardening,
Windows support, English i18n, and new features. Main branch: `feat/server_team` (see `AGENTS.md`).

Fork point: upstream `feat/server_team` at `2ee2239`; synced with `origin/feat/server_team` through the multi-format wiki merge (Sep 2026). To re-diff any time:

```bash
git fetch upstream
git log --oneline 2ee2239..HEAD --reverse        # every fork commit
git diff --stat 2ee2239..HEAD -- README.md CHANGELOG.md INSTALL.md docs
```

Chinese (`*_CN.md`, `README_CN.md`, `INSTALL_CN.md`) docs are frozen upstream snapshots —
this fork documents in English only.

## 1. API: v3-only

- Server routes consolidated on **`/v3`**. v1/v2 server routes, SDKs, and transports deleted:
  Core gateway data plane (L0-L3) v3-only (16 deprecated team/user/agent/task entity routes,
  handlers, and schemas dropped); offload plane `/v2/offload/*` becomes `/v3/offload/*`;
  `pipeline/status` and `instance/destroy` v3-only.
- Python SDK top-level **is** v3 (offload plus `read_file` ported; `v2/` package and v2 transport
  tests deleted). TS SDK plus READMEs (EN/CN, py/ts) moved to `/v3` paths.
- Dead `seed-v2` launcher and npm entries removed.
- Client impact: callers still on `/v1`, `/v2`, or `/v2/offload/*` must move to the `/v3`
  equivalents; there is no dual-mount fallback.

## 2. Storage: SQLite-only (Tencent Vector DB removed)

- `TcvdbMemoryStore` / `TcvdbClient` / `TcvdbSkillStore` plus bins and scripts deleted;
  factory, store-pool, gateway, skill, manifest, and config paths are SQLite-only.
- Legacy `tencentdb` / `tcvdb` config blocks parse but are **ignored with a warning** (degrade to SQLite).
- Vector recall is local BM25 (`@tencentdb-agent-memory/tcvdb-text` encoder) plus FTS5 — no cloud
  vector dependency to provision. Covered by `sqlite-only.test.ts`.

## 3. Auth and security hardening (single identity plane)

- **One identity plane:** `x-tdai-user-key` is verified in-process on the Core data plane
  (`/v2`, `/v3`, offload); the verified `user_id` overrides body and header claims. Bearer is
  legacy transport only (still guards bootstrap and ops).
- Knowledge verifies the user key via Core `auth/verify` (`CORE_VERIFY_URL`, `CORE_VERIFY_BEARER`,
  60s positive cache), **fail-closed**; the `KNOWLEDGE_AUTH_DISABLED` bypass was removed.
- Gap closes: skill `space_id` mismatch returns 403; Meta read-path authz
  (team/agent/task/asset/fixed-asset/acl-check), self-or-admin binding, 404 anti-oracle;
  internal user dump behind a flag; Panel 401 on missing auth headers plus S2S callback-secret
  verification; Proxy verified-id only when auth is on, debug identity behind opt-in, `whoami`
  Bearer-only, health stops leaking URLs, upstream SSRF scheme guard;
  `TDAI_GATEWAY_REQUIRE_API_KEY` fail-closed opt-in; callbacks fail-closed; bridge reject helper;
  default-deny (404) on unknown routes.
- **Unlimited user keys** per user (count limit removed).
- Internal control-plane exception: `/v3/internal/*` additionally accepts a shared `KNOWLEDGE_AUTH_TOKEN`
  Bearer (constant-time compare) so Panel automation with no end-user identity can run LLM-binding
  auto-provision; unset or mismatch falls through to user-key verification (still fail-closed).
  Set the same token in KS and Panel env (see `MemoryKnowledge/.env.example`).
- Pinned by `v3-read-guards` tests (cross-user and cross-team denials) and allowlist tests.

## 4. Health and embedding failure semantics

- Health reports **LLM and embedding availability plus last error** (a ready service with no traffic
  yet reports `lastError: null`).
- Embedding failure is **never silent**: unconfigured embedding counts as invalid, and every vector
  path returns **503** instead of succeeding with degraded or empty results.

## 5. Knowledge service: retrieval-augmented wiki ingest plus Windows fixes

- **Memory-enabled ingest (on by default):** each source chunk queries the existing wiki over the
  same BM25 FTS5 `searchInternal` plus `readPage` path as `/v3/search` and injects the top pages
  into the extraction prompt, so docs that assume earlier knowledge keep cross-document facts.
  Tune with `KNOWLEDGE_WIKI_RETRIEVAL_ENABLED` (default `true`),
  `KNOWLEDGE_WIKI_RETRIEVAL_TOP_K` (`3`), `KNOWLEDGE_WIKI_RETRIEVAL_MAX_CHARS` (`12000`),
  `KNOWLEDGE_WIKI_RETRIEVAL_QUERY_TERMS` (`24`). Graceful degradation on first ingest or any
  failure; set `..._ENABLED=false` to restore listing-only behavior. Design notes live under
  `MemoryKnowledge/docs/`.
- `better-sqlite3` bumped to `^13.0.3` (Knowledge plus Proxy).
- Wiki raw write creates **parent dirs** (nested `docs/x.md` paths no longer fail with `ENOENT`;
  `../` traversal still rejected with 400; batch atomicity intact).
- `knowledge-self-start` guard fixed (never matched under `tsx`, so `:8421` never bound).
- Windows dev launchers: `MemoryKnowledge/dev-start.local.mts` (KS) and
  `MemoryKnowledge/mcp-start.local.mts` (MCP).

## 6. Org-hierarchy sync (groupy, off by default)

- Mirrors HR structure (groupy) into teams: kernel sync engine (adapter, closure, store, routes),
  grant expansion (shares, ACL recompute, asset-grant route), KS grant tables (`grant_type`
  owner/editor/viewer) with list-union, enforcement, and grants routes, plus Panel grant flow
  (groupy routes, asset-grant, KS mirror) with mirror-sync heal.
- `GROUPY_ENABLED=false` means zero behavior change. Enable via `GROUPY_*` gateway env, restart,
  check `POST /v3/meta/groupy/status` returns `healthy: true`.
- Auth: `team_required`, agent ownership checks, owner-only escalate, tenant guard; verified-agent
  on both paths. Read and query planes stay legacy-open by design; shared-resource mutations require
  `team_id`.
- Docs: `docs/org-hierarchy-sync/DESIGN.md` plus `PLAN.md` (P1-P5, status, column deviations),
  setup section 7 in `docs/research-team-setup.md`, ops note in `docs/tdai-v2-technical-ops.md` 9.

## 7. Panel web UI

- **Dark mode:** header plus login toggle, follows system default, persisted
  (`theme.ts`, `ThemeToggle.tsx`, Tailwind plus CSS hooks, `index.html` pre-paint).
- **Deep-linkable navigation:** `BrowserRouter` asset URLs with canonical builders and validators
  (`web/src/lib/asset-routes.ts`), shared URL-to-state sync (`use-routed-selection.ts`), real HTTP
  404s for unknown asset pages, back and forward support. Covered by `ui-asset-routes` tests.
- **Fully English** (was mixed Chinese and English): guarded JSX-safe translation pass over
  `MemoryPanel/web`; `ApiKeysPage` piloted first.

## 8. SDK parity plus coverage

- 12 cross-SDK parity bugs fixed in one pass — Python: `ParamError` unification, COS internal URL,
  `with_isolation` None-semantics, prompt `_ids` guard, setting target rules, genlog `memory_id`
  path, `conversation_add` validation, null-data crash, NaN timeout, None query params;
  TS: `getByName` explicit-only ids, legacy `session_id` guard.
- Coverage suites: Python 95 tests and 100 percent statements, TS 133 tests and 100 percent
  statements plus branches (including `parity-fixes.test.ts`).

## 9. Windows and cross-platform paths

- Linux-specific path code (`/tmp` fallbacks, `~/`-only, hardcoded separators, `startsWith` guards)
  replaced with `node:os` and `node:path` helpers shared per package (`platform-paths`).
- Traversal guards hardened (drive letters, UNC, case-insensitive containment, sibling-prefix
  bypass); wiki `resolveRawPath` and page refs use path separators (previously every raw write failed
  on Windows with `400 traversal detected`). 28 cross-platform path tests.
- Git hook script renamed `secret-scan.sh` to `secret-leak-check.sh` (`install-git-hooks.sh` and
  deploy publish scripts follow).

## 10. English i18n (whole repo)

- Web UI, API docs (`meta-api.openapi.yaml`), prompt corpus plus tool descriptions
  (language-contract preserved), CLI and shell output, comments, and configs translated; root
  `CHANGELOG.md`, `INSTALL.md`, and `.gitignore` comments in English.
- Reusable local engine plus workflow in `scripts/zh-en/` (`local-translate.mjs`, `leak-count.mjs`,
  `plan-slice.mjs`, `zh-en-translate.workflow.js`, `zh-en.config.mjs`).
- Chinese matcher examples in `ZH_EN_TRANSLATION_PLAN.md` are intentional test fixtures.

## 11. Setup and ops docs

- `docs/research-team-setup.md`: 7-researcher model — 2-key split (shared ingest KEY_A plus per-user
  chat keys plus `user_key` values), team-shared wiki and skills vs private chat memory, every step
  ending in a verify block, plus all-curl-tested team/wiki/skill commands (task uses `title` not
  `name`, no `user_ids`; meta needs both `x-tdai` headers; skill create needs Bearer `user_key` plus
  frontmatter `name` and `description`; skill sharing means fork per agent since ACLs do not mount
  skills) and section 7 groupy setup. Backed by a 13-test executable contract.
- `docs/tdai-v2-technical-ops.md` section 9: fork ops deltas (groupy off-by-default, v3-only,
  SQLite-only, embedding 503s) alongside pre-existing noise notes.

## 12. Tests (beyond the suites above)

- Customer integration suites (Knowledge auth plane plus flows, Proxy and Panel with fake data, real
  Core verifier wire contract — no stubs), full-coverage round 2 (Core gateway, MCP, control plane,
  live LLM, Panel CG, Proxy passthrough), live LLM suites (`zen` default, `LLM_LIVE` opt-in, BYO
  binding live path, OpenRouter defaults, file-key-wins env precedence), live vector search, boot
  contract plus live boot, Panel chat search and mine. Prettier-only commits carry no logic changes.

## 13. Wiki: multi-format file ingest (docling + in-process)

- Route per extension (`MemoryKnowledge/src/engines/wiki/convert.ts`): `pdf/docx/pptx/xlsx` via
  **docling-serve sidecar** (async-first client, per-conversion reachability probe); `doc/xls/msg/vsdx`
  plus `txt/csv/html/eml/md` **in-process pure-JS** — no LibreOffice anywhere. Anything else is
  `unsupported`.
- Sidecar wiring: compose runs `quay.io/docling-project/docling-serve:latest` (`DOCLING_HOST_PORT`,
  default `5001`); KS points at it with `KNOWLEDGE_DOCLING_URL` (fallback `DOCLING_URL`, default
  `http://localhost:5001`). Probe tries `GET /health`, falls back to `GET /v1/status/poll/test`.
- Storage: one SourceFile renders to one RenderedMd (the only indexed form) with a recorded
  SourceLink back to its source; raw quota helpers (`KNOWLEDGE_RAW_MAX_BYTES` default 100 MB/file,
  `KNOWLEDGE_RAW_TOTAL_BYTES` default 50 GB). Vocabulary in `CONTEXT.md` (SourceFile/RenderedMd/
  Conversion/SourceLink; OneNote out of scope).
- Correctness: byte-parity `vsdx` port (direct-XML, tested against real `ECommerceTestFile.vsdx`)
  plus real `doc/xls/msg` and Hebrew `docx/pdf` fixtures; self-starting docling integration tests.

## 14. Knowledge control plane: LLM fail-fast

- Unconfigured LLM endpoint used to fail late with cryptic `TypeError: Failed to parse URL from
  /chat/completions` per source file. Now client creation throws an actionable error naming the
  bearer/user-key requirement for `llm-binding/set` instead (covered by fail-fast guard tests).

## Verify a claim

```bash
git log --oneline 2ee2239..HEAD --reverse | grep -i -e v3-only -e tcvdb -e groupy -e dark -e i18n
git show e438c8d --stat   # v3 consolidation
git show 613e2fc --stat   # sqlite-only
git show be35ed8 --stat   # single identity plane
git show 8491fed --stat   # multi-format ingest
git show 2a1d0fc --stat   # internal service bearer
```
