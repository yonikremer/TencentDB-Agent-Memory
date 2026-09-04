#!/usr/bin/env bash
# One-key launcher for memory -> memory-hub -> proxy stack (interactive).
#
# Order: Start memory (core), wait for healthy; start memory-hub (panel+knowledge), wait for healthy;
# finally start proxy. Any failed step aborts and prints container logs.
#
# Usage:
#   ./start-all.sh            # Interactive wizard to input LLM settings (press Enter to keep current values)
#   PULL=1 ./start-all.sh     # Pull latest Docker images first before starting

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Copy from .env.example if .env does not exist
if [[ ! -f "$ENV_FILE" ]]; then
  info ".env does not exist, copying from .env.example"
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
fi

load_env

# Interactive LLM setup + connectivity check + save to .env
interactive_llm_setup

# Validate all required variables up front
require_vars \
  MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE \
  MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT \
  MEMORY_CORE_VOLUME PANEL_VOLUME \
  MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
  KNOWLEDGE_PUBLIC_BASE_URL \
  PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL

# Port check up front
check_ports

info "═══ Step 1/3: memory ═══════════════════════════════════════"
"$SCRIPT_DIR/start-memory-core.sh"

info "═══ Step 2/3: memory-hub ═══════════════════════════════════"
"$SCRIPT_DIR/start-memory-hub.sh"

info "═══ Step 3/3: proxy ════════════════════════════════════════"
PROXY_FULL_STACK="${PROXY_FULL_STACK:-1}" "$SCRIPT_DIR/start-proxy.sh"

ok "═══ All services ready ═════════════════════════════════════"
print_endpoints

ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  UPSTREAM_MODEL="${PROXY_UPSTREAM_MODEL:-<your-model>}"
  echo ""
  echo "  ┌─ Using Claude Code via proxy ─────────────────────────────────────┐"
  echo "  │  export ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}/claude-code/default"
  echo "  │  export ANTHROPIC_AUTH_TOKEN='${ADMIN_KEY}'"
  echo "  │  claude --model ${UPSTREAM_MODEL}"
  echo "  │"
  echo "  │  admin user_key saved at: $ADMIN_KEY_FILE"
  echo "  └────────────────────────────────────────────────────────────────┘"
fi
echo ""
echo "  View logs:   docker logs -f tdai-memory-core | tdai-memory-hub | tdai-proxy"
echo "  Stop stack:  ./stop-all.sh"
echo ""
