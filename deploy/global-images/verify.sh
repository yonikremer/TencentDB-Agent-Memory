#!/usr/bin/env bash
# Dry run verification: do not start any containers, only check if the environment is ready.
#
# Usage:
#   ./verify.sh               # Default full check (including LLM path pre-check)
#   ./verify.sh --skip-llm    # Skip LLM check (use in offline environments or if you don't want to send external requests)
#
# Check items:
#   1. docker command is available
#   2. .env file exists
#   3. All required parameters in .env are filled (not REPLACE_ME and not empty)
#   4. Check if the three images are already local (not a failure if not local, just a warn)
#   5. Target ports are not occupied
#   6. LLM upstream paths (memory group + proxy group, pre-checked individually)
#      - openai protocol: GET {base}/models, consumes 0 tokens
#      - anthropic protocol: POST {base}/v1/messages max_tokens=1, consumes ≤ 10 tokens
#      - If containers are already running, additionally docker exec to ping from inside the container (verify container → LLM network reachability)
#
# All passed → exit 0; Errors found → exit 1; Only warns → exit 0

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

SKIP_LLM=0
for arg in "$@"; do
  case "$arg" in
    --skip-llm) SKIP_LLM=1 ;;
    --help|-h)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) warn "Unknown parameter: ${arg} (ignored)" ;;
  esac
done

ERRORS=0
WARNS=0
CURL=/usr/bin/curl

# ─── LLM Path Check Functions ───────────────────────────────────────────────
# check_llm_openai <label> <base_url> <api_key> <model>
#   OpenAI compatible: GET {base}/models only validates auth+URL, consumes no tokens.
#   base_url allows with or without /v1; normalized here.
check_llm_openai() {
  local label="$1" base="$2" key="$3" model="$4"
  # Normalize: remove trailing /, remove /messages or /chat/completions suffix
  base="${base%/}"
  base="${base%/messages}"
  base="${base%/chat/completions}"
  local url="${base}/models"
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
    -H "Authorization: Bearer $key" \
    "$url" 2>/dev/null || echo "000")
  if [[ "$code" == "200" ]]; then
    # Try parsing to see if model is in the list (loose matching, just warn if not)
    if grep -q "\"$model\"" "$body_file" 2>/dev/null; then
      ok "$label OpenAI protocol path OK ($model is in /models list)"
    else
      ok "$label OpenAI protocol path OK (model ${model} not explicitly listed in /models, might still be usable on business side)"
    fi
    rm -f "$body_file"
    return 0
  elif [[ "$code" == "401" || "$code" == "403" ]]; then
    echo "${C_RED}[error]${C_RST} $label API key invalid (HTTP ${code}): $url" >&2
    head -c 200 "$body_file" >&2; echo >&2
    rm -f "$body_file"
    return 1
  elif [[ "$code" == "404" ]]; then
    # Some providers don't have the /models endpoint, switch to anthropic style check or skip: warn, not error
    warn "$label GET /models 404 —— provider might not have this endpoint, falling back to anthropic protocol check"
    check_llm_anthropic "$label" "$base" "$key" "$model"
    rm -f "$body_file"
    return $?
  else
    warn "$label Cannot access ${url} (HTTP=${code}) $(head -c 100 "$body_file" 2>/dev/null)"
    rm -f "$body_file"
    return 1
  fi
}

