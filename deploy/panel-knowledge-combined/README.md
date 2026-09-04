# Memory Hub

**Memory Hub** is a merged mirror: it runs two services simultaneously within a single container—Team Memory Control (Panel) and Knowledge Service (KS).

- **Panel**: Console for managing team / Agent / Knowledge resources
- **KS**: Wiki / Code Graph knowledge service, available for Agent to call via tools

Mirror release on Docker Hub: [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub) (recommended to pull `latest`).

---

## Prerequisites

### 1. Instance Configuration File

After purchasing a Memory instance on the cloud, you will receive the **instance ID**, **Gateway address**, and **API Key**. Write a JSON file (e.g., `metadata-instances.json`):

```json
{
  "instances": [
    {
      "id": "mem-xxxxxxxx",
      "name": "My Memory Instance",
      "gateway_endpoint": "https://memory.ap-shanghai.tencenttdai.com",
      "api_key": "your-gateway-api-key"
    }
  ]
}
```

`gateway_endpoint` should be filled with the Gateway address provided by the console (the example above is only for the Shanghai region, please fill in the actual address). For multiple instances, add multiple objects to the `instances` array.

### 2. KS External Reachable Addresses

KS needs to expose an address externally so that Agent (and the cloud Gateway) can access KS's tools interface. This address **must be externally accessible** (cannot use `127.0.0.1` / `localhost`), and **must contain** `/v3`.

For example, if the host's public/private network IP is `10.2.3.4` and the port mapping is `8424`, then:

`http://10.2.3.4:8424/v3`

### 3. LLM Proxy Address

The Wiki ingest / summary capabilities of KS will call a large model, and by default, use the LLM forwarding capability provided by Memory.

`KNOWLEDGE_LLM_PROXY_BASE_URL` is the same address as the `gateway_endpoint` above: the Gateway address obtained from the Memory console. For example, in the Shanghai region:

`https://memory.ap-shanghai.tencenttdai.com`

(Other regions are filled in according to the actual address on the console.)

