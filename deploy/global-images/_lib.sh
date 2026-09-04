#!/usr/bin/env bash
# Common utility functions: load .env, validate required parameters, wait for container health, and clean up old containers.
# Sourced by start-*.sh via `source _lib.sh`; not intended to be executed directly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

# 颜色
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_BLU=$'\033[34m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_RST=""
fi

info() { echo "${C_BLU}[$(date +%H:%M:%S)]${C_RST} $*"; }
ok()   { echo "${C_GRN}[ok]${C_RST} $*"; }
warn() { echo "${C_YLW}[warn]${C_RST} $*" >&2; }
die()  { echo "${C_RED}[error]${C_RST} $*" >&2; exit 1; }

# Load .env (guide user if missing)
load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    die ".env does not exist. First cp .env.example .env and fill in LLM parameters."
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

# Validate required variables; exit and list missing vars if any are empty or REPLACE_ME
require_vars() {
  local missing=()
  for var in "$@"; do
    local val="${!var:-}"
    if [[ -z "$val" || "$val" == "REPLACE_ME" ]]; then
      missing+=("$var")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    echo "${C_RED}[error]${C_RST} The following required parameters in .env are not set or still set to REPLACE_ME:" >&2
    for v in "${missing[@]}"; do echo "  - $v" >&2; done
    echo "" >&2
    echo "  Edit $ENV_FILE and try again." >&2
    exit 1
  fi
}

# Find available docker command
find_docker() {
  if command -v docker >/dev/null 2>&1; then
    echo "docker"
    return
  fi
  local candidate
  for prefix in /opt/homebrew/Cellar/docker /usr/local/Cellar/docker; do
    if [[ -d "$prefix" ]]; then
      candidate=$(ls -1 "$prefix" 2>/dev/null | sort -V | tail -n1)
      if [[ -n "$candidate" && -x "$prefix/$candidate/bin/docker" ]]; then
        echo "$prefix/$candidate/bin/docker"
        return
      fi
    fi
  done
  for path in /opt/homebrew/bin/docker /usr/local/bin/docker; do
    if [[ -x "$path" ]]; then
      echo "$path"
      return
    fi
  done
  die "docker command not found. Please install Docker Desktop / OrbStack / colima + docker CLI first."
}

DOCKER="$(find_docker)"

# Pull latest image when PULL=1
pull_image() {
  local image="$1"
  [[ "${PULL:-0}" == "1" ]] || return 0
  info "Pulling image $image"
  $DOCKER pull "$image" || die "Failed to pull $image."
}

# Idempotently remove existing container with the same name
rm_container_if_exists() {
  local name="$1"
  if $DOCKER ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; then
    info "Removing existing container $name"
    $DOCKER rm -f "$name" >/dev/null
  fi
}

# Wait for container to enter healthy state (or running if no healthcheck)
wait_healthy() {
  local name="$1"
  local timeout="${2:-90}"    # seconds
  local interval=2
  local elapsed=0

  info "Waiting for $name to be ready (timeout ${timeout}s)..."
  while (( elapsed < timeout )); do
    local status
    status=$($DOCKER inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo "not_found")
    case "$status" in
      healthy)
        ok "$name is healthy"
        return 0
        ;;
      exited|dead|not_found)
        warn "$name status is ${status}, showing recent logs:"
        $DOCKER logs --tail 30 "$name" 2>&1 | sed 's/^/  │ /' >&2 || true
        die "$name is not running."
        ;;
      unhealthy)
        warn "$name is unhealthy, logs:"
        $DOCKER logs --tail 30 "$name" 2>&1 | sed 's/^/  │ /' >&2 || true
        die "$name healthcheck failed."
        ;;
      running)
        # Image has no healthcheck: treat running as ready
        ok "$name is running (no healthcheck)"
        return 0
        ;;
    esac
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  warn "$name wait timed out, last logs:"
  $DOCKER logs --tail 40 "$name" 2>&1 | sed 's/^/  │ /' >&2 || true
  die "$name failed to become ready within ${timeout}s."
}

