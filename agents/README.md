# Agents

Memory Proxy currently supports 7 types of AI Agent clients, with significant differences in their respective protocols, session initialization methods, and injection logic.

## Quick Start

### Method 1: Run Script Manually

```bash
cd <repository-root>
bash agents/setup-proxy.sh
```

Interactive wizard guiding you step-by-step to complete the configuration for Agent connecting to Proxy:
1. Automatically scan existing configurations (reuse if available, no need to refill)
2. Select the Agent to configure
3. Fill in the Model ID
4. Health check (verify Proxy connectivity)
5. Write configuration file (automatically back up the original file as `.bak`)
6. Optional: Import local skills/dialogues into team memory

Supports all 7 Agents, configure one at a time, run multiple times to configure different Agents.

### Method 2: Assisted Configuration via AI Agent (Skill)

Let AI Agents like Claude Code / CodeBuddy guide you through the configuration using the skill; the agent will incrementally detect the environment, verify connectivity, and make dynamic choices.

#### Step 1: Copy the agents directory to home

```bash
cd <repository-root>
cp -r agents ~/agents
```

#### Step 2: Use the following prompt in the AI Agent conversation

> Note: The agent needs to `cd ~/agents` into the directory before executing the script.

**Configure a new Agent to connect to Proxy:**

```
Please read the skill document at ~/agents/skills/setup-proxy/SKILL.md, and then follow the steps inside to guide me through configuring the Agent to connect to Memory Proxy.
```

**Configure a specific Agent (e.g., Claude Code):**

```
Please read ~/agents/skills/setup-proxy/SKILL.md and help me configure Claude Code to connect to Memory Proxy. My proxy address is http://localhost:8096, and the instance ID is default.
```

**Configure Hermes/OpenClaw (requires header pre-selection):**

```
Please read ~/agents/skills/setup-proxy/SKILL.md and help me configure Hermes to connect to Memory Proxy. The panel address is http://localhost:8125, help me pull the team/agent list from the panel to choose.
```

**Only do health check (no configuration write):**

```
Please read ~/agents/skills/setup-proxy/SKILL.md and help me probe if the proxy at http://localhost:8096 is normal, using the codebuddy protocol and the claude-opus-4.7 model.
```

> ℹ️ The Skill file is located at `agents/skills/setup-proxy/SKILL.md`, and its companion script is `agents/skills/setup-proxy/setup-proxy.sh`. The Agent is responsible for gathering information step-by-step and verifying the environment, and finally calling the script in `--non-interactive` mode to write the configuration.

---

Each subdirectory corresponds to an agent and contains:
- `README.md` — Connection configuration, adaptation method, Session Init process, common issues
- `asset-import.md` — Manual to import local skills / memory / session for that client into Memory Hub (single file manual)
- `asset-import.ts` — Disk scanning implementation for that client, unified entry at repo root `agents/asset-import.ts`, use `--source <name>` to specify IDE
- Can place in future: adaptation process records, debugging scripts, packet capture fixtures, etc.

---

## Quick Reference Table

| Agent | Protocol | Session Init Method | Form Tool | Pagination | Default/Plan Gate | Headless Bypass |
|-------|------|-------------------|-----------|------|-------------------|-----------------|
| [Claude Code](./claude-code/) | Anthropic Messages | Interactive Form | `AskUserQuestion` | ✅ (max 4) | ❌ | ❌ |
| [CodeBuddy](./codebuddy/) | OpenAI Chat Completions | Interactive Form | `ask_followup_question` | ❌ (Unlimited) | ❌ | ❌ |
| [Codex](./codex/) | OpenAI Responses API | Interactive Form + Default Gate | `request_user_input` | ✅ | ✅ | ❌ |
| [WorkBuddy](./workbuddy/) | Responses (Desktop) / Chat (Web) | Interactive Form | `AskUserQuestion` | ✅ (max 4) | ✅ | ✅ (Silent pass-through) |
| [dsh (DeepSeek Harness)](./dsh/) | OpenAI Chat Completions | Interactive Form + Headless Bypass | `ask_user_question` | ❌ (Unlimited) | ❌ | ✅ (When no tools) |
| [Hermes](./hermes/) | OpenAI Chat Completions | Header Pre-selection (No Form) | N/A | N/A | N/A | ✅ (When header missing) |
| [OpenClaw](./openclaw/) | OpenAI Chat Completions | Header Pre-selection (No Form) | N/A | N/A | N/A | ✅ (When header missing) |

---

## Local Asset Import

Import skills / memory / historical sessions from various client disks into Memory Hub. Each client has a scanning file that can be run directly:

```bash
# Interactive import (prompts y/N for skills / memory / sessions one by one)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid>

# Non-interactive full import (for scripts/CI)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid> -y
```


