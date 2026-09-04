# TencentDB-Agent-Memory

AI Agent long-term memory service, providing 4-tier progressive memory capabilities (L0 dialogue → L1 atomic memory → L2 scene induction → L3 user persona) for any Agent framework.

## Image Information

| Item | Value |
|------|---|
| Image Name | `tencentdb-agent-memory` |
| Base Image | `node:22-slim` |
| Size | ~920MB |
| Port | 8420 |
| Run User | tdai (uid 10001) |
| PID 1 | tini |

## Quick Start

The following commands default to executing within the `MemoryCore/` directory; if you are in the repository root, `cd MemoryCore` first.

### 1. Build Image

```bash
docker build -t tencentdb-agent-memory:latest .
```

### 2. Prepare Configuration Files

The project provides two configuration templates:

| Template | Applicable Scenario |
|------|---------|
| `tdai-gateway.standalone.yaml` | Local development, standalone deployment, zero external dependencies |
| `tdai-gateway.service.yaml` | K8s multi-replica, multi-tenant cloud service |

Copy and modify the templates:

```bash
# Standalone mode
cp tdai-gateway.standalone.yaml tdai-gateway.yaml

# Service mode
cp tdai-gateway.service.yaml tdai-gateway.yaml
```

### 3. Start Container

**Standalone mode (Simplest):**

```bash
docker run -d --name agent-memory \
  -v $(pwd)/tdai-gateway.yaml:/data/config/tdai-gateway.yaml:ro \
  -e TDAI_LLM_API_KEY=sk-your-key \
  -p 8420:8420 \
  tencentdb-agent-memory:latest
```

**Service mode (Requires Redis):**

```bash
# Start Redis (if no remote Redis is available)
docker run -d --name redis -p 6379:6379 redis:7-alpine

# Start mock-shark (provides VDB/COS credentials locally)
VDB_ENDPOINT=http://your-vdb:8100 \
VDB_API_KEY=xxx \
VDB_DATABASE=your-db \
COS_BUCKET=your-bucket \
COS_REGION=ap-guangzhou \
COS_SECRET_ID=xxx \
COS_SECRET_KEY=xxx \
npx tsx scripts/mock-shark-server.ts &

# Start Memory Service
docker run -d --name agent-memory \
  -v $(pwd)/tdai-gateway.real.yaml:/data/config/tdai-gateway.yaml:ro \
  -e TDAI_LLM_API_KEY=sk-your-key \
  -p 8420:8420 \
  tencentdb-agent-memory:latest
```

**Docker Compose one-click start (includes Redis):**

```bash
TDAI_LLM_API_KEY=sk-your-key docker compose -f docker-compose.local.yaml up --build
```

### 4. Verify Service

```bash
curl http://localhost:8420/health
```

Normal response:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "services": {
    "timerScanner": { "isLeader": true },
    "pipelineWorker": { "workerId": "worker-xxx" },
    "stateBackend": "connected"
  }
}
```

## Configuration Method

### Configuration File + Environment Variables (Recommended)

All configuration items support both **YAML configuration files** and **environment variables**, with environment variables taking higher priority.

The configuration file path inside the container is specified by the `TDAI_GATEWAY_CONFIG` environment variable, default is `/data/config/tdai-gateway.yaml`.

```
┌─────────────────────────────┐
│  Environment Variables (Highest)│  ← Secret credentials
├─────────────────────────────┤
│  tdai-gateway.yaml config    │  ← ConfigMap mount
├─────────────────────────────┤
│  Code defaults               │  ← Fallback
└─────────────────────────────┘
```

### Configuration File Structure

```yaml
deployMode: service          # standalone | service

server:
  port: 8420
  host: "0.0.0.0"

llm:                         # LLM API (OpenAI compatible)
  baseUrl: "https://api.lkeap.cloud.tencent.com/v1"
  apiKey: "${TDAI_LLM_API_KEY}"
  model: "deepseek-v3.2"

redis:                       # Redis (required for service mode)
  host: "redis:6379"
  keyPrefix: "tdai_memory"

shark:                       # Shark config center (provides VDB/COS credentials)
  baseUrl: "http://shark:8000"

scanner:                     # Timer Scanner
  intervalMs: 500

worker:                      # Pipeline Worker
  pollMs: 200

memory:                      # Memory engine parameters
  pipeline:
    everyNConversations: 5
    enableWarmup: true
  recall:
    maxResults: 5
    strategy: "hybrid"