# check_llm_anthropic <label> <base_url> <api_key> <model>
#   Anthropic: POST {base}/v1/messages sending max_tokens=1, consumes ≤ 10 tokens but can verify URL/auth/model all at once.
check_llm_anthropic() {
  local label="$1" base="$2" key="$3" model="$4"
  base="${base%/}"
  # Normalize: use if already contains /messages; otherwise append /v1/messages
  local url
  if [[ "$base" == */messages ]]; then
    url="$base"
  elif [[ "$base" == */v1 ]]; then
    url="${base}/messages"
  else
    url="${base}/v1/messages"
  fi
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 15 -o "$body_file" -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" \
    -H "x-api-key: $key" \
    -H "Authorization: Bearer $key" \
    -H "anthropic-version: 2023-06-01" \
    -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
    "$url" 2>/dev/null || echo "000")
  case "$code" in
    200)
      ok "$label Anthropic protocol path OK (model $model replied)"
      rm -f "$body_file"; return 0 ;;
    401|403)
      echo "${C_RED}[error]${C_RST} $label API key invalid (HTTP ${code}): $url" >&2
      head -c 200 "$body_file" >&2; echo >&2
      rm -f "$body_file"; return 1 ;;
    404)
      echo "${C_RED}[error]${C_RST} $label URL does not exist (HTTP 404): $url —— Check BASE_URL" >&2
      rm -f "$body_file"; return 1 ;;
    400)
      # 400 is common if model name doesn't exist or body validation fails
      if grep -qE "model.*not.*found|invalid.*model|model_not_found" "$body_file" 2>/dev/null; then
        echo "${C_RED}[error]${C_RST} $label Model name '$model' invalid (HTTP 400)" >&2
        rm -f "$body_file"; return 1
      fi
      warn "$label HTTP 400 (might be parameter format issue, not path error): $(head -c 150 "$body_file")"
      rm -f "$body_file"; return 0 ;;
    *)
      warn "$label Cannot access ${url} (HTTP=${code}) $(head -c 100 "$body_file" 2>/dev/null)"
      rm -f "$body_file"; return 1 ;;
  esac
}

# check_llm_group <label> <base_url> <api_key> <model> <protocol>
check_llm_group() {
  local label="$1" base="$2" key="$3" model="$4" proto="${5:-openai}"
  info "Check $label path (protocol=${proto}, base=${base}, model=${model})..."
  case "$proto" in
    anthropic) check_llm_anthropic "$label" "$base" "$key" "$model" ;;
    *)         check_llm_openai    "$label" "$base" "$key" "$model" ;;
  esac
}

# In-container curl verification (optional, only done when container is running)
check_llm_from_container() {
  local container="$1" label="$2" base="$3" key="$4" model="$5" proto="${6:-openai}"
  if ! $DOCKER ps --format '{{.Names}}' | grep -qx "$container"; then
    return 0  # Container is not running, skip (not an error)
  fi
  info "  ↳ Send request again from inside container $container to $label..."
  # The focus is "network reachability": getting any HTTP status code means it's reachable; 000 means unreachable.
  # Auth errors have already been reported on the host side, no need to trigger error again inside container.
  local url code
  case "$proto" in
    anthropic)
      base="${base%/}"; [[ "$base" == */messages ]] || base="${base}/v1/messages"
      url="$base"
      code=$($DOCKER exec "$container" curl -sS -o /dev/null --max-time 15 \
         -w "%{http_code}" -X POST -H "Content-Type: application/json" \
         -H "x-api-key: $key" -H "anthropic-version: 2023-06-01" \
         -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
         "$url" 2>/dev/null || echo "000")
      ;;
    *)
      base="${base%/}"; base="${base%/v1}"
      url="${base}/v1/models"
      code=$($DOCKER exec "$container" curl -sS -o /dev/null --max-time 10 \
         -w "%{http_code}" -H "Authorization: Bearer $key" "$url" 2>/dev/null || echo "000")
      ;;
  esac
  if [[ "$code" == "000" ]]; then
    warn "  Container ${container} cannot access ${url} (Network isolated / DNS failure)"
    WARNS=$((WARNS+1))
  else
    ok "  Container ${container} → $label network reachable (HTTP ${code})"
  fi
}

# 1. docker
if command -v "$DOCKER" >/dev/null 2>&1 || [[ -x "$DOCKER" ]]; then
  ok "docker available: $DOCKER"
else
  ERRORS=$((ERRORS+1))
  echo "${C_RED}[error]${C_RST} docker unavailable" >&2
fi

# 2. .env
if [[ ! -f "$ENV_FILE" ]]; then
  ERRORS=$((ERRORS+1))
  echo "${C_RED}[error]${C_RST} $ENV_FILE does not exist. Run: cp .env.example .env" >&2