If you wish to use your own LLM endpoint, see [Custom mode](#custom-mode-direct-connection-to-llm-no-proxy) below.

---

Quick Start

```bash
docker run -d --name memory-hub \
  -p 8125:8125 -p 8424:8424 \
  -v memory-hub:/data/knowledge \
  -v /path/to/metadata-instances.json:/app/panel/config/metadata-instances.json:ro \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://10.2.3.4:8424/v3 \
  -e KNOWLEDGE_LLM_PROXY_BASE_URL=https://memory.ap-shanghai.tencenttdai.com \
  agentmemory/memory-hub:latest
```

> Replace `/path/to/metadata-instances.json`, `10.2.3.4` (KS external address), and `KNOWLEDGE_LLM_PROXY_BASE_URL` (same as `gateway_endpoint`, fill in the actual Gateway address on the console) with your actual values.

Required items (only these 3 items)

| Configuration | Method | Description |
| --- | --- | --- |
| Instance Configuration | Mount `metadata-instances.json` | ID, Gateway address, and API Key of the cloud Memory instance |
| KS External Address | `KNOWLEDGE_PUBLIC_BASE_URL` | Address accessible externally to KS, **must include** `/v3` |
| LLM Proxy Address | `KNOWLEDGE_LLM_PROXY_BASE_URL` | Same as `gateway_endpoint`, fill in the Gateway address from the Memory console |

The above 3 items must be provided by the user, and the rest of the configuration has built-in default values in the mirror, which can be adjusted as needed.

---

Optional configuration

The following configurations all have built-in default values in the mirror, so they can work without being passed. Just override them as needed.

### LLM Configuration

| Environment Variable | Default Value | Description |
| --- | --- | --- |
| `LLM_PROTOCOL` | `openai` | LLM protocol: `openai` uses `/chat/completions`, `anthropic` uses `/messages` |
| `LLM_MODEL` | `Memory-Model` | Model ID, passed through to proxy/TokenHub |
| `LLM_MODE` | `proxy` | `proxy`: routes through Memory Gateway LLM forwarding; `custom`: direct connection to BYO endpoint |
| `LLM_MAX_TOKENS` | `32768` | Maximum output tokens per LLM call |
| `LLM_TIMEOUT_MS` | `1200000` | LLM call timeout in ms (20 minutes, reasoning models require longer timeouts) |
| `LLM_API_KEY` | empty | Required only when `LLM_MODE=custom` |
| `LLM_BASE_URL` | empty | required only when `LLM_MODE=custom`, e.g. `https://api.openai.com/v1` |

**Agreement and Model Matching Rules**:

| Protocol | Applicable Model | Endpoint |
| --- | --- | --- |
| `openai` (default) | `Memory-Model`, `deepseek-v4-pro` | `/chat/completions` |
| `anthropic` | `ep-pksklwtb`, `claude-sonnet-4-5` etc. | `/messages` |

The protocol must be matched when switching models:

```bash
# Default (OpenAI Protocol + Memory-Model)
# No additional configuration is needed, the image is default

# Switch to Anthropic model
-e LLM_PROTOCOL=anthropic -e LLM_MODEL=ep-pksklwtb
```

Network and Storage

| Environment Variable | Default Value | Description |
| --- | --- | --- |
| `PANEL_PORT` | `8125` | Panel service port |
| `KNOWLEDGE_PORT` | `8424` | KS service port |
| `KNOWLEDGE_DATA_DIR` | `/data/knowledge` | KS data directory (SQLite, git clone, wiki files, logs) |
| `KNOWLEDGE_DB_PATH` | `/data/knowledge/knowledge.db` | KS SQLite database path |
| `TMC_CALLBACK_URL` | `http://127.0.0.1:8125` | Root URL for the Panel to be called by KS ingest completion (auto-loopback inside the container, generally no need to modify) |
| `KNOWLEDGE_TIMEOUT_MS` | `15000` | Request timeout for Panel calling KS |
| `METADATA_REMOTE_TIMEOUT_MS` | `15000` | Panel's timeout for requests to the remote Gateway |
| `REMOTE_INSTANCE_PROXY_URL` | empty | The base URL displayed in the Panel UI "Client Access Address" card. When running core+proxy separately for an open-source local deployment, fill in the external address of the proxy (e.g., `http://host.docker.internal:8096`); then the Panel UI's copied CodeBuddy/ClaudeCode access address will point to the proxy. Leave it empty to retain the old behavior — the UI falls back to `gateway_endpoint`. **Forwarding from the Panel backend to the Kernel always uses `REMOTE_INSTANCE_URL`, which is unrelated to this variable.** (Ignore this variable when `metadata-instances.json` is mounted, and add a `proxy_endpoint` field directly in the JSON)

### TLS certificate

Public network formal certificates generally do not require additional configuration. When LLM Proxy or Gateway uses HTTPS and the certificate is not trusted by the container (such as self-signed certificates, internal CA), there are two ways to resolve it:

**Method A: Skip TLS verification (for quick testing only, not recommended for production)**

```bash
-e NODE_TLS_REJECT_UNAUTHORIZED=0
```

**Method B: Mount CA certificate (recommended)**

```bash
-v /path/to/your-ca.pem:/usr/local/share/ca-certificates/extra-ca.crt:ro \
-e NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/extra-ca.crt
```

| Environment Variable | Default Value | Description |
| --- | --- | --- |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Not set | Set to `0` to skip TLS certificate verification (for testing only) |
| `NODE_EXTRA_CA_CERTS` | Not set | Additional CA certificate path, natively supported by Node.js, and also read by AI SDK's fetch |

### Log

| Environment Variable | Default Value | Description |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | Log level (`debug` / `info` / `warn` / `error`) |
| `LOG_FORMAT` | `json` | Log format (`json` / `text`) |
| `LOG_DIR` | `/data/knowledge/logs` | Log file directory |

Log to `${LOG_DIR}/panel.log` and `${LOG_DIR}/knowledge.log`, rotate a `.prev` each startup, and also output to stdout (visible via `docker logs`).

Observability (Langfuse)

After configuring all three, KS's LLM calls will automatically report traces to Langfuse.

| Environment Variable | Default Value | Description |
| --- | --- | --- |
| `LANGFUSE_BASE_URL` | empty | Langfuse service URL |
| `LANGFUSE_PUBLIC_KEY` | empty | Langfuse public key |
| `LANGFUSE_SECRET_KEY` | empty | Langfuse secret key |

### LLM Binding Synchronization

| Environment Variable | Default Value | Description |
| --- | --- | --- |
| `KNOWLEDGE_LLM_BINDING_SYNC` | `1` | Whether the instance synchronizes KS llm_binding at Panel startup. It is forced to `1` when `LLM_MODE=proxy`; set it to `0` in `custom` mode to let KS use global configuration |

---

Access address

| Service | Address |
| --- | --- |
| Panel UI | `http://localhost:8125/` |
| Panel API | `http://localhost:8125/api/v1/` |
| KS Health | `http://localhost:8424/health` |
| KS API | `http://localhost:8424/v3/` |
| KS Swagger Document | `http://localhost:8424/docs` |

---

## Custom mode (direct connection to LLM, no Proxy)

If you do not use the Memory Gateway's LLM forwarding, you can directly specify your own LLM endpoint. In this case, `KNOWLEDGE_LLM_PROXY_BASE_URL` is not needed.

```bash
docker run -d --name memory-hub \
  -p 8125:8125 -p 8424:8424 \
  -v memory-hub:/data/knowledge \
  -v /path/to/metadata-instances.json:/app/panel/config/metadata-instances.json:ro \
  -e KNOWLEDGE_PUBLIC_BASE_URL=http://10.2.3.4:8424/v3 \
  -e LLM_MODE=custom \
  -e LLM_API_KEY=sk-your-llm-key \
  -e LLM_BASE_URL=https://api.openai.com/v1 \
  -e LLM_MODEL=gpt-4o \
  -e KNOWLEDGE_LLM_BINDING_SYNC=0 \
  agentmemory/memory-hub:latest
```

---

## Data Persistence

| Mount Point | Description |
| --- | --- |
| `/data/knowledge` | KS data (SQLite, git clone, wiki files, logs) |

Recommended to use a named volume: `-v memory-hub:/data/knowledge` (consistent with the container name).

---

Common Questions

Access host services from within a container?

The Cloud Gateway (`KNOWLEDGE_LLM_PROXY_BASE_URL`) is generally directly accessible and does not need to be changed to the host machine's address. If other services (such as Langfuse) are running on the host machine, use `172.17.0.1` (docker0 bridge) instead of `localhost`:

```bash
-e LANGFUSE_BASE_URL=http://172.17.0.1:8400
```

Or add `--add-host=host.docker.internal:host-gateway` using `host.docker.internal`.

### A: wiki ingest reports timeout?

The reasoning model may need to take more than 20 minutes to process large files:

```bash
-e LLM_TIMEOUT_MS=1800000  # 30 minutes
```

Why does tools/list return 404?

`KNOWLEDGE_PUBLIC_BASE_URL` must include the `/v3` prefix. Correct format: `http://host:port/v3`.

Error after switching the LLM protocol?

Ensure that `LLM_PROTOCOL` and `LLM_MODEL` are matched:

```bash
# OpenAI model (default)
-e LLM_PROTOCOL=openai -e LLM_MODEL=Memory-Model

# Anthropic models
-e LLM_PROTOCOL=anthropic -e LLM_MODEL=ep-pksklwtb
```

---

Build

### Prerequisites

All source code is located in the root directory of this repository:

```text
memory-tencentdb/
├── MemoryPanel/                         # Panel backend + web frontend
├── MemoryKnowledge/                     # Knowledge Service
└── deploy/panel-knowledge-combined/     # Recipe
```

Local single-architecture build (for debugging)

```bash
cd deploy/panel-knowledge-combined
IMAGE_TAG=1.0.0-beta.1 ./build.sh          # Default linux/amd64 → team-memory-panel-knowledge:1.0.0-beta.1
PLATFORM=linux/arm64 IMAGE_TAG=arm64 ./build.sh   # If the machine is arm64, you can build directly
```

Publish to Docker Hub (amd64 + arm64)

Tag convention:

| Tag | Meaning |
| --- | --- |
| `1.0.0-beta.N` | Pin version (use this for documentation/reproduction) |
| `beta` | Floating channel: always points to the current latest beta (default pushed with release) |
| `latest` | Use for the official stable version (default not pushed) |

Recommended launch: `agentmemory/memory-hub:1.0.0-beta.1` + `agentmemory/memory-hub:beta`.

```bash
cd deploy/panel-knowledge-combined

# 1) Logged into Docker Hub (requires agentmemory org push permission)
docker login

# 2) Only scan sensitive information + prepare context (do not build)
DRY_RUN=1 VERSION=1.0.0-beta.1 ./publish.sh

# 3) Optional: First locally load amd64, spot-check that there is no .env / metadata-instances.json in the image layers
PUSH=0 VERSION=1.0.0-beta.1 ./publish.sh

# 4) Formally build dual architecture and push (default to :beta simultaneously)
VERSION=1.0.0-beta.1 ./publish.sh

Keep version tag, don't move :beta:
# ALSO_BETA=0 VERSION=1.0.0-beta.1 ./publish.sh

# Officially re-run latest (do not enable in beta stage):
# ALSO_LATEST=1 ALSO_BETA=0 VERSION=1.0.0 ./publish.sh
```

`publish.sh` will:

1. Run `scripts/secret-leak-check.sh` on `MemoryPanel` / `MemoryKnowledge`
2. `PREPARE_ONLY=1 ./build.sh` to generate the rsync context (`.env*`, `metadata-instances.json`, etc. are already excluded)
3. Check the context once more
4. `docker buildx build --platform linux/amd64,linux/arm64 --push` to `agentmemory/memory-hub:<VERSION>` (default adds `:beta`; the local name `team-memory-panel-knowledge` is only used for `PUSH=0` and will not be pushed)

Post-push self-check:

```bash
docker buildx imagetools inspect agentmemory/memory-hub:1.0.0-beta.1
docker buildx imagetools inspect agentmemory/memory-hub:beta
# Both should see Platform: linux/amd64 and linux/arm64, and digest matches
docker pull agentmemory/memory-hub:beta
```

Environment variable quick reference:

| Variable | Default | Description |
| --- | --- | --- |
| `VERSION` | `1.0.0-beta.1` | version tag |
| `HUB_IMAGE` | `agentmemory/memory-hub` | repo name |
| `PLATFORMS` | `linux/amd64,linux/arm64` | buildx targets |
| `BUILDER` | `multiarch` | buildx builder name (auto-create if not exists) |
| `DRY_RUN` | `0` | `1` = only perform leak check |
| `PUSH` | `1` | `0` = local `--load` single architecture |
| `ALSO_BETA` | `1` | `1` = push extra `:beta` |
| `ALSO_LATEST` | `0` | `1` = push extra `:latest` |
