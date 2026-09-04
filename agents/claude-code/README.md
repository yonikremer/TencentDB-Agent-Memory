# Claude Code (CC)

> agentSource: `claude-code` | Protocol: Anthropic Messages API | Handler: `anthropicHandler.ts`
>
> Local history import into Memory Hub: see the [Asset Import Guide](./asset-import.md).

---

## 1. Client Configuration

### Method 1: Environment Variables

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="<business user sk-mem-... user_key>"
claude --model <PROXY_UPSTREAM_MODEL defined upstream>
```

### Method 2: Configuration File `~/.claude/settings.json` (recommended, persistent)

Edit `~/.claude/settings.json` and add the following to the `env` field:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<business user sk-mem-... user_key>",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default",
    "ANTHROPIC_MODEL": "claude-opus-4.7"
  }
}
```

After configuration, simply run `claude`; the client will load the environment variables from `settings.json`.

#### Field Explanation

- `ANTHROPIC_BASE_URL`: Redirects the CC API to the proxy; the `default` segment is the memory instance ID (`x-tdai-service-id`), fixed as `default` for local deployments.
- `ANTHROPIC_AUTH_TOKEN`: **Business user** API key (obtain from the panel "API Key" page; do not use the admin key).
- `ANTHROPIC_MODEL`: Upstream model name (can also be set via `--model` CLI flag).

The proxy performs: `auth` (validate `user_key`) → `sessionInit` (team/agent/task form) → `injection` (inject L2/L3 memory, skill, knowledge into system prompt) → forward to upstream LLM.

Client requests hit `POST /claude-code/:spaceId/v1/messages`.

---

## 2. Session ID

| Priority | Header |
|----------|--------|
| 1 | `x-claude-code-session-id` |
| 2 | `x-session-id` |
| 3 | `x-conversation-id` |

CC automatically generates a session ID on each start and sends it with requests; no manual configuration needed.

---

## 3. Session Init (Form)

### 3.1 Mechanism

CC uses **Anthropic native `tool_use`** to launch an interactive Form:

- Tool name: `AskUserQuestion`
- Block ID prefix: `toolu_cc_session_init_`
- Protocol: Anthropic SSE (`content_block_start` / `content_block_delta` / `content_block_stop` events)

### 3.2 State Machine

```
team_select → agent_select → task_select → initialized
```

Four steps:
1. **team_select** – select team
2. **agent_select** – select agent
3. **task_select** – select task (includes a virtual `isDefault` entry to skip)
4. **initialized** – inject assets and enter normal conversation.

### 3.3 Pagination

CC's `AskUserQuestion` tool is limited to **2‑4 options** (Anthropic protocol constraint). When options exceed 3, pagination is used:

- Each page shows 3 real options + a "More →" entry.
- Selecting "More →" returns the next page.
- The last page has no pagination entry.

### 3.4 Plan Mode / Default Mode

CC **does not have** a Default Mode gate. The client always supports `tool_use`, and the form is always available.

### 3.5 Skipping Session Init

Users can type **"skip"** (or similar) at any step; the proxy will bypass the form and pass through the request without asset injection.

---

## 4. Request Classification

CC distinguishes several request types:

| Type | Detection | Handling |
|------|-----------|----------|
| **main** | default | Full pipeline (injection + archiving + telemetry) |
| **fork** | `cache_control` marker location analysis | Full pipeline (sub‑agent shares `session_id`) |
| **sidequery** | `cache_control` marker + specific pattern | Lightweight handling |
| **compact** | URL suffix `/compact` | Auxiliary request, skip injection |
| **title-gen** | URL suffix + body characteristics | Auxiliary request, skip injection |

CC's `cache_control` marker is the core criterion for distinguishing main vs auxiliary requests.

---

## 5. User Text Extraction

From the last `role: "user"` message in `body.messages`:
- Take the last `type: "text"` content block.
- **Skip** blocks that start with `<system-reminder>` (these are system injections, not user text).

---

## 6. Profile Injection

The system prompt injection uses a **Markdown** structure:

```markdown
## Skills
<available_skills>...</available_skills>

## Memory
<user_memory>...</user_memory>

# Harness
<session_context>...</session_context>
```

The injection point is the `body.system` field (the Anthropic protocol separates `system` from `messages`).

---

## 7. Special Behaviors

- **resetEpoch**: Supports the `mem:session-reset` command for cross‑node stale checks.
- **Vertex AI relay**: Supports passthrough of `x-vertex-ai-session-id`.
- **Fork/Subagent**: When a `task` command creates a sub‑agent, the `session_id` remains unchanged; the proxy aggregates sub‑agent data with the main agent for archiving.
- **mem commands**: Fully supports `mem:sync`, `mem:create-skill`, `mem:session-reset`, etc.

---

## 8. Archiving Triggers

- Automatic archiving when a conversation exceeds token or turn thresholds (`skill/conversation/add`).
- Manual archiving via `skill/conversation/force-archive`.
- Archived data is written to L0 (TDAI write).

---

## 9. Environment Variables

There are no CC‑specific variables; use the global proxy configuration:

```env
PROXY_PORT=8096
FORWARD_URL=https://api.anthropic.com   # CC upstream
```

---

## 10. FAQ

**Q: Could CC stall if the form has too many options?**
A: No. Pagination ensures a maximum of 4 options per page; users may need to page through many options.

**Q: Do sub‑agent requests trigger Session Init again?**
A: No. Sub‑agents reuse the main agent's `session_id`; the proxy detects the initialized state and skips the form.

**Q: Do auxiliary requests (title‑gen / compact) undergo injection?**
A: No. The proxy forwards auxiliary requests directly without injection or archiving.
