#!/usr/bin/env bash
set -euo pipefail

# ─── Knowledge Service Startup Script ───
# Automatically handles Node version, pnpm, better-sqlite3 compilation compatibility

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NODE_VERSION="22.19.0"
NODE_PATH="/codev/opt/nodejs/${NODE_VERSION}/bin"
PYTHON_BIN="/usr/bin/python3.8"

echo "========================================"
echo "  Knowledge Service Startup Script"
echo "========================================"

# ── Step 1: Check / Switch Node version ──
echo "[1/5] Checking Node.js version..."
if [ ! -x "${NODE_PATH}/node" ]; then
  echo "  Error: Node.js ${NODE_VERSION} not found at (${NODE_PATH})"
  echo "  Please install Node.js ${NODE_VERSION} first"
  exit 1
fi

export PATH="${NODE_PATH}:$PATH"
echo "  Node: $(node -v) ($(which node))"
echo "  npm:  $(npm -v)"

# ── Step 2: Install pnpm (if needed) ──
echo "[2/5] Checking pnpm..."
if ! command -v pnpm &>/dev/null; then
  echo "  Installing pnpm@9.15.0..."
  npm install -g pnpm@9.15.0 2>&1 | tail -1
fi
echo "  pnpm: $(pnpm --version)"

# ── Step 3: Install dependencies ──
echo "[3/5] Installing dependencies..."
if [ ! -d "node_modules" ]; then
  PYTHON="${PYTHON_BIN}" npm_config_python="${PYTHON_BIN}" pnpm install --ignore-scripts
fi

# ── Step 4: Validate / Prepare better-sqlite3 ──
echo "[4/5] Validating better-sqlite3..."
if node -e "require('better-sqlite3')(':memory:')" &>/dev/null; then
  echo "  better-sqlite3 prebuilt binary loaded successfully"
else
  echo "  Prebuilt binary unavailable, attempting source build..."
  BETTER_SQLITE3_DIR="$(node -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))" 2>/dev/null)"
  BINDING_GYP="${BETTER_SQLITE3_DIR}/binding.gyp"

  if [ -z "${BETTER_SQLITE3_DIR}" ] || [ ! -f "${BINDING_GYP}" ]; then
    echo "  Error: Unable to locate better-sqlite3 package, please run pnpm install first"
    exit 1
  fi

  # Patch GCC 8.5 does not support -std=c++20
  if grep -q -- "-std=c++20" "${BINDING_GYP}"; then
    sed -i "s/-std=c++20/-std=c++2a/g" "${BINDING_GYP}"
    echo "  Patched binding.gyp: -std=c++20 → -std=c++2a"
  fi

  # Manual build
  cd "${BETTER_SQLITE3_DIR}"
  PYTHON="${PYTHON_BIN}" npm_config_python="${PYTHON_BIN}" \
    npx node-gyp rebuild --python="${PYTHON_BIN}" 2>&1 | grep -E "(gyp info ok|error|Error)" || true
  cd "$SCRIPT_DIR"

  if node -e "require('better-sqlite3')(':memory:')" &>/dev/null; then
    echo "  better-sqlite3 source build succeeded"
  else
    echo "  Error: better-sqlite3 unavailable (prebuilt load failed and source build failed)"
    exit 1
  fi
fi

# ── Step 5: Start Service ──
echo "[5/5] Starting Knowledge Service..."
echo "  Port: ${PORT:-8421}"
echo "  Data directory: ${KNOWLEDGE_DATA_DIR:-~/.memory-tencentdb/knowledge}"
echo "========================================"
echo ""

pnpm run dev
