# CodeBuddy (CB)

> agentSource: `codebuddy` | Protocol: OpenAI Chat Completions / Anthropic Messages | Handler: `handler.ts` (shared)

> Local history import into Memory Hub: see the [Asset Import Guide](./asset-import.md).

---

## 1. Client Configuration

CodeBuddy configures custom models via a **configuration file** `~/.codebuddy/models.json`:

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-20250514",
      "name": "proxy-memory-agent",
      "vendor": "claude",
      "apiKey": "<business user sk-mem-... user_key>",
      "maxInputTokens": 200000,
      "url": "http://127.0.0.1:8096/codebuddy/default",
      "supportsToolCall": true,
      "supportsImages": true
    }
  ]
}
```

**Field explanation:**
- `id` — Model ID supported by the proxy upstream (e.g., `claude-sonnet-4-20250514`).
- `name` — Display name in the CodeBuddy UI, customizable.
- `vendor` — UI display only (e.g., `claude`, `openai`), does not affect the request.
- `apiKey` — Business user `user_key` (same as CC's `ANTHROPIC_AUTH_TOKEN`), obtained from the panel.
- `url` — Proxy address plus `/codebuddy/<spaceId>`; `default` is the memory instance ID.

After configuration, select the model in the CodeBuddy chat window.

### ⚠️ Version Limitation

> CodeBuddy **4.10.2 ~ 4.10.4** does not carry `sessionId`, so Session Init cannot be performed.
> **Please use ≥ 4.10.5 or ≤ 4.10.1**.

**Request paths:**
- OpenAI: `POST /codebuddy/:spaceId/v1/chat/completions`
- Anthropic: `POST /codebuddy/:spaceId/v1/messages`

---

## 2. Session ID

| Priority | Header |
|----------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |
| 3 | `x-cb-session-id` |
| 4 | `x-codebuddy-session-id` |

The CodeBuddy IDE plugin automatically generates and sends `x-conversation-id`.

---

## 3. Session Init (Form)

### 3.1 Mechanism

CodeBuddy uses **`ask_followup_question`** function_call to launch an interactive Form:
- Tool name: `ask_followup_question`
- Call ID prefix: `call_session_init_` (OpenAI) / `toolu_session_init_` (Anthropic)
- Protocol: OpenAI SSE `tool_calls` chunks or Anthropic SSE

### 3.2 State Machine

```
asset_confirm → team_select → agent_task_select → initialized
```

Four steps:
1. **asset_confirm** – confirm whether assets need injection (“Use memory/skills?”)
2. **team_select** – select team
3. **agent_task_select** – combined Agent + Task selection
4. **initialized** – inject assets and enter normal conversation

### 3.3 Pagination

CodeBuddy’s `ask_followup_question` option list has **no limit**; all options are displayed at once, no pagination needed.

### 3.4 Plan Mode / Default Mode

CodeBuddy **does not have** a Default Mode gate. The client always has the `ask_followup_question` tool available, and the form can always be sent.

### 3.5 Skipping Session Init

- In the `asset_confirm` step, choose **“No”** → skip all subsequent steps and pass through the request.
- At any step, type **“skip”** (or similar); the `SKIP_RE` regex matches and the step is bypassed.

---

## 4. Request Classification

CodeBuddy’s request classification is simple:

| Type | Description |
|------|-------------|
| **main** | All requests default to main |

CodeBuddy **does not have** fork / sidequery / compact auxiliary request concepts; every request goes through the full pipeline.

---

## 5. User Text Extraction

The `message.content` field in CodeBuddy is always a **plain string** (not an array of content blocks).

**Extraction logic:**
1. Search the string for `<user_query>...</user_query>` XML wrapper.
2. If found, extract the inner text.
3. If not found, treat the entire string as user text.
4. Strip CodeBuddy pseudo‑XML tags such as `<agent_context>`, `<code_context>`, etc.

---

## 6. Profile Injection

Injection uses an **XML structure** for the system prompt:

```xml
<agent_skills>
  <available_skills>...</available_skills>
</agent_skills>
<content_policy>...</content_policy>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

**Injection point:**
- OpenAI: `messages[0].content` (append to the system message string)
- Anthropic: `system` field

---

## 7. Special Behaviors

- **Unique header set**: `x-agent-intent`, `x-conversation-message-id`, `x-conversation-request-id`.
- **Assistant placeholder**: CodeBuddy assistant messages may be `"-"` as a placeholder (empty reply marker).
- **Shared handler**: dsh reuses this handler (`handleChatCompletions`).
- **Dual‑protocol support**: The same CodeBuddy version may use OpenAI or Anthropic protocol; the handler automatically adapts.

---

## 8. Archiving Triggers

- Automatic archiving when a conversation exceeds token or turn thresholds (`skill/conversation/add`).
- Manual archiving via `skill/conversation/force-archive`.
- Archived data is written to L0.

---

## 9. Environment Variables

There are no CodeBuddy‑specific variables; use the global proxy configuration:

```env
PROXY_PORT=8096
FORWARD_URL=https://api.openai.com   # CB OpenAI upstream
# or FORWARD_URL=https://api.anthropic.com  # CB Anthropic upstream
```

The actual upstream is determined dynamically by `resolveForwardTarget` (tokenhub / direct provider).

---

## 10. FAQ

**Q: What are the main differences between CB and CC?**
A: Different protocols (OpenAI vs Anthropic), different content structures (string vs content‑block array), no auxiliary request classification, and options are not paginated.

**Q: Who adds the `<user_query>` wrapper?**
A: The CodeBuddy IDE plugin client automatically wraps the user’s original text before sending; the proxy strips it during extraction.

