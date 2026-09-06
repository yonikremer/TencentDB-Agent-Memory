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
GW=http://127.0.0.1:8420; SID=default
ME=<your user_id>; KEY=<your user_key>  # admin key from step 2.1
H1="x-tdai-service-id: $SID"; H2="x-tdai-user-key: $KEY"

# 0. who am I (do this first — every id below depends on it)
curl -s -X POST -H "$H1" $GW/v3/meta/auth/verify -d '{"user_key":"'"$KEY"'"}'
# → data.user.user_id must equal $ME

# 1. team (owner = your user_id)
curl -s -X POST -H "Content-Type: application/json" -H "$H1" -H "$H2" \
  $GW/v3/meta/team/create -d '{"name":"research","owner_user_id":"'"$ME"'"}'
# → data.team_id  (save as TEAM)

# 2. members — repeat per researcher. Get their user_id first:
#    auth/verify with THEIR user_key, or user/list -d '{"team_id":"..."}'.
curl -s -X POST -H "Content-Type: application/json" -H "$H1" -H "$H2" \
  $GW/v3/meta/team-member/add \
  -d '{"team_id":"'"$TEAM"'","user_id":"<uid>","role":"member"}'
# role ∈ admin|member|reviewer. → code 0. Self-add and owner-demote are rejected.

# 3. agents — one shared + one private per researcher (owner = each user)
curl -s -X POST -H "Content-Type: application/json" -H "$H1" -H "$H2" \
  $GW/v3/meta/agent/create \
  -d '{"team_id":"'"$TEAM"'","owner_user_id":"<uid>","name":"lit-review"}'
# → data.agent_id  (visibility defaults to team)

# 4. one task per project …
curl -s -X POST -H "Content-Type: application/json" -H "$H1" -H "$H2" \
  $GW/v3/meta/task/create \
  -d '{"team_id":"'"$TEAM"'","creator_user_id":"'"$ME"'","title":"project-x"}'
# → data.task_id  (field is TITLE, not name; there is NO user_ids field)

# 5. … members join via task-agent/link (repeat per agent)
curl -s -X POST -H "Content-Type: application/json" -H "$H1" -H "$H2" \
  $GW/v3/meta/task-agent/link -d '{"task_id":"'"$TASK"'","agent_id":"'"$AGENT"'"}'
