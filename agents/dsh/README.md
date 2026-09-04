# DeepSeek Harness (dsh)

> agentSource: `dsh` | Protocol: OpenAI Chat Completions | Handler: `handler.ts` (shared with CodeBuddy)

> Local history import into Memory Hub: see the [Asset Import Guide](./asset-import.md).

---

## 1. Client Configuration

dsh configures custom models via **configuration files** `~/.dsh/settings.yaml` and `~/.dsh/.credentials.yaml`:

**`~/.dsh/settings.yaml`**:
```yaml
llm-deepseek:
  # dsh reads the proxy user_key from this environment variable name
  apiKeyEnv: PROXY_USER_KEY

  # ⚠️ Do not add a trailing /v1 — dsh hard‑codes ${baseURL}/chat/completions
  baseURL: http://127.0.0.1:8096/dsh/default

  # thinking mode
  reasoningEffort: high
```

**`~/.dsh/.credentials.yaml`**:
```yaml
PROXY_USER_KEY: <business user sk-mem-... user_key>
```

**Security requirements** (checked at dsh startup):
```bash
chmod 700 ~/.dsh
chmod 600 ~/.dsh/.credentials.yaml
```

**Field explanation**:
- `baseURL` — Proxy address plus `/dsh/<spaceId>`; **no `/v1`** (dsh client hard‑codes `${baseURL}/chat/completions`).
- `apiKeyEnv` — Name of the environment variable from which the key is read; the actual value resides in `.credentials.yaml`.
- `PROXY_USER_KEY` — Business user `user_key` (obtain from the panel).

**Request paths** (⚠️ dsh does not use a `/v1` prefix):
- `POST /dsh/:spaceId/chat/completions` (primary path)
- `POST /dsh/:spaceId/v1/chat/completions` (also accepted)

---

## 2. Session ID

| Priority | Header |
|----------|--------|
| 1 | `x-deepseek-harness-session-id` |
| 2 | `x-session-id` |

The dsh client automatically generates and sends a session ID in the header; the proxy only reads it from the header.

---

## 3. Session Init (Form)

### 3.1 Mechanism

dsh uses the **`ask_user_question`** tool_call to launch an interactive Form:
- Tool name: `ask_user_question`
- Call ID prefix: `call_dsh_session_init_`
- Protocol: OpenAI Chat Completions SSE

### 3.2 State Machine

Reuses the CodeBuddy state machine:
```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

dsh option lists have **no quantity limit**; all options are displayed at once, no pagination required.

### 3.4 Headless Bypass (Key Difference)

dsh has a unique **headless bypass** mechanism:
- Inspect `body.tools` array.
- If `body.tools` is non‑empty **but does not contain** `ask_user_question` tool → proxy treats the request as headless.
- In headless mode → **skip** session‑init entirely and forward the request.

This allows dsh to operate in non‑interactive scenarios (e.g., direct API calls, batch mode).

### 3.5 `reasoning_content` Requirement

dsh client uses DeepSeek’s thinking mode, which **hard‑validates** that assistant messages include a `reasoning_content` field. The proxy must populate a non‑empty `reasoning_content` placeholder when generating the form response.

### 3.6 Skipping Session Init

Three ways to skip:
1. Headless bypass (tools array lacks `ask_user_question`).
2. User inputs "skip" / "skip".
3. Choose "No" in the `asset_confirm` step.

### 3.7 First Session – Select Team → Agent → Task

Start the web UI:
```bash
cd /path/to/deepseek-harness
pnpm dsh web --port 3080
# or: node apps/cli/lib/bin.js web --port 3080
```
Open <http://127.0.0.1:3080> and send a message (e.g., "hi"); the proxy returns a four‑step button form:
1. "Associate team assets?" – select **Yes** to inject assets, **No** to pass through.
2. Team selector (auto‑skipped if only one team).
3. Agent selector.
4. Task selector (first option is a virtual **"Do not associate a task this time"**).
After selection, the Agent introduces itself; subsequent turns automatically inject `<session_context>`, `<available_skills>`, `<tdai_profile_memory>` blocks.

`mem:help`, `mem:sync`, `mem:create-skill`, etc., are available after session init.

---

## 4. Request Classification

dsh uses its own classification logic:

| Type | Detection | Handling |
|------|-----------|----------|
| **compact** | `x-deepseek-harness-compact: 1` header | Auxiliary request, skip injection |
| **title-gen** | Body features: no tools + `thinking.disabled` + `max_tokens≤128` + system starts with "Create a concise title..." | Auxiliary request, skip injection |
| **main** | All others | Full pipeline |

---

## 5. User Text Extraction

dsh message `content` is always a **plain string**, without wrapper tags:
- No `<user_query>` wrapper (unlike CodeBuddy).
- No content block array (unlike Claude Code).
- Directly take the `content` string of the last user message.

---

## 6. Profile Injection

dsh shares the CodeBuddy handler (both OpenAI Chat Completions), injection is similar to CodeBuddy:
```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

**Injection point**: `messages[0].content` (append to the system message string).