# Print unified service endpoint table
print_endpoints() {
  echo ""
  echo "  ┌─────────────────────────────────────────────────────────┐"
  echo "  │ Service Endpoints                                       │"
  echo "  ├─────────────────────────────────────────────────────────┤"
  echo "  │  Memory Panel:      http://127.0.0.1:${PANEL_PORT}"
  echo "  │  Knowledge Service: http://127.0.0.1:${KNOWLEDGE_PORT}"
  echo "  │  Memory Core:       http://127.0.0.1:${MEMORY_CORE_PORT}"
  echo "  │  Memory Proxy:      http://127.0.0.1:${PROXY_PORT}"
  echo "  └─────────────────────────────────────────────────────────┘"
  echo ""
}

# Check LLM connectivity
check_llm_openai() {
  local label="$1" base="$2" key="$3" model="$4"
  local url="${base%/}/models"
  local body_file
  body_file=$(mktemp)

  local code
  code=$(curl -s -w "%{http_code}" -o "$body_file" \
    -H "Authorization: Bearer $key" \
    --connect-timeout 10 -m 20 "$url" 2>/dev/null || echo "000")

  if [[ "$code" == "200" ]]; then
    if grep -q "\"id\":[[:space:]]*\"${model}\"" "$body_file" 2>/dev/null; then
      ok "$label OpenAI protocol check OK (model $model found in /models)"
    else
      ok "$label OpenAI protocol check OK (model $model not explicitly listed in /models, but endpoint reachable)"
    fi
    rm -f "$body_file"
    return 0
  elif [[ "$code" == "401" || "$code" == "403" ]]; then
    warn "$label API key invalid (HTTP ${code}): $url"
    rm -f "$body_file"
    return 1
  elif [[ "$code" == "404" ]]; then
    warn "$label GET /models 404 — vendor may not support this endpoint, trying anthropic protocol check"
    rm -f "$body_file"
    return 2
  else
    warn "$label Cannot access ${url} (HTTP=${code}): $(head -c 100 "$body_file" 2>/dev/null)"
    rm -f "$body_file"
    return 1
  fi
}

check_llm_anthropic() {
  local label="$1" base="$2" key="$3" model="$4"
  local url="${base%/}/v1/messages"
  local body_file
  body_file=$(mktemp)

  local code
  code=$(curl -s -w "%{http_code}" -o "$body_file" \
    -X POST "$url" \
    -H "x-api-key: $key" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "{\"model\":\"${model}\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
    --connect-timeout 10 -m 20 2>/dev/null || echo "000")

  case "$code" in
    200) ok "$label Anthropic protocol check OK (model $model responded)"; rm -f "$body_file"; return 0 ;;
    401|403)
      warn "$label API key invalid (HTTP ${code}): $url"
      rm -f "$body_file"; return 1
      ;;
    404)
      warn "$label URL does not exist (HTTP 404): $url — check BASE_URL"
      rm -f "$body_file"; return 1
      ;;
    400)
      if grep -q "model" "$body_file" 2>/dev/null; then
        warn "$label Model name '$model' invalid (HTTP 400)"
      else
        warn "$label HTTP 400: $(head -c 150 "$body_file")"
      fi
      rm -f "$body_file"; return 1
      ;;
    *)
      warn "$label Cannot access ${url} (HTTP=${code}): $(head -c 100 "$body_file" 2>/dev/null)"
      rm -f "$body_file"; return 1
      ;;
  esac
}

check_llm_group() {
  local label="$1" base="$2" key="$3" model="$4" proto="${5:-openai}"
  info "Checking $label connectivity (protocol=${proto})..."
  if [[ "$proto" == "anthropic" ]]; then
    check_llm_anthropic "$label" "$base" "$key" "$model"
  else
    if check_llm_openai "$label" "$base" "$key" "$model"; then
      return 0
    else
      check_llm_anthropic "$label" "$base" "$key" "$model"
    fi
  fi
}

