#!/bin/bash
#
# install_memory_tencentdb.sh
#
# Execute after install_hermes_ubuntu.sh, for:
#   1. Download @tencentdb-agent-memory/memory-tencentdb@latest via npm to
#      $MEMORY_TENCENTDB_ROOT/tdai-memory-openclaw-plugin (default ~/.memory-tencentdb/tdai-memory-openclaw-plugin)
#   2. Install the Gateway's Node.js dependencies (npm install)
#   3. Configure hermes config.yaml to use memory_tencentdb as the memory provider
#   4. Set the Gateway's auto-start environment variables
#
# Path Convention (all located under ~/.memory-tencentdb/, can be overridden via environment variables):
#   $MEMORY_TENCENTDB_ROOT      Default: ~/.memory-tencentdb
#   $TDAI_INSTALL_DIR           Default: $MEMORY_TENCENTDB_ROOT/tdai-memory-openclaw-plugin
#   $TDAI_DATA_DIR              Default: $MEMORY_TENCENTDB_ROOT/memory-tdai
#
# Old versions (<= 0.3.x) use ~/tdai-memory-openclaw-plugin and ~/memory-tdai;
# This script automatically migrates these two old directories to new locations before execution (see Step 0).
#
# Usage:
#    Execute as the target user (recommended):
#     su - <username> -c "bash ~/install_memory_tencentdb.sh"
#     # Or directly log in with this user to execute
#     bash ~/install_memory_tencentdb.sh
#
Execute as root (image build scenario):
#     bash ~/install_memory_tencentdb.sh
#     # root will automatically su to the target user to execute, and fix permissions after completion
#
# Prerequisites:
#   - install_hermes_ubuntu.sh has been executed (hermes-agent has been installed)
#   - Node.js >= 22 is installed

set -e

# Dynamically obtain the target installation user and their HOME directory.
# Priority:
#   1. Explicit ``INSTALL_AS_USER`` environment variable (admin script scenario: root runs the installation but
#       wants to configure for another user)
#   2. ``SUDO_USER`` (when called by ``sudo``, switch back to the original user instead of root)
#   3. ``whoami`` —— the user corresponding to the current EUID
#
# Note: When root directly sshs in (not via sudo), neither of the first two will be set,
# ``whoami`` returns ``root``. The below ``id -u`` == 0 branch recognizes this "the target
# is root" case and skips the ``su - root`` recursion.
USERNAME="${INSTALL_AS_USER:-${SUDO_USER:-$(whoami)}}"
USER_HOME=$(eval echo ~$USERNAME)

# npm package name
NPM_PACKAGE="@tencentdb-agent-memory/memory-tencentdb@latest"

# Hermes path
HERMES_HOME="$USER_HOME/.hermes"
# HERMES_AGENT_DIR（fix: issue #18）
# What is passed via environment variables is used as-is; if not set, it falls back to the traditional path.
# If the directory does not exist, subsequent pre-checks will uniformly report an error.
HERMES_AGENT_DIR="${HERMES_AGENT_DIR:-$HERMES_HOME/hermes-agent}"
HERMES_CONFIG="$HERMES_HOME/config.yaml"

# unified root directory for memory-tencentdb (all tdai-related data/code are stored here)
# can be overridden via the environment variable MEMORY_TENCENTDB_ROOT
MEMORY_TENCENTDB_ROOT="${MEMORY_TENCENTDB_ROOT:-$USER_HOME/.memory-tencentdb}"

# tdai unzip target directory (located under the unified root directory)
# Can be overridden via the environment variable TDAI_INSTALL_DIR
TDAI_INSTALL_DIR="${TDAI_INSTALL_DIR:-$MEMORY_TENCENTDB_ROOT/tdai-memory-openclaw-plugin}"

# tdai data directory (Gateway baseDir, located under the unified root directory)
# Can be overridden via the environment variable TDAI_DATA_DIR
TDAI_DATA_DIR="${TDAI_DATA_DIR:-$MEMORY_TENCENTDB_ROOT/memory-tdai}"

# Old path (used only for automatic migration)
LEGACY_INSTALL_DIR="$USER_HOME/tdai-memory-openclaw-plugin"
LEGACY_DATA_DIR="$USER_HOME/memory-tdai"

# ==================== root → automatically switch to target user ====================
# Keep consistent with install_hermes_ubuntu.sh: if executed as root and the target user is not
# root, automatically su to the target user to run the actual installation logic.
#
# If the current user is root and the target user is also root (``USERNAME=root``, for example directly ssh
# logging in as root to run the installation), skip ``su - root`` —— otherwise it will infinitely recurse (``su - root``
# enters root, then reaches this branch again, su again, and never stops). See issue #20.