---

## 7. Special Behaviors

- **Shared Handler**: dsh reuses CodeBuddy's `handleChatCompletions` (not a separate handler).
- **Client Fingerprint Headers**:
  - `user-agent: deepseek-harness/*`
  - `x-deepseek-harness-user-id`
  - `x-deepseek-harness-session-id`
  - `x-deepseek-harness-compact`
- **Thinking mode**: assistant messages may include a `reasoning_content` field (DeepSeek chain‑of‑thought).
- **No `<user_query>` wrapper**: although sharing the handler with CB, the user‑text extraction logic differs (dsh does not strip tags).

---

## 8. Archiving Triggers

- Shares archiving mechanism with CodeBuddy.
- Automatic archiving when a conversation exceeds token/turn thresholds (`skill/conversation/add`).
- Manual archiving via `skill/conversation/force-archive`.

---

## 9. Environment Variables

No dsh‑specific variables. Upstream routing is dynamic (usually points to DeepSeek API).

---

## 10. FAQ

**Q: dsh and CodeBuddy share a handler; how are they distinguished?**
A: Routing distinguishes them via the `/:agent/` segment. Inside the handler, the `agentSource` field determines behavior differences (form tool name, session‑ID header, content extraction logic, etc.).

**Q: When does dsh headless bypass trigger?**
A: When the client sends a non‑empty `body.tools` array that does not contain `ask_user_question`. Typical scenario: dsh API mode with custom tools but no user interaction tool.

**Q: What is the `x-deepseek-harness-compact` header?**
A: The dsh client includes this header when performing conversation compaction. The proxy recognizes it and skips injection/archiving, forwarding the request directly to the upstream.

**Q: Why does dsh require a `reasoning_content` placeholder?**
A: DeepSeek’s thinking mode enforces that assistant messages contain a `reasoning_content` field. The proxy must provide this field (even empty) in the session‑init form response.


> agentSource: `dsh` | Protocol: OpenAI Chat Completions | Handler: `handler.ts` (Shared with CB)
>
> Local history import to Memory Hub: see [Asset Import Manual](./asset-import.md).

---

## 1. Client Access Configuration

dsh configures via **config file** `~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml`:

**`~/.dsh/settings.yaml`**：
```yaml
llm-deepseek:
  # Read proxy user_key from this environment variable name
  apiKeyEnv: PROXY_USER_KEY

  # ⚠️ Do not append /v1 —— dsh hardcodes ${baseURL}/chat/completions
  baseURL: http://127.0.0.1:8096/dsh/default

  # thinking mode
  reasoningEffort: high
```

**`~/.dsh/.credentials.yaml`**：
```yaml
PROXY_USER_KEY: <business user's sk-mem-... user_key>
```

**Permission Hard Requirement** (Checked when dsh starts, directly rejects startup if not met):
```bash
chmod 700 ~/.dsh
chmod 600 ~/.dsh/.credentials.yaml
```

Field description:
- `baseURL` — Proxy address + `/dsh/<spaceId>`; **without `/v1`** (dsh client hardcodes `${baseURL}/chat/completions`)
- `apiKeyEnv` — Specifies which environment variable name to read the key from, the value itself is in `.credentials.yaml`
- `PROXY_USER_KEY` — The business user's `user_key` (obtained from the panel)

