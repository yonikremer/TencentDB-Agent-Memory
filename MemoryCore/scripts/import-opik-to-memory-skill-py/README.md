# Opik → Memory Core Skill Import Tool (Python Version)

**Only use Python standard library, no third-party dependencies**, runs directly on Python 3.9+.

Three subcommands

- `list-projects` — lists Opik projects only
- `fetch` — fetches data from Opik + aggregates local session JSON files (does not write core)
- `import` — imports local session files into Memory Core

**Recommended approach: separate fetch and import**. After fetch is complete, you can disconnect Opik, and let import run slowly; import supports resumable transfers (enabled by default), so if it crashes halfway through, restarting only fills in the missing parts.

Relationship with the TS version (`../import-opik-to-memory-skill/`)

| Dimension | TS version | Python version |
|---|---|---|
| Fetch vs Ingest | One Step | **Two-Step Separation** (fetch → import) |
| Dependencies | Node ≥ 22.16 + `npm install` | Python 3.9+, Zero Dependencies |
| Ingest Batching | Pack by bytes/items | **Batch by "one round of conversation"** (one user + its subsequent assistant/tool_call/tool_result) |
| Ingest Rhythm | As fast as possible | Sleep per round (default 3s), Opik global rate limit 500ms |
| Resume | Yes | **import has it, per-session granularity** |
| Extracted Output Stats | Polls `skill/list` until convergence | No query; view output in UI or via `/v3/skill/list` |

Prerequisites

- Python 3.9+
- Opik REST API is reachable
- Memory Core Gateway business interface (`/v3/skill/*`) is working
- Memory Core side skill extraction + LLM are both running (otherwise 0 output)
- `team_id` + `agent_id` are registered at the metadata layer
  - ⚠️ agent id is `agt-xxx` instead of `apt-xxx`; the `asset_id` found in metadata `/api/v1/meta/asset/list-accessible` is `skl-*` (skill primary key), and the corresponding `agent_id` needs to be reverse-looked up via `owner_agent_id` using core's `/v3/skill/list`

Only the key uses an environment variable, the rest are command-line arguments

Deliberately design it this way: env is easy to mess up, forget to unset, and be inherited by other processes. Identity-type parameters (`--team-id / --agent-id / --user-id / --service-id / --memory-url / --opik-url`) **must be explicitly provided on the command line**, so that each call can clearly see which environment it is targeting.

Keys are read only from environment variables and do not accept CLI parameters (to avoid appearing in shell history / `ps aux`)

```bash
export MEMORY_CORE_API_KEY='ck_xxx.xxx'
# Opik is needed only when authentication:
# export OPIK_API_KEY='...'
# export OPIK_AUTH_SCHEME='Bearer'
```

> `user_id` / `team_id` / `agent_id` / `session_id` must not contain `|` (Redis queue element separator), which is validated when the script starts.

Usage

### 1. List Opik project

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py list-projects \
  --opik-url 'http://<opik-host>:5173'
```

No Memory Core parameter or key is needed.

### 2. Fetch —— Pull data from Opik to local

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py fetch \
  --opik-url 'http://<opik-host>:5173' \
  --project '3367b740' \
  --out-dir ./opik-dump-3367b740
```

- `--project` supports exact id / exact name / id prefix / name prefix
- Each session in the output directory has a `.json` file (`session_id + .json`, illegal characters converted to `-`)
- There is also a `manifest.json` in the directory, which records the project id, trace count, session count, and capture time
- Existing files are skipped by default; only overwrite with `--overwrite`

**Important**: fetch only compresses Opik, not Memory Core, and the two are decoupled.

### 3. Import —— Pouring from local directory into Memory Core

```bash
MEMORY_CORE_API_KEY='ck_xxx.xxx' \
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir ./opik-dump-3367b740 \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id  team-xxx \
  --agent-id agt-xxx \
  --user-id  usr-xxx \
  --task-id  opik-import-2026-08 \
  --concurrency 5 \
  --turn-gap-ms 2000
```

You will see a rough ETA on the first run:

```
[import] total sessions=87 (completed 0, pending 87) total turns=412 pending turns=412
[import] concurrency=5 turn-gap=2000ms → rough ETA ~2m44s (HTTP time to be added separately)
```

A progress line is printed after each session is completed during the running process:

