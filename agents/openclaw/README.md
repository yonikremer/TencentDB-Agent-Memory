# OpenClaw

> agentSource: `openclaw` | Protocol: OpenAI Chat Completions | Session Init: Header Pre-selection (No-interaction Form)
>
> Local history import to Memory Hub: see [Asset Import Manual](./asset-import.md).

---

## 1. Client Access Configuration

OpenClaw is configured via the `models.providers` section of the `~/.openclaw/openclaw.json` **config file**:

```jsonc
{
  "models": {
    "mode": "merge",
    "providers": {
      "memory-proxy": {
        "baseUrl": "http://<proxy-host>:8096/openclaw/<spaceId>",
        "apiKey": "<business user's sk-mem-... user_key>",
        "api": "openai-completions",
        "headers": {
          "x-team-id": "<team_id fetched from the panel>",
          "x-agent-id": "<agent_id fetched from the panel>",
          "x-task-id": "<task_id fetched from the panel>",
          "x-conversation-id": "<custom conversation identifier>"
        },
        "request": {
          "allowPrivateNetwork": true
        },
        "models": [
          {
            "id": "gpt-5.5",
            "name": "GPT-5.5",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 32000,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  }
}
```

Field description:
- `baseUrl` — Proxy address + `/openclaw/<spaceId>`; `default` is the memory instance ID
- `apiKey` — The business user's `user_key` (obtained from the panel)
- `api` — Must be `"openai-completions"`
- `headers` — Must include `x-team-id`, `x-agent-id`, `x-task-id`, `x-conversation-id`
- `models[].id` — Must match the model ID configured in the Proxy upstream
- `allowPrivateNetwork: true` — allows access to private network addresses

Request path: `POST /openclaw/:spaceId/v1/chat/completions`

---

## 2. Session ID

| Source | Header |
|------|--------|
| Unique | `x-conversation-id` (statically specified by the user in the configuration file) |

Like Hermes, OpenClaw does not automatically manage the session ID and requires manual replacement.

---

## 3. Session Init

### ⚠️ Core Difference: Pure Header Pre-selection, No Interactive Form

OpenClaw is exactly the same as Hermes —— **does not support interactive forms**, Session registration relies on Header:

| Header | Description | Required |
|--------|------|------|
| `x-team-id` | Team ID | ✅ |
| `x-agent-id` | Agent ID | ✅ |
| `x-task-id` | Task ID | ✅ (Current Version) |
| `x-conversation-id` | Conversation ID | ✅ |

**Processing logic**:
- All four headers exist and are valid → directly register session, inject assets
- Any missing → session bypass (pass-through, no injection)

---

## 4. Request Classification

All requests are **main**. OpenClaw has no auxiliary request concept.

---

## 5. Inject Profile

Same as CB — XML structure is injected into `messages[0].content` (system message).

---

## 6. Known Constraints

Identical to Hermes:

### `x-task-id` is currently required

When missing, session bypass, and memory injection does not take effect.
Solution: configure `sessionInit.defaultTaskId: "no-task"` in proxy and fill in a fixed value.

`x-conversation-id` needs to be managed manually

- Share session by same ID; new conversations require manual value switching
- Some subsequent rounds of tool calls may not carry headers → skip injection for those rounds

---

## 7. Common Questions

**Q: What is the difference from Hermes?**
A: For proxy, the behavior is completely the same (both are header pre-selection + OpenAI Chat). The difference is only in the client configuration file format (YAML vs JSON) and the agentSource marker.

**Q: Is it okay to fill cost with 0 in models?**
**A:** Yes. OpenClaw uses cost for client-side budget calculation, and the actual billing occurs upstream when going through the proxy, so filling it with 0 on the client side does not affect functionality.

**Q: What is `allowPrivateNetwork: true`?**
**A:** OpenClaw by default disallows requests to private network addresses (security policy). You need to add this configuration to access `127.0.0.1` or proxies on private IPs.