Request path (⚠️ dsh without `/v1` prefix):
- `POST /dsh/:spaceId/chat/completions` (main path)
- `POST /dsh/:spaceId/v1/chat/completions` (also accepted)

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-deepseek-harness-session-id` |
| 2 | `x-session-id` |

The dsh client automatically generates and carries a session ID in the header, so there is no need for manual configuration. The Proxy only retrieves it from the header and has no fallback for the body.

---

## 3. Session Init (Session Initialization / Form)

### 3.1 Mechanism

dsh uses the **`ask_user_question`** tool_call to initiate an interactive Form:

- Tool name: `ask_user_question`
- Call ID prefix: `call_dsh_session_init_`
- Protocol: OpenAI Chat Completions SSE

### 3.2 State Machine

Reuse the CB state machine:

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

The options list for dsh has **no quantity limit**, no pagination is needed. All options are displayed at once.

### 3.4 Headless Bypass (⚠️ Key Difference)

dsh has a unique **headless bypass** mechanism:

- Check the `body.tools` array
- If `body.tools` is non-empty **but does not contain** the `ask_user_question` tool → the proxy is determined to be in headless mode
- In headless mode → **completely skip** session-init, pass through directly

This allows dsh to work properly in scenarios without interactive capability (such as direct API calls, batch mode).

### 3.5 reasoning_content requirements

dsh client uses DeepSeek's thinking mode, **hard validation** that assistant messages must contain the `reasoning_content` field.
proxy fills in a non-empty `reasoning_content` placeholder when generating form responses.

### 3.6 Skip Session Init

Three ways:
1. Headless bypass (no `ask_user_question` in tools) → automatically skip
2. User inputs "skip" / "skip"
3. Select "No" in asset_confirm

### 3.7 First Session - Select Team → Agent → Task

Start Web UI:

```bash
cd /path/to/deepseek-harness
pnpm dsh web --port 3080
# or: node apps/cli/lib/bin.js web --port 3080
```

Open <http://127.0.0.1:3080> in the browser, send a sentence (e.g., "hi"), and Proxy will return a 4-step button-style form:

1. "Is the team asset associated?" —— Select **Yes** to associate the injection, select **No** to pass through directly
2. Team selector (automatically skipped when there is only one team)
3. Agent selector
4. Task selector (the first item is virtual **"No task association this time"**)

After selection, the Agent will introduce itself, and then `<session_context>`, `<available_skills>`, `<tdai_profile_memory>`, and other blocks will be automatically injected in each round of conversation.

`mem:help` / `mem:sync` / `mem:create-skill` and other mem commands are also available after session init is complete.

---

## 4. Request Classification

dsh uses independent classification logic:

| Type | Recognition Method | Processing |
|------|----------|------|
| **compact** | `x-deepseek-harness-compact: 1` header | auxiliary request, skip injection |
| **title-gen** | Body feature all-in-one: no tools + thinking.disabled + max_tokens≤128 + system starts with "Create a concise title..." | auxiliary request, skip injection |
| **main** | all others | full pipeline |

---

## 5. User Text Extraction

dsh message content is always a **pure string**, with no wrapping tags:
- No `<user_query>` wrapping (different from CB)
- No content block array (different from CC)
- Directly take the content string of the last user message

---

## 6. Inject Profile

The dsh shared CB handler path (all are OpenAI Chat Completions), with the injection method similar to CB:

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

Injection point: `messages[0].content` (append within the system message string).

---

## 7. Special Behaviors

- **Shared Handler**: dsh reuses CB's `handleChatCompletions` (not a standalone handler)
- **Client fingerprint Header**:
  - `user-agent: deepseek-harness/*`
  - `x-deepseek-harness-user-id`
  - `x-deepseek-harness-session-id`
  - `x-deepseek-harness-compact`
- **Thinking mode**: assistant messages may carry a `reasoning_content` field (DeepSeek thinking chain)
- **No `<user_query>` wrapping**: shares the handler with CB but has a different user text extraction logic (dsh does not strip tags)

---

## 8. Archive Trigger

- Share archive mechanism with CB
- Automatically `skill/conversation/add` when conversation exceeds threshold
- Support `skill/conversation/force-archive`

---

## 9. Environment Variables

No dsh-specific variables. Upstream routing dynamically determines (generally pointing to the DeepSeek API).

---

## 10. Frequently Asked Questions

**Q: How to distinguish between dsh and CB sharing the handler?**
A: At the routing level, it is distinguished by the `/:agent/` segment. After entering the handler, behavioral differences are distinguished by the `agentSource` field (form tool name, session ID header, content extraction logic, etc.).

**Q: When is dsh headless bypass triggered?**
A: When the `body.tools` sent by the client is non-empty but does not contain `ask_user_question`. Typical scenario: dsh is called directly in API mode (with custom tools but no user interaction tool).

**Q: What is the `x-deepseek-harness-compact` header of dsh?**
**A:** The dsh client includes this header when performing conversation compaction. After the proxy recognizes it, it skips injection/archiving and directly forwards it to the upstream for compaction.

**Q: Why does dsh need reasoning_content placeholder?**
**A:** The client of DeepSeek thinking mode has a hard validation on the format of assistant messages — it must have the `reasoning_content` field. The session-init form response generated by proxy is also an assistant message, so it must include this field (the content can be an empty string or a placeholder).

---

## 11. Differences from Claude Code / CodeBuddy / Codex

| Dimension | Claude Code | CodeBuddy | Codex | **dsh** |
|---|---|---|---|---|
| Protocol | Anthropic Messages | OpenAI Chat | OpenAI Responses | **OpenAI Chat** |
| Config | Environment variables | `~/.codebuddy/models.json` | `~/.codex/config.toml` | `~/.dsh/settings.yaml` + `.credentials.yaml` |
| URL Prefix | `/claude-code/<spaceId>` | `/codebuddy/<spaceId>` | `/codex/<spaceId>` | **`/dsh/<spaceId>`** (without `/v1`) |
| Key Passing | env `ANTHROPIC_AUTH_TOKEN` | JSON `apiKey` | TOML `experimental_bearer_token` | `.credentials.yaml` environment variables |
| Session init | Auto form popup | Auto form popup | Requires switching to Plan mode on first use | **Auto form popup** |
| UI Form tool | `AskUserQuestion` | `ask_followup_question` | fake `function_call` | **`ask_user_question`** (native to dsh) |
| Wire special | cache_control markers | None | encrypted rs_id | **tool-call round `reasoning_content` required** (handled automatically by Proxy) |

---

## 12. Current Status

- ✅ Code implementation completed
- ✅ Local verification passed
- ⚠️ Not yet used on a large scale in the production environment
