# MemoryKnowledge (Knowledge Service)

This directory contains the **Knowledge Service (KS)** within the monorepo: user-side Wiki + Code-Graph engine.  
The control plane resides in [`../MemoryPanel`](../MemoryPanel/).

Default port **8421**, API prefix **`/v3`**.

## Features

| Capability | Description |
| --- | --- |
| **LLM-Wiki** | Upload/pull documents → LLM extracts structured pages → FTS5 full-text search + Knowledge Graph |
| **Code-Graph** | `git clone` repositories → CodeGraph index (symbols, call graphs, file tree) → Exploration queries |
| **Auto-Sync** (Optional) | Periodically scans code-graph, FIFO queue + worker pool automatically pulls git updates and rebuilds index. Disabled by default, see `docs/data-flow.md` §9. |
| **Tools** | `POST /v3/tools/list`, `/v3/tools/call`, for Agent / Kernel self-discovery and invocation |
| **Status Callback** | Callbacks Panel (`TMC_CALLBACK_URL`) after ingest/sync completion, then writes remote meta / knowledge |

Running `pnpm dev` alone starts the service; in the production workflow, Panel must push `llm_binding`, receive callbacks, and write remote metadata.

## Source Structure

```text
MemoryKnowledge/
├── src/
│   ├── server.ts           # Hono entry: routing, Swagger, server listener
│   ├── module.ts           # Assembles store / wiki / code-graph / queue / recovery
│   ├── config.ts           # Environment variables
│   ├── callback.ts         # → Panel status-callback
│   ├── telemetry.ts        # Optional Langfuse (disabled if KEY is missing)
│   ├── routes/             # wiki / code-graph / tools / llm-binding / health
│   ├── engines/
│   │   ├── wiki/           # ingest-v2, index, graph search
│   │   └── code/           # CodeGraph bridge
│   ├── store/              # SQLite (Drizzle) + build queue + llm_binding
│   ├── source-fetcher/     # Git pull
│   ├── mcp/                # MCP stdio (forwards to local HTTP API)
│   ├── db/                 # schema / client
│   └── middleware/
├── docs/                   # Design and API details
├── Dockerfile              # KS single image (optional)
└── docker-compose.yml      # Local single-command KS container runner (optional)
```

## Local Setup

For production or joint debugging using the **Panel + KS combined image**, pull [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub) directly (see [`../deploy/panel-knowledge-combined/README.md`](../deploy/panel-knowledge-combined/README.md) for usage). Below is how to run only this service's source code:

```bash
cd MemoryKnowledge
pnpm install --ignore-workspace
cp .env.example .env
# Edit .env (see below)
pnpm dev
```

```bash
curl -s http://127.0.0.1:8421/health
# Swagger: http://127.0.0.1:8421/docs
```

When debugging alongside Panel (Panel default `8123`), KS `.env` requires at least:

```dotenv
PORT=8421
API_PREFIX=/v3
KNOWLEDGE_DATA_DIR=./data
KNOWLEDGE_DB_PATH=./data/knowledge.db
KNOWLEDGE_PUBLIC_BASE_URL=http://127.0.0.1:8421/v3   # Accessible by Agent, must include /v3
TMC_CALLBACK_URL=http://127.0.0.1:8123               # Panel root address, do NOT include callback path
LLM_MODE=proxy
LLM_MODEL=Memory-Model
```

Panel side (Panel's own `.env`, not KS):

```dotenv
KNOWLEDGE_SERVICE_URL=http://127.0.0.1:8421
```

| Variable | Read By | Includes `/v3`? |
| --- | --- | --- |
| `KNOWLEDGE_PUBLIC_BASE_URL` | KS → written into resource `service_url` | Yes |
| Panel `KNOWLEDGE_SERVICE_URL` | Panel → calls KS management API | No |
| `TMC_CALLBACK_URL` | KS → callbacks Panel | No (root only) |

`LLM_MODE=proxy` (default): Wiki uses `llm_binding` pushed by Panel per `x-tdai-service-id`; no need to start Proxy locally.  
`LLM_MODE=custom`: Set `LLM_API_KEY` / `LLM_BASE_URL` (and optional `LLM_PROTOCOL=anthropic`) in `.env`.

## Common Commands

```bash
pnpm dev          # HTTP API (tsx hot reload)
pnpm dev:mcp      # MCP stdio (open another terminal; requires HTTP already running)
pnpm typecheck
pnpm test
pnpm build        # tsdown → dist/
```

## Optional: ClickHouse Tool Call Telemetry

Disabled by default. When the following environment variables are set, Knowledge Service will log `POST /v3/tools/call` into `tool_call_logs` (compatible structure with Memory/Skill); tables are created idempotently on startup, and batch write or table creation failures will not block business requests.

```dotenv
KNOWLEDGE_CLICKHOUSE_ENABLED=true
KNOWLEDGE_CLICKHOUSE_URL=http://clickhouse.example.com:8123
KNOWLEDGE_CLICKHOUSE_DATABASE=default
KNOWLEDGE_CLICKHOUSE_TABLE=tool_call_logs
KNOWLEDGE_CLICKHOUSE_USER=knowledge_writer
KNOWLEDGE_CLICKHOUSE_PASSWORD=              # Inject from env only, do NOT commit to code
```

See `.env.example` for optional tuning options. If caller passes `x-conversation-id`, `x-tdai-user-id`, `x-tdai-team-id`, `x-tdai-agent-id`, `x-tdai-agent-source`, `x-tdai-space-id`, `x-tdai-turn-seq`, these dimensions will be stored together; if missing, corresponding columns remain empty. Request body is recursively sanitized and truncated to 512 bytes.

## Optional: Langfuse

Configure `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` (and optional `LANGFUSE_BASE_URL`) to report Wiki LLM calls.  
When unconfigured, Trace is disabled without affecting business logic.
