# Deployment and Integration Guide (Open Source Standalone / Cloud Service)

> 📖 **This document specifically explains deployment topologies, Hermes integration, and end-to-end verification.**
> To understand the core capabilities, configuration parameters, and CLI tools of the plugin, please return to the **[Main README](README.md)**.

`memory-tencentdb` provides **two independent deployment topologies**, both of which can be called by external Agents (typically Hermes) via HTTP APIs, adapting to different deployment scales and operational requirements:

| Topology | Backend Storage | State Backend | Multi-tenant | Applicable Scenarios |
|------|----------|----------|--------|----------|
| **Standalone (Open Source Single Node)** | SQLite + Local Files | In-process Map / Timer | Single space | Local development, single Agent sidecar, Docker all-in-one, offline deployment |
| **Service (Cloud Service)** | TCVDB + COS | Redis (Distributed lock + Task queue) | Multi-space per-`service_id` | K8s multi-replica, multi-tenant SaaS, multi-Agent shared memory |

```
L0  Raw Dialogue Records (Conversation)    ← Auto written
L1  Atomic Structured Memory (Atomic Memory)  ← LLM extraction + deduplication
L2  Scene Blocks (Scene Blocks)           ← LLM scene extraction
L3  User Persona (Persona)              ← LLM persona synthesis
```

Both topologies share the same Gateway binary and v1/v2 HTTP APIs, differing only in configuration and backend. Switching topologies only requires adjusting the `TDAI_DEPLOY_MODE` environment variable.

---

## Quick Start (3 Steps)

```bash
# 1. Enter MemoryCore and install dependencies
cd MemoryCore
npm install

# 2. Configure LLM
export TDAI_LLM_API_KEY="your-api-key"
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"
export TDAI_LLM_MODEL="deepseek-chat"

# 3. Start Gateway
npx tsx src/gateway/server.ts
```

Gateway listens on `http://127.0.0.1:8420` by default, and data is stored in `~/.memory-tencentdb/memory-tdai/`.

---

## Deployment Modes

### Standalone Mode (Single Node)

Zero external dependencies, all data is stored locally. Suitable for: local development, single Agent sidecar, Docker all-in-one deployment.

**Storage**: SQLite (Vector + Records) + Local File System (L2/L3 Documents)
**State Management**: In-process Map/Timer

#### Environment Variable Configuration

```bash
# Required — LLM Configuration
export TDAI_LLM_API_KEY="sk-xxx"
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"   # Default https://api.openai.com/v1
export TDAI_LLM_MODEL="deepseek-chat"                     # Default gpt-4o
export TDAI_LLM_MAX_TOKENS=4096
export TDAI_LLM_TIMEOUT_MS=120000

# Optional — Service Configuration
export TDAI_GATEWAY_PORT=8420            # Listen port, default 8420
export TDAI_GATEWAY_HOST="127.0.0.1"    # Listen host, default 127.0.0.1
export TDAI_DATA_DIR="~/.memory-tencentdb/memory-tdai"  # Data directory
```

#### YAML Configuration File (Optional)

Configuration file search order: `$TDAI_GATEWAY_CONFIG` → `./tdai-gateway.yaml` → `<dataDir>/tdai-gateway.yaml`

```yaml
# tdai-gateway.yaml — Standalone mode
server:
  port: 8420
  host: "127.0.0.1"

data:
  baseDir: "~/.memory-tencentdb/memory-tdai"

llm:
  baseUrl: "https://api.deepseek.com/v1"
  apiKey: "${TDAI_LLM_API_KEY}"
  model: "deepseek-chat"
  maxTokens: 4096
  timeoutMs: 120000

# memory config (optional, all have reasonable defaults)
memory:
  capture:
    enabled: true
    excludeAgents: []
  recall:
    maxResults: 5
    scoreThreshold: 0.3
    strategy: "hybrid"            # hybrid / embedding / keyword
  embedding:
    enabled: true
    provider: "openai"            # none / openai / deepseek / qclaw
    baseUrl: "${TDAI_LLM_BASE_URL}"
    apiKey: "${TDAI_LLM_API_KEY}"
    model: "text-embedding-3-small"
    dimensions: 1536
  bm25:
    enabled: true
    language: "zh"
  storeBackend: "sqlite"          # sqlite (standalone) or tcvdb (service)
  pipeline:
    everyNConversations: 5
    enableWarmup: true
    l1IdleTimeoutMs: 30000
    l2IntervalMs: 300000
    l3IntervalMs: 600000
```

