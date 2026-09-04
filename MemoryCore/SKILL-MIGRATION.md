---
name: openclaw-memory-tencentdb-migration
description: Helps existing users migrate OpenClaw memory plugin from legacy package @tdai/memory-tdai to new package @tencentdb-agent-memory/memory-tencentdb. Triggered when users mention "plugin migration", "change memory plugin package name", "memory-tdai upgrade", "package name change", or encounter errors related to legacy package installation.
version: 1.0.0
---

## Purpose

Help existing users with `@tdai/memory-tdai` (legacy package name) installed smoothly migrate to `@tencentdb-agent-memory/memory-tencentdb` (new package name), ensuring existing memory data is not lost and configuration is fully restored.

## Background

- **Legacy package name**: `@tdai/memory-tdai` (Plugin ID: `memory-tdai`)
- **New package name**: `@tencentdb-agent-memory/memory-tencentdb` (Plugin ID: `memory-tencentdb`)
- Legacy and new plugins share the same data directory (`~/.openclaw/memory-tdai/`); uninstalling the legacy plugin **does not delete the data directory**, so existing memory data remains unaffected.
- Uninstalling the legacy plugin **deletes** its configuration block from `openclaw.json`, so backup is required beforehand.

## Applicable Scenarios

- User has `@tdai/memory-tdai` installed and needs to migrate to the new package name.
- User executes `openclaw plugins install @tdai/memory-tdai` and encounters 404 / not found error.
- User is notified that the legacy package is deprecated and needs to migrate.

## Non-Applicable Scenarios

- User has never installed a memory plugin (should use `openclaw-memory-tencentdb-setup` skill instead).
- User is using a different memory plugin (e.g. `openclaw-mem0`).

## Standard Workflow

### 1) Confirm Current State

Confirm whether legacy plugin is installed:

```bash
openclaw plugins list | grep -i memory
```

Expected output shows `memory-tdai` or `@tdai/memory-tdai` in `loaded` state.

If the legacy plugin is not found, skip the migration workflow and use `openclaw-memory-tencentdb-setup` skill directly for fresh installation.

### 2) Backup Existing Configuration (Critical Step)

Uninstalling the legacy plugin deletes its configuration section in `openclaw.json`. **Must backup first**.

Run the following command to extract legacy plugin configuration:

```bash
cat ~/.openclaw/openclaw.json | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
plugins = cfg.get('plugins', {}).get('entries', {})
old_cfg = plugins.get('memory-tdai', {})
if old_cfg:
    print(json.dumps(old_cfg, indent=2, ensure_ascii=False))
    with open('/tmp/memory-tdai-config-backup.json', 'w') as f:
        json.dump(old_cfg, f, indent=2, ensure_ascii=False)
    print('\n✅ Config backed up to /tmp/memory-tdai-config-backup.json')
else:
    print('⚠️ memory-tdai config section not found (possibly using default config)')
"
```

**Pay special attention to whether the following configurations exist (must record if present)**:

- `embedding` configuration (`provider`, `baseUrl`, `apiKey`, `model`, `dimensions`, `proxyUrl`)
- `extraction.model` (model used for extraction)
- `persona.model` (model used for persona)
- `capture.excludeAgents` (excluded agent list)
- `capture.l0l1RetentionDays` (data retention days)

### 3) Confirm Data Directory Exists

```bash
ls -la ~/.openclaw/memory-tdai/
```

Expected files: `conversations/`, `records/`, `scene_blocks/`, `vectors.db`, `persona.md`, etc.

Record current data volume as baseline for post-migration verification:

```bash
echo "=== Pre-migration Data Stats ==="
wc -l ~/.openclaw/memory-tdai/conversations/*.jsonl 2>/dev/null || echo "No conversation data"
wc -l ~/.openclaw/memory-tdai/records/*.jsonl 2>/dev/null || echo "No record data"
ls ~/.openclaw/memory-tdai/scene_blocks/*.md 2>/dev/null | wc -l | xargs -I{} echo "Scene blocks: {}"
wc -c ~/.openclaw/memory-tdai/persona.md 2>/dev/null || echo "No persona"
```

### 4) Uninstall Legacy Plugin

```bash
openclaw plugins uninstall memory-tdai
```

After execution, confirm:

- `memory-tdai` configuration section removed from `openclaw.json` (expected behavior)
- `~/.openclaw/memory-tdai/` data directory **still exists** (will not be deleted)

```bash
# Verify data directory remains
ls ~/.openclaw/memory-tdai/ && echo "✅ Data directory intact" || echo "❌ Data directory lost!"
```

### 5) Install New Plugin

