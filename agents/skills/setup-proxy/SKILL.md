---
name: setup-proxy
description: Interactive guide to help users configure AI Agent to connect to Memory Proxy (step-by-step probing and validation)
triggers:
  - configure proxy
  - configure agent
  - setup proxy
  - connect proxy
  - connect memory
---

# Setup Proxy — Agent Connection Configuration Wizard

You are helping the user connect an AI Agent client (Claude Code / CodeBuddy / Codex / WorkBuddy / dsh / Hermes / OpenClaw) to the Memory Proxy.

## Background Knowledge

Memory Proxy is an LLM request proxy that injects team memory/skills/knowledge before forwarding the request to the upstream LLM. Each agent client has a different configuration file format and protocol:

| Agent | Config File | Protocol | Special Requirements |
|-------|----------|------|----------|
| claude-code | `~/.claude/settings.json` | Anthropic Messages | 5 model variables in the env field |
| codebuddy | `~/.codebuddy/models.json` | OpenAI Chat | Append entry to models array |
| codex | `~/.codex/config.toml` | OpenAI Responses | TOML format, must be `wire_api = "responses"` |
| workbuddy | `~/.workbuddy/models.json` | OpenAI Chat / Responses | Top-level array |
| dsh | `~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml` | OpenAI Chat (No /v1) | Two files + chmod 700/600 |
| hermes | `~/.hermes/config.yaml` | OpenAI Chat | Requires header preselect (x-team-id/agent-id/task-id) |
| openclaw | `~/.openclaw/openclaw.json` | OpenAI Chat | Requires header preselect + allowPrivateNetwork |

## Script Location

Configuration write script: `agents/skills/setup-proxy/setup-proxy.sh` (relative to the repository root)

## Execution Flow

**Strictly follow this order. Each step must pass validation before proceeding to the next.**

### Step 1: Scan Existing Configuration

First, check if the user already has a proxy configuration to avoid duplicate data entry:

```bash
# Check Claude Code
cat ~/.claude/settings.json 2>/dev/null | jq -r '.env.ANTHROPIC_BASE_URL // empty'

# Check CodeBuddy
cat ~/.codebuddy/models.json 2>/dev/null | jq -r '.models[]? | select(.url | contains("/codebuddy/")) | .url' 2>/dev/null | head -1

# Check other agents similarly...
```

If a URL with a proxy path (containing fragments like `/claude-code/`, `/codebuddy/`, `/codex/`) is found, **extract and display**:
- Proxy Address (the part before `/<agent>/` in the URL)
- Instance ID (the segment after `/<agent>/` in the URL)
- User Key (value of the corresponding field, mask displaying only the first and last 4 characters)
- Model ID

Ask the user: "Existing configuration detected. Do you want to reuse it?"
- Yes → Skip to Step 3
- No → Continue to Step 2 for manual input

### Step 2: Collect Basic Information

Collect the following from the user in sequence:
1. **Proxy Address** (including protocol + port, e.g., `http://127.0.0.1:8096`)
2. **Instance ID** (defaults to `default`, usually no need to change for local deployments)
3. **User Key** (obtain from the Panel → API Key page, no format restrictions)

Confirm each piece of information after obtaining it. Do not ask for all three at once.

### Step 3: Select Agent

Display the 7 available agents and let the user select **one**:
1. Claude Code
2. CodeBuddy
3. Codex
4. WorkBuddy
5. dsh (DeepSeek Harness)
6. Hermes
7. OpenClaw

### Step 4: Enter Model ID

Tell the user:
- This model ID must be supported by the upstream of the Proxy
- Provide common examples: `claude-sonnet-4-20250514`, `claude-opus-4.7`, `gpt-5.5`, `deepseek-r1`

### Step 5: Health Probe (Critical Validation Step)

**Based on the selected agent's protocol**, construct the corresponding curl probe request:

```bash
# Claude Code → Anthropic Messages
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/claude-code/${INSTANCE_ID}/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# CodeBuddy / Hermes / OpenClaw → OpenAI Chat
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/${AGENT}/${INSTANCE_ID}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# dsh → OpenAI Chat but without /v1
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/dsh/${INSTANCE_ID}/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# Codex → Responses API
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/codex/${INSTANCE_ID}/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}],"stream":false}'

# WorkBuddy → OpenAI Chat (More universal)
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/workbuddy/${INSTANCE_ID}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'
```

**Evaluate the Result**:
- HTTP connection failure (000) → Tell the user the proxy is unreachable, ask them to check the address/port/service status, **do not continue**
- 2xx → Completely normal, continue
- 4xx → Proxy is reachable (could be form returned by session-init or auth issue), **display response body to user for reference**, continue
- 5xx → Proxy has issues, **display full error response**, ask user if they want to continue

### Step 6: Header Preselect (Hermes / OpenClaw Only)

If hermes or openclaw is selected, you need to additionally collect header preselect information. These agents do not support interactive forms and must have the team/agent/task ID pre-filled in the configuration.

**Preferred Approach: Fetch lists via Panel API for the user to select**

