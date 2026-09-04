# OpenCode

> agentSource: `opencode` | Protocol: OpenAI Chat Completions | Handler: `handler.ts` (Shared with CB / dsh)

---

## 1. Client Access Configuration

OpenCode is the open-source AI coding CLI by [SST](https://github.com/sst/opencode), via
`~/.config/opencode/opencode.json` configures a custom provider to connect to Proxy:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "proxy-memory": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Proxy Memory (OpenCode)",
      "options": {
        "baseURL": "http://127.0.0.1:8096/opencode/default/v1",
        "apiKey": "<business user's sk-mem-... user_key>"
      },
      "models": {
        "claude-opus-4.7-1m": {
          "name": "claude-opus-4.7-1m"
        }
      }
    }
  }
}
```

Field description:
- `baseURL` — Proxy address + `/opencode/<spaceId>/v1`; `default` is the memory instance ID (spaceId)
- `apiKey` — The business user's `user_key` (copy from the MemoryPanel panel → OpenCode card)
- `models.<id>.name` — Model IDs supported by the Proxy upstream (e.g., `claude-opus-4.7-1m`)
- OpenCode uses the `@ai-sdk/openai-compatible` provider, following the **OpenAI Chat Completions** protocol

After starting OpenCode, select a model under `proxy-memory` in the `/model` selector.

Request path:
- Main path: `POST /opencode/:spaceId/v1/chat/completions`
- Bare tail variant: `POST /opencode/:spaceId/chat/completions` (when `baseURL` does not include `/v1`)

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |

OpenCode client itself **does not carry** session ID header, proxy will automatically generate for each request
A stable sessionId (based on request context), behaviorally equivalent to "each session being independent".

If `x-conversation-id` is attached via the wrapper / proxy layer, the proxy will use it preferentially.

---

## 3. Session Init (Session Initialization / Form)

### 3.1 Mechanism

OpenCode reuses CB's **`ask_followup_question`** function_call mechanism to initiate an interactive Form:

- Tool name: `ask_followup_question`
- Call ID prefix: `call_oc_session_init_` (the handler uses a separate prefix for opencode, distinguishing it from CB `call_session_init_` / dsh `call_dsh_session_init_`)
- Protocol: OpenAI SSE tool_calls chunks

### 3.2 State Machine

Reuse the CB state machine:

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

Unlimited quantity, all options displayed at once.

### 3.4 Skip Session Init

- `asset_confirm` select "No" → pass through directly
- Any step input "Skip" / "skip" → skip

---

## 4. Marker Routing (⚠️ Key Point)

OpenCode supports appending **marker** via URL segments to trigger cost-guard routing or analyse request classification,
Usage is fully aligned with CB / Codex:

| Marker | Path | Purpose |
|--------|------|------|
| （None） | `/opencode/<spaceId>/v1/chat/completions` | Default uses the general pipeline |
| **cost-guard** | `/opencode/<spaceId>/cost-guard/v1/chat/completions` | Forces use of the cost-guard tier |
| **analyse** | `/opencode/<spaceId>/analyse/v1/chat/completions` | Marks the request as analyse |

Naked tail variant (when `baseURL` does not contain `/v1`):
- `/opencode/<spaceId>/cost-guard/chat/completions`
- `/opencode/<spaceId>/analyse/chat/completions`

### 4.1 marker gating

Both marker routes are controlled by the configuration gate `assetReflection.markerOptIn`:
- `markerOptIn: true` → hit and take effect
- `markerOptIn: false` → return `404 {"error":"cost_guard_marker_disabled"}` / similar

See `MemoryProxy/z_config/config.yaml` → `assetReflection.markerOptIn`.

### 4.2 How the Client is Used

Switch directly in the `baseURL` of opencode.json:

```jsonc
// Default level
"baseURL": "http://127.0.0.1:8096/opencode/default/v1"

// Force cost-guard
"baseURL": "http://127.0.0.1:8096/opencode/default/cost-guard/v1"