# → code 0
```

> Auth rule for every `/v3/meta/*` call: **both** headers
> `x-tdai-service-id` **and** `x-tdai-user-key`. One missing = 400/401.
> Destroy is plural: `team/delete` takes `{"team_ids":[...]}` (cascades to
> members/agents/tasks/assets), `agent/delete` takes `{"agent_ids":[...]}`.

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

API equivalent (all POST, header `x-tdai-service-id: default` only — no user key on KS):

```bash
KS=http://127.0.0.1:8421; SID=default; TEAM=<team_id>; WNAME=research-shared
H="x-tdai-service-id: $SID"

# 2.1 create (idempotent on same team+name) → data.wiki_id (save as WIKI)
curl -s -X POST -H "Content-Type: application/json" -H "$H" \
  $KS/v3/wiki/create -d '{"team_id":"'"$TEAM"'","name":"'"$WNAME"'"}'

# 2.2 add files — plain filenames, no '..', no leading '/'
# limits per call: ≤10 files, ≤512 KB/file, ≤5 MB total. Big corpus = batches.
curl -s -X POST -H "Content-Type: application/json" -H "$H" \
  $KS/v3/wiki/raw/write -d @- <<EOF
{"team_id":"$TEAM","wiki_id":"$WIKI","files":[
  {"filename":"notes.md","content":"# Topic\n\nBody text here.\n"},
  {"filename":"docs/extra.md","content":"# More\n\nSubdir paths allowed.\n"}
]}
EOF
# → data.items[].filename. 400 "traversal detected" on a plain name =
# stale KS binary (Windows sep bug, fixed on feat/server_team) — pull + restart KS.

# list what is staged:
curl -s -X POST -H "Content-Type: application/json" -H "$H" \
  $KS/v3/wiki/raw/ls -d '{"wiki_id":"'"$WIKI"'"}'
# → data.items[].filename

# 2.3 ingest — async, returns 202 pending. Empty wiki → 400 (upload first).
curl -s -X POST -H "Content-Type: application/json" -H "$H" \
  $KS/v3/wiki/ingest -d '{"wiki_id":"'"$WIKI"'"}'

# poll to ready (2s interval; busy → 409 means an ingest is already running):
for i in $(seq 1 150); do
  S=$(curl -s -X POST -H "Content-Type: application/json" -H "$H" \
    $KS/v3/wiki/get -d '{"wiki_id":"'"$WIKI"'"}');
  echo "$S" | grep -o '"status":"[^"]*"' | head -1;
  echo "$S" | grep -q '"status":"ready"' && break
  echo "$S" | grep -q '"status":"failed"' && break
  sleep 2
done
# failed + sync_error naming the LLM provider = KEY_A/BASE_URL problem (step 1.3).

# query it:
curl -s -X POST -H "Content-Type: application/json" -H "$H" \
  $KS/v3/wiki/search -d '{"wiki_id":"'"$WIKI"'","query":"<a term>","limit":5}'
```

### 2.4 Share the wiki with the team (register → allocate → verify)

A wiki is invisible to agents until it is a **team asset** bound to an agent.
Three calls, in order:

```bash
GW=http://127.0.0.1:8420; PANEL=http://127.0.0.1:8123; SID=default
ME=<your user_id>; KEY=<your user_key>; TEAM=<team_id>; WIKI=<wiki_id>; AGENT=<agent_id>

# 1. register as team-visible asset (asset_id MUST equal wiki_id)
curl -s -X POST -H "Content-Type: application/json" \
  -H "x-tdai-service-id: $SID" -H "x-tdai-user-key: $KEY" \
  $GW/v3/meta/asset/create -d '{"asset_id":"'"$WIKI"'","team_id":"'"$TEAM"'",\
"asset_type":"llm_wiki","name":"research-shared","owner_user_id":"'"$ME"'",\
"source_type":"uploaded","visibility":"team"}'
# → code 0. visibility team = every team member can read it.

# 2. allocate to the agent(s) — repeat per agent (shared + each private one
#    that should recall it). Panel header names use capital X-Tdai-* here.
curl -s -X POST -H "Content-Type: application/json" \
  -H "X-Tdai-Service-Id: $SID" -H "X-Tdai-User-Key: $KEY" \
  $PANEL/api/v1/knowledge/allocate \
  -d '{"team_id":"'"$TEAM"'","knowledge_id":"'"$WIKI"'","agent_id":"'"$AGENT"'"}'
# → data.allocated true. 404 KNOWLEDGE_NOT_FOUND = step 1 skipped.

# 3. verify the bind (injection_mode tool = agent can search it at runtime)
curl -s -X POST -H "Content-Type: application/json" \
  -H "x-tdai-service-id: $SID" -H "x-tdai-user-key: $KEY" \
  $GW/v3/meta/agent-fixed-asset/list -d '{"agent_id":"'"$AGENT"'"}' \
  | grep -o '"asset_id":"[^"]*"'
# → must include "asset_id":"<your wiki_id>". Empty = allocate skipped —
# the proxy answers with no knowledge and NO error, so check explicitly.
# Unshare: POST $PANEL/api/v1/knowledge/unbind {"knowledge_id","agent_id"}.
```

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

**API path (bulk):** per skill folder. Auth differs from meta routes:
`Authorization: Bearer <user_key>` + `x-tdai-service-id` (NOT the
`x-tdai-user-key` header — that gives 401).

```bash
GW=http://127.0.0.1:8420; SID=default
ME=<your user_id>; KEY=<your user_key>; TEAM=<team_id>; AGENT=<shared-agent_id>
BH="Authorization: Bearer $KEY"; H="x-tdai-service-id: $SID"

# 3. create — content MUST start with frontmatter carrying name+description.
# name: ^[a-z0-9][a-z0-9-]*$, ≤64 chars. body ≤50k chars, ≤100 resources, ≤1 MiB.
cat > /tmp/skill.json <<EOF
{"user_id":"$ME","team_id":"$TEAM","agent_id":"$AGENT","name":"lit-review",
 "content":"---\nname: lit-review\ndescription: How we do lit reviews.\n---\n\n# Lit review\n\n1. Search wiki first.\n",
 "resources":[{"path":"checklist.md","content":"- [ ] cite sources\n","encoding":"utf-8"}]}
EOF
curl -s -X POST -H "Content-Type: application/json" -H "$H" -H "$BH" \
  $GW/v3/skill/create -d @/tmp/skill.json
# → code 0 + data.skill_id. 42203 = frontmatter missing/invalid.

# read back:
curl -s -X POST -H "Content-Type: application/json" -H "$H" -H "$BH" \
  $GW/v3/skill/get \
  -d '{"user_id":"'"$ME"'","team_id":"'"$TEAM"'","skill_id":"<skl-…>","include_content":true}'

# list one agent's skills:
curl -s -X POST -H "Content-Type: application/json" -H "$H" -H "$BH" \
  $GW/v3/skill/list -d '{"user_id":"'"$ME"'","team_id":"'"$TEAM"'",\
"filters":{"owner_agent_id":"'"$AGENT"'"},"pagination":{"limit":20,"offset":0}}'

# delete = archive (needs owner agent + current version from get/list):
curl -s -X POST -H "Content-Type: application/json" -H "$H" -H "$BH" \
  $GW/v3/skill/delete -d '{"user_id":"'"$ME"'","team_id":"'"$TEAM"'",\
"agent_id":"'"$AGENT"'","skill_id":"<skl-…>","expected_version":1}'
# → data.archived true
```

### 3.1 Share the skill with the team (fork, not ACL)

Runtime injection filters by `owner_agent_id`, so `acl/grant` does NOT
mount a skill on anyone. Sharing = **fork**: re-create the same content
with `agent_id` = each target agent (same name allowed across agents;
duplicate under the SAME agent is rejected):

```bash
# 1. read source (content + manifest from the get call above)
# 2. create under the teammate's agent, tagging lineage:
curl -s -X POST -H "Content-Type: application/json" -H "$H" -H "$BH" \
  $GW/v3/skill/create -d '{"user_id":"'"$ME"'","team_id":"'"$TEAM"'",\
"agent_id":"<teammate-agent_id>","name":"lit-review",\
"content":"<same SKILL.md text>",\
"metadata":{"forked_from":{"skill_id":"<source skl-…>","name":"lit-review"}}}'
# → new skill_id with owner_agent_id = teammate agent. Copy resources[] too
# (read each via files/read {path}, add to the create body) or the fork
# loses its attachments.

# 3. verify — teammate agent lists it:
curl -s -X POST -H "Content-Type: application/json" -H "$H" -H "$BH" \
  $GW/v3/skill/list -d '{"user_id":"'"$ME"'","team_id":"'"$TEAM"'",\
"filters":{"owner_agent_id":"<teammate-agent_id>"},"pagination":{"limit":20,"offset":0}}' \
  | grep -o '"name":"[^"]*"' | head
```

**✅ Verify:** the forked `skill_id` shows under the target agent's list
(or Panel → Agent assets); a chat on that agent matching the scenario
follows it. Note: `agents/asset-import.ts` imports **chat histories**,
not `SKILL.md` folders — don't use it for this.

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