#### Docker Deployment

```bash
# Pure Gateway
docker run -d \
  -e TDAI_LLM_API_KEY="sk-xxx" \
  -e TDAI_LLM_BASE_URL="https://api.deepseek.com/v1" \
  -e TDAI_LLM_MODEL="deepseek-chat" \
  -e TDAI_GATEWAY_HOST="0.0.0.0" \
  -p 8420:8420 \
  -v tdai-data:/root/.memory-tencentdb/memory-tdai \
  agentmemory/hermes-memory:latest
```

#### Data Directory Structure

```
~/.memory-tencentdb/memory-tdai/
  ├── vectors.db              # SQLite vector database (L0 + L1)
  ├── conversations/          # L0 raw dialogues JSONL
  ├── records/                # L1 structured memories
  ├── scene_blocks/           # L2 scene Markdown files
  ├── persona.md              # L3 user persona
  └── checkpoint.json         # Pipeline progress
```

---

### Service Mode (Cloud Service)

Uses external storage (TCVDB vector database + COS object storage), supports multi-replica horizontal scaling. Suitable for: K8s clusters, multi-tenant SaaS, multi-Agent shared memory.

**Storage**: TCVDB (Vector search) + COS (L2/L3 documents, per-serviceId path isolation)
**State Management**: Redis (Distributed lock + Task queue)
**Config Source**: Shark service (Dynamic VDB/COS credentials) or Environment variables (Static credentials)

#### Environment Variable Configuration

```bash
# ── Deployment Mode ──
export TDAI_DEPLOY_MODE="service"           # CRITICAL: enable service mode

# ── LLM (same as standalone) ──
export TDAI_LLM_API_KEY="sk-xxx"
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"
export TDAI_LLM_MODEL="deepseek-chat"

# ── Service Port ──
export TDAI_GATEWAY_PORT=3100
export TDAI_GATEWAY_HOST="0.0.0.0"

# ── Redis (Distributed State Backend) ──
export STATE_BACKEND="redis"                # redis or local (for local testing)
export REDIS_HOST="redis.example.com"
export REDIS_PORT=6379
export REDIS_PASSWORD="your-password"
export REDIS_KEY_PREFIX="tdai_memory"

# ── VDB Vector Database (Direct Connection Mode) ──
export VDB_ENDPOINT="http://vdb.example.com:8100"
export VDB_USER="root"
export VDB_API_KEY="your-vdb-api-key"
export VDB_DATABASE="memory-production"

# ── COS Object Storage (Direct Connection Mode) ──
export COS_SECRET_ID="AKIDxxxx"
export COS_SECRET_KEY="xxxxx"
export COS_TOKEN=""                         # Fill in when using STS temporary credentials
export COS_URL="https://your-bucket.cos.ap-guangzhou.myqcloud.com"
export COS_PATH_PREFIX="tenants/prod/"

# ── Or use Shark config service (Recommended for production) ──
export SHARK_BASE_URL="http://shark.example.com:8080"
# Shark will automatically provide per-instance VDB and COS configs

# ── Optional Tuning ──
export CONFIG_VDB_TTL_MS=300000             # VDB config cache TTL, default 5 minutes
export CONFIG_COS_BUFFER_MS=120000          # COS credential early refresh time
export CONFIG_MAX_INSTANCES=1000            # Max cached instances
export SCANNER_SPACES="space1,space2"       # Space list for Timer Scanner to scan
export TDAI_SPACE_ID="default"              # Current instance space ID
```

#### YAML Configuration File