// analyse classification (for backend link identification)
"baseURL": "http://127.0.0.1:8096/opencode/default/analyse/v1"
```

---

## 5. Request Classification

The request classification of OpenCode is relatively simple:

| Type | Description |
|------|------|
| **main** | All requests default to main |
| **analyse** | Mark as analyse when URL has `/analyse/` marker (for report layer to identify) |

OpenCode **does not** have auxiliary request concepts such as fork / sidequery / compact.

---

## 6. User Text Extraction

OpenCode message body `message.content` is a **pure string** (not a content block array, and does not
XML wrapping:

- Do not use `<user_query>` wrapping (different from CB)
- Do not use content block array (different from CC)
- Directly take the content string of the last user message

Image input is passed through the `image_url` content-part (the client base64-encodes it and the proxy directly
Forward to upstream), no special handling on the proxy side.

---

## 7. Inject Profile

The handler path for OpenCode's shared CB (all OpenAI Chat Completions) is consistent in its injection method:

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

Injection point: `messages[0].content` (append within the system message string).

---

## 8. Special Behaviors

- **Shared Handler**: OpenCode reuses CB's `handleChatCompletions` (same path as dsh)
- **agentSource distinction**: Route layer `/opencode/` segment → `agentSource=opencode`
- **No independent header fingerprint**: OpenCode CLI does not carry custom headers, proxy relies on URL segment + user-agent for identification
- **Marker routing**: `/cost-guard/` and `/analyse/` two URL markers, see §4

---

## 9. Archive Trigger

- Share archive mechanism with CB / dsh
- Automatically `skill/conversation/add` when conversation exceeds threshold
- Support `skill/conversation/force-archive`
- Write archived data to L0

---

## 10. Environment Variables

No OpenCode-specific variables. Upstream routing is dynamically determined by `resolveForwardTarget`
(usually pointing to tokenhub or direct provider).

---

## 11. Frequently Asked Questions

**Q: How to distinguish OpenCode and CB / dsh sharing the handler?**
A: At the routing level, it is distinguished by the `/:agent/` segment. After entering the handler, it is triggered via `agentSource=opencode`
OpenCode-specific behaviors (marker routing, self-generated session IDs, etc.).

**Q: Is `baseURL` in opencode.json required to have `/v1`?**
**A: It is recommended to include it (main path), and proxy also accepts the bare tail variant (without `/v1`). Both are supported.**

**Q: What to do about marker routing 404?**
A: Check whether `MemoryProxy/z_config/config.yaml`'s `assetReflection.markerOptIn` is
`true`. After modifying it, `./scripts/proxy.sh restart` loads it.

**Q: Does OpenCode CLI itself support the `@image:path` syntax?**
A: This is a capability on the OpenCode client side, and is unrelated to the proxy. The client reads the file, converts it to base64, and inserts it into `image_url`
content-part, and the proxy transparently forwards it to the upstream.

**Q: Can local historical session / skill be imported into Memory Hub?**
A: OpenCode client does not persist skill / session files locally (unlike CB / dsh), and there is currently no
`asset-import.md`. If you need to import historical conversations, manually import them via Panel or use the `mem:sync` command.

---

Differences from CB / dsh

| Dimension | CodeBuddy | dsh | **OpenCode** |
|---|---|---|---|
| Protocol | OpenAI Chat Completions | OpenAI Chat Completions | **OpenAI Chat Completions** |
| Config File | `~/.codebuddy/models.json` | `~/.dsh/settings.yaml` + `.credentials.yaml` | **`~/.config/opencode/opencode.json`** |
| URL Prefix | `/codebuddy/<spaceId>` | `/dsh/<spaceId>` (without `/v1`) | **`/opencode/<spaceId>`** |
| Provider Library | Built-in | Built-in | **`@ai-sdk/openai-compatible`** |
| Key Passing | JSON `apiKey` | `.credentials.yaml` environment variable | **JSON `provider.*.options.apiKey`** |
| Form Tool | `ask_followup_question` | `ask_user_question` | **`ask_followup_question`** (same as CB) |
| Session ID | client with `x-conversation-id` | client with `x-deepseek-harness-session-id` | **auto-generated by proxy** |
| Marker routing | none | none | **`/cost-guard/` `/analyse/`** |
| Local asset import | yes (`asset-import.md`) | yes (`asset-import.md`) | **none** (no file is written by the client) |

---

## 13. Current Status

- ✅ Code implementation complete (handler reuses CB path)
- ✅ marker routing (cost-guard / analyse) unit tests 6/6 passed
- ✅ End-to-end curl verification passed (3 real upstream streaming responses)
- ✅ Panel has displayed OpenCode card
