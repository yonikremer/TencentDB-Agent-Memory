# Docker Deployment Instructions

This directory contains the containerized build files for **team-memory-control** (Control panel backend).

## Table of Contents

```
docker/
├── README.md                          # This file
└── local/
    ├── Dockerfile.local               # Control single image (multi-stage build)
    └── Dockerfile.local.dockerignore  # Build context ignore rules
```

## Overview of Images

| Image Name (Example) | Dockerfile | Build Context | Description |
|----------------|------------|------------|------|
| `team-memory-control:local` | `docker/local/Dockerfile.local` | **Repository root** `.` | Control HTTP service, default `:8123` |

---

## `docker/local/Dockerfile.local`

Usage

Build the **Control panel** monolithic image: run `src/index.ts` directly with `tsx` on the backend (stateless panel, entry `src/panel/`), and compile the `web/` frontend in a separate stage and serve it as static assets.

Multi-stage structure

| Stage | Function |
|-------|------|
| `base` | `node:22-slim` + native build toolchain (`better-sqlite3` requires `python3`/`make`/`g++`) |
| `ui-builder` | Build `web/`: `npm install` + `npm run build` → `dist/` |
| `runtime` | Copy full repo source, `npm install`, embed UI artifacts, start Control |

Build Parameters

| Parameter | Default Value | Description |
|------|--------|------|
| `PANEL_UI` | `web` | Frontend project directory (the currently active panel is `web/`; `frontend/` is a historical directory and is no longer maintained) |
| `WEB_UI` | `1` | `1` builds the panel UI normally; `0` skips UI building and generates a placeholder `index.html` (see "Disable Panel UI Building" below) |

Specify the instance table via `METADATA_INSTANCES_CONFIG` at runtime, and `UI_DIST_DIR=./web/dist` hosts the frontend.

Expose Ports and Health Checks

- Port: `8123`
- Health check: `GET http://127.0.0.1:8123/health`

---

## Build and Run

### Prerequisites

- Docker (BuildKit is recommended to be enabled)
- Node engine requirement matches the repository: `>=22` (see root `package.json`)
- Execute the build in the **repository root directory** (context is the entire repository)

```bash
# In the repository root directory
docker build \
  --build-arg PANEL_UI=web \
  -t team-memory-control:local \
  -f docker/local/Dockerfile.local .

docker run -d --name tmc-control \
  -p 8123:8123 \
  -e UI_DIST_DIR=./web/dist \
  -e METADATA_INSTANCES_CONFIG=/app/config/metadata-instances.json \
  -e KNOWLEDGE_SERVICE_URL=http://host.docker.internal:8421 \
  -e KNOWLEDGE_AUTH_TOKEN=<ks-token> \
  -e KNOWLEDGE_LLM_PROXY_BASE_URL=http://host.docker.internal:8096 \
  -v "$(pwd)/config/metadata-instances.json:/app/config/metadata-instances.json:ro" \
  team-memory-control:local
```

Login: Open `http://localhost:8123/` in the browser, select the instance ID, and enter the Gateway's **user_key**. The fields of the instance table are in [`config/metadata-instances.README.md`](../config/metadata-instances.README.md).

If the Gateway runs on the host, the `gateway_endpoint` in the mounted `metadata-instances.json` must use an address accessible to the container (e.g., `http://host.docker.internal:8420`), and not `127.0.0.1`.

Disable panel UI construction (`WEB_UI=0`)

The panel UI depends on internal packages such as `@tencent/*`, which are not provided by the public npm mirror. If the build environment **cannot access the internal npm source** (such as offline machines, external CI), `npm install` will fail. In this case, skip the UI build by using `WEB_UI=0`:

```bash
docker build \
  --build-arg PANEL_UI=web \
  --build-arg WEB_UI=0 \
  -t team-memory-control:local-no-ui \
  -f docker/local/Dockerfile.local .
```

The mirror will generate a placeholder `dist/index.html`, **the Control backend and `/health`, `/api/*` are fully available**, but only the static panel pages are inaccessible (frontend routes return placeholder prompts). When you need the panel UI, please use the default `WEB_UI=1` and ensure you can fetch the internal dependencies.

Common Environment Variables

| Variable | Default | Description |
|------|------|------|
| `UI_DIST_DIR` | `./web/dist` | Static frontend directory (Dockerfile sets it to `./${PANEL_UI}/dist` via `ENV`) |
| `METADATA_INSTANCES_CONFIG` | `./config/metadata-instances.json` | Instance registry path |
| `METADATA_REMOTE_TIMEOUT_MS` | `15000` | Forward Gateway timeout |
| `KNOWLEDGE_SERVICE_URL` | `http://127.0.0.1:8421` | Knowledge Service (KS) address; must point to a KS accessible within the container |
| `KNOWLEDGE_AUTH_TOKEN` | — | Bearer token for calling KS, filled in according to deployment |
| `KNOWLEDGE_TIMEOUT_MS` | `15000` | Timeout for calling KS |
| `KNOWLEDGE_LLM_BINDING_SYNC` | `true` | Ensure the KS LLM binding for each instance at startup (via proxy accounting); `false` to skip |
| `KNOWLEDGE_LLM_PROXY_BASE_URL` | `http://127.0.0.1:8096` | LLM accounting proxy address (must be reachable inside the container) |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | Locally set `LOG_FORMAT=pretty` |

> Note: `LLM_MODEL` (wiki ingest model) is not configured in Panel; it is uniformly determined by the `LLM_MODEL` on the KS side (default `Memory-Model`).

---

## `docker/local/Dockerfile.local.dockerignore`

BuildKit will prioritize `<dockerfile>.dockerignore` (rather than the root `.dockerignore`).

Mainly excluding:

- `**/node_modules`, `**/dist` — avoid host-platform-compiled `better-sqlite3` or old artifacts entering the image
- `.env`, `data/`, `*.db` — prohibit including keys and local data in the image
- `docs/`, test reports, etc. — reduce the build context

**Security Notice**: `config/metadata-instances.json` **will** be included in the image with `COPY . .`. If it contains real `api_key`, the production image should be changed to mount it at runtime, or exclude the file in `dockerignore` and enforce `-v` mounting.

---

## Local Development Comparison

| Method | Command |
|------|------|
| Source Code Development | `pnpm dev` |
| Docker Single Image | See above `docker build` / `docker run` |

---

## Troubleshooting

| Phenomenon | Possible causes |
|------|----------|
| `GET /` 404 | `UI_DIST_DIR` is not set to `./web/dist`, or the frontend stage `npm run build` fails |
| Login API 401 / No team after login | `gateway_endpoint` in `metadata-instances.json` is unreachable, or `api_key` does not match the Gateway |
| Knowledge asset loading fails / 500 | `KNOWLEDGE_SERVICE_URL` is unreachable inside the container, or `KNOWLEDGE_AUTH_TOKEN` does not match |
| Stuck at "ensure LLM binding" | `KNOWLEDGE_LLM_PROXY_BASE_URL` is unreachable inside the container; you can set `KNOWLEDGE_LLM_BINDING_SYNC=false` to temporarily skip |
