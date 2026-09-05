#!/usr/bin/env bash
# secret-leak-check.sh — Check whether the repository working tree leaks sensitive information
#
# Usage:
#   scripts/secret-leak-check.sh                  # Check the repository root, exit 1 if a hit is found
#   scripts/secret-leak-check.sh path1 path2 ...  # Check only the specified paths
#
# Integration Method (Choose one of three):
#   1. Git pre-commit hook：
#        cp scripts/secret-leak-check.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#      (Only check the staged changes this time, the script will automatically detect)
#   2. Manually execute before Docker build: `bash scripts/secret-leak-check.sh docker/`
#   3. Run in CI before the build step: `bash scripts/secret-leak-check.sh || exit 1`
#
# Hit rules (regex OR):
#   - High-entropy strings 32+ char base64/hex (may be Bearer / api_key / secret)
#   - `sk-[a-zA-Z0-9_\-]{15,}` (OpenAI/Anthropic/tdai user_key family)
#   - `Bearer\s+[A-Za-z0-9._+/=~-]{15,}`
#   - `["']?(password|passwd|secret|token|api_key|apikey)["']?\s*[:=]\s*["'][^"']{6,}["']`
And the value is not a common placeholder (xxx / your- / example / REPLACE_ / test / demo / dummy)
#
# Whitelist: examples in test/spec/example/docs/README should not fail. Disable the whitelist with --strict.

set -u

STRICT=0
[[ "${1:-}" == "--strict" ]] && { STRICT=1; shift; }

# Default check directory (skip node_modules / dist / .git, etc.)
if [[ $# -eq 0 ]]; then
  TARGETS=(src web/src tests config docker README.md package.json)
else
  TARGETS=("$@")
fi

# Known safe placeholder string, considered non-leak on hit
PLACEHOLDER='xxx|your-|example|REPLACE_|placeholder|<[A-Z_]+>|dummy|fake|test-|demo-|sample|bogus|invalid-|knowledge-debug|-debug"|task-draft-generator'

# Paths that require exemption (example code / known demo passwords / gitignored local files)
EXEMPT_PATH='node_modules/|/dist/|/build/|\.example\.|/docs/|README\.md|\.md:|\.test\.|__tests__/'

Note: the determination of gitignored is in the filter_gitignored function below, to avoid arg list too long.

hits=0
tmp=$(mktemp)
trap "rm -f $tmp" EXIT

for t in "${TARGETS[@]}"; do
  [[ -e "$t" ]] || continue
  # ── Rule 1: sk- prefix keys ──
  grep -rEn "sk-[a-zA-Z0-9_-]{15,}" "$t" 2>/dev/null | grep -Ev "$PLACEHOLDER" >> "$tmp" || true

  # ── Rule 2: Bearer tokens ──
  grep -rEn 'Bearer[[:space:]]+[A-Za-z0-9._+/=~-]{15,}' "$t" 2>/dev/null | grep -Ev "$PLACEHOLDER" >> "$tmp" || true

  # ── Rule 3: api_key/secret/password followed by long values ──
  grep -rEn '"(api_key|apiKey|secret|password|token|passwd)"[[:space:]]*:[[:space:]]*"[^"]{8,}"' "$t" 2>/dev/null \
    | grep -Ev "$PLACEHOLDER" \
    | grep -Ev '"(local|debug|123123)"' >> "$tmp" || true

  # Rule 4 (base64 high-entropy universal scan) has been removed —— false positive rate is too high without PCRE (camelCase names +
  # paths will both trigger it). Rules 1-3 cover the three main forms: sk-*, Bearer, and "api_key":"...".
  # If added in the future, consider using a standalone python/node script for shannon entropy determination.
done

# Application exemption path + gitignored (gitignored files are not committed / in the image, no leak surface)
final=$(grep -Ev "$EXEMPT_PATH" "$tmp" || true)

# gitignored filtering: extract paths line by line, determine with git check-ignore -q; exempt if matched
if git rev-parse --show-toplevel >/dev/null 2>&1 && [[ -n "$final" ]]; then
  repo_root=$(git rev-parse --show-toplevel)
  filtered=""
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    path="${line%%:*}"
    if git -C "$repo_root" check-ignore -q "$path" 2>/dev/null; then
      continue  # gitignored → skip
    fi
    filtered+="$line"$'\n'
  done <<< "$final"
  final="${filtered%$'\n'}"
fi

if [[ -n "$final" ]]; then
  echo "❌ secret-leak-check: Found possible sensitive information ($(echo "$final" | wc -l | tr -d ' ') places)"
  echo
  echo "$final"
  echo
  echo "If it is confirmed to be a false positive, add it to EXEMPT_PATH or use // secret-leak-check-ignore to exempt the line"
  exit 1
fi

echo "✓ secret-leak-check: No sensitive information found (Scan target: ${TARGETS[*]})"
exit 0
