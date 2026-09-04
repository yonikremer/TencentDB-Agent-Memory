---
name: openclaw-diagnostic-export
description: Helps users export OpenClaw + memory-tencentdb (formerly memory-tdai) memory plugin diagnostic data for troubleshooting. Triggered when users mention "export diagnostic data", "export diagnostic", "on-site data", "troubleshoot issue", "export log", "collect environment data", or "package diagnostic data".
version: 1.0.0
---

## Purpose

Pack OpenClaw logs, memory plugin data (L0~L3), and redacted configurations into a local archive for users to review and manually send to the R&D team for troubleshooting.

> **Name Note**: The plugin has been renamed from `@tdai/memory-tdai` to `@tencentdb-agent-memory/memory-tencentdb`, but the data directory remains `~/.openclaw/memory-tdai/` (hardcoded in code). All references to the `memory-tdai` directory in this skill refer to the actual data directory path, unrelated to the plugin ID.

## Export Workflow

### Step 1: Verify Environment

Before exporting, verify that the OpenClaw working directory exists and is accessible:

```bash
# Detect working directory (priority: environment variable > ~/.openclaw > ~/.clawdbot)
OPENCLAW_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
[ -d "$OPENCLAW_DIR" ] || OPENCLAW_DIR="$HOME/.clawdbot"
ls -la "$OPENCLAW_DIR/" 2>/dev/null && echo "✅ Found: $OPENCLAW_DIR" || echo "❌ OpenClaw working directory not found"
```

Verify memory-tdai subdirectory exists:

```bash
ls -la "$OPENCLAW_DIR/memory-tdai/" 2>/dev/null
```

### Step 2: Run Export Script

Run the export script under the project `scripts/` directory:

```bash
bash scripts/export-diagnostic.sh
```

> The script is located at `scripts/export-diagnostic.sh` in this project. If running via `pnpm` or other methods, ensure the current working directory is the project root.

By default, the script outputs the archive to `~/Downloads/openclaw-diagnostic-<timestamp>.tar.gz`.

To specify a different output directory:

```bash
bash scripts/export-diagnostic.sh /tmp
```

### Step 3: Verify Export Results

After script execution completes, inspect the output:

1. **Confirm archive generated** — The script prints the archive path and size at the end.
2. **Explain contents to user**:

| File/Directory | Content | Privacy Risk |
|-----------|------|---------|
| `env-info.txt` | OS version, OpenClaw version, directory structure, disk usage | Low |
| `logs/` | OpenClaw gateway log + rolling logs (recent 3 days, max 5000 lines per file) | Low |
| `memory-tdai/` | Full memory plugin data: L0 chat, L1 memory, L2 scenes, L3 persona, SQLite DB, checkpoint | **High** — Contains raw user conversation text |
| `openclaw-config-redacted.json` | Redacted configuration (API Key/Token/Password/Secret removed; models/channels/env blocks replaced) | Low |
| `plugins-info.txt` | Installed plugins list and versions | Low |

3. **Remind User**:
   - Configuration files are automatically redacted; sensitive info such as API Key and Token are replaced with `***REDACTED***`
   - **Memory data (`memory-tdai/`) contains raw user conversation text**; please verify before sharing
   - Archives are saved locally and **will not be automatically uploaded**; users must manually send them to the R&D team

### Step 4: Inform User of Next Steps

After export completes, inform the user:

1. Archive has been saved locally (print exact path)
2. Please inspect the contents and manually send to the R&D team via messaging/email
3. If only partial data is needed (e.g. logs only or config only), extract and select files manually before sending

## Export Content Details

### OpenClaw Log Locations

| Log Type | Path | Description |
|---------|------|-------------|
| Gateway stdout | `~/.openclaw/logs/gateway.log` | Gateway daemon standard output |
| Gateway stderr | `~/.openclaw/logs/gateway.err.log` | Gateway daemon error output |
| Rolling log | `/tmp/openclaw/openclaw-YYYY-MM-DD.log` | Daily rolling log, JSON Lines format, automatically cleaned after 24h |
| Config audit | `~/.openclaw/logs/config-audit.jsonl` | Configuration write audit records |
| Command log | `~/.openclaw/logs/commands.log` | Command event log (optional via hook) |

### Memory Plugin Data Structure

```
~/.openclaw/memory-tdai/
├── conversations/          — L0 raw conversation (daily JSONL shards)
├── records/                — L1 structured memory (daily JSONL shards)
├── scene_blocks/           — L2 scene Markdown files
├── persona.md              — L3 user persona
├── vectors.db              — SQLite database (vector + full-text search)
├── .metadata/              — checkpoint, scene_index.json
└── .backup/                — rolling backups
```

### Configuration Redaction Rules

The export script applies the following redactions to `openclaw.json`:

| Rule | Processing Method |
|------|-------------------|
| Field name matches `apiKey/token/password/secret/credential` with string value | Replaced with `***REDACTED(Nchars)***` |
| SecretRef object (containing source/provider/id) | id replaced with `***REDACTED***` |
| Top-level `models`, `secrets`, `channels`, `env` blocks | Replaced entirely with `***REDACTED_SECTION***` |
| token/password under `gateway.auth` | Replaced with `***REDACTED***` |
| Other fields (including full `plugins` configuration) | **Preserved as-is** (plugin configuration is a primary troubleshooting target) |

## Manual Export (Fallback when script is unavailable)

If the export script cannot be executed (e.g. Node.js unavailable), collect manually using these steps:

```bash
# 1. Create export directory
EXPORT_DIR=~/Downloads/openclaw-diagnostic-$(date +%Y%m%d-%H%M%S)
mkdir -p "$EXPORT_DIR"

# 2. Copy logs
cp -r ~/.openclaw/logs/ "$EXPORT_DIR/logs/" 2>/dev/null
cp /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log "$EXPORT_DIR/" 2>/dev/null

# 3. Copy memory plugin data
cp -r ~/.openclaw/memory-tdai/ "$EXPORT_DIR/memory-tdai/" 2>/dev/null

# 4. Manually redact configuration (⚠️ Sensitive fields MUST be removed manually!)
# Copy configuration and use an editor to delete models/secrets/channels blocks and all apiKey/token values
cp ~/.openclaw/openclaw.json "$EXPORT_DIR/openclaw-config-NEEDS-MANUAL-REDACTION.json"

# 5. Archive
cd ~/Downloads && tar -czf "$EXPORT_DIR.tar.gz" "$(basename $EXPORT_DIR)"

echo "⚠️ Please manually inspect and remove sensitive information from configuration before sending!"
```

## Common Troubleshooting Clues

After exporting data, the R&D team usually focuses on the following aspects:

| Investigation Area | File to Inspect | Key Information |
|--------------------|-----------------|-----------------|
| Plugin load status | Search `[memory-tdai]` in `logs/` | Plugin registration, config parsing logs (Note: log tag remains `[memory-tdai]`, unrelated to plugin ID) |
| Memory recall functionality | Search `[recall]` in `logs/` | Search strategy, latency, hit count |
| L1 extraction trigger | Search `[pipeline]` in `logs/` | Scheduling triggers, L1/L2/L3 execution status |
| Vector search availability | `plugins.entries` in `openclaw-config-redacted.json` | Whether embedding configuration is correct |
| Data volume / Disk usage | `env-info.txt` | `du` output, file counts |
| Checkpoint status | `memory-tdai/.metadata/recall_checkpoint.json` | Progress, cursor, counters |
