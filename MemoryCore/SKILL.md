---
name: openclaw-memory-tencentdb-setup
description: Used to install, configure, and verify the @tencentdb-agent-memory/memory-tencentdb plugin in an OpenClaw environment. Triggered when users mention "install memory plugin", "configure memory-tencentdb", "enable long-term memory/recall", or encounter related errors.
version: 1.0.0
---

## Purpose

Provide persistent local long-term memory capabilities (L0→L1→L2→L3) for OpenClaw without relying on external hosted memory services, achieving a single closed loop from installation and configuration to acceptance testing.

## Applicable Scenarios

- User requests installing or enabling `memory-tencentdb` in OpenClaw.
- User needs to configure recall, extraction, persona, cleanup, or other parameters.
- User reports "plugin installed but no memory / no recall / no vector search".

## Non-Applicable Scenarios

- User only wants memory concepts explained without actual deployment.
- User wants integration with a non-OpenClaw host (confirm target framework first).

## Standard Workflow

### 1) Environment Pre-check

First verify base version requirements are met:

- OpenClaw: `>= 2026.3.13`
- Node.js: `>= 22.16.0`

Execute:

```bash
openclaw --version
node -v
```

If versions do not meet requirements, upgrade before proceeding.

### 2) Install Plugin

Run installation command:

```bash
openclaw plugins install @tencentdb-agent-memory/memory-tencentdb
```

If already installed, run update:

```bash
openclaw plugins update memory-tencentdb
```

### 3) Write Minimal Configuration

Edit `~/.openclaw/openclaw.json` to ensure the following exists:

```json
{
  "memory-tencentdb": {
    "enabled": true
  }
}
```

Note: The plugin supports zero-configuration startup; base capabilities run without additional fields.

### 4) Add Recommended Configurations as Needed (Production Use)

Add configuration groups based on user requirements:

- `capture`: Conversation capture and retention policies
- `extraction`: L1 extraction and deduplication
- `pipeline`: L1→L2→L3 scheduling
- `recall`: Recall counts, thresholds, and strategies
- `persona`: Scene and persona trigger parameters
- `embedding`: Vector search configuration (remote OpenAI-compatible)

Recommended template:

```json
{
  "memory-tencentdb": {
    "capture": {
      "enabled": true,
      "excludeAgents": [],
      "l0l1RetentionDays": 90,
      "cleanTime": "03:00"
    },
    "extraction": {
      "enabled": true,
      "enableDedup": true,
      "maxMemoriesPerSession": 10,
      "model": "provider/model"
    },
    "pipeline": {
      "everyNConversations": 5,
      "enableWarmup": true,
      "l1IdleTimeoutSeconds": 600,
      "l2DelayAfterL1Seconds": 10,
      "l2MinIntervalSeconds": 900,
      "l2MaxIntervalSeconds": 3600,
      "sessionActiveWindowHours": 24
    },
    "recall": {
      "enabled": true,
      "maxResults": 5,
      "scoreThreshold": 0.3,
      "strategy": "hybrid"
    },
    "persona": {
      "triggerEveryN": 50,
      "maxScenes": 15,
      "backupCount": 3,
      "sceneBackupCount": 10,
      "model": "provider/model"
    },
    "embedding": {
      "enabled": true,
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "${EMBEDDING_API_KEY}",
      "model": "text-embedding-3-small",
      "dimensions": 1536,
      "conflictRecallTopK": 5
    }
  }
}
```

### 5) Critical Configuration Rules (Prevent Implicit Failures)

- When `embedding.provider = "none"`, vector capabilities are disabled, retaining keyword search path only.
- If configuring remote `provider` (e.g. `openai` / `deepseek`), all of the following must be provided:
  - `apiKey`
  - `baseUrl`
  - `model`
  - `dimensions`
- If any of the above is missing, the plugin will continue running but automatically fall back to non-vector mode.
- `l0l1RetentionDays`:
  - `0` means no cleanup
  - Non-`0` values recommended to be `>=3`
  - If set to `1~2`, `allowAggressiveCleanup` must be explicitly enabled

### 6) Restart and Verify Effective

Execute:

```bash
openclaw gateway restart
```

Verification items:

- Gateway log displays `[memory-tdai]` prefix
- Data directory created: `~/.openclaw/state/memory-tdai/`
- Contains at least: `conversations/`, `records/`, `scene_blocks/`, `vectors.db`

### 7) Functional Smoke Test

Execute a minimal conversation loop and verify:

1. Conduct 2~3 continuous conversation turns providing memorable information (preferences, constraints, background).
2. Start a new turn of conversation and observe if recalled context is injected.
3. Invoke tools in Agent:
   - `tdai_memory_search`
   - `tdai_conversation_search`
4. Confirm newly generated content can be retrieved.

## Troubleshooting Quick Reference

- Plugin yields no logs: Check if `memory-tencentdb.enabled` is `true` in `openclaw.json` and confirm Gateway restarted.
- Records exist but no recall: Check if `recall.enabled` or `scoreThreshold` is set too high.
- No vector results: Check whether `embedding` 4-tuple (`apiKey/baseUrl/model/dimensions`) is fully specified.
- Aggressive cleanup results in sparse history: Check `l0l1RetentionDays` and `allowAggressiveCleanup`.
- Configuration updated but behavior unchanged: Confirm `~/.openclaw/openclaw.json` was edited and restart Gateway again.

## Security & Compliance Constraints

- Treat `apiKey` as sensitive information; do not expose plain text in chat, logs, or screenshots.
- Prefer environment variable injection for keys; keep placeholders in configuration examples.
- Only modify `memory-tencentdb` configuration block, avoiding overwriting other user plugin configs.

## Definition of Done

Before ending the task, all of the following must be satisfied:

- Plugin install/update command succeeds
- Valid `memory-tencentdb` configuration present in `openclaw.json`
- Gateway restarted
- `[memory-tdai]` logs visible
- Data directory and critical files generated
- At least 1 retrieval tool invocation successfully returns results

## Delivery Response Template

May be output to user upon completion:

- Completed `memory-tencentdb` installation and configuration, and restarted Gateway.
- Verified logs and data directory are active, and memory pipeline is functional.
- For further optimization, tune `recall.scoreThreshold`, `pipeline.everyNConversations`, `persona.triggerEveryN`, and `embedding` model parameters.