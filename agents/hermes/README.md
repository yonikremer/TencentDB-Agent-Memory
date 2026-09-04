# Hermes

> agentSource: `hermes` | Protocol: OpenAI Chat Completions | Session Init: Header Pre-selection (No-Interaction Form)
>
> Local history import to Memory Hub: see [Asset Import Manual](./asset-import.md).

---

## 1. Client Access Configuration

Hermes is configured via **config file** `~/.hermes/config.yaml`:

```yaml
model:
  default: gpt-5.5
  provider: custom
  base_url: http://<proxy-host>:8096/hermes/<spaceId>
  api_key: <business user's sk-mem-... user_key>
  extra_headers:
    x-team-id: <team_id fetched from the panel>
    x-agent-id: <agent_id fetched from the panel>
    x-task-id: <task_id fetched from the panel>
    x-conversation-id: <custom conversation identifier>
```

Field description:
- `base_url` — Proxy address + `/hermes/<spaceId>`; `default` is the memory instance ID
- `api_key` — The business user's `user_key` (obtained from the panel)
- `x-team-id` / `x-agent-id` / `x-task-id` — Obtained from the corresponding pages of the panel
- `x-conversation-id` — User-defined conversation identifier (see §6 Known Limitations below)

Request path: `POST /hermes/:spaceId/v1/chat/completions`

---

## 2. Session ID

| Source | Header |
|------|--------|
| Unique | `x-conversation-id` (statically specified by the user in the configuration file) |

⚠️ Hermes does not automatically manage the session ID, and the user needs to manually change `x-conversation-id` for each new conversation.

---

## 3. Session Init

### ⚠️ Core Difference: Pure Header Pre-selection, No Interactive Form

Hermes **does not support interactive forms** (the client cannot respond to the function_call returned by the proxy).
Session registration completely relies on the Header carried in the request:

| Header | Description | Required |
|--------|------|------|
| `x-team-id` | Team ID | ✅ |
| `x-agent-id` | Agent ID | ✅ |
| `x-task-id` | Task ID | ✅ (Current Version) |
| `x-conversation-id` | Conversation ID | ✅ |

**Processing logic**:
- All four headers exist and are valid → directly register session, inject assets
- Any missing → session bypass (pass-through, no injection)

No Plan Mode / Default Mode

Hermes does not involve the concept of Plan/Default mode. Either the header is complete and the full pipeline is executed, or bypass.

---

## 4. Request Classification

All requests are **main**. Hermes has no auxiliary request concept.

---

## 5. Inject Profile

Same as CB — XML structure is injected into `messages[0].content` (system message).

---

## 6. Known Constraints

### `x-task-id` is currently required

The Proxy's header pre-selection mechanism requires all three IDs to be present to complete session registration. When `x-task-id` is missing, the proxy attempts to pop a form, but Hermes cannot respond → session bypass → memory injection does not take effect.

**Impact**:
- Users need to create a Task in the panel in advance and obtain the task_id
- Switching tasks requires manually modifying the configuration file

`x-conversation-id` needs to be managed manually

- All requests sharing the same conversation ID share the same session
- Each new conversation requires manual session switching (otherwise the previous session state is retained)
- Some client tool call subsequent requests may not carry extra headers → skip injection for those rounds

---

## 7. Common Questions

**Q: Is memory injection not working?**
A: Check whether all four values in `extra_headers` are filled in and correct. Any missing or incorrect value will cause session bypass.

**Q: How to get team_id / agent_id / task_id?**
A: Log in to the panel → go to the corresponding page → the details contain ID fields. Or use the panel API `team/list`, `agent/list`, `task/list` to query.

**Q: What if I don't want to bind a Task?**
**A:** It is required in the current version. You can use this fixed value after configuring `sessionInit.defaultTaskId: "no-task"` in the proxy `config.yaml`.