```yaml
# tdai-gateway.yaml — Service mode
deployMode: service

server:
  port: 3100
  host: "0.0.0.0"

data:
  baseDir: "/data/tdai-memory"

llm:
  baseUrl: "${TDAI_LLM_BASE_URL}"
  apiKey: "${TDAI_LLM_API_KEY}"
  model: "deepseek-chat"

memory:
  storeBackend: "tcvdb"
  tcvdb:
    embeddingModel: "bge-large-zh"    # Server-side embedding model for VDB
    timeout: 10000
  embedding:
    enabled: false                     # TCVDB has built-in embedding, client doesn't need it
    provider: "none"
  bm25:
    enabled: true
    language: "zh"
  recall:
    strategy: "hybrid"
    maxResults: 10
```

#### K8s Deployment

```yaml
# Core environment variables (injected via ConfigMap/Secret)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tdai-memory-gateway
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: gateway
          image: agentmemory/hermes-memory:latest
          env:
            - name: TDAI_DEPLOY_MODE
              value: "service"
            - name: TDAI_GATEWAY_PORT
              value: "3100"
            - name: TDAI_GATEWAY_HOST
              value: "0.0.0.0"
            - name: STATE_BACKEND
              value: "redis"
            - name: REDIS_HOST
              valueFrom:
                configMapKeyRef:
                  name: tdai-config
                  key: redis-host
            - name: SHARK_BASE_URL
              value: "http://shark-svc:8080"
          ports:
            - containerPort: 3100
---
apiVersion: v1
kind: Service
metadata:
  name: tdai-memory-gateway
spec:
  selector:
    app: tdai-memory-gateway
  ports:
    - port: 3100
      targetPort: 3100
```

#### Multi-replica Architecture

```
                    ┌─────────────┐
                    │  Hermes #1  │─┐
                    └─────────────┘ │
                    ┌─────────────┐ │    ┌──────────────────┐    ┌──────────┐
                    │  Hermes #2  │─┼───→│  TDAI Gateway    │───→│  TCVDB   │
                    └─────────────┘ │    │  (N replicas)    │    │ Vector DB│
                    ┌─────────────┐ │    │                  │───→│          │
                    │  Hermes #3  │─┘    │  ┌─ Scanner ─┐   │    └──────────┘
                    └─────────────┘      │  │  Worker   │   │    ┌──────────┐
                                         │  └───────────┘   │───→│   COS    │
  Each Hermes uses a unique              └──────────────────┘    │ ObjectStrg│
  x-tdai-service-id                             │                └──────────┘
  to achieve data isolation              ┌──────────────┐
                                         │    Redis     │
                                         │ State + Tasks│
                                         └──────────────┘
```

---

## Hermes Plugin Configuration

Two Hermes plugins are provided for different deployment scenarios.

### v1 Plugin: `memory_tencentdb` (Standalone Self-managed)

Automatically starts and manages the Gateway child process; no manual Gateway deployment needed. Suitable for single Agent local/Docker deployments.

**Install Plugin**:

```bash
# Symlink (recommended for dev environments)
ln -s "$(pwd)/MemoryCore/hermes-plugin/memory/memory_tencentdb" \
      <hermes-agent>/plugins/memory/memory_tencentdb

# Copy (for production deployments)
cp -r MemoryCore/hermes-plugin/memory/memory_tencentdb \
      <hermes-agent>/plugins/memory/memory_tencentdb
```

**Hermes Configuration** (`~/.hermes/config.yaml`):

```yaml
memory:
  provider: memory_tencentdb
```

**Environment Variables**:

| Variable | Default Value | Description |
|------|--------|------|
| `TDAI_LLM_API_KEY` | (Required) | LLM API Key |
| `TDAI_LLM_BASE_URL` | `https://api.openai.com/v1` | LLM API URL |
| `TDAI_LLM_MODEL` | `gpt-4o` | LLM model name |
| `MEMORY_TENCENTDB_GATEWAY_PORT` | `8420` | Gateway listen port |
| `MEMORY_TENCENTDB_GATEWAY_HOST` | `127.0.0.1` | Gateway listen address |
| `MEMORY_TENCENTDB_GATEWAY_CMD` | (Auto-detected) | Custom Gateway start command |

