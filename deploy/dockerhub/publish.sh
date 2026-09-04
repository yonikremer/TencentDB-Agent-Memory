#!/usr/bin/env bash
# Build and publish the triple suite images to the agentmemory namespace on Docker Hub.
#
# This script is **self-contained**: it only depends on the Dockerfiles in the repository,
# deploy/panel-knowledge-combined/build.sh and MemoryPanel/scripts/secret-leak-check.sh,
# without referencing any internal build tools, allowing it to be used as-is in open source branches.
#
# Components and Image Names:
#   memory-core   MemoryCore/                        → agentmemory/memory-core
#   memory-proxy  MemoryProxy/                       → agentmemory/memory-proxy
#   memory-hub    MemoryPanel/ + MemoryKnowledge/    → agentmemory/memory-hub
#
# Usage (VERSION is required to avoid publishing floating tags by mistake):
#   VERSION=1.0.0 ./publish.sh all
#   VERSION=1.0.0 ./publish.sh memory-core
#   DRY_RUN=1 VERSION=1.0.0 ./publish.sh all      # Only check leaks + prepare context
#   PUSH=0 VERSION=1.0.0 ./publish.sh memory-core # Local single-arch --load, no push
#
# Common Environment Variables:
#   NAMESPACE=agentmemory          Target namespace
#   PLATFORMS=linux/amd64,linux/arm64
#   ALSO_LATEST=1                  Also push :latest
#   APT_MIRROR=mirrors.tencent.com Build-time apt acceleration (defaults to official Debian source)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKSPACE_ROOT="$(dirname "$REPO_ROOT")"

REGISTRY="${REGISTRY:-docker.io}"
NAMESPACE="${NAMESPACE:-agentmemory}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-multiarch}"
PUSH="${PUSH:-1}"
ALSO_LATEST="${ALSO_LATEST:-0}"
DRY_RUN="${DRY_RUN:-0}"
KEEP_CTX="${KEEP_CTX:-0}"
APT_MIRROR="${APT_MIRROR:-deb.debian.org}"
LOAD_PLATFORM="${LOAD_PLATFORM:-linux/amd64}"
SECRET_LEAK_CHECK="${SECRET_LEAK_CHECK:-$REPO_ROOT/MemoryPanel/scripts/secret-leak-check.sh}"

if [[ -t 1 ]]; then
  C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_RED=$'\033[31m'; C_BLU=$'\033[34m'; C_RST=$'\033[0m'
else
  C_GRN=""; C_YLW=""; C_RED=""; C_BLU=""; C_RST=""
fi
info() { echo "${C_BLU}[$(date +%H:%M:%S)]${C_RST} $*"; }
ok()   { echo "${C_GRN}[ok]${C_RST} $*"; }
warn() { echo "${C_YLW}[warn]${C_RST} $*" >&2; }
die()  { echo "${C_RED}[error]${C_RST} $*" >&2; exit 1; }

usage() { sed -n '2,26p' "$0"; exit 1; }

# ── Parameter Validation ────────────────────────────────────────────────────────
TARGET="${1:-}"
case "$TARGET" in
  memory-core|memory-proxy|memory-hub|all) ;;
  -h|--help|"") usage ;;
  *) die "Unknown component: $TARGET (Options: memory-core | memory-proxy | memory-hub | all)" ;;
esac

[[ -n "${VERSION:-}" ]] || die "Please explicitly specify VERSION, e.g.: VERSION=1.0.0 ./publish.sh $TARGET"
[[ "$VERSION" == dev-* ]] && die "VERSION cannot start with dev- (to avoid pushing dev tags to the public)"

command -v docker >/dev/null || die "docker is required"
command -v rsync  >/dev/null || die "rsync is required"
[[ -f "$SECRET_LEAK_CHECK" ]] || die "secret-leak-check script does not exist: $SECRET_LEAK_CHECK"

# ── Common Steps ────────────────────────────────────────────────────────
check_leaks() {
  local dir="$1"; shift
  info "secret-leak-check: $dir"
  ( cd "$dir" && bash "$SECRET_LEAK_CHECK" "$@" )
}

ensure_builder() {
  if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    info "Create buildx builder: $BUILDER"
    docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
  fi
  docker buildx inspect "$BUILDER" --bootstrap >/dev/null
}

