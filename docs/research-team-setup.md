# Research Team Setup — 7 researchers, 2 LLM keys

One person (you, server admin) hosts the stack. Researchers install
nothing except Claude Code + 4 env vars.

> How to use this guide: every step ends with a **✅ Verify** block.
> Do not continue until it passes — later steps fail silently on earlier
> mistakes (especially wrong keys).

## 0. Key split

| Key | Used by | Set where |
|---|---|---|
| KEY_A — ingest/memory LLM | Gateway memory extraction + Knowledge wiki ingest | `tdai-gateway.yaml` + KS `.env` |
| own chat key per researcher (7) | Claude Code traffic, billed to each | Their own provider account, passthrough |
| `user_key` per researcher (7) | Memory login + proxy auth (`x-api-key`), per-user audit | Gateway, handed out once (step 2.2) |

Researchers never see KEY_A. They bring their own chat key + the `user_key` you give them.

## 0.5 Sharing model (read this first)

| Layer | Visibility | Lives on | Why |
|---|---|---|---|
| Wiki (literature, docs) | **team-shared** | shared agent | one common ground — everyone recalls the same corpus |
| Skills (playbooks) | **team-shared** | shared agent | same methods for all, improved once |
| Chat memory (sessions, hypotheses) | **private per researcher** | own agent each | raw thinking stays theirs; precise recall, no cross-noise |

Rule: **share knowledge via assets, not via a shared brain.** Refined
conclusions graduate from private chat → shared wiki/skill. Exceptions:
a private draft wiki per person (shared when mature), and task-scoped
shared memory for joint project decisions. Mechanism is the visibility
toggle (Shared/Private) on each asset — not separate systems.

## 1. Server machine (you)

### 1.1 Start all four services

```bash
# Gateway :8420 (memory core)
cd MemoryCore && node --import tsx src/gateway/server.ts
# Knowledge :8421 (wiki + code-graph)
cd MemoryKnowledge && npx tsx src/server.ts
# Panel API :8123
cd MemoryPanel && npx tsx src/index.ts
# Proxy :8096 (Claude Code entry)
cd MemoryProxy && node --import tsx/esm src/index.ts
# Panel web :5173 (dev) — or serve web/dist from :8123 in prod
cd MemoryPanel/web && npm run dev
```

Keep them alive after logout: `nohup … & disown` (logs to files), or
systemd / pm2 / docker. Health: `/health` on 8420/8421/8123/8096.

> LAN access: defaults bind loopback. Researchers on other machines need
> reachable addresses: set `HOST=0.0.0.0` / `server.host: 0.0.0.0`, open
> firewall ports, prefer Tailscale/VPN over raw internet. `gateway_endpoint`
> and `proxy_endpoint` in panel config must be the LAN addresses.

**✅ Verify — all four answer:**

```bash
for p in 8420 8421 8123 8096; do printf "$p: "; curl -s -m 3 http://127.0.0.1:$p/health | head -c 60; echo; done
curl -s -m 3 http://127.0.0.1:5173/ -o /dev/null -w "web: %{http_code}\n"
```

Expect: `8420: {"status":"ok"`, `8421: {"status":"ok"`,
`8123: {"status":"ok"}`, `8096: {"status":"ok"`, `web: 200`.
Empty reply = that service crashed or never booted — read its log before
continuing (a dead :8420 makes every later step fail with `fetch failed`).

### 1.2 KEY_A — Gateway (memory extraction/persona)

`MemoryCore/tdai-gateway.yaml`:

```yaml
llm:
  baseUrl: "https://<ingest-provider>/v1"   # or TDAI_LLM_BASE_URL env
  apiKey: "${TDAI_LLM_API_KEY}"              # KEY_A
  model: "deepseek-v3.2"                     # or TDAI_LLM_MODEL env
```

**✅ Verify — gateway sees the key:** restart the gateway and check the
first 20 log lines: model name shown, no `llm … error` / `401` /
`unauthorized`. Full proof comes in step 3 (first ingest triggers real
LLM calls). Wrong KEY_A symptom later: L0 capture works but extraction
never produces L1 memories — gateway log fills with LLM errors.

### 1.3 KEY_A — Knowledge Service (wiki ingest)

`MemoryKnowledge/.env` (copy from `.env.example`):