else
  ok ".env exists"
  set -a; source "$ENV_FILE"; set +a

  # 3. Required parameters
  MISSING=()
  for var in \
    MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE \
    MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT \
    MEMORY_CORE_VOLUME PANEL_VOLUME \
    MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
    KNOWLEDGE_PUBLIC_BASE_URL \
    PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL; do
    val="${!var:-}"
    if [[ -z "$val" || "$val" == "REPLACE_ME" ]]; then
      MISSING+=("$var")
    fi
  done
  if (( ${#MISSING[@]} > 0 )); then
    ERRORS=$((ERRORS+1))
    echo "${C_RED}[error]${C_RST} The following required parameters are not set: ${MISSING[*]}" >&2
  else
    ok "All required parameters are filled"
  fi

  # 4. Check if images exist locally
  for img_var in MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE; do
    img="${!img_var:-}"
    if [[ -z "$img" ]]; then continue; fi
    if $DOCKER image inspect "$img" >/dev/null 2>&1; then
      ok "Image already exists locally: $img"
    else
      WARNS=$((WARNS+1))
      warn "Image does not exist locally, will pull on startup: $img"
    fi
  done

  # 5. Port occupancy (warning only)
  for port_var in MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT; do
    port="${!port_var:-}"
    if [[ -z "$port" ]]; then continue; fi
    if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      WARNS=$((WARNS+1))
      warn "Port $port ($port_var) is already occupied, please release it before starting or change port in .env"
    else
      ok "Port $port ($port_var) is free"
    fi
  done

  # 6. LLM Paths (checked by default, skip with --skip-llm)
  if (( SKIP_LLM == 1 )); then
    info "Skip LLM path check (--skip-llm)"
  elif (( ${#MISSING[@]} > 0 )); then
    warn "Skip LLM path check (required parameters missing)"
  else
    echo ""
    info "═══ LLM Path Check ═══════════════════════════════════════"

    # memory group
    if ! check_llm_group "memory group" "$MEMORY_LLM_BASE_URL" "$MEMORY_LLM_API_KEY" \
         "$MEMORY_LLM_MODEL" "${MEMORY_LLM_PROTOCOL:-openai}"; then
      ERRORS=$((ERRORS+1))
    fi
    # If container is already running, check again from inside
    check_llm_from_container tdai-memory-hub "memory group (from container)" \
      "$MEMORY_LLM_BASE_URL" "$MEMORY_LLM_API_KEY" "$MEMORY_LLM_MODEL" \
      "${MEMORY_LLM_PROTOCOL:-openai}"

    # proxy group (if values are exactly the same as memory group, user used the same settings, just check once)
    if [[ "$PROXY_UPSTREAM_URL" == "$MEMORY_LLM_BASE_URL" && \
          "$PROXY_UPSTREAM_API_KEY" == "$MEMORY_LLM_API_KEY" && \
          "$PROXY_UPSTREAM_MODEL" == "$MEMORY_LLM_MODEL" ]]; then
      ok "proxy group is exactly the same as memory group, skip duplicate check"
    else
      # proxy group defaults to openai protocol (matches config.yaml)
      if ! check_llm_group "proxy group" "$PROXY_UPSTREAM_URL" "$PROXY_UPSTREAM_API_KEY" \
           "$PROXY_UPSTREAM_MODEL" openai; then
        ERRORS=$((ERRORS+1))
      fi
      check_llm_from_container tdai-proxy "proxy group (from container)" \
        "$PROXY_UPSTREAM_URL" "$PROXY_UPSTREAM_API_KEY" "$PROXY_UPSTREAM_MODEL" openai
    fi
  fi
fi

echo ""
if (( ERRORS > 0 )); then
  echo "${C_RED}✗ ${ERRORS} errors, ${WARNS} warnings —— unable to start${C_RST}" >&2
  exit 1
elif (( WARNS > 0 )); then
  echo "${C_YLW}⚠ ${WARNS} warnings —— can start, but please note the warnings above${C_RST}"
  exit 0
else
  echo "${C_GRN}✓ All checks passed —— you can directly run ./start-all.sh${C_RST}"
  exit 0
fi