if [ "$(id -u)" -eq 0 ] && [ "$USERNAME" != "root" ]; then
    echo "[memory-tencentdb] Running as root, switching to $USERNAME for installation..."

    # Verify prerequisites
    if [ ! -d "$HERMES_AGENT_DIR" ]; then
        echo "[ERROR] Hermes agent not found at $HERMES_AGENT_DIR"
        echo "[ERROR] Please run install_hermes_ubuntu.sh first."
        exit 1
    fi

    # Switch to target user to execute
    TEMP_SCRIPT=$(mktemp /tmp/memory-tencentdb-install-XXXXXX.sh)
    cp "${BASH_SOURCE[0]}" "$TEMP_SCRIPT"
    chmod 755 "$TEMP_SCRIPT"
    su - $USERNAME -c "bash $TEMP_SCRIPT" </dev/null

    # Fix permissions
    echo "[memory-tencentdb] Fixing permissions..."
    chown -R $USERNAME:$USERNAME "$USER_HOME"

    rm -f "$TEMP_SCRIPT"
    echo "[memory-tencentdb] Installation completed successfully"
    exit 0
elif [ "$(id -u)" -eq 0 ]; then
    # Current user is root and the target user is also root: directly run the subsequent installation logic as root,
    # no longer go through ``su -`` switching (to avoid the recursion in #20).
    echo "[memory-tencentdb] Running as root; target user is also root — installing in place."
fi

# ==================== User Phase (Core Installation Logic) ====================

echo "[memory-tencentdb] Installing memory-tencentdb plugin (user: $(whoami))..."

# Verify Prerequisites
if [ ! -d "$HERMES_AGENT_DIR" ]; then
    echo "[ERROR] Hermes agent not found at $HERMES_AGENT_DIR"
    echo "[ERROR] Please run install_hermes_ubuntu.sh first."
    exit 1
fi

# Load hermes environment (node/npm need to be in PATH)
if [ -f /etc/profile.d/hermes-env.sh ]; then
    source /etc/profile.d/hermes-env.sh
fi

Ensure the unified root directory exists
mkdir -p "$MEMORY_TENCENTDB_ROOT"

# ---------- Step 0: Automatically Migrate Old Paths (Backward Compatible) ----------
#
# The historical version unpacks tdai to ~/tdai-memory-openclaw-plugin and places the data in ~/memory-tdai.
# Now it is uniformly consolidated under ~/.memory-tencentdb/, and this performs a one-time automatic migration.
# Skip if already in the new location; if both old and new locations exist, print a warning and leave the new location unchanged.

migrate_legacy_dir() {
    local legacy="$1"
    local target="$2"
    local label="$3"
    if [ ! -e "$legacy" ]; then
        return 0
    fi
    if [ -L "$legacy" ]; then
        # The old location is a symlink, so remove it directly
        echo "[memory-tencentdb] Removing legacy symlink: $legacy"
        rm -f "$legacy"
        return 0
    fi
    if [ -e "$target" ]; then
        echo "[memory-tencentdb] WARN: legacy $label dir exists at $legacy but new location $target also exists." >&2
        echo "[memory-tencentdb] WARN: keeping new location; please review and remove $legacy manually if obsolete." >&2
        return 0
    fi
    echo "[memory-tencentdb] Migrating legacy $label dir: $legacy -> $target"
    mkdir -p "$(dirname "$target")"
    mv "$legacy" "$target"
}

migrate_legacy_dir "$LEGACY_INSTALL_DIR" "$TDAI_INSTALL_DIR" "install"
migrate_legacy_dir "$LEGACY_DATA_DIR"    "$TDAI_DATA_DIR"    "data"

# ---------- Step 1: Download packages via npm and extract to $TDAI_INSTALL_DIR ----------

echo "[memory-tencentdb] Step 1: Downloading $NPM_PACKAGE via npm..."

# Clean up old installation
rm -rf "$TDAI_INSTALL_DIR"

# Download packages via npm install using a temporary directory
TEMP_DOWNLOAD=$(mktemp -d /tmp/memory-tencentdb-download-XXXXXX)
cd "$TEMP_DOWNLOAD"
npm init -y --silent > /dev/null 2>&1
npm install "$NPM_PACKAGE" --omit=dev 2>&1 | tail -5

# After package installation, located at node_modules/@tencentdb-agent-memory/memory-tencentdb
PACK_DIR="$TEMP_DOWNLOAD/node_modules/@tencentdb-agent-memory/memory-tencentdb"