```bash
openclaw plugins install @tencentdb-agent-memory/memory-tencentdb
```

### 6) Restore Configuration

Write the configuration backed up in Step 2 back into `openclaw.json`, noting that the new plugin's configuration key is `memory-tencentdb`:

```bash
python3 -c "
import json, os

# Read backup configuration
backup_path = '/tmp/memory-tdai-config-backup.json'
if os.path.exists(backup_path):
    with open(backup_path) as f:
        old_cfg = json.load(f)
    print('📋 Backup config content:')
    print(json.dumps(old_cfg, indent=2, ensure_ascii=False))
else:
    old_cfg = {'enabled': True}
    print('⚠️ Backup not found, using minimal config')

# Read current openclaw.json
config_path = os.path.expanduser('~/.openclaw/openclaw.json')
with open(config_path) as f:
    cfg = json.load(f)

# Write new plugin configuration
cfg.setdefault('plugins', {}).setdefault('entries', {})['memory-tencentdb'] = old_cfg

with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

print('\n✅ Config written to memory-tencentdb')
"
```

If backup is lost or manual restoration is required, ensure at least minimal configuration is written:

```json
{
  "memory-tencentdb": {
    "enabled": true
  }
}
```

### 7) Restart Gateway and Verify

```bash
openclaw gateway restart
```

Verification items:

- Gateway log displays `[memory-tdai]` prefix (Note: log tag remains `memory-tdai`, which is normal)
- Data directory content unchanged

```bash
echo "=== Post-migration Verification ==="
# Confirm new plugin loaded
openclaw plugins list | grep -i memory

# Confirm data volume matches pre-migration stats
wc -l ~/.openclaw/memory-tdai/conversations/*.jsonl 2>/dev/null
wc -l ~/.openclaw/memory-tdai/records/*.jsonl 2>/dev/null
```

### 8) Functional Smoke Test

Execute a conversation to confirm memory pipeline functionality:

1. Send a message containing personal information (such as preferences, habits)
2. Confirm logs contain `[before_prompt_build]` and `[agent_end]` related outputs
3. If embedding configuration exists, confirm vector search works normally (no embedding errors in log)

## Rollback Plan

If issues arise post-migration, quick rollback can be performed:

```bash
# 1. Uninstall new plugin
openclaw plugins uninstall memory-tencentdb

# 2. Reinstall legacy plugin (if npm registry remains accessible)
openclaw plugins install @tdai/memory-tdai

# 3. Manually restore configuration (from backup)
# Write /tmp/memory-tdai-config-backup.json content back to openclaw.json memory-tdai section

# 4. Restart
openclaw gateway restart
```

## Troubleshooting

| Symptom | Possible Cause | Solution |
|---------|----------------|----------|
| New plugin yields no log output | `enabled` not set to `true` in config | Check `memory-tencentdb.enabled` in `openclaw.json` |
| Error installing new plugin | npm registry unavailable | Check network / npm registry configuration |
| Missing history memory after migration | Incomplete configuration restoration | Compare `/tmp/memory-tdai-config-backup.json` with current config |
| Embedding error | `apiKey` or other config missing | Restore `embedding` config section from backup |
| Empty data directory | Unexpected deletion during uninstall (extremely rare) | Check whether `~/.openclaw/memory-tdai/` exists |

## Security & Compliance Constraints

- Backup file `/tmp/memory-tdai-config-backup.json` may contain `apiKey`; recommended to delete after migration completes: `rm /tmp/memory-tdai-config-backup.json`
- Do not display `apiKey` in plain text in chat or logs
- Only modify `memory-tencentdb` configuration block, leaving other user plugins unaffected

## Definition of Done

Migration completion requires satisfying all of the following:

- [x] Legacy plugin `@tdai/memory-tdai` uninstalled
- [x] New plugin `@tencentdb-agent-memory/memory-tencentdb` installed and loaded
- [x] Complete `memory-tencentdb` configuration present in `openclaw.json` (including user custom embedding settings)
- [x] Gateway restarted
- [x] Log displays `[memory-tdai]` prefix
- [x] Data directory intact and data volume matches pre-migration stats
- [x] At least 1 conversation verified for normal memory pipeline behavior
- [x] Sensitive information in backup files cleaned up

## Delivery Response Template

> Memory plugin migration completed:
> - Legacy plugin `@tdai/memory-tdai` → New plugin `@tencentdb-agent-memory/memory-tencentdb`
> - Existing memory data fully retained (conversations/records/scene blocks/vector database unaffected)
> - Configuration fully restored from legacy plugin (including custom embedding / extraction / persona settings)
> - Gateway restarted, memory pipeline verified normally