```

For complete configuration, refer to `tdai-gateway.standalone.yaml` and `tdai-gateway.service.yaml`.

### Environment Variables and Configuration File Cross-Reference Table

| Environment Variable | YAML Path | Default Value | Description |
|---------|----------|--------|------|
| `TDAI_DEPLOY_MODE` | `deployMode` | `standalone` | Deployment mode |
| `TDAI_GATEWAY_CONFIG` | — | `/data/config/tdai-gateway.yaml` | Config file path |
| `TDAI_LLM_API_KEY` | `llm.apiKey` | — | LLM API Key |
| `TDAI_LLM_BASE_URL` | `llm.baseUrl` | `https://api.openai.com/v1` | LLM URL |
| `TDAI_LLM_MODEL` | `llm.model` | `gpt-4o` | Model name |
| `REDIS_HOST` | `redis.host` | `127.0.0.1` | Redis host |
| `REDIS_PORT` | `redis.port` | `6379` | Redis port |
| `REDIS_PASSWORD` | `redis.password` | — | Redis password |
| `REDIS_KEY_PREFIX` | `redis.keyPrefix` | `tdai_memory` | Key prefix |
| `SHARK_BASE_URL` | `shark.baseUrl` | — | Shark URL |
| `STATE_BACKEND` | `stateBackend` | Auto | `redis` / `local` |
| `SCANNER_INTERVAL_MS` | `scanner.intervalMs` | `500` | Scan interval |
| `WORKER_POLL_MS` | `worker.pollMs` | `200` | Worker poll |
| `COS_DOMAIN` | `cos.domain` | — | COS internal domain |

## K8s / TKE Deployment

Refer to `MemoryCore/deploy/k8s/tdai-memory.yaml`, core approach:

1. **ConfigMap** mounts `tdai-gateway.yaml` to `/app/config/`
2. **Secret** injects `TDAI_LLM_API_KEY` + `REDIS_PASSWORD` via environment variables
3. **Deployment** sets `TDAI_GATEWAY_CONFIG=/data/config/tdai-gateway.yaml`

```yaml
# Key configurations in Deployment
env:
  - name: TDAI_GATEWAY_CONFIG
    value: /data/config/tdai-gateway.yaml
  - name: TDAI_LLM_API_KEY
    valueFrom:
      secretKeyRef:
        name: tdai-memory-secrets
        key: TDAI_LLM_API_KEY
volumeMounts:
  - name: config-volume
    mountPath: /app/config
    readOnly: true
volumes:
  - name: config-volume
    configMap:
      name: tdai-memory-config
```

## API Overview

| Method | Path | Description |
|------|------|------|
| GET | `/health` | Health check |
| POST | `/recall` | Memory recall |
| POST | `/capture` | Write conversation |
| POST | `/search/memories` | L1 memory search |
| POST | `/search/conversations` | L0 conversation search |
| POST | `/session/end` | End session |
| POST | `/v2/*` | v2 multi-tenant API (requires Bearer Token) |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 TencentDB Agent Memory               │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Gateway  │  │ TimerScanner │  │ PipelineWorker│  │
│  │ HTTP API │  │ 500ms scan   │  │ Competing cons│  │
│  └────┬─────┘  └──────┬───────┘  └──────┬────────┘  │
│       │               │                 │            │
│  ┌────▼─────────────────────────────────▼────────┐  │
│  │          IStateBackend (Redis / Local)         │  │
│  └───────────────────────────────────────────────┘  │
│       │                                              │
│  ┌────▼───────────┐  ┌────────────┐  ┌───────────┐  │
│  │  TdaiCore      │  │ StorePool  │  │ COS       │  │
│  │  L0→L1→L2→L3   │  │ VDB Pool   │  │ ObjectStrg│  │
│  └────────────────┘  └────────────┘  └───────────┘  │
└─────────────────────────────────────────────────────┘
         │                    │               │
    ┌────▼────┐         ┌────▼────┐     ┌────▼────┐
    │  LLM    │         │  TCVDB  │     │  COS    │
    │ API     │         │ VecDB   │     │ ObjectDB│
    └─────────┘         └─────────┘     └─────────┘
```

## File Structure

```
.
├── MemoryCore/
│   ├── Dockerfile                       # Image build
│   ├── docker-compose.local.yaml        # Local one-click test (incl. Redis)
│   ├── tdai-gateway.standalone.yaml     # Standalone config template
│   ├── tdai-gateway.service.yaml        # Service config template
│   ├── tdai-gateway.real.yaml           # Local test config (connects to real service)
│   ├── deploy/k8s/tdai-memory.yaml      # K8s/TKE deployment manifest
│   ├── scripts/mock-shark-server.ts     # Mock Shark (local dev)
│   └── src/gateway/server.ts            # Service entry point
```

## License

Proprietary — Tencent Cloud