```
[progress] sessions 12/87  turns 68/412  elapsed 34s  ETA ~2m5s
```

Breakpoints are saved in `--in-dir/.import-state.json` (overridable with `--state-file`). Re-running after a crash will automatically skip completed sessions; add `--no-resume` to force a re-import.

### Dry-run

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir ./opik-dump-3367b740 \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id  team-xxx --agent-id agt-xxx --user-id usr-xxx \
  --dry-run
```

It won't really send core, won't write breakpoints, only goes through the grouping logic once. dry-run also needs to provide identity parameters (the script needs to read them in for validation and calculating ETA).

## Parameter Mapping

### `fetch`

| Parameter | Default | Description |
|---|---:|---|
| `--project` | **Required** | id / name / prefix |
| `--out-dir` | **Required** | output directory |
| `--max-traces` | 0 | maximum number of traces to pull from Opik (0=unlimited) |
| `--max-sessions` | 0 | keep only the first N sessions |
| `--page-size` | 100 | Opik pagination size |
| `--opik-request-gap-ms` | 500 | minimum interval between Opik requests (protect Opik) |
| `--include-system` | Off | Keep system messages (default: discard) |
| `--overwrite` | Off | Overwrite existing files |

### `import`

| Parameter | Default | Description |
|---|---:|---|
| `--in-dir` | **Required** | directory generated by fetch |
| `--max-sessions` | 0 | only fetch the first N sessions |
| `--concurrency` | 2 | concurrency limit between different sessions |
| `--turn-gap-ms` | 3000 | interval between turns in the same session |
| `--no-force-archive` | Off | do not perform tail force-archive |
| `--dry-run` | Off | read-only, no writes |
| `--state-file` | `<in-dir>/.import-state.json` | checkpoint file |
| `--no-resume` | off | ignore checkpoint |

## Data Flow

```
Opik /projects
    ↓ (select project)
Opik /traces?project_id=...   (pagination; global rate limit 500ms per request)
    ↓
Aggregate by thread_id → keep only the trace with the most messages per thread (cumulative snapshot)
    ↓
Local JSON file: <out-dir>/<session_id>.json
    ↓ (fetch finished; you can disconnect Opik at this point)
    ↓ (import started)
Read local file → split each session into "one round of conversation"
    ↓
concurrency=N run different sessions concurrently; serially within the same session
    ↓
Each round POST /v3/skill/conversation/add (same session_id)
    ↓ sleep turn-gap-ms
    ↓
force-archive fallback → record breakpoint
```

**Key points**:
- The same session always uses the same `session_id`; only one round of conversation is pushed each time
- Sleep between rounds within the same session (default 3s), different sessions run concurrently
- Opik captures the global minimum interval (default 500ms)
- The import breakpoint granularity is session; if a round within a session fails, it will warn and continue to the next round

Extraction Threshold

The server `add-handler` triggers archiving when any of the following conditions are met:

| Condition | Threshold |
|---|---:|
| `tool_call` total count | 10 |
| Total bytes | 40 KB |
| Bytes per request | ≥ 40 KB compress and archive immediately |

If a session has few tool calls and short content, only `force-archive` triggers archiving; the extractor judging it as "not worth persisting" → 0 skills, this is a **normal result**.

Quick verification (1 session, link verification)

```bash
# fetch 1 session
python3 scripts/import-opik-to-memory-skill-py/import_opik.py fetch \
  --opik-url 'http://<opik-host>:5173' \
  --project '019ed0c0' --out-dir /tmp/opik-smoke \
  --max-sessions 1 --max-traces 20

# Inject into core
MEMORY_CORE_API_KEY='ck_xxx.xxx' \
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir /tmp/opik-smoke \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id team-xxx --agent-id agt-xxx --user-id usr-xxx \
  --turn-gap-ms 1000
```

## Known Limitations

- Do not filter evaluation data such as SWE-bench (manually avoid when selecting projects)
- Do not check the extraction output; review the UI / `/v3/skill/list` later
- A single round failure within a single session will warn and continue, without overall rollback (next rerun of the same session content is consistent, will it not be archived repeatedly? — it will be repeated; the granularity of the checkpoint is the session, and no further subdivision within the session. If many rounds fail, you can delete the checkpoint entries of this session and rerun)