if [ ! -d "$PACK_DIR" ]; then
    echo "[ERROR] Downloaded package directory not found at $PACK_DIR"
    rm -rf "$TEMP_DOWNLOAD"
    exit 1
fi

# Move package contents to the target installation directory
mkdir -p "$(dirname "$TDAI_INSTALL_DIR")"
cp -r "$PACK_DIR" "$TDAI_INSTALL_DIR"

echo "[memory-tencentdb] Package downloaded and extracted to $TDAI_INSTALL_DIR"

# ---------- Step 2: Install Gateway Node.js Dependencies ----------

echo "[memory-tencentdb] Step 2: Installing Gateway dependencies..."

cd "$TDAI_INSTALL_DIR"

echo "[memory-tencentdb] Running npm install (this may take a while)..."
npm install --omit=dev 2>&1 | tail -5

# Install tsx (required for Gateway startup), prefer local installation
if ! npx tsx --version &>/dev/null; then
    npm install tsx 2>&1 | tail -2
fi

echo "[memory-tencentdb] Gateway dependencies installed"

# ---------- Step 2.5: Link the plugin to the hermes plugin directory ----------

echo "[memory-tencentdb] Step 2.5: Linking plugin into hermes plugins directory..."

HERMES_PLUGIN_DIR="$HERMES_AGENT_DIR/plugins/memory/memory_tencentdb"
PLUGIN_SRC_DIR="$TDAI_INSTALL_DIR/hermes-plugin/memory/memory_tencentdb"

# Remove old links/directories
rm -rf "$HERMES_PLUGIN_DIR"

# Create symlink so hermes can discover plugins
ln -sf "$PLUGIN_SRC_DIR" "$HERMES_PLUGIN_DIR"

echo "[memory-tencentdb] Plugin linked: $HERMES_PLUGIN_DIR -> $PLUGIN_SRC_DIR"

# ---------- Step 3: Prompt user to manually enable memory_tencentdb (do not modify config automatically) ----------

echo "[memory-tencentdb] Step 3: Checking hermes config..."

# The plugin has been linked to the hermes plugin directory, but is not enabled by default, only a prompt is shown
if [ -f "$HERMES_CONFIG" ]; then
    if sed -n '/^memory:/,/^[a-zA-Z]/p' "$HERMES_CONFIG" | grep -q "provider: memory_tencentdb"; then
        echo "[memory-tencentdb] memory.provider already set to memory_tencentdb"
    else
        echo "[memory-tencentdb] Plugin installed but NOT enabled by default."
        echo "[memory-tencentdb] To enable tdai memory, add/edit in $HERMES_CONFIG:"
        echo ""
        echo "    memory:"
        echo "      provider: memory_tencentdb"
        echo ""
    fi
else
    echo "[memory-tencentdb] WARN: $HERMES_CONFIG not found, please run install_hermes_ubuntu.sh first"
fi

# ---------- Step 4: Configure Gateway Environment Variables ----------

echo "[memory-tencentdb] Step 4: Setting up Gateway environment..."

# Build Gateway startup command
# Wrap with sh -c, cd to plugin directory first then start Gateway (ESM resolution required)
#
# Parse node absolute path and write to GATEWAY_CMD (fix: issue #19)
# When Hermes or an independent Gateway runs as a systemd service, systemd does not
# source any user shell rc files, so the PATH injected by nvm/asdf does not exist.
# Use `command -v node` to resolve the absolute path during install, and switch to Node's native
# `--import tsx/esm` (Node >= 20.6 stable) instead of `npx tsx`,
# so the final command does not depend on the runtime PATH at all.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    echo "[ERROR] 'node' not found in PATH; cannot generate Gateway start command." >&2
    echo "[ERROR] If you installed Node via nvm/asdf, source the loader script first:" >&2
    echo "[ERROR]   source ~/.bashrc   # or 'nvm use <version>'" >&2
    exit 1
fi
echo "[memory-tencentdb] Resolved node: $NODE_BIN"

GATEWAY_CMD="sh -c 'cd $TDAI_INSTALL_DIR && exec \"$NODE_BIN\" --import tsx/esm src/gateway/server.ts'"