**Tool List**:

| Tool | Purpose |
|------|------|
| `memory_tencentdb_memory_search` | Search L1 structured memory |
| `memory_tencentdb_conversation_search` | Search L0 raw conversations |

**Features**: Automatically starts Gateway child process, health check watchdog (10s interval), automatic recovery, circuit breaker protection, background sync thread.

---

### v2 Plugin: `memory_tencentdb_v2` (External Gateway)

Connects to a running Gateway service (local or remote), communicating via v2 REST API. Suitable for multi-Agent shared Gateway, K8s cluster deployments.

**Install Plugin**:

```bash
ln -s "$(pwd)/MemoryCore/hermes-plugin/memory/memory_tencentdb_v2" \
      <hermes-agent>/plugins/memory/memory_tencentdb_v2
```

**Install Python SDK**:

```bash
pip install tdai-memory
```

**Hermes Configuration** (`~/.hermes/config.yaml`):

```yaml
memory:
  provider: memory_tencentdb_v2
```

**Environment Variables**:

| Variable | Default Value | Description |
|------|--------|------|
| `TDAI_MEMORY_ENDPOINT` | `http://127.0.0.1:8420` | Gateway service address |
| `TDAI_MEMORY_API_KEY` | `""` | Bearer Token (required in service mode) |
| `TDAI_MEMORY_SERVICE_ID` | `""` | Instance/space ID (Multi-tenant isolation key) |

**Tool List**:

| Tool | Purpose | Parameters |
|------|------|------|
| `tdai_memory_search` | Search L1 structured memory | `query`(required), `limit`(default 5) |
| `tdai_conversation_search` | Search L0 raw conversations | `query`(required), `limit`(default 5) |
| `tdai_read_scene` | Read L2 scene content | `scene_id`(required) |

**Features**: Based on `tdai_memory` Python SDK (httpx), Bearer Token authentication, multi-tenant isolation, circuit breaker (5 failures → 60s cooldown), thread-safe.

---

### Selection Recommendations

| Scenario | Recommended Plugin | Deployment Mode | Gateway |
|------|----------|----------|---------|
| Local dev / Single Agent | `memory_tencentdb` (v1) | standalone | Plugin auto-managed |
| Docker single container | `memory_tencentdb` (v1) | standalone | Plugin auto-managed |
| Multi-Agent shared memory | `memory_tencentdb_v2` (v2) | service | Independently deployed |
| K8s cluster | `memory_tencentdb_v2` (v2) | service | K8s Service |
| Multi-tenant SaaS | `memory_tencentdb_v2` (v2) | service | Multi-replica + Redis |

---

## API Overview

### v1 API (Standalone Compatible)

| Method | Path | Description |
|------|------|------|
| GET | `/health` | Health check |
| POST | `/recall` | Memory recall (prefetch) |
| POST | `/capture` | Conversation capture (sync_turn) |
| POST | `/search/memories` | L1 memory search |
| POST | `/search/conversations` | L0 conversation search |
| POST | `/session/end` | Session end + flush |
| POST | `/seed` | Batch import historical conversations |

### v2 API (Multi-tenant, requires Bearer Token + x-tdai-service-id)

| Method | Path | Description |
|------|------|------|
| POST | `/v2/conversation/add` | L0 add conversation |
| POST | `/v2/conversation/query` | L0 query conversation |
| POST | `/v2/conversation/search` | L0 search conversation |
| POST | `/v2/conversation/delete` | L0 delete conversation |
| POST | `/v2/atomic/add` | L1 add memory |
| POST | `/v2/atomic/query` | L1 query memory |
| POST | `/v2/atomic/search` | L1 search memory |
| POST | `/v2/atomic/delete` | L1 delete memory |
| POST | `/v2/scenario/ls` | L2 list scenes |
| POST | `/v2/scenario/read` | L2 read scene |
| POST | `/v2/scenario/write` | L2 write scene |
| POST | `/v2/scenario/rm` | L2 delete scene |
| POST | `/v2/persona/read` | L3 read persona |
| POST | `/v2/persona/write` | L3 write persona |

---

