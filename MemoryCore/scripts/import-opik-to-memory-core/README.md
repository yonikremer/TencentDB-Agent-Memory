# Opik → Memory Core Import Tool

Convert the Trace under Opik Project into conversation messages, and write them to L0 via the `POST /v3/conversation/add` of Memory Core Gateway.

## Capabilities

- Automatically paginate to read all Opik Projects and the specified Project's Traces
- Support selecting a project by Project name or UUID
- Recognize common Trace structures such as `messages`, `conversation`, `history`, `prompt/response`, and OpenAI `choices`
- Automatically merge input/output messages, eliminate overlaps, and limit the size of individual messages and batches
- Perform a pre-check by Session before writing; when the estimated number of L0 records exceeds 40,000, deduplicate across Traces and prioritize importing the latest tail snapshot
- Support Dry Run, resumable transfers, network retries, and Pipeline throttling
- The key is read only from environment variables

## Prerequisites

- Node.js `>= 22.16.0`
- Current project dependencies are installed
- Opik REST API is accessible
- Remote Memory Core Gateway is accessible at `/health`, `/v3/conversation/add`, and `/v3/conversation/query`
- Target `service_id`, `team_id`, `agent_id`, and `user_id` have been determined

Enter the Memory Core directory:

```bash
cd MemoryCore
```

View all parameters:

```bash
npm run import:opik -- --help
```

## Opik Address and Pagination

Recommended to configure only the Opik root address and workspace:

```bash
export OPIK_URL='http://opik.example.com:5173'
export OPIK_WORKSPACE='default'
```

Also compatible with UI address:

```text
http://opik.example.com:5173/default/projects?size=25
```

The `size=25` in the UI URL does not limit the import scope. The tool converts it to the `/api/v1/private` API address and automatically reads all paginated data by `page` and `size`; the default for `--page-size` is `100`.

Configure Remote Memory Core

The following address is only an example, please replace it with the actual Gateway address:

```bash
export MEMORY_CORE_URL='http://memory-core.example.com:8423'
export MEMORY_CORE_SERVICE_ID='default'
export MEMORY_CORE_TEAM_ID='team-001'
export MEMORY_CORE_AGENT_ID='agent-001'
export MEMORY_CORE_USER_ID='user-001'
```

Optional Task isolation:

```bash
export MEMORY_CORE_TASK_ID='task-001'
```

When no Task is needed:

```bash
unset MEMORY_CORE_TASK_ID
```

Safely input API Key, avoid writing it into code or configuration files:

```bash
read -s "MEMORY_CORE_API_KEY?Memory Core API Key: "
echo
export MEMORY_CORE_API_KEY
```

Check Gateway:

```bash
curl --fail --silent --show-error "${MEMORY_CORE_URL}/health"
```

First, run a Dry Run

Dry Run reads the real Opik and converts Traces, but does not write to Memory Core or breakpoint files:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-traces 5 \
  --dry-run
```

`--project` accepts both the Project name and UUID, and can be passed repeatedly or separated by commas:

```bash
npm run import:opik -- \
  --project 'project-a' \
  --project '019fb2e2-16a9-717d-98a8-0cd2e1bef87e' \
  --dry-run
```

If `--project` is not passed, all projects under the workspace are processed. When there are many projects, you should first specify the project and `--max-traces` for small-batch verification.

Formal import

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-traces 5 \
  --state-file './opik-import-remote-state.json'
```

It outputs:

```text
[import] project=... trace=... accepted=...
[done] seen_traces=5 imported_traces=5 ... imported_messages=...
```

Tool actual call:

```text
POST <MEMORY_CORE_URL>/v3/conversation/add
```

The write range is determined by the following fields:

- `x-tdai-service-id`: `MEMORY_CORE_SERVICE_ID`
- `team_id`: `MEMORY_CORE_TEAM_ID`
- `agent_id`: `MEMORY_CORE_AGENT_ID`
- `user_id`: `MEMORY_CORE_USER_ID`
- `task_id`: `MEMORY_CORE_TASK_ID`, optional
- `session_id`: Stably generated based on the Opik Project ID and `thread_id`/Trace ID

Each message writes the Opik original time simultaneously:

- `timestamp`: The actual time the message occurred
- `recorded_at`: The L0 ingestion sorting time, corresponding to TCVDB's `recorded_at_ms`

Therefore, when the panel is sorted by `recorded_at_ms desc`, it displays by Opik's historical time rather than by the time of this import execution. Ordinary Memory Core writes that do not explicitly pass `recorded_at` still use the server's reception time.

## Super Large Session Protection

