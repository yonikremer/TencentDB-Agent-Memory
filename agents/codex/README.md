# Codex

> agentSource: `codex` | Protocol: OpenAI Responses API | Handler: `codexHandler.ts` (Standalone)
>
> Local history import to Memory Hub: see [Asset Import Manual](./asset-import.md).

---

## 1. Client Access Configuration

Codex is configured via the **config file** `~/.codex/config.toml`:

```toml
# ~/.codex/config.toml
model_provider = "team-proxy"
model = "claude-opus-4.7"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.team-proxy]
name       = "TDAI team-proxy"
wire_api   = "responses"
base_url   = "http://127.0.0.1:8096/codex/default"
experimental_bearer_token = "<business user's sk-mem-... user_key>"

request_max_retries    = 2
stream_max_retries     = 3
stream_idle_timeout_ms = 120000
```

Field description:
- `wire_api = "responses"` — **required**, Codex uses the OpenAI Responses API protocol
- `base_url` — Proxy address + `/codex/<spaceId>`; `default` is the memory instance ID
- `experimental_bearer_token` — the business user's `user_key` (obtained from the panel)
- `disable_response_storage = true` — disable local caching to ensure every round passes through Proxy injection
- `stream_idle_timeout_ms = 120000` — avoid timeout during session-init waiting for user action

> ⚠️ **Switch to Plan mode before the first conversation** (`Shift+Tab`). Codex's default Agent mode will automatically execute tool calls and skip user selection, causing session-init to never complete. After selecting Team→Agent→Task, switch back to Agent mode.

Requested path:
- `POST /codex/:spaceId/v1/responses`
- `POST /codex/:spaceId/responses` (no v1 prefix, also accepted)

Auxiliary paths:
- `/codex/:spaceId/responses/compact` — compact request
- `/codex/:spaceId/memories/trace_summarize` — trace summary
- `/codex/:spaceId/realtime/calls` — realtime call

---

## 2. Session ID

| Priority | Source |
|--------|------|
| 1 | `session-id` header |
| 2 | `body.client_metadata.session_id` |

Codex CLI automatically generates and writes session_id in both header and body, no manual configuration required by the user.

---

## 3. Session Init (Session Initialization / Form)

### 3.1 Mechanism

Codex initiates an interactive Form using the **`request_user_input`** function_call:

- Tool name: `request_user_input`
- ID prefix: `fc_codex_session_init_`(⚠️ must have the `fc_` prefix; the OpenAI Responses spec enforces it)
- Call ID prefix: `call_codex_session_init_`
- Protocol: OpenAI Responses API SSE (`response.created` / `response.output_item.*` / `response.completed` events)

### 3.2 State Machine

Reuse the CB state machine, but with `agentSource="codex"`, `protocol="responses"` markers:

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

Codex uses a dedicated `computeCodexPagination`, with rules similar to CC (limited option count), but implemented independently.

### 3.4 ⚠️ Default Mode Gate (Key Difference)

Codex has two running modes:
- **Suggest mode** — `request_user_input` tool is available → proceeds normally through form
- **Default mode** — client blocks `request_user_input` call

**Default mode determination**: When the proxy sends a form, the `function_call_output.output` returned by the client contains:

```
"request_user_input is unavailable in Default mode"
```

proxy detects this gate string and → **permanently skips** session-init, all subsequent requests are passed through directly.

### 3.5 Skip Session Init

Three ways:
1. Default mode gate auto-trigger → permanently skip
2. User manually inputs "skip" / "skip"
3. Select "No" in asset_confirm

---

## 4. Request Classification

Codex uses **three signals** to assist in request determination:

| Signal | Check Content |
|------|----------|
| Path suffix | `/compact`, `/memories/trace_summarize`, `/realtime/calls` |
| Header | `x-openai-memgen-request: true` |
| Body | `body.client_metadata.thread_source` ≠ `"main"` |

Any of the three hits → judged as auxiliary → skip injection/archiving.

---

## 5. User Text Extraction

Extract from the `body.input[]` array:
1. Find the last item with `type: "message"` and `role: "user"`
2. Extract the text of all `input_text` type blocks from its `content[]`
3. Concatenate into the final user text

⚠️ Codex's body structure is completely different from Chat Completions (`input[]` instead of `messages[]`).

---

## 6. Inject Profile

Use the codex-specific injection builder `buildCodexInjectionBlock`:

```
instructions field injection (non messages/input)
```

The injection point of Codex is `body.instructions` (the equivalent of the system prompt in the Responses API).

---

## 7. Special Behaviors

- **Independent Handler**: `codexHandler.ts`, not shared with CB/CC
- **fc_ prefix enforcement**: The OpenAI Responses API requires the function_call id to start with `fc_`, otherwise the client replay returns 400
- **marker routing**: `/codex/:spaceId/cost-guard/responses` and `/codex/:spaceId/analyse/responses` support cost-guard/analyse routing
- **archive hook**: On 2026-08-11, codex's `skill/conversation/add` + TDAI L0 writes were completed (previously data was silently lost)

---

## 8. Archive Trigger

- Automatically `skill/conversation/add` when the conversation exceeds the threshold (via the `responses` branch of `normalize-conversation`)
- Support `skill/conversation/force-archive`
- Codex archiving requires conversion to a unified format via `normalizeCodexConversation`

---

## 9. Environment Variables

```env
PROXY_PORT=8096
# Codex Upstream (generally via tokenhub or copilot.tencent.com)
# Dynamically routed by resolveForwardTarget
```

The local codex upstream goes to `https://copilot.tencent.com` (without `/v1`, `/v2`).
Available models: `gpt-5.3-codex` / `gpt-5.4` / `gpt-5.5` / `gpt-5.6-*` / `deepseek-r1`, `claude-*` are hard rejected.

---

## 10. Common Questions

**Q: Is there absolutely no memory injection under Codex Default mode?**
**A:** Yes. After the Default mode gate is triggered, the proxy passes through directly without any injection. This is a design decision of the codex client—Default mode pursues minimal latency.

What is the fc_ prefix issue?
A: The OpenAI Responses API has regex validation on the `id` field of `function_call`, which must start with `fc_`. When the proxy generates forms, it uses the `fc_codex_session_init_` prefix, and `call_id` maintains the `call_` prefix. Before the change, the codex client replayed the 5th request and got a 400.

**Q: What is Codex's /compact request?**
**A:** Similar to CC's conversation compaction (conversation compression), it is an auxiliary request triggered automatically by the client, and does not require injection/archiving.

**Q: What is the code reuse relationship between Codex and CB?**
A: Codex has an independent `codexHandler.ts`, but the underlying implementation of the session-init state machine reuses CB's implementation (with different agentSource + protocol parameters passed in).

---

## 11. Differences from Claude Code / CodeBuddy

| Dimension | Claude Code | CodeBuddy | Codex |
|------|-------------|-----------|-------|
| Protocol | Anthropic Messages | OpenAI Chat Completions | **OpenAI Responses** |
| Config | Environment variables | `~/.codebuddy/models.json` | `~/.codex/config.toml` |
| URL Prefix | `/claude-code/<spaceId>` | `/codebuddy/<spaceId>` | `/codex/<spaceId>` |
| Key Passing | env `ANTHROPIC_AUTH_TOKEN` | JSON `apiKey` | TOML `experimental_bearer_token` |
| Session init | Auto form popup | Auto form popup | **Manual Plan mode switch required on first use** |