## Configuration Reference

### All Environment Variables

| Variable | Default Value | Applicable Mode | Description |
|------|--------|----------|------|
| **Gateway Basics** |
| `TDAI_DEPLOY_MODE` | `standalone` | All | `standalone` or `service` |
| `TDAI_GATEWAY_PORT` | `8420` | All | Listen port |
| `TDAI_GATEWAY_HOST` | `127.0.0.1` | All | Listen host |
| `TDAI_DATA_DIR` | `~/.memory-tencentdb/memory-tdai` | All | Data directory |
| `TDAI_GATEWAY_CONFIG` | (Search) | All | Config file path |
| **LLM** |
| `TDAI_LLM_API_KEY` | `""` | All | LLM API Key |
| `TDAI_LLM_BASE_URL` | `https://api.openai.com/v1` | All | LLM API URL |
| `TDAI_LLM_MODEL` | `gpt-4o` | All | Model name |
| `TDAI_LLM_MAX_TOKENS` | `4096` | All | Max output tokens |
| `TDAI_LLM_TIMEOUT_MS` | `120000` | All | LLM request timeout |
| **Service Mode** |
| `STATE_BACKEND` | (auto) | service | `redis` or `local` |
| `REDIS_HOST` | `127.0.0.1` | service | Redis host |
| `REDIS_PORT` | `6379` | service | Redis port |
| `REDIS_PASSWORD` | (None) | service | Redis password |
| `REDIS_KEY_PREFIX` | `tdai_memory` | service | Redis key prefix |
| **VDB (Direct Connect Mode)** |
| `VDB_ENDPOINT` | `""` | service | VDB URL |
| `VDB_USER` | `root` | service | VDB username |
| `VDB_API_KEY` | `""` | service | VDB API Key |
| `VDB_DATABASE` | `default` | service | VDB database name |
| **COS (Direct Connect Mode)** |
| `COS_SECRET_ID` | (None) | service | COS AK |
| `COS_SECRET_KEY` | (None) | service | COS SK |
| `COS_TOKEN` | (None) | service | COS STS Token |
| `COS_URL` | (None) | service | COS Bucket URL |
| `COS_PATH_PREFIX` | (None) | service | COS path prefix |
| **Shark (Production Mode)** |
| `SHARK_BASE_URL` | (None) | service | Shark config service URL |
| **Tuning** |
| `CONFIG_VDB_TTL_MS` | `300000` | service | VDB config cache TTL |
| `CONFIG_COS_BUFFER_MS` | `120000` | service | COS credential early refresh |
| `CONFIG_MAX_INSTANCES` | `1000` | service | Max cached instances |
| `SCANNER_SPACES` | `default` | service | Spaces for Scanner to scan |
| `TDAI_SPACE_ID` | `default` | service | Current space ID |

---

## Typical Deployment Examples

### Example 1: Local Development (Simplest)

```bash
export TDAI_LLM_API_KEY="sk-xxx"
export TDAI_LLM_BASE_URL="https://api.deepseek.com/v1"
export TDAI_LLM_MODEL="deepseek-chat"
npx tsx src/gateway/server.ts
```

### Example 2: Docker All-in-One (Hermes + Gateway)

```bash
docker run -d \
  -e MODEL_API_KEY="sk-xxx" \
  -e MODEL_BASE_URL="https://api.deepseek.com/v1" \
  -e MODEL_NAME="deepseek-chat" \
  -p 8420:8420 \
  -v hermes-data:/home/agentuser \
  agentmemory/hermes-memory:latest
```

### Example 3: Multi-Agent + Shared Gateway

```bash
# 1. Start Gateway (service mode)
cd MemoryCore
TDAI_DEPLOY_MODE=service \
TDAI_GATEWAY_PORT=3100 \
TDAI_GATEWAY_HOST=0.0.0.0 \
STATE_BACKEND=local \
VDB_ENDPOINT="http://vdb.example.com:8100" \
VDB_API_KEY="your-key" \
VDB_DATABASE="memory-shared" \
npx tsx src/gateway/server.ts

# 2. Configure different service_ids for each Hermes Agent
# Agent A:
export TDAI_MEMORY_ENDPOINT="http://gateway-host:3100"
export TDAI_MEMORY_API_KEY="shared-key"
export TDAI_MEMORY_SERVICE_ID="agent-code-assistant"

# Agent B:
export TDAI_MEMORY_ENDPOINT="http://gateway-host:3100"
export TDAI_MEMORY_API_KEY="shared-key"
export TDAI_MEMORY_SERVICE_ID="agent-customer-support"
```

