#!/usr/bin/env bash
# install-git-hooks.sh — Enable the secret-leak-check pre-commit hook in this repository
#
# Usage: bash scripts/install-git-hooks.sh
#
# Effect: Automatically run scripts/secret-leak-check.sh before each `git commit`, and reject the commit if a hit is found.
# Uninstall: rm .git/hooks/pre-commit
set -eu

repo_root=$(git rev-parse --show-toplevel)
hook_path="$repo_root/.git/hooks/pre-commit"

cat > "$hook_path" <<'EOF'
#!/usr/bin/env bash
# Auto-installed pre-commit hook —— see scripts/install-git-hooks.sh
repo_root=$(git rev-parse --show-toplevel)
exec bash "$repo_root/scripts/secret-leak-check.sh"
EOF

chmod +x "$hook_path"
echo "✓ pre-commit hook has been installed to $hook_path"
echo "   It runs secret-leak-check.sh before each git commit; commits containing sensitive information will be rejected."
echo "   Temporary skip: git commit --no-verify"