**Q: When CB uses the Anthropic protocol, how does it differ from CC?**
A: The form tool name is different (`ask_followup_question` vs `AskUserQuestion`), content remains a string, injection uses XML instead of Markdown, and the `agentSource` marker differs.


> agentSource: `codebuddy` | Protocol: OpenAI Chat Completions / Anthropic Messages | Handler: `handler.ts` (Shared)
>
> Local history import to Memory Hub: see [Asset Import Manual](./asset-import.md).

---

## 1. Client Access Configuration

CB configures custom models via the **config file** `~/.codebuddy/models.json`:

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-20250514",
      "name": "proxy-memory-agent",
      "vendor": "claude",
      "apiKey": "<business user's sk-mem-... user_key>",
      "maxInputTokens": 200000,
      "url": "http://127.0.0.1:8096/codebuddy/default",
      "supportsToolCall": true,
      "supportsImages": true
    }
  ]
}
```

Field description:
- `id` — Model ID supported by the upstream Proxy (e.g., `claude-sonnet-4-20250514`)
- `name` — Name displayed in the CodeBuddy dialog, customizable
- `vendor` — For UI display (e.g., `claude`, `openai`); does not affect actual requests
- `apiKey` — The business user's `user_key` (obtained from the panel, same as CC's `ANTHROPIC_AUTH_TOKEN`)
- `url` — Proxy address + `/codebuddy/<spaceId>`; `default` is the memory instance ID

After configuration, select the model in the CB dialog box.

### ⚠️ Version Limitations

> CodeBuddy **4.10.2 ~ 4.10.4** does not carry sessionId, so it cannot complete Session Init.
> **Please use ≥ 4.10.5 or ≤ 4.10.1**.

Requested path:
- OpenAI: `POST /codebuddy/:spaceId/v1/chat/completions`
- Anthropic: `POST /codebuddy/:spaceId/v1/messages`

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |
| 3 | `x-cb-session-id` |
| 4 | `x-codebuddy-session-id` |

The CB IDE plugin automatically generates and carries `x-conversation-id`.

---

## 3. Session Init (Session Initialization / Form)

### 3.1 Mechanism

CB initiates an interactive Form using the **`ask_followup_question`** function_call:

- Tool name: `ask_followup_question`
- Call ID prefix: `call_session_init_` (OpenAI) / `toolu_session_init_` (Anthropic)
- Protocol: OpenAI SSE tool_calls chunks or Anthropic SSE

### 3.2 State Machine

```
asset_confirm → team_select → agent_task_select → initialized
```

4-step process:
1. **asset_confirm** — Confirm whether assets need to be injected ("Do you use memory/skills?")
2. **team_select** — Select team
3. **agent_task_select** — Select Agent + Task together
4. **initialized** — Inject assets and enter normal conversation

### 3.3 Pagination

The `ask_followup_question` option list of CB has **no quantity limit** and does not require pagination.
All options are displayed all at once.

### 3.4 Plan Mode / Default Mode

CB **does not exist** Default Mode gate. The CB client always has the `ask_followup_question` tool available, and the form can always be sent.

### 3.5 Skip Session Init

- Select "No" in the `asset_confirm` step → skip all subsequent steps and pass through directly
- Input "Skip" / "skip" in any step → skip after SKIP_RE matches

---

## 4. Request Classification

The request classification of CB is relatively simple:

| Type | Description |
|------|------|
| **main** | All requests default to main |

CB **does not** have auxiliary request concepts such as fork / sidequery / compact. Each request goes through the complete pipeline.

---

## 5. User Text Extraction

The `message.content` in the CB message body is always a **pure string** (not a content block array).

Extract logic:
1. Search for `<user_query>...</user_query>` XML wrapping within the string
2. If found → extract the internal text
3. If not found → use the entire string as the user text
4. Strip CB pseudo XML tags (`<agent_context>`, `<code_context>`, etc.)

---

## 6. Inject Profile

**XML structure** system prompt injection:

```xml
<agent_skills>
  <available_skills>...</available_skills>
</agent_skills>
<content_policy>...</content_policy>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

Injection point:
- OpenAI: `messages[0].content` (appended within the system message string)
- Anthropic: `system` field

---

## 7. Special Behaviors

- **Unique Header Set**: `x-agent-intent`, `x-conversation-message-id`, `x-conversation-request-id`
- **Assistant Placeholder**: CB assistant messages may be `"-"` placeholders (empty reply markers)
- **Shared Handler**: dsh also reuses this handler (`handleChatCompletions`)
- **Dual Protocol Support**: The same CB version may use either OpenAI or Anthropic protocols, and the handler auto-adapts

---

## 8. Archive Trigger

- Automatically trigger `skill/conversation/add` when the conversation exceeds the threshold
- Support `skill/conversation/force-archive`
- Write archived data to L0

---

## 9. Environment Variables

There is no CB-specific variable. Use the global proxy configuration:

```env
PROXY_PORT=8096
FORWARD_URL=https://api.openai.com   # CB OpenAI upstream
# or FORWARD_URL=https://api.anthropic.com  # CB Anthropic upstream
```

Actually, the upstream is dynamically determined by `resolveForwardTarget` (tokenhub / direct provider).

---

## 10. Common Questions

What is the main difference between CB and CC?
A: Different protocols (OpenAI vs Anthropic), different content structures (string vs content-block array), no auxiliary request classification, no pagination for options.

**Q: Who added the `<user_query>` wrapping for CB?**
**A:** The CB IDE plugin client automatically wraps the user's original text before sending, and the proxy strips it during extraction.

**Q: What is the difference between CB using the Anthropic protocol and CC?**
A: The form tool name differs (`ask_followup_question` vs `AskUserQuestion`), the content is still in string format, injection uses XML rather than Markdown. The agentSource marker differs.