# Interactive prompt helpers
prompt_with_default() {
  local label="$1" default="$2" input
  if [[ -n "$default" ]]; then
    printf '%s [%s]: ' "$label" "$default" >&2
  else
    printf '%s: ' "$label" >&2
  fi
  read -r input
  echo "${input:-$default}"
}

prompt_select_proto() {
  local default="${1:-openai}" input
  printf 'memory group LLM protocol (openai/anthropic) [%s]: ' "$default" >&2
  read -r input
  case "${input:-$default}" in
    openai|anthropic) echo "${input:-$default}" ;;
    *) warn "Unknown protocol '$input', falling back to openai"; printf 'openai' ;;
  esac
}

prompt_confirm() {
  local msg="$1" default="${2:-1}" prompt_str input
  if (( default == 1 )); then prompt_str="[Y/n]"; else prompt_str="[y/N]"; fi
  printf '%s %s: ' "$msg" "$prompt_str" >&2
  read -r input
  case "${input,,}" in
    y|yes) return 0 ;;
    n|no)  return 1 ;;
    "")    (( default == 1 )) && return 0 || return 1 ;;
    *)     (( default == 1 )) && return 0 || return 1 ;;
  esac
}

update_env_var() {
  local file="$1" key="$2" val="$3"
  val_escaped=$(printf '%s\n' "$val" | sed -e 's/[\/&]/\\&/g')
  if grep -q "^[[:space:]]*${key}=" "$file" 2>/dev/null; then
    awk -v k="$key" -v v="$val" '
      BEGIN { FS="="; OFS="=" }
      $1 == k { $2 = v; found=1 }
      { print }
      END { if (!found) print k "=" v }
    ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

interactive_llm_setup() {
  info "═══ Interactive LLM Setup (press Enter to keep current values) ═══════════════"

  # memory group
  while true; do
    base=$(prompt_with_default "memory group LLM BASE_URL" "${MEMORY_LLM_BASE_URL:-}")
    key=$(prompt_with_default "memory group LLM API_KEY" "${MEMORY_LLM_API_KEY:-}")
    model=$(prompt_with_default "memory group LLM MODEL" "${MEMORY_LLM_MODEL:-}")
    proto=$(prompt_select_proto "${MEMORY_LLM_PROTOCOL:-openai}")

    if check_llm_group "memory group" "$base" "$key" "$model" "$proto"; then
      MEMORY_LLM_BASE_URL="$base"
      MEMORY_LLM_API_KEY="$key"
      MEMORY_LLM_MODEL="$model"
      MEMORY_LLM_PROTOCOL="$proto"
      break
    fi
    warn "memory group LLM check failed."
    prompt_confirm "Retry entering parameters?" 1 || die "User canceled, exiting."
  done

  # proxy group
  local reuse_same=1
  if [[ -n "${PROXY_UPSTREAM_URL:-}" && "${PROXY_UPSTREAM_URL:-}" != "REPLACE_ME" ]]; then
    if [[ "${PROXY_UPSTREAM_URL:-}" != "$MEMORY_LLM_BASE_URL" || \
          "${PROXY_UPSTREAM_API_KEY:-}" != "$MEMORY_LLM_API_KEY" || \
          "${PROXY_UPSTREAM_MODEL:-}" != "$MEMORY_LLM_MODEL" ]]; then
      reuse_same=0
    fi
  fi

  if prompt_confirm "Reuse memory group LLM settings for proxy group?" "$reuse_same"; then
    PROXY_UPSTREAM_URL="$MEMORY_LLM_BASE_URL"
    PROXY_UPSTREAM_API_KEY="$MEMORY_LLM_API_KEY"
    PROXY_UPSTREAM_MODEL="$MEMORY_LLM_MODEL"
    ok "proxy group reusing memory group settings, skipping check"
  else
    while true; do
      base=$(prompt_with_default "proxy group UPSTREAM_URL" "${PROXY_UPSTREAM_URL:-}")
      key=$(prompt_with_default "proxy group UPSTREAM_API_KEY" "${PROXY_UPSTREAM_API_KEY:-}")
      model=$(prompt_with_default "proxy group UPSTREAM_MODEL" "${PROXY_UPSTREAM_MODEL:-}")

      if check_llm_group "proxy group" "$base" "$key" "$model" openai; then
        PROXY_UPSTREAM_URL="$base"
        PROXY_UPSTREAM_API_KEY="$key"
        PROXY_UPSTREAM_MODEL="$model"
        break
      fi
      warn "proxy group LLM check failed."
      prompt_confirm "Retry entering parameters?" 1 || die "User canceled, exiting."
    done
  fi

  info "Writing LLM configuration to → $ENV_FILE"
  set_env_value MEMORY_LLM_BASE_URL "$MEMORY_LLM_BASE_URL" "$ENV_FILE"
  set_env_value MEMORY_LLM_API_KEY "$MEMORY_LLM_API_KEY" "$ENV_FILE"
  set_env_value MEMORY_LLM_MODEL "$MEMORY_LLM_MODEL" "$ENV_FILE"
  set_env_value MEMORY_LLM_PROTOCOL "$MEMORY_LLM_PROTOCOL" "$ENV_FILE"
  set_env_value PROXY_UPSTREAM_URL "$PROXY_UPSTREAM_URL" "$ENV_FILE"
  set_env_value PROXY_UPSTREAM_API_KEY "$PROXY_UPSTREAM_API_KEY" "$ENV_FILE"
  set_env_value PROXY_UPSTREAM_MODEL "$PROXY_UPSTREAM_MODEL" "$ENV_FILE"
  ok "LLM configuration saved to $ENV_FILE"
}

# ═══════════════════════════════════════════════════════════════
# Port Pre-check
# ═══════════════════════════════════════════════════════════════

# port_in_use <port>
#   Detects if a specific port on the host is in the LISTEN state. Returns 0=in-use / 1=idle.
port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${port}$"
  else
    return 1  # Treat as idle if detection tools are missing, avoiding blocking startup
  fi
}

