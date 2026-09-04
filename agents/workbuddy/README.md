# WorkBuddy (WB)

> agentSource: `workbuddy` | Protocol: OpenAI Responses API (Desktop) + Chat Completions (Web) | Handler: `workbuddyHandler.ts` (Standalone)
>
> Local history import to Memory Hub: see [Asset Import Manual](./asset-import.md).

---

## 1. Client Access Configuration

WB configures custom models through the **config file** `~/.workbuddy/models.json`:

```json
[
  {
    "id": "claude-opus-4.7-1m",
    "name": "claude-opus-4.7-1m",
    "vendor": "Custom",
    "url": "http://127.0.0.1:8096/workbuddy/default",
    "apiKey": "<business user's sk-mem-... user_key>",
    "supportsToolCall": true,
    "supportsImages": false,
    "supportsReasoning": false,
    "useCustomProtocol": false
  }
]
```

Field description:
- `id` — Model ID supported by the Proxy upstream (e.g., `claude-opus-4.7-1m`)
- `name` — Name displayed in the WorkBuddy "Custom Models" list
- `vendor` — For UI display (`Custom`, `claude`, etc.), does not affect actual requests
- `url` — Proxy address + `/workbuddy/<spaceId>`; `default` is the memory instance ID
- `apiKey` — The business user's `user_key` (obtained from the panel)

After configuration is complete, select the model in the WorkBuddy model selector under "Custom Models".
Session init is consistent with CC/CB (select Team → Agent → Task); the session ID is automatically managed by the client.

Request path:
- Desktop: `POST /workbuddy/:spaceId/v1/responses` or `/workbuddy/:spaceId/responses`
- Web: `POST /workbuddy/:spaceId/v1/chat/completions`

Auxiliary path (same as Codex):
- `/workbuddy/:spaceId/responses/compact`
- `/workbuddy/:spaceId/memories/trace_summarize`
- `/workbuddy/:spaceId/realtime/calls`

---

## 2. Session ID

| Priority | Source |
|--------|------|
| 1 | `session-id` header |
| 2 | `body.client_metadata.session_id` |

The WB client automatically generates and carries the session ID, requiring no manual configuration from the user.

---

## 3. Session Init

The WB session init is consistent with CC/CB — interactively selecting Team → Agent → Task via Form.

### 3.1 Interactive Form

When the client's `body.tools` contains the `AskUserQuestion` tool, it goes through an interactive form:

- Tool name: `AskUserQuestion` (Same as CC)
- Call ID prefix: `call_wb_session_init_`
- Pagination: CC-style pagination (max 4 options)
- State machine: Reuse CB state machine

### 3.4 Default Mode Gate

WB Desktop also has a Default mode gate (same as Codex):
The client returns `"request_user_input is unavailable in Default mode"` → permanently skips the form.

---

## 4. Request Classification

WB uses the same **three-signal** auxiliary request determination as Codex:

| Signal | Check Content |
|------|----------|
| Path suffix | `/compact`, `/memories/trace_summarize`, `/realtime/calls` |
| Header | `x-openai-memgen-request: true` |
| Body | `body.client_metadata.thread_source` ≠ `"main"` |

---

## 5. User Text Extraction

WB has two protocols, so user text extraction is **dual-mode**:

| Mode | Protocol | Extraction Method |
|------|------|----------|
| Desktop | Responses API | Extract from `body.input[]` (same as Codex algorithm) |
| Web | Chat Completions | Extract from `messages[].content` string + strip `<user_query>` (same as CB algorithm) |

---

## 6. Inject Profile

WB has an independent injection Profile, located at `injection/agents/workbuddy/`:

- Independent parser / serializer
- System prompt uses **nunjucks template**, with placeholders:
  ```
  {{ WorkbuddyMemory_1 }}
  {{ WorkbuddySkills }}
  {{ WorkbuddyKnowledge }}
  ```
The injection point depends on the protocol:
  - Responses API: `body.instructions`
  - Chat Completions: `messages[0].content`

---

## 7. Special Behaviors

- **Independent Handler**: `workbuddyHandler.ts`, with zero cross-references to Codex/CB/CC
- **Dual Protocol Coexistence**: Desktop uses the Responses API, Web uses Chat Completions, handled within the same handler
- **Desktop SDK**: The client uses the `@openai/agents 0.5.2` SDK
- **Unique Header Set**: `X-Agent-Intent`, `X-Agent-Purpose`, `X-User-Id`, `X-Codebuddy-Run-Timeout`
- **nginx Routing**: Internal nginx needs to configure `/workbuddy/:iid/*` to forward to proxy (added on 2026-08-13)

---

## 8. Archive Trigger

- Share archive mechanism with Codex
- Automatically `skill/conversation/add` when conversation exceeds threshold
- Support `skill/conversation/force-archive`

---

## 9. Environment Variables

No WB-specific variables. The upstream routing is dynamically determined by `resolveForwardTarget`.

---

## 10. Frequently Asked Questions

**Q: What is the simplest way to connect to WB?**
A: You can simply add the `x-tdai-team-id` / `x-tdai-agent-id` / `x-tdai-task-id` headers to the client request. The proxy will directly register and inject assets, with zero interaction latency.

**Q: What happens if WB has no header and no tool?**
A: Silent pass-through. No error, no blocking, but also no memory/skill injection. This is intentional design — WB does not force integration with memory.

**Q: Why do the WB Desktop and Web use different protocols?**
A: The Desktop version uses the `@openai/agents` SDK to use the Responses API; the Web version uses the standard Chat Completions. The proxy supports both, distinguishing them automatically by path.

**Q: What is the relationship between WB and Codex code?**
A: Completely independent. Although both support the Responses API, WB has its own handler, injection profile, and template system. There is no cross-import.