# build_image <image> <context_dir>
# PUSH=1 → multi-arch buildx --push; PUSH=0 → single-arch --load for local spot check.
build_image() {
  local image="$1" ctx="$2"

  if [[ "$PUSH" != "1" ]]; then
    info "PUSH=0 → Local build ${image}:${VERSION} ($LOAD_PLATFORM)"
    docker buildx build \
      --builder "$BUILDER" \
      --platform "$LOAD_PLATFORM" \
      --build-arg "APT_MIRROR=$APT_MIRROR" \
      -t "${image}:${VERSION}" \
      --load \
      "$ctx"
    spot_check "${image}:${VERSION}"
    ok "Local image ready: ${image}:${VERSION} (Not pushed)"
    return 0
  fi

  local tags=(-t "${image}:${VERSION}")
  [[ "$ALSO_LATEST" == "1" ]] && tags+=(-t "${image}:latest")

  info "buildx --push ${image}:${VERSION} ($PLATFORMS)"
  docker buildx build \
    --builder "$BUILDER" \
    --platform "$PLATFORMS" \
    --build-arg "APT_MIRROR=$APT_MIRROR" \
    "${tags[@]}" \
    --push \
    "$ctx"
  ok "Pushed ${image}:${VERSION}"
  # Use if instead of `[[ ]] && ok`: the latter acting as the last statement of a function
  # when evaluated to false would cause the function to return 1,
  # silently interrupting the entire 'all' flow under set -e.
  if [[ "$ALSO_LATEST" == "1" ]]; then
    ok "Pushed ${image}:latest"
  fi
}

# Spot check image filesystem for sensitive files
spot_check() {
  local image="$1" cid
  cid=$(docker create "$image")
  # shellcheck disable=SC2064
  trap "docker rm -f '$cid' >/dev/null 2>&1 || true" RETURN
  if docker export "$cid" | tar -t 2>/dev/null \
      | grep -E '(/\.env$|metadata-instances\.json|/\.admin-key$)'; then
    die "Suspected sensitive files found in image, aborting"
  fi
  ok "Image spot check passed: $image"
}

# ── memory-core ─────────────────────────────────────────────────────
# MemoryCore/.dockerignore already excludes tests, docs, private submodules, and truth yaml,
# so the source directory can be used directly as the build context without extra cleanup.
build_memory_core() {
  local image="${REGISTRY}/${NAMESPACE}/memory-core"
  [[ "$REGISTRY" == "docker.io" ]] && image="${NAMESPACE}/memory-core"
  local src="$REPO_ROOT/MemoryCore"

  info "═══ memory-core → ${image}:${VERSION} ═══"
  [[ -f "$src/Dockerfile" ]] || die "Missing $src/Dockerfile"
  check_leaks "$src" src package.json openclaw.plugin.json

  if [[ "$DRY_RUN" == "1" ]]; then
    ok "DRY_RUN=1 → Skip build/push"
    return 0
  fi
  build_image "$image" "$src"
}

# ── memory-proxy ────────────────────────────────────────────────────
# packages/cost-guard is a private submodule and is not included in the open-source image.
# However, package.json declares it as a file: dependency, and Dockerfile COPYs it,
# so we place a stub package in the isolated context to let npm resolve the dependency graph;
# the runtime dynamic import failure will fallback to passthrough.
build_memory_proxy() {
  local image="${REGISTRY}/${NAMESPACE}/memory-proxy"
  [[ "$REGISTRY" == "docker.io" ]] && image="${NAMESPACE}/memory-proxy"
  local src="$REPO_ROOT/MemoryProxy"
  local ctx="${CTX_DIR:-$WORKSPACE_ROOT/dockerhub-memory-proxy-ctx}"

  info "═══ memory-proxy → ${image}:${VERSION} ═══"
  [[ -f "$src/Dockerfile" ]] || die "Missing $src/Dockerfile"
  check_leaks "$src" src package.json

  [[ "$KEEP_CTX" == "1" ]] || rm -rf "$ctx"
  mkdir -p "$ctx"
  info "rsync $src → $ctx"
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude 'coverage' \
    --exclude 'packages/cost-guard/*' \
    --exclude 'packages/cost-guard/.*' \
    --exclude '.env' \
    --exclude '.env.*' \
    --exclude '**/.env' \
    --exclude '**/.env.*' \
    --exclude 'config.yaml' \
    --exclude 'config.*.local.yaml' \
    "$src"/ "$ctx"/

  make_cost_guard_stub "$ctx/packages/cost-guard"

  # The source lockfile records the real submodule structure, conflicting with the stub;
  # Replace it with an empty shell to force npm re-resolution.
  cat > "$ctx/package-lock.json" <<'JSON'
{
  "name": "context-proxy",
  "version": "0.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {}
}
JSON

  check_leaks "$ctx" src package.json packages

  if [[ "$DRY_RUN" == "1" ]]; then
    ok "DRY_RUN=1 → context ready in $ctx, skip build/push"
    return 0
  fi
  build_image "$image" "$ctx"
  info "context kept at $ctx"
}