Default `--max-session-messages 40000`. This counts the number of L0 messages, not the "turns" after pairing user/assistant; 40,000 messages is approximately equivalent to 20,000 standard Q&A turns, which is below the known single Session 50,000-message risk boundary.

The tool will first aggregate the Trace to be processed by the target `session_id`. If the same Session is expected to write more than the limit:

1. Merge cumulative conversations in Trace chronological order to eliminate the issue of previous Trace history being repeatedly appearing in subsequent Traces;
2. Only retain the latest N messages after deduplication;
3. Prioritize writing to an independent tail snapshot Session, with ID in the format `original session:t40000:<snapshot hash>`;
4. No longer write the old Traces of the source Session one by one, so a single new Session will not exceed the configured limit.

The independent snapshot ID changes with the trailing content. When new messages are added to the data source, a new snapshot Session is generated to avoid appending to the old Session and exceeding the limit again.

Check large sessions in Dry Run

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-session-messages 40000 \
  --large-session-strategy tail \
  --dry-run
```

If truncation is not allowed, we want to stop when an overflow is detected:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-session-messages 40000 \
  --large-session-strategy error \
  --dry-run
```

Using `--max-session-messages 0` can disable protection, but it is not recommended for Sessions that may exceed 50,000 L0 messages.

Resume from breakpoint

Default resume from breakpoint is enabled. Each successful batch is immediately written to `--state-file`, and re-executing the same command will automatically skip completed batches:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --state-file './opik-import-remote-state.json'
```

Ignore existing breakpoints:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --no-resume
```

`--no-resume` may cause duplicate imports, and should only be used when explicitly needing to re-import. The breakpoint file permissions are `0600`, but it does not store API Keys.

## Pipeline Strategy

Wait for L1 to be idle after every 20 batches written, and wait for L1/L2/L3 to be idle at the end.

If the target environment has memory extraction disabled, just write L0:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --wait-every 0 \
  --no-final-wait \
  --state-file './opik-import-remote-state.json'
```

Review import results

```bash
curl --fail --silent --show-error \
  -X POST "${MEMORY_CORE_URL}/v3/conversation/query" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${MEMORY_CORE_API_KEY}" \
  -H "x-tdai-service-id: ${MEMORY_CORE_SERVICE_ID}" \
  --data "$(cat <<JSON
{
  \"team_id\": \"${MEMORY_CORE_TEAM_ID}\",
  \"agent_id\": \"${MEMORY_CORE_AGENT_ID}\",
  \"user_id\": \"${MEMORY_CORE_USER_ID}\",
  \"limit\": 100,
  \"offset\": 0
}
JSON
)"
```

## Opik Authentication

Self-hosted Opik may not require authentication by default. When authentication is enabled:

```bash
read -s "OPIK_API_KEY?Opik API Key: "
echo
export OPIK_API_KEY
export OPIK_AUTH_SCHEME='Bearer'
```

When `OPIK_AUTH_SCHEME` is empty, `OPIK_API_KEY` is used as the `Authorization` Header as-is.

Common Parameters

| Parameter | Default Value | Description |
|---|---:|---|
| `--project` | All projects | Project name or UUID, repeatable or comma-separated |
| `--page-size` | `100` | Number of items per page in the Opik API |
| `--max-traces` | `0` | Maximum number of Traces to process this time, `0` means no limit |
| `--max-session-messages` | `40000` | Maximum number of L0 messages written to a single target Session, `0` disables the protection |
| `--large-session-strategy` | `tail` | Keep the latest tail when over limit; `error` means stop directly |
| `--state-file` | `.opik-memory-import-state.json` | Checkpoint file |
| `--dry-run` | Off | Only fetch and convert, do not write |
| `--no-resume` | Off | Ignore checkpoint, may import repeatedly |
| `--include-system` | Off | Convert system/developer to user messages with prefix |
| `--wait-every` | `20` | Wait for L1 every N write requests, `0` disables |
| `--no-final-wait` | Off | Do not wait for final L1/L2/L3 to be idle |
| `--timeout-ms` | `30000` | Timeout for a single HTTP request |
| `--retries` | `4` | Retries for network errors, 429, and 5xx |

Verified Link

This tool has been end-to-end verified using a real Opik API and an isolated local Memory Core:

1. Paginate and read Opik Project and Trace
2. Convert 5 Traces into 15 L0 messages
3. Write to `/v3/conversation/add`
4. Query 15 messages back via `/v3/conversation/query`
5. On repeated execution, breakpoint hit and write count is 0
6. SQLite and JSONL mirror disk write count are consistent
