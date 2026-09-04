# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────
# TencentDB-Agent-Memory · MemoryProxy — Production Image
# ──────────────────────────────────────────────────────────────────────
# Multi-stage build (requires DOCKER_BUILDKIT=1):
#   1. deps-builder: install all deps (incl. native compile toolchain for
#                    better-sqlite3 / node-pty)
#   2. runtime:      slim image with runtime deps + app, tini as PID 1
#
# Configuration: mount config.yaml to /data/config.yaml
#   docker run -v ./config.yaml:/data/config.yaml:ro ...
# Sensitive credentials are injected via environment variables (env takes precedence over the config file).
#
# Build:
#   DOCKER_BUILDKIT=1 docker build -t memory-proxy:latest .
#
# Note: at runtime tsx runs TypeScript directly (no precompile step). tsx is a devDependency,
# so dev dependencies are kept in the image; optional dependencies (better-sqlite3 / cos-nodejs-sdk-v5 /
# cost-guard) are retained for the sqlite / cos storage backends and CostGuard smart routing.
# ──────────────────────────────────────────────────────────────────────

# ──────────────────────────────────────────────────────────────────────
# Stage 1: deps-builder — install deps (with toolchain for native bindings)
# ──────────────────────────────────────────────────────────────────────
FROM node:22-slim AS deps-builder

# Use the official Debian apt source (deb.debian.org). If the build is slow, you can switch to a mirror during local builds, e.g.:
#   sed -i 's|deb.debian.org|mirrors.tencent.com|g' /etc/apt/sources.list.d/debian.sources

# Native build toolchain (better-sqlite3 / node-pty require compilation)
# Use BuildKit cache mount to cache apt packages and avoid redundant downloads
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        ca-certificates

WORKDIR /app

# node:22-slim ships with npm@10.9.8 which has an arborist "edgesOut" crash (clean
# `npm install` consistently reports `Cannot read properties of null (reading
# 'edgesOut')`). Upgrade to 11 to mitigate, without affecting other build behaviors.
RUN npm install -g npm@11 --no-audit --no-fund

# Copy package metadata first to maximize Docker layer cache.
COPY package.json package-lock.json ./

# Install all dependencies (keep dev: tsx needs it at runtime; keep optional: sqlite/cos/cost-guard).
# Use the BuildKit npm cache mount to greatly speed up repeated builds.
RUN --mount=type=cache,id=proxy-npm-cache,target=/root/.npm \
    npm install \
        --no-audit \
        --no-fund

# Copy the remaining source (.dockerignore excludes node_modules/.git/docs/scripts/gateway etc.)
COPY . .

# ──────────────────────────────────────────────────────────────────────
# Stage 2: runtime — slim image
# ──────────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# Use the official Debian apt source (deb.debian.org). If the build is slow, you can switch to a mirror of your own.

# Runtime essentials only (curl for HEALTHCHECK; tini handles signal processing)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        curl \
        tini \
        ca-certificates

WORKDIR /app

# Run as a non-root user (security baseline)
RUN groupadd -r app && useradd -r -g app -u 10001 -m app

# Copy the whole /app from the builder (including the file: symlinks under node_modules pointing to packages/cost-guard)
COPY --from=deps-builder /app /app

# Data / log directories (can be mounted as a K8s PVC)
RUN mkdir -p /data/tdai-memory-proxy /data/config /app/logs && \
    chown -R app:app /app /data

USER app

# ── Runtime configuration ──
# Config file path: mount the yaml to /data/config.yaml
# Sensitive credentials are injected via environment variables (env takes precedence over the config file)
ENV NODE_ENV=production \
    PROXY_DB_PATH=/data/tdai-memory-proxy/proxy.db \
    NODE_OPTIONS="--max-old-space-size=1536"

EXPOSE 8096

# K8s-friendly health check (liveness/readiness should still be defined separately
# in the Deployment manifest — this is the local-runtime fallback).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD curl -fsS http://127.0.0.1:8096/health || exit 1

# Use tini as PID 1 so SIGTERM/SIGKILL propagate cleanly to Node and its child processes, and zombie processes are reaped.
# tsx is a runtime dependency and can run TypeScript directly.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "--import", "tsx/esm", "src/index.ts"]

# Default config file path (can be overridden by additional docker run arguments)
CMD ["--config", "/data/config.yaml"]