### Example 4: K8s Production Deployment

Refer to `MemoryCore/deploy/k8s/tdai-memory.yaml` (Gateway + Redis Cluster) and `MemoryCore/deploy/k8s/multi-hermes.yaml` (Multi-Hermes Agent Orchestration).

---

## End-to-End Verification (E2E)

The repository provides two out-of-the-box E2E scripts, covering both deployment topologies. They both test the full pipeline using the real Hermes API Server + Real LLM + Real Gateway processes.

### Standalone E2E: `__tests__/e2e/test_hermes_standalone_e2e.py`

Verifies the open-source single-node deployment pipeline:

```
Hermes API Server → memory_tencentdb (v1 plugin) → Self-managed Gateway child process → SQLite + Local FS
```

Coverage:
- Hermes API Server starts, `/health` passes
- First chat triggers v1 plugin `initialize()`, automatically starts Node child process via `pnpm exec tsx src/gateway/server.ts`
- Gateway `/health` reports `vectorStore: true`
- 3 rounds of dialogue: inject marker → model recalls and echoes → prefetch recall across sessions via v1 plugin
- Side-channel: Connect directly to Gateway `/search/conversations` to find the marker for this run
- Tool layer: `/search/conversations` / `/search/memories` respond normally

```bash
hermes-agent/.venv/bin/python MemoryCore/__tests__/e2e/test_hermes_standalone_e2e.py
```

Actual results: **16 / 16 passed**.

### Service E2E: `MemoryCore/__tests__/e2e/test_hermes_service_e2e.py`

Verifies the cloud service multi-replica deployment pipeline:

```
mock-shark (Shark stub: provides VDB/COS configs)
2 Gateway processes (service mode, sharing TCVDB)
Hermes → memory_tencentdb_v2 (v2 plugin, tdai_memory SDK) → Gateway-1 → TCVDB
Side-channel verification on Gateway-2 → proves true TCVDB sharing
```

Coverage:
- mock-shark + GW1 + GW2 + Hermes all ready
- Both Gateways are in service mode (`stateBackend=connected` + `timerScanner` running)
- Hermes `/v1/models` returns 200, v2 plugin loaded successfully
- 3 rounds of dialogue written to GW1 via v2 plugin → Real TCVDB
- **Cross-Gateway Consistency**: GW2 search can find the marker written by GW1
- GW2 `/conversation/query` pulls all messages of the main session
- Cross-session prefetch: Model recalls marker in a new session via v2 plugin
- L1 add on GW1 → Immediately visible to GW2 `/atomic/query` (proves TCVDB shared read/write)
- Auto backup/restore of `memory.provider` field in `~/.hermes/config.yaml`

```bash
# Prerequisite: Install SDK into Hermes venv (One-time)
hermes-agent/.venv/bin/python -m pip install -e sdk/memory-core/python/

# Run
hermes-agent/.venv/bin/python __tests__/e2e/test_hermes_service_e2e.py
```

Actual results: **23 / 23 passed** (Cross-Gateway consistency, cross-session recall, L1 cross-GW sharing all passed).

### Common Prerequisites for Both Scripts

1. `hermes` CLI is installed (default path `~/.hermes/bin/hermes`)
2. `model.api_key` / `model.base_url` / `model.default` in `~/.hermes/config.yaml` configured with an available LLM
3. v1 / v2 plugins are linked to `hermes-agent/plugins/memory/` (installed by default)
4. Service mode additionally requires: `pnpm add cos-nodejs-sdk-v5` (Gateway dependency) + `pip install -e sdk/memory-core/python/` (SDK for Hermes)