# tdai_self_ports
#   Outputs ports (space-separated) mapped to the host by the currently running tdai container trio.
#   These ports are occupied by 'our own' services and will be rebuilt by rm_container_if_exists during startup, not considered a conflict.
tdai_self_ports() {
  local c p ports=""
  for c in tdai-proxy tdai-memory-hub tdai-memory-core; do
    if $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
      p="$($DOCKER port "$c" 2>/dev/null | grep -oE '[0-9]+$' | sort -u | tr '\n' ' ' || true)"
      ports="$ports $p"
    fi
  done
  printf '%s' "$ports"
}

# check_ports
#   Checks if the 4 target ports are in use; exits with error if occupied by an "external process".
#   Excludes ports occupied by our own tdai containers (which will be rebuilt on startup).
check_ports() {
  local self_ports port_var port conflict=0
  self_ports=" $(tdai_self_ports) "
  info "═══ Port Pre-check ══════════════════════════════════════════"
  for port_var in MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT; do
    port="${!port_var:-}"
    if [[ -z "$port" ]]; then continue; fi
    if [[ "$self_ports" == *" $port "* ]]; then
      info "Port $port ($port_var) is occupied by old tdai container (will be rebuilt on startup), skipping"
      continue
    fi
    if port_in_use "$port"; then
      echo "${C_RED}[error]${C_RST} Port $port ($port_var) is already in use. Please free this port or change it in .env." >&2
      conflict=1
    else
      ok "Port $port ($port_var) is free"
    fi
  done
  (( conflict == 0 )) || die "Port conflict detected, please free the ports and try again."
}