```bash
PORT=8421
LLM_MODE=custom            # do NOT use proxy mode here — that bills KEY_B
LLM_PROVIDER=custom
LLM_MODEL=<ingest-model>
LLM_BASE_URL=https://<ingest-provider>/v1
LLM_API_KEY=<KEY_A>
```

(`LLM_MODE=proxy` routes ingest through the Proxy = KEY_B billing.
Use it only if you want one bill.)

**✅ Verify — KS booted with your key:** log shows
`Knowledge service listening on http://localhost:8421` (and NOT a stale
`custom` empty-key warning), plus:

```bash
curl -s -X POST -H "x-tdai-service-id: default" \
  http://127.0.0.1:8421/v3/wiki/list -d '{"team_id":"t"}' | head -c 120
```

Expect `{"code":0`. Real LLM proof comes at first ingest (step 3) —
a bad KEY_A surfaces there as `failed` + `sync_error` mentioning the
LLM provider, never as a clear "bad key" message.

### 1.4 Upstream — each researcher uses their OWN chat key (passthrough)

No shared KEY_B. Proxy verifies memory identity from `x-api-key`, and
forwards each researcher's own chat key upstream untouched.

`MemoryProxy/config.yaml`:

```yaml
server: { host: 0.0.0.0, port: 8096 }
upstream:
  url: https://<chat-provider>/v1   # fallback only, same provider for all
  apiKey: ""                        # empty = never substitute a server key
  agents:
    claude-code:
      url: "https://<chat-provider>/v1"
      # NO apiKey here → per-request client key passthrough
      # (once an agent is listed, the outer upstream.apiKey fallback is cut off)
auth: { enabled: true, url: "http://127.0.0.1:8420" }
```

> Variant: shared team key instead — put KEY_B in
> `upstream.agents.claude-code.apiKey` (or outer `upstream.apiKey`) and
> researchers set any/own token. Mixed mode also works: some agents on a
> server key, others on passthrough.

**✅ Verify — passthrough really passes through:** restart the proxy,
then send a bogus client key:

```bash
curl -s -m 15 -X POST -H "x-api-key: <a-real-memory-user_key>" \
  -H "Authorization: Bearer sk-ant-fake" \
  http://127.0.0.1:8096/claude-code/default/v1/messages \
  -d '{"model":"<model>","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}' \
  | head -c 300
```

Expect an **upstream auth error** (provider rejects `sk-ant-fake`).
That proves no server key was substituted. If you instead get a proxy
`authentication_error` about `user_key`, the `x-api-key` is wrong —
fix it before touching researcher machines.

### 1.5 Panel instance registry

`MemoryPanel/config/metadata-instances.json` (gitignored, create from
`.example.json` — note: the example has syntax errors, validate JSON):

```json
{ "instances": [{
  "id": "default",
  "name": "Research",
  "gateway_endpoint": "http://<server-lan-ip>:8420",
  "proxy_endpoint": "http://<server-lan-ip>:8096",
  "api_key": "<admin user_key, step 2.1>"
}]}
```

## 2. Bootstrap team (you, on server)

Gateway base: `http://127.0.0.1:8420`, header `x-tdai-service-id: default`.

### 2.1 First admin (EMPTY DB ONLY)

`POST /v3/internal/meta/user/init-admin` with
`{"username":"admin","user_key":"<generate sk-mem-…>"}` returns the
admin `user_key`. Save it — shown once.

> Returns 409 if users exist. Then recover the key from the metadata DB
> (`meta_user_keys` table) or create a new admin via an existing key.
> Never wipe the DB to re-run init — that deletes all memory.

Put the admin key in `metadata-instances.json` (`api_key`) and restart Panel.

**✅ Verify — Panel talks to the Gateway:**

```bash
curl -s http://127.0.0.1:8123/health; echo
tail -n 5 MemoryPanel/.pi/logs/panel-8123.log 2>/dev/null || tail -n 5 panel.log
```

Expect `{"status":"ok"}` and a `panel listening` line with **zero**
`invalid_user_key` warnings. Any `401 invalid_user_key` here = the
`api_key` in the JSON is wrong — Panel UI will load but every forwarded
call fails, so fix now.

### 2.2 Seven users (one call each, auth = admin key in `x-tdai-user-key`)