# ── 4a: /etc/profile.d (SSH interactive login scenario) ──
# Write persistent environment variables to /etc/profile.d for use when manually executing `hermes` via SSH.
# Note: LLM-related variables (API key, model, etc.) need to be manually configured by the user later
ENVFILE="/etc/profile.d/memory-tencentdb-env.sh"
cat << ENVEOF | sudo tee "$ENVFILE" > /dev/null
# memory-tencentdb Gateway environment variables
export MEMORY_TENCENTDB_GATEWAY_CMD="$GATEWAY_CMD"
export MEMORY_TENCENTDB_GATEWAY_HOST="127.0.0.1"
export MEMORY_TENCENTDB_GATEWAY_PORT="8420"
# LLM Configuration (Modify as needed)
# export MEMORY_TENCENTDB_LLM_API_KEY="sk-..."
# export MEMORY_TENCENTDB_LLM_BASE_URL="https://api.openai.com/v1"
# export MEMORY_TENCENTDB_LLM_MODEL="gpt-4o"
ENVEOF

echo "[memory-tencentdb] Environment variables written to $ENVFILE"

# ── 4b: ~/.hermes/.env (systemd service scenario) ──
# When hermes-gateway is started via a systemd user service, it does not source /etc/profile.d/*.sh,
# but hermes's run.py loads load_dotenv("~/.hermes/.env") when it starts.
# Therefore, key variables must be synced into .env, otherwise the Gateway cannot auto-start in the systemd scenario.
HERMES_ENV="$HERMES_HOME/.env"

_append_or_update_env() {
    local key="$1"
    local value="$2"
    local file="$3"
    if [ ! -f "$file" ]; then
        touch "$file"
    fi
    # Remove existing same-named variable lines (including commented-out and quoted ones), then append
    sed -i "/^${key}=/d" "$file"
    sed -i "/^# *${key}=/d" "$file"
    # python-dotenv requires values containing spaces/quotes/special characters to be wrapped in double quotes
    echo "${key}=\"${value}\"" >> "$file"
}

_append_or_update_env "MEMORY_TENCENTDB_GATEWAY_CMD" "$GATEWAY_CMD" "$HERMES_ENV"
_append_or_update_env "MEMORY_TENCENTDB_GATEWAY_HOST" "127.0.0.1"   "$HERMES_ENV"
_append_or_update_env "MEMORY_TENCENTDB_GATEWAY_PORT" "8420"         "$HERMES_ENV"

echo "[memory-tencentdb] Gateway env vars also written to $HERMES_ENV (for systemd service)"

# ---------- Cleanup ----------

rm -rf "$TEMP_DOWNLOAD"

# ---------- Verify Installation ----------

echo ""
echo "=========================================="
echo "[memory-tencentdb] Installation Summary"
echo "=========================================="
echo "  Root dir:       $MEMORY_TENCENTDB_ROOT"
echo "  tdai source:    $TDAI_INSTALL_DIR"
echo "  tdai data dir:  $TDAI_DATA_DIR"
echo "  Hermes config:  $HERMES_CONFIG"
echo "  Env file:       $ENVFILE"
echo ""
echo "  Installed files in tdai dir:"
ls -la "$TDAI_INSTALL_DIR"/ 2>/dev/null | head -20 || echo "  (none)"
echo ""

# Verify that the hermes plugin file exists (in the extraction directory)
PLUGIN_SRC="$TDAI_INSTALL_DIR/hermes-plugin/memory/memory_tencentdb"
MISSING=0
for f in __init__.py plugin.yaml client.py supervisor.py; do
    if [ ! -f "$PLUGIN_SRC/$f" ]; then
        echo "  [WARN] Missing: $PLUGIN_SRC/$f"
        MISSING=1
    fi
done

if [ "$MISSING" -eq 0 ]; then
    echo "  [OK] All hermes plugin files present"
fi

# Verify that the Gateway entry exists
if [ -f "$TDAI_INSTALL_DIR/src/gateway/server.ts" ]; then
    echo "  [OK] Gateway entry point found"
else
    echo "  [WARN] Gateway server.ts not found at $TDAI_INSTALL_DIR/src/gateway/server.ts"
fi

# Verify node_modules is installed
if [ -d "$TDAI_INSTALL_DIR/node_modules" ]; then
    echo "  [OK] Gateway node_modules installed"
else
    echo "  [WARN] Gateway node_modules not found"
fi

echo ""
echo "[memory-tencentdb] Done!"
echo ""
echo "  NOTE: Before using the memory plugin, configure LLM credentials in ~/.hermes/.env:"
echo "    MEMORY_TENCENTDB_LLM_API_KEY=your-api-key"
echo "    MEMORY_TENCENTDB_LLM_BASE_URL=https://api.openai.com/v1"
echo "    MEMORY_TENCENTDB_LLM_MODEL=gpt-4o"
echo ""
echo "  (For systemd-managed hermes-gateway, ~/.hermes/.env is the authoritative config."
echo "   /etc/profile.d/ is only used for interactive SSH sessions.)"
echo ""
