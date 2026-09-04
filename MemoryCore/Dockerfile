# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────
# TencentDB-Agent-Memory — Production Image
# ──────────────────────────────────────────────────────────────────────
# Multi-stage build (requires DOCKER_BUILDKIT=1):
#   1. deps-builder: install all deps (incl. native compile toolchain)
#   2. runtime:      slim image with only runtime deps + app
#
# Configuration: mount config.yaml to /data/config/tdai-gateway.yaml
#   docker run -v ./config.yaml:/data/config/tdai-gateway.yaml ...
#
# Build:
#   docker build -t tencentdb-agent-memory:latest .
#
# Package manager: npm (Node.js bundled). The repo ships pnpm-lock.yaml for
# local development, but inside the image we generate an npm lockfile on the
# fly to keep the image free of pnpm/corepack and to align with team CI/CD
# conventions. A small package.json patch is applied to:
#   - drop optional peerDependencies (`openclaw`, `node-llama-cpp`) which
#     pull in transitive packages that ship broken `workspace:*` refs to
#     unpublished sub-packages (e.g. @jimp/config-typescript).
#   - add `overrides` to short-circuit any straggler workspace refs.
# These tweaks only affect the image, not the source tree.
# ──────────────────────────────────────────────────────────────────────

# Stage 1: build/install deps (with toolchain for native bindings)
FROM node:22-slim AS deps-builder

# APT sources default to official Debian mirrors for direct public building. Internal network acceleration:
#   docker build --build-arg APT_MIRROR=mirrors.tencent.com .
ARG APT_MIRROR=deb.debian.org
RUN if [ "$APT_MIRROR" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi

# Native build toolchain (sqlite-vec, @node-rs/jieba etc.)
# Use BuildKit cache mount to cache APT packages and avoid redundant downloads
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        ca-certificates

WORKDIR /build

# node:22-slim ships with npm@10.9.8 which has an arborist "edgesOut" crash (clean
# `npm install` consistently reports `Cannot read properties of null (reading
# 'edgesOut')`). Upgrade to 11 to mitigate, without affecting other build behaviors.
RUN npm install -g npm@11 --no-audit --no-fund

# Copy package metadata first to maximize Docker layer cache
COPY package.json ./

# Patch package.json for npm-friendly install:
#   1. Strip optional peerDependencies (openclaw, node-llama-cpp) — these
#      pull in @whiskeysockets/baileys → jimp@1.6.1, whose published manifest
#      contains a broken `workspace:*` ref to @jimp/config-typescript that
#      npm cannot resolve.
#   2. Add overrides as a defensive short-circuit in case any other
#      transitive dep reintroduces the same pattern.
RUN node -e " \
        const fs=require('fs'); \
        const p=JSON.parse(fs.readFileSync('package.json','utf8')); \
        delete p.peerDependencies; \
        delete p.peerDependenciesMeta; \
        p.overrides=Object.assign({},p.overrides,{ \
            '@jimp/config-typescript':'npm:dotenv@latest' \
        }); \
        fs.writeFileSync('package.json',JSON.stringify(p,null,2)); \
    "

# Generate lockfile + install production deps.
# --omit=optional trims image size to reduce CI push timeout risks (optional dependencies like mongodb,
# @clickhouse/client, kafkajs etc. are not needed in the gateway image).
# --ignore-scripts skips the openclaw postinstall patch (irrelevant in image).
# --legacy-peer-deps relaxes strict peer resolution for older transitive deps.
# Use BuildKit cache mount for npm download cache to significantly speed up repeated builds
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm install \
        --omit=dev \
        --omit=optional \
        --ignore-scripts \
        --legacy-peer-deps \
        --no-audit \
        --no-fund

# tsx requires esbuild binary (which is an optionalDependency of tsx); it is lost after --omit=optional.
# Install esbuild separately (--no-save without modifying package.json). esbuild (~10MB) is far smaller than
# total omitted optional dependencies (mongodb ~100MB+, etc.).
#
# Note: Do NOT pass --omit=optional here — esbuild's platform-specific binaries
# (@esbuild/linux-x64 / @esbuild/linux-arm64) are themselves optionalDependencies.
# Adding it will cause runtime errors: "The package @esbuild/linux-x64 could not be found".
# Allowing dev does not matter: esbuild itself has no devDeps.
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm install \
        --no-save \
        --ignore-scripts \
        --no-audit \
        --no-fund \
        esbuild

# Now copy the rest of the source
# Note: .dockerignore already excludes node_modules/.git/__tests__/docs etc.
COPY . .

# Retain original package.json (COPY . overwrites the patched version, so no git checkout needed)
# Note: .git is excluded by .dockerignore, so the original git checkout command actually always failed


# ──────────────────────────────────────────────────────────────────────
# Stage 2: runtime — slim image
# ──────────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

ARG APT_MIRROR=deb.debian.org
RUN if [ "$APT_MIRROR" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi

# Runtime essentials only (curl for HEALTHCHECK; tini for proper signal handling)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        curl \
        tini \
        ca-certificates

WORKDIR /app

# Copy app from builder stage
COPY --from=deps-builder /build /app

# Data directory (mountable as PVC in K8s)
RUN mkdir -p /data/tdai-memory /data/config

# ── Runtime configuration ──
# Configuration file path: mount yaml to /data/config/tdai-gateway.yaml
# Sensitive credentials injected via environment variables (env overrides configuration file)
ENV NODE_ENV=production \
    TDAI_GATEWAY_CONFIG=/data/config/tdai-gateway.yaml \
    TDAI_GATEWAY_HOST=0.0.0.0 \
    TDAI_DATA_DIR=/data/tdai-memory \
    NODE_OPTIONS="--max-old-space-size=1536"

EXPOSE 8420

# K8s-friendly health check (liveness/readiness probes still defined separately
# in the Deployment manifest — this is the local-runtime fallback).
# Default value is written here only and not put in ENV: once TDAI_GATEWAY_PORT becomes an image env var,
# it overrides server.port in mounted config (env takes precedence over yaml), while 8420 matches gateway's code default.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD curl -fsS http://127.0.0.1:${TDAI_GATEWAY_PORT:-8420}/health || exit 1

# Use tini as PID 1 so SIGTERM/SIGKILL propagate cleanly to Node and its
# pipeline workers, and zombie processes are reaped.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the Gateway. tsx is a runtime dependency so we can run TypeScript directly.
CMD ["node", "--import", "tsx", "src/gateway/server.ts"]