```bash
curl -X POST -H "x-tdai-service-id: default" \
  -H "x-tdai-user-key: <ADMIN_KEY>" \
  http://127.0.0.1:8420/v3/meta/user/create \
  -d '{"username":"alice"}'
# → data.default_user_key — send to Alice, repeat × 7

**✅ Verify — each key is real (do it in the loop, × 7):**

```bash
curl -s -X POST -H "x-tdai-service-id: default" \
  http://127.0.0.1:8420/v3/meta/auth/verify \
  -d '{"user_key":"<alice-key>"}'
```

Expect `{"code":0,…"valid":true}`. `valid:false` = you copied the
key wrong or created the user on a different instance id — re-create,
do not hand out unverified keys (a bad key fails at the researcher's
first chat, hardest place to debug).
```

### 2.3 Team + agents + task

```bash
# team (owner = your user_id)
POST /v3/meta/team/create {"name":"research","owner_user_id":"<you>"}
# → team_id
# one shared agent + one private agent per researcher (owner = each user)
POST /v3/meta/agent/create {"team_id":"<team>","owner_user_id":"<uid>","name":"lit-review"}
# → agent_id
# one task per project, members = the researchers on it
POST /v3/meta/task/create {"team_id":"<team>","creator_user_id":"<you>","name":"project-x","user_ids":[...]}
```

Recommended shape (follows §0.5): **1 shared agent** holding only
team-shared wiki/skills — no private chat expected there — +
**1 private agent each** holding personal chat memory (+ optional draft
wiki) + **1 task per project** (task narrows recall; no task = broad
recall). Do NOT run personal chats on the shared agent: its persona
turns generic and everyone's recall gets noisy.

Hand each researcher: their `user_key`, `team_id`, `agent_id`(s), `task_id`,
proxy URL. IDs are also visible in Panel (Agents page tags, API Key page).

**✅ Verify — topology complete:** open Panel → Agents page: 1 team,
8 agents (1 shared + 7 private), each tagged with the right `team_id`.
Spot-check via API: `agent-fixed-asset/list` for the shared agent
returns `code 0` (empty items is fine — binds come in step 3).

## 3. Ingest the md files (KEY_A bills this)

Easiest = Panel web → Wiki page (no curl):

1. Create wiki (`research-shared`, plus optional `notes-<name>` per person).
2. Upload `.md` — limits per call: **10 files, 512 KB/file, 5 MB total**.
   Big corpus = multiple batches.
3. **Ingest** button (LLM distills pages; billed to KEY_A). Poll to `ready`.
4. Allocate wiki to agent(s): Agent assets tab → allocate (injection `tool`).

API equivalent: `POST :8421/v3/wiki/create` → `/raw/write` → `/ingest`
(header `x-tdai-service-id`, body `team_id`), then `POST :8420`
`/v3/meta/asset/create` (`asset_id` = `wiki_id`) + `agent-fixed-asset/set`.

> Code repos go the same way via code-graph (`/v3/code-graph/create` +
> `/sync`): **public HTTPS repos only**, no local paths. CLI helper:
> `node .pi/kq.mjs search|explore|callers|callees|files`.

**✅ Verify — knowledge is queryable AND bound:**

```bash
# 1. wiki/code-graph status is ready (not processing/failed)
#    Panel → Wiki/Code page, or: POST :8421/v3/wiki/get / code-graph/get
# 2. search returns hits:
node .pi/kq.mjs search "<a term from your docs>" 3
# 3. agent actually holds it:
curl -s -X POST -H "x-tdai-service-id: default" -H "x-tdai-user-key: <ADMIN_KEY>" \
  http://127.0.0.1:8420/v3/meta/agent-fixed-asset/list-with-detail \
  -d '{"agent_id":"<agent>","apply_visibility_filter":false}' | grep -o '"asset_id":"[^"]*"'
```

Expect: `ready` + real search hits + your `wiki_id`/`cg-…` in the bind
list. `failed` + LLM-flavored `sync_error` = KEY_A problem (step 1.3).
Empty bind list = allocate step skipped — proxy will answer with no
knowledge and no error, so check explicitly.

## 3.5 Import existing team skills to shared memory

Skills (`SKILL.md` + files) live on the **shared agent**, not on wikis.
Creating a skill auto-registers its asset and binds it to the owner agent.