make_cost_guard_stub() {
  local dir="$1"
  if [[ -d "$dir" ]] && [[ -n "$(ls -A "$dir" 2>/dev/null)" ]]; then
    die "$dir is not empty —— private submodules cannot be built into public images, please check rsync exclude rules"
  fi
  info "Generate cost-guard stub → $dir"
  mkdir -p "$dir/src"
  cat > "$dir/package.json" <<'JSON'
{
  "name": "@context-proxy/cost-guard",
  "version": "0.0.0-stub",
  "description": "Placeholder for the optional cost-guard extension. The proxy falls back to passthrough routing when the real module is absent.",
  "type": "module",
  "main": "src/index.js",
  "exports": { ".": "./src/index.js" },
  "private": true
}
JSON
  cat > "$dir/src/index.js" <<'JS'
// Placeholder for the optional @context-proxy/cost-guard extension.
// src/guard-adapter.ts imports this package dynamically and degrades to
// passthrough routing when the real implementation is unavailable.
export const CostGuard = undefined;
export const setAnalyzerDebug = undefined;
export const resolveAgentProfile = undefined;
JS
}

# ── memory-hub ──────────────────────────────────────────────────────
# Reuse panel-knowledge-combined/build.sh context preparation logic (PREPARE_ONLY=1),
# Handle buildx push to Docker Hub here.
build_memory_hub() {
  local image="${REGISTRY}/${NAMESPACE}/memory-hub"
  [[ "$REGISTRY" == "docker.io" ]] && image="${NAMESPACE}/memory-hub"
  local combined="$REPO_ROOT/deploy/panel-knowledge-combined"
  local ctx="${CTX_DIR:-$WORKSPACE_ROOT/dockerhub-memory-hub-ctx}"

  info "═══ memory-hub → ${image}:${VERSION} ═══"
  [[ -f "$combined/build.sh" ]] || die "Missing $combined/build.sh"
  check_leaks "$REPO_ROOT/MemoryPanel" src web/src config package.json
  check_leaks "$REPO_ROOT/MemoryKnowledge" src .env.example package.json

  info "Preparing context via panel-knowledge-combined/build.sh"
  KEEP_CTX="$KEEP_CTX" PREPARE_ONLY=1 CTX_DIR="$ctx" \
    IMAGE_TAG="scan-$VERSION" bash "$combined/build.sh"

  [[ -f "$ctx/panel/package.json" && -f "$ctx/knowledge/package.json" ]] \
    || die "Context preparation failed: $ctx"
  [[ -f "$ctx/knowledge/openapi.yaml" ]] \
    || die "Context missing knowledge/openapi.yaml —— Required by Swagger UI at runtime"

  check_leaks "$ctx" panel knowledge Dockerfile start-combined.sh

  if [[ "$DRY_RUN" == "1" ]]; then
    ok "DRY_RUN=1 → context ready in $ctx, skip build/push"
    return 0
  fi
  build_image "$image" "$ctx"
  info "context kept at $ctx"
}

# ── Main Flow ──────────────────────────────────────────────────────────
if [[ "$DRY_RUN" != "1" ]]; then
  ensure_builder
  if [[ "$PUSH" == "1" ]]; then
    docker login "$REGISTRY" >/dev/null 2>&1 \
      || warn "No $REGISTRY login state detected, push phase might fail (run docker login first)"
  fi
fi

case "$TARGET" in
  memory-core)  build_memory_core ;;
  memory-proxy) build_memory_proxy ;;
  memory-hub)   build_memory_hub ;;
  all)
    build_memory_core
    build_memory_proxy
    build_memory_hub
    ;;
esac

echo ""
ok "Done: $TARGET (version=$VERSION)"
if [[ "$PUSH" == "1" && "$DRY_RUN" != "1" ]]; then
  echo "  Verification:"
  echo "    docker pull ${NAMESPACE}/memory-core:${VERSION}"
  echo "    docker buildx imagetools inspect ${NAMESPACE}/memory-core:${VERSION}"
fi
