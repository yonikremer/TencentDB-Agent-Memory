#!/usr/bin/env bash
# Boot contract for deploy/global-images/start-all.sh (no docker needed).
# Pins the customer boot order: syntax valid, core -> hub -> proxy ordering,
# required vars validated up front, health waits per step, stop script covers
# every container the start scripts launch.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
G="$DIR/../deploy/global-images"
PASS=0
FAIL=0
check() { # $1=name $2=command...
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL $name"
    FAIL=$((FAIL + 1))
  fi
}
check "bash-syntax-all" bash -n "$G/start-all.sh"
check "bash-syntax-lib" bash -n "$G/_lib.sh"
check "bash-syntax-core" bash -n "$G/start-memory-core.sh"
check "bash-syntax-hub" bash -n "$G/start-memory-hub.sh"
check "bash-syntax-proxy" bash -n "$G/start-proxy.sh"
check "bash-syntax-stop" bash -n "$G/stop-all.sh"
check "bash-syntax-verify" bash -n "$G/verify.sh"
# Order: core line before hub line before proxy line in start-all.sh
core=$(grep -n "start-memory-core.sh" "$G/start-all.sh" | cut -d: -f1)
hub=$(grep -n "start-memory-hub.sh" "$G/start-all.sh" | cut -d: -f1)
proxy=$(grep -n "start-proxy.sh" "$G/start-all.sh" | cut -d: -f1)
check "order-core-first" test "$core" -lt "$hub"
check "order-hub-before-proxy" test "$hub" -lt "$proxy"
# Required vars validated before any start
check "require-vars-present" grep -q "require_vars" "$G/start-all.sh"
for v in MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE MEMORY_LLM_BASE_URL PROXY_UPSTREAM_URL; do
  check "require-var-$v" grep -q "$v" "$G/start-all.sh"
done
# Ports checked before start
check "ports-before-start" bash -c "[ $(grep -n check_ports "$G/start-all.sh" | cut -d: -f1) -lt $core ]"
# Each start script waits for health
for s in start-memory-core start-memory-hub start-proxy; do
  check "$s-waits-healthy" grep -q "wait_healthy" "$G/$s.sh"
done
# set -euo pipefail everywhere (fail fast, no silent half-boot)
for s in start-all.sh _lib.sh start-memory-core.sh start-memory-hub.sh start-proxy.sh stop-all.sh; do
  check "$s-strict-mode" grep -q "set -euo pipefail" "$G/$s"
done
# Every container started is stopped: CONTAINER= vars in start scripts must
# appear in stop-all.sh (loose tdai-* matching false-positives on config
# files like tdai-gateway.yaml and x-tdai-* headers, so match assignments).
started=$(grep -hoE "^CONTAINER=[a-z-]+" "$G/start-memory-core.sh" "$G/start-memory-hub.sh" "$G/start-proxy.sh" | cut -d= -f2 | sort -u)
[ -n "$started" ] || {
  echo "FAIL no-containers-found"
  FAIL=$((FAIL + 1))
}
for c in $started; do
  check "stop-covers-$c" grep -q "$c" "$G/stop-all.sh"
done
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
