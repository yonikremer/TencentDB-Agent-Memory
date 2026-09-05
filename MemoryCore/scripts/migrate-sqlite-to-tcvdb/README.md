# SQLite → Tencent Cloud Vector Database Migration Tool

Offline migration tool, used to migrate data from memory-tdai from local SQLite storage to Tencent Cloud Vector Database (TCVDB).

## Prerequisites

- Node.js >= 22.16.0
- The plugin has been installed via `openclaw plugins install`
- The migration script has been compiled (see below)

## Compile

The migration script is written in TypeScript and needs to be compiled before running:

```bash
npm run build:migrate-sqlite-to-vdb
```

Output the compilation artifacts to `scripts/migrate-sqlite-to-tcvdb/dist/`, which can be run directly with Node.

Usage

```bash
# Pre-check mode (only view source data, no writes executed)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --dry-run

# Official Migration
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --yes
```

### More examples

```bash
# Directly pass the API Key (without using environment variables)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key 'your-api-key-here' \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --yes
```

```bash
# Specify a custom SQLite path (when the database is not located at the default vectors.db location)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --sqlite-path /backup/2026-04/vectors-snapshot.db \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --yes
```

```bash
# Only migrate the L1 memory layer (skip L0 raw messages and Profile)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --layers l1 \
  --yes
```

```bash
# Only migrate L0 and L1 (do not migrate Profile)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --layers l0,l1 \
  --yes
```

```bash
# Use English BM25 for tokenization
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-en-v1.5 \
  --bm25-language en \
  --yes
```

```bash
# Disable BM25 sparse vectors (use dense vector retrieval only)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --no-bm25-enabled \
  --yes
```

```bash
# Only migrate data, do not automatically update openclaw.json and manifest (manually manage configuration)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --no-apply-config \
  --no-rewrite-manifest \
  --yes
```

```bash
# Append migration: allow target database to have existing data, skip non-empty check
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --no-fail-if-target-nonempty \
  --no-verify-counts \
  --yes
```

```bash
# Output migration summary to JSON file (suitable for CI/automation pipelines)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --summary-json-path ./migration-report.json \
  --job-id "migrate-2026-04-13" \
  --yes
```

```bash
# Set custom timeout and aliases
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://10.0.1.50:80 \
  --tcvdb-username admin \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --tcvdb-alias "Production-Primary Database" \
  --tcvdb-timeout-ms 30000 \
  --yes
```

## Parameter Description

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--plugin-data-dir` | Yes | — | Plugin data directory path |
| `--openclaw-config-path` | Yes | — | `openclaw.json` config file path |
| `--sqlite-path` | No | `<plugin-data-dir>/vectors.db` | SQLite database file path (defaults to `vectors.db` under the data directory) |
| `--plugin-id` | No | `memory-tencentdb` | Plugin ID used when writing the configuration |
| `--tcvdb-url` | Yes | — | TCVDB service address |
| `--tcvdb-username` | Yes | — | TCVDB username |
| `--tcvdb-api-key` | * | — | TCVDB API key (plaintext) |
| `--tcvdb-api-key-env` | * | — | Environment variable name containing the API key |
| `--tcvdb-database` | Yes | — | TCVDB database name |
| `--tcvdb-embedding-model` | Yes | — | Embedding model name |
| `--tcvdb-alias` | No | `""` | User-defined alias |
| `--tcvdb-timeout-ms` | No | `10000` | Request timeout (milliseconds) |
| `--layers` | No | `l0,l1,l2,l3` | Layers to migrate (comma-separated) |
| `--dry-run` | No | `false` | Preview only, do not perform writes |
| `--yes` | No | `false` | Skip interactive confirmation |
| `--apply-config` | No | `true` | Update openclaw.json after migration |
| `--config-backup` | No | `true` | Back up the original config file before writing |
| `--rewrite-manifest` | No | `true` | Update manifest.json to tcvdb |
| `--fail-if-target-nonempty` | No | `true` | Abort if the target database is non-empty |
| `--verify-counts` | No | `true` | Verify record count after migration |
| `--summary-json-path` | No | — | Write migration summary to this file |
| `--job-id` | No | — | Migration job ID (for tracking) |
| `--bm25-enabled` | No | `true` | Enable BM25 sparse vectors |
| `--bm25-language` | No | `zh` | BM25 language (`zh` or `en`) |

* `--tcvdb-api-key` and `--tcvdb-api-key-env` are mutually exclusive, one must be provided.

## Table of Contents

```
scripts/migrate-sqlite-to-tcvdb/
├── cli-entry.ts          # CLI entry
├── sqlite-to-tcvdb.ts    # Migration core logic (parameter parsing, pre-check, data migration)
├── config-write.ts       # OpenClaw config update (JSON5, self-contained)
├── manifest-write.ts     # Manifest rewrite
├── *.test.ts             # Locally placed test files
├── tsconfig.json         # Migration script compilation config
├── dist/                 # Build artifacts (gitignored)
└── README.md             # This file

bin/migrate-sqlite-to-tcvdb.mjs     # Thin bin wrapper → dist/
```

The migration script references the storage implementation via `../../src/` (VectorStore, TcvdbMemoryStore, etc.), but **does not depend on `openclaw/plugin-sdk`**. Configuration is written back directly using `json5`.