**UI path (recommended):** Panel → Skills page → Import Skill → owner =
shared agent → toggle **Shared** (Agent assets tab). Every teammate's
Claude Code session then follows the `SKILL.md` playbook automatically.

**API path (bulk):** per skill folder, with your `user_key`:

```bash
POST :8420/v3/skill/create  (headers x-tdai-service-id, x-tdai-user-key)
{"team_id":"<team>","agent_id":"<shared-agent>","name":"<skill-name, ≤64 chars>",
 "content":"<full SKILL.md text>",
 "resources":[{"path":"<rel-path>","content":"<text>"}]}
# limits: body ≤ 1 MiB, ≤ 100 resources
```

Expect `code 0` + `skill_id`. Skill appears under Panel → Agent assets
of the shared agent; flip Shared/Private there.

**✅ Verify:** `POST /v3/skill/get-by-name` (or Panel Skills page)
returns the skill; a Claude Code chat on the shared agent that matches
the skill scenario follows it. Note: `agents/asset-import.ts` imports
**chat histories**, not `SKILL.md` folders — don't use it for this.

## 4. Researcher machines (Claude Code + OWN chat key)

Each researcher sets 4 env vars, nothing else to install.
Two different keys, two different headers — do not mix them:

```bash
# 1. Route chat through the memory proxy
 export ANTHROPIC_BASE_URL="http://<server-lan-ip>:8096/claude-code/default"
# 2. THEIR OWN chat-provider key (billed to them, passed through untouched)
 export ANTHROPIC_AUTH_TOKEN="<own chat key, e.g. sk-ant-…>"
# 3. Memory identity (NOT a chat key — from you, step 2.2)
 export ANTHROPIC_CUSTOM_HEADERS='{"x-api-key":"<own memory user_key>"}'
# 4. Model display name (must match proxy pricing/model table)
 export ANTHROPIC_MODEL="<model name>"
```

Flow per request: proxy reads `x-api-key` → verifies memory `user_id`
against the Gateway → injects/recalls team memory → forwards the
`ANTHROPIC_AUTH_TOKEN` to the chat provider as-is. Memory sees who you
are; the chat provider bills your own key.

First chat: session popup picks Team → Agent → Task. Memory capture +
recall is automatic after that (L0/L1/L2/L3 server-side).

Rules to share: never paste KEY_A/KEY_B anywhere; `user_key` = password
(revoke + reissue on leak via API Key page); task-scoped chats keep
project memories separate.

**✅ Verify — per researcher (have THEM run this, don't trust "it works"):**

1. `claude -p "say OK"` returns OK (chat key + route good).
2. Chat once about their project, then check server proxy logs:
   `write-l0` present + `agentSource=claude-code` (capture good).
3. New chat asks about step 2 → answer recalls it (recall good).

Symptom table:

| Sees | Cause | Fix |
|---|---|---|
| proxy `authentication_error` re `user_key` | `x-api-key` wrong | reissue step 2.2 key |
| provider 401 / invalid API key | own chat key wrong | researcher fixes on their side |
| OK chat but no memory ever | wrong team/agent/task picked in popup | re-pick, check binds (step 3 verify #3) |

## 5. Day-2 ops (you)

- New md batch → upload + ingest again (or `sync` for code-graphs).
- Researcher leaves → revoke `user_key`, reassign owned agents
  (`owner_user_id`), keep or archive their private wiki.
- Costs: watch KEY_A (ingest spikes per batch) vs KEY_B (chat tokens in
  proxy logs) separately.
- Logs: gateway / KS / panel / `docker logs tdai-proxy` (`write-l0` =
  capture working, `agentSource=` shows client type).

## 6. Local-dev gotchas (already handled on this machine)

- `MemoryPanel/config/metadata-instances.example.json` is invalid JSON —
  validate after copy.
- On Windows/Git-Bash, `MemoryKnowledge/src/server.ts`, MCP
  `src/mcp/server.ts` (+ stale `bin/*.mjs` → `dist` name mismatch) never
  boot due to a `file://` argv guard. Workarounds in-repo:
  `MemoryKnowledge/dev-start.local.mts`, `mcp-start.local.mts`, `.pi/kq.mjs`.
