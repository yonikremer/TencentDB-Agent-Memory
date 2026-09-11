#!/usr/bin/env bash
# Live boot test: real `start-all.sh` against an isolated ENV_FILE, then
# health-probe all three services, then stop-all and verify cleanup.
#
# Mutates the machine (containers, test volumes/ports) — explicit opt-in:
#   BOOT_LIVE=1 LLM_LIVE=1 ./tests/boot-live.sh
# Needs: docker daemon up, images present (or PULL=1), tests/.env with key.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$DIR")"
G="$ROOT/deploy/global-images"
[ "${BOOT_LIVE:-0}" = "1" ] || {
  echo "SKIP: set BOOT_LIVE=1 to run live boot"
  exit 0
}
[ "${LLM_LIVE:-0}" = "1" ] || {
  echo "SKIP: set LLM_LIVE=1 to run live boot"
  exit 0
}
docker info >/dev/null 2>&1 || {
  echo "FAIL: docker daemon not running"
  exit 1
}
# Isolated env file (never touches the user's real deploy/.env).
TEST_ENV="$DIR/.boot-live.env"
cp "$G/.env.example" "$TEST_ENV"
# Test ports to avoid clashing with a real stack.
for kv in MEMORY_CORE_PORT=18501 PANEL_PORT=18525 KNOWLEDGE_PORT=18421 PROXY_PORT=18096; do
  k="${kv%%=*}"
  v="${kv#*=}"
  grep -q "^$k=" "$TEST_ENV" && sed -i "s|^$k=.*|$k=$v|" "$TEST_ENV" || echo "$k=$v" >>"$TEST_ENV"
done
# LLM straight from tests/.env (OpenRouter free model).
OR_KEY=$(grep -E "^OPENROUTER_API_KEY=" "$ROOT/tests/.env" | cut -d= -f2- | tr -d "\" ")
[ -n "$OR_KEY" ] || {
  echo "FAIL: no OPENROUTER_API_KEY in tests/.env"
  exit 1
}
for kv in "MEMORY_LLM_BASE_URL=https://openrouter.ai/api/v1" "MEMORY_LLM_API_KEY=$OR_KEY" "MEMORY_LLM_MODEL=nvidia/nemotron-3.5-lightning:free" "MEMORY_LLM_PROTOCOL=openai" "PROXY_UPSTREAM_URL=https://openrouter.ai/api/v1" "PROXY_UPSTREAM_API_KEY=$OR_KEY" "PROXY_UPSTREAM_MODEL=nvidia/nemotron-3.5-lightning:free"; do
  k="${kv%%=*}"
  v="${kv#*=}"
  grep -q "^$k=" "$TEST_ENV" && sed -i "s|^$k=.*|$k=$v|" "$TEST_ENV" || echo "$k=$v" >>"$TEST_ENV"
done
cleanup() { rm -f "$TEST_ENV"; }
trap cleanup EXIT
# Feed Enters to accept all prompted defaults (non-interactive).
# shellcheck disable=SC2128
printf '\n%.0s' {1..60} | ENV_FILE="$TEST_ENV" "$G/start-all.sh"
# Probe health of all three tiers.
CORE_P=$(grep -E "^MEMORY_CORE_PORT=" "$TEST_ENV" | cut -d= -f2)
HUB_P=$(grep -E "^PANEL_PORT=" "$TEST_ENV" | cut -d= -f2)
PROXY_P=$(grep -E "^PROXY_PORT=" "$TEST_ENV" | cut -d= -f2)
for url in "http://127.0.0.1:$CORE_P/health" "http://127.0.0.1:$HUB_P/health" "http://127.0.0.1:$PROXY_P/health"; do
  if curl -fs -m 10 "$url" >/dev/null; then
    echo "PASS healthy $url"
  else
    echo "FAIL unhealthy $url"
    ENV_FILE="$TEST_ENV" "$G/stop-all.sh" || true
    exit 1
  fi
done
# Tear down and verify no test containers remain.
ENV_FILE="$TEST_ENV" "$G/stop-all.sh"
left=$(docker ps --format "{{.Names}}" | grep -cE "tdai-" || true)
[ "$left" -eq 0 ] || {
  echo "FAIL: $left tdai containers remain"
  exit 1
}
echo "== live boot PASS =="
