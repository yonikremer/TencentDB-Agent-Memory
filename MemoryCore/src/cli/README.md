# memory-tdai CLI

`openclaw memory-tdai` command space, providing offline data management tools.

## seed — import historical conversation data

Import the historical conversation JSON file into the memory pipeline, and fully execute the L0→L1→L2→L3 process. Applicable to:

- Ingest existing conversation data into the memory system
- Batch test memory extraction effectiveness
- Migrate/restore memory data

Usage

```bash
openclaw memory-tdai seed --input <file> [options]
```

Parameters

| Parameter | Required | Description |
|------|------|------|
| `--input <file>` | ✅ | Input JSON file path |
| `--output-dir <dir>` | — | Output directory (default auto-generated directory with timestamp) |
| `--session-key <key>` | — | Fallback session key (used when input data is missing) |
| `--config <file>` | — | Config override file (JSON, deeply merged with openclaw.json plugin config) |
| `--strict-round-role` | — | Strictly validate that each round of conversation must contain user and assistant messages |
| `--yes` | — | Skip interactive confirmation (e.g., confirmation for automatic timestamp filling) |

### Example

```bash
# Basic Usage
openclaw memory-tdai seed --input conversations.json

# Specified output directory
openclaw memory-tdai seed --input data.json --output-dir ./seed-output

# Use custom configuration to override (e.g., adjust pipeline parameters)
openclaw memory-tdai seed --input data.json --config seed-config.json

# Skip all confirmations
openclaw memory-tdai seed --input data.json --yes

# Strict Mode + Custom Configuration
openclaw memory-tdai seed --input data.json --config seed-config.json --strict-round-role --yes
```

### Input File Format

Supports two types of JSON formats:

#### Format A: Object Wrapping

```json
{
  "sessions": [
    {
      "sessionKey": "user-alice",
      "sessionId": "conv-001",
      "conversations": [
        [
          { "role": "user", "content": "Hello", "timestamp": 1711929600000 },
          { "role": "assistant", "content": "Hello! How can I help you?", "timestamp": 1711929601000 }
        ],
        [
          { "role": "user", "content": "How is the weather today?" },
          { "role": "assistant", "content": "It's sunny today, perfect for going out." }
        ]
      ]
    }
  ]
}
```

#### Format B: Top-level Array

```json
[
  {
    "sessionKey": "user-alice",
    "conversations": [
      [
        { "role": "user", "content": "Hello" },
        { "role": "assistant", "content": "Hello!" }
      ]
    ]
  }
]
```

Field Description

| Field | Type | Required | Description |
|------|------|------|------|
| `sessionKey` | string | ✅ | Session identifier (e.g., user ID, channel name) |
| `sessionId` | string | — | Session instance ID (multiple sessionIds can exist under the same sessionKey) |
| `conversations` | message[][] | ✅ | Conversation turn array, where each turn is a set of messages |
| `role` | string | ✅ | Message role: `user` or `assistant` |
| `content` | string | ✅ | Message content |
| `timestamp` | number \| string | — | Timestamp: epoch milliseconds or ISO 8601 string. If missing, seed will prompt for automatic filling |

Configuration Override

`--config` accepts a JSON file, performing a **two-level deep merge** with the plugin configuration in `openclaw.json`:

- If the top-level key is an object on both sides → shallow merge (preserve fields not overridden in base)
- Other types → direct overwrite

Common scenarios: use more aggressive pipeline parameters when seeding to accelerate processing:

```json
{
  "pipeline": {
    "everyNConversations": 3,
    "enableWarmup": false,
    "l1IdleTimeoutSeconds": 2,
    "l2DelayAfterL1Seconds": 1,
    "l2MinIntervalSeconds": 1,
    "l2MaxIntervalSeconds": 10
  }
}
```

If you need to seed an independent TCVDB database:

```json
{
  "storeBackend": "tcvdb",
  "tcvdb": {
    "database": "my_seed_test_db"
  },
  "pipeline": {
    "everyNConversations": 3,
    "enableWarmup": false,
    "l1IdleTimeoutSeconds": 2
  }
}
```

### Output directory structure

```
<output-dir>/
├── conversations/          — L0 JSONL files
├── records/                — L1 JSONL files
├── scene_blocks/           — L2 scene blocks
├── vectors.db              — SQLite vector database (sqlite backend only)
├── .metadata/
│   ├── manifest.json       — Metadata (store binding + seed run records)
│   └── checkpoint.json     — Pipeline progress
└── .backup/                — Rolling backup
```

After `Seed` is complete, `manifest.json` will record the information of this run:

```json
{
  "version": 1,
  "createdAt": "2026-04-01T22:00:00.000Z",
  "store": {
    "type": "sqlite",
    "sqlite": { "path": "vectors.db" }
  },
  "seed": {
    "inputFile": "conversations.json",
    "sessions": 3,
    "rounds": 42,
    "messages": 128,
    "startedAt": "2026-04-01T22:00:00.000Z",
    "completedAt": "2026-04-01T22:05:30.000Z"
  }
}
```