| Agent | Manual |
|-------|------|
| Claude Code | [asset-import.md](./claude-code/asset-import.md) |
| CodeBuddy | [asset-import.md](./codebuddy/asset-import.md) |
| Codex | [asset-import.md](./codex/asset-import.md) |
| WorkBuddy | [asset-import.md](./workbuddy/asset-import.md) |
| dsh | [asset-import.md](./dsh/asset-import.md) |
| Hermes | [asset-import.md](./hermes/asset-import.md) |
| OpenClaw | [asset-import.md](./openclaw/asset-import.md) |

---

## Session ID Header Quick Reference

| Agent | Main Header | Fallback |
|-------|-----------|------|
| Claude Code | `x-claude-code-session-id` | `x-session-id`, `x-conversation-id` |
| CodeBuddy | `x-conversation-id` | `x-session-id`, `x-cb-session-id`, `x-codebuddy-session-id` |
| Codex | `session-id` | `body.client_metadata.session_id` |
| WorkBuddy | `session-id` | `body.client_metadata.session_id` |
| dsh | `x-deepseek-harness-session-id` | `x-session-id` |
| Hermes | `x-conversation-id` | — (User static config) |
| OpenClaw | `x-conversation-id` | — (User static config) |

---

## Client Configuration Methods

| Agent | Configuration Method | Config File / Variables | Key Passing |
|-------|----------|-----------------|----------|
| Claude Code | Env vars or Config file | `~/.claude/settings.json` or env `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | env / JSON `env.ANTHROPIC_AUTH_TOKEN` |
| CodeBuddy | Config file | `~/.codebuddy/models.json` | JSON `apiKey` |
| Codex | Config file | `~/.codex/config.toml` | TOML `experimental_bearer_token` |
| WorkBuddy | Config file | `~/.workbuddy/models.json` | JSON `apiKey` |
| dsh | Config file | `~/.dsh/settings.yaml` + `.credentials.yaml` | YAML Env ref |
| Hermes | Config file | `~/.hermes/config.yaml` | YAML `api_key` + headers |
| OpenClaw | Config file | `~/.openclaw/openclaw.json` | JSON `apiKey` + headers |

---

## Routing Rules

```
/:agent/:spaceId/v1/messages          → Anthropic protocol (CC, CB-Anthropic)
/:agent/:spaceId/v1/chat/completions  → OpenAI Chat (CB, WB-web, dsh, Hermes, OpenClaw)
/:agent/:spaceId/chat/completions     → OpenAI Chat without v1 prefix (dsh)
/:agent/:spaceId/v1/responses         → Responses API (Codex, WB-desktop)
/:agent/:spaceId/responses            → Responses API without v1 prefix (Codex, WB-desktop)
```

---

## Header Pre-selection (Universal, available for all agents)

Besides interactive Forms, **all agents** support completing session registration directly via HTTP Headers, skipping form interactions. Suitable for:
- Incapable of responding to forms (like Hermes / OpenClaw)
- Wanting to skip form to accelerate first frame (like CI/CD automation scenarios)
- Third-party platforms / Custom developed Agents

### Required Headers

| Header | Description |
|--------|------|
| `Authorization: Bearer <user_key>` | Business user's API Key (obtained from panel) |
| `x-team-id` | Team ID |
| `x-agent-id` | Agent ID |
| `x-task-id` | Task ID (required in current version) |
| `x-conversation-id` | Session identifier, generated and managed by the client |

If all above headers are complete → Proxy directly completes session registration + injects assets, no form pops up.  
If any is missing → falls back to interactive form (if client supports) or session bypass (if form not supported).

### Other Platform Integration

Any OpenAI API compatible platform can integrate by pointing the API base URL to the Proxy:

```text
http://<proxy-host>:<port>/<agent-source>/<spaceId>
```

- `<agent-source>`: Must choose from Proxy supported values: `claude-code`, `codebuddy`, `workbuddy`, `codex`, `hermes`, `openclaw`. Other platforms can masquerade as one of them to connect (e.g., using `codebuddy`)
- `<spaceId>`: Memory instance ID (fixed as `default` for local deployment)

---

## New Agent Integration Process Overview

1. **Packet Capture** — Use mitmproxy to capture 3~5 typical requests (main / aux / title-gen), save to `docs/<agent>-recon/`
2. **Identify Protocol** — Determine wire protocol (Anthropic / Chat / Responses)
3. **Determine Session ID Source** — Find unique session identifier in header or body
4. **Choose Session Init Strategy** — If tool exists → interactive form; if no tool → header pre-selection / headless bypass
5. **Classify Auxiliary Requests** — Identify title-gen / compact / fork and other requests that don't need full link
6. **Implement Handler / Reuse** — Share handler if protocol is identical (e.g., dsh reuses CB's handleChatCompletions)
7. **Inject Profile** — Define injection template according to client's system prompt format
8. **E2E Verification** — Run full link to confirm session-init + injection + archiving works

See sub-documents for details.
