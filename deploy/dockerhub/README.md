# Docker Hub Image Publishing

Build and push the triple suite images to the Docker Hub [`agentmemory`](https://hub.docker.com/u/agentmemory) namespace.

`publish.sh` is self-contained: it only depends on the respective components' Dockerfiles, `deploy/panel-knowledge-combined/build.sh`, and `MemoryPanel/scripts/secret-leak-check.sh`.

## Components and Image Names

| Component | Build Context | Image |
|---|---|---|
| `memory-core` | `MemoryCore/` | `agentmemory/memory-core` |
| `memory-proxy` | `MemoryProxy/` (rsync to a temporary context) | `agentmemory/memory-proxy` |
| `memory-hub` | `MemoryPanel/` + `MemoryKnowledge/` combined | `agentmemory/memory-hub` |

## Prerequisites

```bash
docker login docker.io          # Account must have agentmemory push permissions
docker buildx version           # buildx is required (the script will automatically create a builder)
```

## Usage

```bash
cd deploy/dockerhub

# Publish the triple suite at once
VERSION=1.0.0 ./publish.sh all

# Single component
VERSION=1.0.0 ./publish.sh memory-core
VERSION=1.0.0 ./publish.sh memory-proxy
VERSION=1.0.0 ./publish.sh memory-hub

# Dry run: only perform secret-leak-check and context preparation, no build or push
DRY_RUN=1 VERSION=1.0.0 ./publish.sh all

# Local single-architecture build and spot check image content, no push
PUSH=0 VERSION=1.0.0 ./publish.sh memory-core

# Simultaneously update :latest
ALSO_LATEST=1 VERSION=1.0.0 ./publish.sh all
```

`VERSION` is required, and does not accept values starting with `dev-` to avoid pushing development tags to the public internet.

## Environment Variables

| Variable | Default Value | Description |
|---|---|---|
| `VERSION` | None (Required) | Image tag |
| `NAMESPACE` | `agentmemory` | Docker Hub namespace |
| `REGISTRY` | `docker.io` | Target registry |
| `PLATFORMS` | `linux/amd64,linux/arm64` | Multi-architecture build targets |
| `ALSO_LATEST` | `0` | Whether to also push `:latest` |
| `PUSH` | `1` | Set to `0` to locally `--load` single architecture, no push |
| `DRY_RUN` | `0` | Set to `1` to only run scanning and context preparation |
| `LOAD_PLATFORM` | `linux/amd64` | Architecture for local build when `PUSH=0` |
| `KEEP_CTX` | `0` | Set to `1` to reuse the previous temporary context |
| `APT_MIRROR` | `deb.debian.org` | Build-time apt source, can be set to an accelerated mirror in intranet |

## Build-time apt Acceleration

All four Dockerfiles control the apt source via the `APT_MIRROR` build-arg, which defaults to the official Debian source, working out of the box in public network environments. If you want to accelerate the build in an intranet, just pass one variable globally; the image artifacts themselves are not affected:

```bash
APT_MIRROR=<your-debian-mirror> VERSION=1.0.0 ./publish.sh all
```

## About Optional Private Modules

- `MemoryProxy/packages/cost-guard` is an optional extension and is not included in the public image. `publish.sh` will generate a stub package in the temporary context so the dependency graph can resolve; at runtime, the dynamic import in `src/guard-adapter.ts` will fail and automatically degrade to passthrough routing.
- The same applies to `MemoryCore/src/integrations`, which has been excluded in `MemoryCore/.dockerignore`, falling back to default behavior at runtime.

## Verification

```bash
docker pull agentmemory/memory-core:1.0.0
docker buildx imagetools inspect agentmemory/memory-core:1.0.0
```