Ask the user if they want to provide the Panel backend address (default `http://127.0.0.1:8125`). If provided:

```bash
# 1. First get user_id via auth/verify
curl -s -X POST "${PANEL_URL}/api/v1/meta/auth/verify" \
  -H "Content-Type: application/json" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"user_key":"'${USER_KEY}'"}'
# Extract from .data.user.user_id

# 2. Fetch Team list
curl -s -X POST "${PANEL_URL}/api/v1/meta/team/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"user_key":"'${USER_KEY}'"}'
# Display from .data.items for user to select

# 3. Fetch Agent list (with owner_user_id filter)
curl -s -X POST "${PANEL_URL}/api/v1/meta/agent/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"team_id":"'${TEAM_ID}'","user_key":"'${USER_KEY}'","owner_user_id":"'${USER_ID}'"}'
# Display from .data.items for user to select

# 4. Fetch Task list
curl -s -X POST "${PANEL_URL}/api/v1/meta/task/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"team_id":"'${TEAM_ID}'","user_key":"'${USER_KEY}'"}'
# The first option is always "No associated task this time (no-task)"
```

If the Panel is unreachable or the user declines to provide it, ask the user to manually enter team_id / agent_id / task_id.

Additionally, an **x-conversation-id** is required (can be auto-generated, e.g., `conv-20260820-xxxx`).

### Step 7: Confirm Configuration File Path

Inform the user of the default path (see table above) and ask if they want to use it. If not, ask them to input it.

### Step 8: Call Script to Write Configuration

Once all information is collected and verified, **call the non-interactive mode of the script** to write the configuration:

```bash
bash agents/skills/setup-proxy/setup-proxy.sh --non-interactive \
  --proxy-host "${PROXY_HOST}" \
  --instance-id "${INSTANCE_ID}" \
  --user-key "${USER_KEY}" \
  --agent "${CHOSEN_AGENT}" \
  --model "${MODEL_ID}" \
  --config-path "${CONFIG_PATH}"
```

For Hermes/OpenClaw, append:
```bash
  --team-id "${TEAM_ID}" \
  --agent-id "${AGENT_ID}" \
  --task-id "${TASK_ID}" \
  --conv-id "${CONVERSATION_ID}"
```

**Check script exit code**: 0 = Success, Non-0 = Failure (display output to the user).

### Step 9: Verify Written Results

After writing, read the configuration file to confirm the contents are correct:
```bash
cat <config_path>
```

Display key fields for the user to confirm.

### Step 9.5: Remind User to Switch Models

**Writing the configuration does not mean it's active.** You must remind the user to switch to the Proxy model in their client for the requests to go through the Proxy pipeline:

| Agent | How to Switch |
|-------|----------|
| Claude Code | No action needed; `settings.json` env is automatically loaded on start |
| CodeBuddy | In the chat dialog, switch the model to **proxy-memory-agent** (i.e., the configured model ID) |
| Codex | No action needed; `config.toml` already specifies the model |
| WorkBuddy | In the model selector, switch to the corresponding model in the custom model list |
| dsh | No action needed; `settings.yaml` already specifies the model |
| Hermes / OpenClaw | Ensure the provider/model selected in the client points to the Proxy configuration |

**You must inform the user**: If the model is not switched, the requests will not go through the Proxy, and memory/skill injection will not take effect.

### Step 10: Asset Import (Optional)

After configuration is complete, ask the user: Do you want to import this Agent's local assets (skills + chat history) into the team memory?

If the user chooses to import:
- Requires Panel URL, Team ID, Agent ID
- If team/agent was already selected in Step 6, it is recommended to reuse them
- Otherwise, ask the user to provide them

Then call:
```bash
PANEL_URL="${PANEL_URL}" TDAI_SERVICE_ID="${INSTANCE_ID}" TDAI_USER_KEY="${USER_KEY}" \
  tsx agents/asset-import.ts --source "${CHOSEN_AGENT}" --team-id "${TEAM_ID}" --agent-id "${AGENT_ID}"
```

If `tsx` is not available, instruct the user to run the command manually.

## Error Handling Principles

1. **Connection Failure**: Clearly tell the user which step failed and provide troubleshooting suggestions (check service status, ports, network).
2. **4xx Response**: Proxy is reachable but there's a business error; display the full response body to help the user determine if it's a key error, unsupported model, or other issue.
3. **File Permissions**: Check if the directory exists/is writable before writing; dsh requires chmod.
4. **Do Not Guess**: If information is insufficient or status is unclear, ask the user rather than making assumptions.

## Important Notes

- Only configure one agent at a time; inform the user they can run it again to configure other agents after finishing one.
- The script automatically backs up the original config file as `.bak.<timestamp>`.
- All model environment variables in CC (HAIKU/SONNET/OPUS/SUBAGENT) are uniformly set to the user-selected model.
- Codex must switch to Plan mode (Shift+Tab) before the first conversation; this is a client limitation.
- dsh URL does not include `/v1`, which is hardcoded in the client.
- Hermes/OpenClaw's x-conversation-id needs to be manually changed for each new conversation.
