# TDAI Global Images Local Deployment

Local launch scripts for the global triple suite images — `memory-core` + `memory-hub` + `proxy`, can run independently, or all at once with a single command.

## Components and Ports

| Component | Container Name | Image (Docker Hub Public) | Host Port | Purpose |
|---|---|---|---|---|
| **memory-core** | `tdai-memory-core` | [`agentmemory/memory-core`](https://hub.docker.com/r/agentmemory/memory-core) | `8420` | Core gateway, memory read/write, auth, skill/RAG data plane |
| **memory-hub**  | `tdai-memory-hub`  | [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub)   | `8125` / `8424` | Management Panel (Panel) + Knowledge service (Knowledge) combined image |
| **proxy**       | `tdai-proxy`       | [`agentmemory/memory-proxy`](https://hub.docker.com/r/agentmemory/memory-proxy) | `8096` | LLM request forwarding proxy, API entry for coding agents |

> All three images are published under the Docker Hub [`agentmemory`](https://hub.docker.com/u/agentmemory) namespace,
> multi-arch (`linux/amd64` + `linux/arm64`), publicly pullable, no login required. If you want to fix the version, change the tag in `.env` from
> `:latest` to a specific version, such as `:1.0.0-beta.1`.
>
> Tencent internal colleagues can also override to the intranet private registry `mirrors.tencent.com/memory-team-control/` — see the commented alternative block in `.env.example`.

## Environment Requirements

- macOS / Linux
- Docker (Docker Desktop / colima / OrbStack)
- `bash` 4+ (macOS built-in 3.2 also works)

## Quick Start

```bash
cd TencentDB-Agent-Memory/deploy/global-images

# One command: auto copy .env → interactive LLM input → auto check path → launch triple suite
./start-all.sh
```

`start-all.sh` is now **interactive**, when running it will:

1. If `.env` doesn't exist, automatically copy from `.env.example` (no manual `cp` needed)
2. Guide you to fill in two sets of LLMs (**Enter = keep current default**):
   - `memory group`: `BASE_URL` / `API_KEY` / `MODEL` (protocol defaults to `openai`)
   - `proxy group`: First asks "reuse memory group config?", if yes then skip
3. After filling, **immediately check if LLM path is reachable**, if not, prompt to re-enter until passed
4. **Write back the filled values to `.env`** for persistence (next launch will reuse them by default)
5. After passing, launch the triple suite in one click

> If you want to skip interactivity and read directly from `.env`: manually `cp .env.example .env` and fill in the LLMs,
> then run `./start-all.sh` and hit Enter all the way (defaults are the values in `.env`).

### Dry Run Validation (Optional)

`verify.sh` can still be used separately, it only checks the environment without starting containers:

```bash
./verify.sh              # Default full check (includes LLM path pre-check)
./verify.sh --skip-llm   # Skip LLM check (for offline environments)
```

## LLM Path Pre-check

`verify.sh` by default will pre-check the two LLM paths (turn off with `--skip-llm`):

- **OpenAI compatible protocol**: `GET {base}/models`, only validates API key + URL, **consumes 0 tokens**
- **Anthropic protocol**: `POST {base}/v1/messages` sends a minimal message with `max_tokens=1`, consumes ≤ 10 tokens
- **memory group** and **proxy group** are checked independently; if both configs are identical, automatically skips duplicate check
- **If containers are already running**, additionally `exec` a `curl` from inside the container to verify "container → LLM" network reachability (in some corporate proxy/DNS isolation environments, the host is reachable but the container is not)

Failure example:

```
[error] memory group API key invalid (HTTP 401): https://api.deepseek.com/v1/models
{"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid",...}}
```

— Wrong API key, wrong URL, wrong model name will be intercepted before startup, rather than waiting for wiki ingest / chat to return a 401.

After successful startup:

- Panel UI: <http://localhost:8125/>
- Knowledge API: <http://localhost:8424/v3/>
- Knowledge Swagger: <http://localhost:8424/docs>
- Memory Gateway: <http://localhost:8420/>
- Proxy: <http://localhost:8096/>

## Two Sets of Independent Parameters

**This is the core of the script design** — the LLMs for the memory group and proxy group are completely independent, and can point to different providers / different models.

### memory group (used by memory-core + memory-hub)

Core memory embed/summarize, knowledge wiki ingest / summarization use this configuration.

| Variable | Description | Example |
|---|---|---|
| `MEMORY_LLM_BASE_URL` | OpenAI compatible base URL | `https://api.deepseek.com/v1` |
| `MEMORY_LLM_API_KEY` | API Key for the above endpoint | `sk-xxxxxxxx` |
| `MEMORY_LLM_MODEL` | Model ID | `deepseek-chat` |
| `MEMORY_LLM_PROTOCOL` | `openai` or `anthropic`, defaults to `openai` | `openai` |

### proxy group (used by proxy)

When the proxy receives user requests, they are forwarded to these endpoints.

| Variable | Description | Example |
|---|---|---|
| `PROXY_UPSTREAM_URL` | Target base URL for forwarding | `https://api.deepseek.com/v1` |
| `PROXY_UPSTREAM_API_KEY` | API Key for forwarding | `sk-xxxxxxxx` |
| `PROXY_UPSTREAM_MODEL` | Model ID exposed to users | `deepseek-chat` |

> Both sets can be filled with the same values (both pointing to the same LLM), or can be completely different: e.g., memory group uses a cheap model for embedding, proxy group uses a strong model for the main conversation.

If parameters are missing, the script will **list all missing items at once before startup** and `exit 1`, preventing partial failures.

## Internal Credentials (MUST READ for Production Environments)

The triple suite uses `MEMORY_CORE_GATEWAY_API_KEY` to authenticate with each other. On the first startup, it will also use `init-admin` to create a `system_admin` account. For **zero-config local experience**, the script defaults are:

| Variable | Default Value | Purpose |
|---|---|---|
| `MEMORY_CORE_GATEWAY_API_KEY` | `local` | memory-hub / proxy → memory-core Bearer |
| `MEMORY_CORE_ADMIN_USERNAME` | `admin` | Initialized system_admin username |
| `MEMORY_CORE_ADMIN_USER_KEY` | `admin` | Login key for this admin user |

> These three default values are only suitable for testing flows locally. **They must be replaced with random long strings before production/integration/public internet exposure**, otherwise anyone who can reach the ports will get system_admin privileges.
>
> Just uncomment the corresponding three lines in `.env` and override them (`_lib.sh` will `require_vars` to validate other required fields, but since these three variables have default fallbacks, the script will print a `[warn]` at startup to remind you to change them).

## Using Each Component Independently

The three scripts can be executed separately, which is convenient for debugging or when only partial capabilities are needed:

```bash
./start-memory-core.sh       # Only run core gateway (8420)
./start-memory-hub.sh   # Only run panel + knowledge (8125 + 8424); requires MEMORY_LLM_* parameters
./start-proxy.sh        # Only run proxy (8096); requires PROXY_UPSTREAM_* parameters
```

Dependencies:

- **memory-core**: No external dependencies, can be started independently
- **memory-hub**: Can be started independently (LLM_MODE=custom direct to LLM), but internal knowledge will fail when calling memory-core for RAG → recommended to start memory-core first
- **proxy**: Can be started independently (automatically degrades to passthrough when cost-guard is unavailable), but auth / tdai memory / skill injection require memory-core to be effective

If any component is missing, the script will `warn` you but will not block.

## Data Persistence

- `tdai-memory-core-data` (named volume) → memory-core's SQLite / memory data
- `tdai-panel-data` (named volume) → memory-hub's knowledge SQLite / git clone / wiki files

Data is preserved until `docker volume rm` is executed. The name can be changed via `MEMORY_CORE_VOLUME` / `PANEL_VOLUME` in `.env`.

## Stop / Cleanup

```bash
./stop-all.sh            # Stop containers, keep volumes (data remains for next startup)
./stop-all.sh --purge    # Stop containers + delete volumes + delete networks (complete cleanup)
```

## View Logs

```bash
docker logs -f tdai-memory-core
docker logs -f tdai-memory-hub
docker logs -f tdai-proxy
```

memory-hub has two processes inside (panel + knowledge), the logs are at `/data/knowledge/logs/panel.log` and `.../knowledge.log` inside the container respectively.

## Port Conflicts

If `8125` / `8420` / `8424` / `8096` conflict with existing services on your machine, just change them in `.env`:

```bash
MEMORY_CORE_PORT=18420
PANEL_PORT=18125
KNOWLEDGE_PORT=18424
PROXY_PORT=18096
# knowledge externally accessible address should follow KNOWLEDGE_PORT
KNOWLEDGE_PUBLIC_BASE_URL=http://host.docker.internal:18424/v3
```

## Using proxy as the API base for a coding agent

Take Claude Code as an example:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8096
export ANTHROPIC_API_KEY=any-string-if-auth-disabled
# Similar for clients using the openai protocol: OPENAI_BASE_URL=http://localhost:8096/v1
```

The Panel UI "Client Access Address" card will automatically append the host's LAN IP + `PROXY_PORT` (e.g. `http://192.168.1.100:8096/codebuddy/default`), so others can copy it and connect directly from their computers.
It is injected by `MEMORY_HUB_PROXY_PUBLIC_URL` (when unset, the script uses `hostname -I` / macOS `ipconfig getifaddr en0` to auto-detect, falling back to `localhost` if it fails) into memory-hub's `metadata-instances.json.proxy_endpoint`.
The Panel backend → Kernel forwarding is not affected by this variable (it always goes to `REMOTE_INSTANCE_URL` → memory-core:8420).
If the auto-detected address is incorrect (multiple network cards / public domain / behind a reverse proxy), explicitly set it in `.env`: `MEMORY_HUB_PROXY_PUBLIC_URL=http://<real_value>:8096`. If you want the UI card to use the old behavior (fallback to gateway_endpoint), explicitly set `MEMORY_HUB_PROXY_PUBLIC_URL` to an empty string.

`proxy` turns off `auth` / `sessionInit` / `costGuard` by default (these depend on internal services), and only does pure forwarding + `tdai-memory` context injection (injector name, not container name). To enable the full pipeline, additional configuration is required — see `context_proxy/config.example.yaml`.

## Common Questions

**Q: `./start-all.sh` is stuck at wait_healthy?**
The image might still be pulling. Manually pre-pull once using `docker pull <IMAGE>` and then run the script again.

**Q: memory-hub is up but Panel won't open?**

Check if `KNOWLEDGE_PUBLIC_BASE_URL` in `.env` contains `/v3` — without `/v3` the panel will throw an error.

**Q: proxy forwarding returns 401?**
`PROXY_UPSTREAM_API_KEY` is invalid or `PROXY_UPSTREAM_URL` doesn't match. Use `docker logs tdai-proxy` to see the error.

**Q: How to access other services on the host from inside the container (Ollama, Langfuse, etc.)?**
The script defaults to using `--add-host=host.docker.internal:host-gateway`. You can simply use `http://host.docker.internal:<port>` inside the container.
