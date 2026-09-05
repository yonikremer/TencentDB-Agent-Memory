#!/usr/bin/env bash
# scripts/ci/check-skill-queue-isolation.sh
#
# Skill Async Queue Red Line Guard Script
#
# Purpose: Prevent any diff in CI that would pollute the "memory module", and prevent the Skill module
#        from directly importing node:fs (must go through StorageAdapter).
#
# Check item:
#   1) Prohibit modifying the following memory-related red-line files / directories:
#        - src/core/state/types.ts
#        - src/core/state/local-backend.ts
#        - src/services/pipeline-worker.ts
#        - src/integrations/redis/**          (Future memory Redis backend; note this is not redis-skill)
#   2) Prohibit adding `from "node:fs"` / `from "fs"` / `from "fs/promises"` references in src/core/skill/**.
#
# Usage:
#   - Local (compare with origin/main): bash scripts/ci/check-skill-queue-isolation.sh
#   - Specify base in CI: BASE_REF=origin/main bash scripts/ci/check-skill-queue-isolation.sh
#   - Skip (not recommended, emergency bypass only): SKIP_SKILL_QUEUE_ISOLATION=1 bash scripts/ci/check-skill-queue-isolation.sh
#
# Exit code:
#   0: Pass
#   1: Red line is touched
#   2: Environment/dependency issue (git unavailable, etc.)

set -euo pipefail

if [[ "${SKIP_SKILL_QUEUE_ISOLATION:-0}" == "1" ]]; then
  echo "[skill-queue-isolation] SKIP_SKILL_QUEUE_ISOLATION=1, skip red-line check (not recommended)"
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "[skill-queue-isolation] ERROR: git is unavailable" >&2
  exit 2
fi

BASE_REF="${BASE_REF:-origin/main}"
MODE="${MODE:-auto}"   # auto | working-tree | base-diff

# If BASE_REF does not exist (e.g., shallow clone), fall back to HEAD~1
if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  if git rev-parse --verify --quiet "HEAD~1" >/dev/null; then
    BASE_REF="HEAD~1"
  else
    echo "[skill-queue-isolation] WARN: Unable to locate BASE_REF=$BASE_REF and there is no HEAD~1, skipping check"
    exit 0
  fi
fi

echo "[skill-queue-isolation] BASE_REF=$BASE_REF MODE=$MODE"

# Get the list of diff files (A/M/D/R all count)
# - base-diff: compared with BASE_REF (used in CI)
# - working-tree: includes staged + unstaged working tree changes (used locally)
# - auto: in CI environment (GITHUB_ACTIONS=true / CI=true) use base-diff, otherwise working-tree
case "$MODE" in
  base-diff)
    CHANGED=$(git diff --name-only --diff-filter=ACMRT "$BASE_REF"...HEAD || true)
    ;;
  working-tree)
    CHANGED=$(git status --porcelain | awk '$1 ~ /^[AM?RC]/ || $1 ~ /^.[AM]/ {print $NF}' | sort -u || true)
    ;;
  auto|*)
    if [[ "${GITHUB_ACTIONS:-}" == "true" || "${CI:-}" == "true" ]]; then
      CHANGED=$(git diff --name-only --diff-filter=ACMRT "$BASE_REF"...HEAD || true)
    else
      # Local: Merge base..HEAD + working directory changes, maximize coverage
      CHANGED=$( { git diff --name-only --diff-filter=ACMRT "$BASE_REF"...HEAD 2>/dev/null || true; \
                   git status --porcelain | awk '$1 ~ /^[AM?RC]/ || $1 ~ /^.[AM]/ {print $NF}'; } | sort -u)
    fi
    ;;
esac

if [[ -z "$CHANGED" ]]; then
  echo "[skill-queue-isolation] No file changes, pass"
  exit 0
fi

VIOLATIONS=()

# ── Red Line 1: Specific Files Prohibited from Modification ──
FORBIDDEN_FILES=(
  "src/core/state/types.ts"
  "src/core/state/local-backend.ts"
  "src/services/pipeline-worker.ts"
)

for f in "${FORBIDDEN_FILES[@]}"; do
  if echo "$CHANGED" | grep -qx "$f"; then
    VIOLATIONS+=("Prohibited file to modify: $f")
  fi
done

# ── Red Line 2: Prohibit modifying the src/integrations/redis/ directory (Note: redis-skill is allowed) ──
# Use awk to precisely match the `src/integrations/redis/` prefix but exclude `src/integrations/redis-skill/`
while IFS= read -r f; do
  case "$f" in
    src/integrations/redis-skill/*) ;;  # Allow
    src/integrations/redis/*)
      VIOLATIONS+=("Prohibited to modify memory Redis directory: $f")
      ;;
  esac
done <<< "$CHANGED"

# ── Red Line 3: src/core/skill/** must not directly import node:fs ──
# Only check .ts files hit by the diff; test files (*.test.ts / __tests__/) are exempt,
# because tests often need to directly build tmpdir scaffolding (they do not go through runtime product code).
SKILL_TS_CHANGED=$(echo "$CHANGED" | grep -E '^src/core/skill/.*\.ts$' | grep -vE '\.test\.ts$|/__tests__/' || true)

if [[ -n "$SKILL_TS_CHANGED" ]]; then
  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    # Capture fs / node:fs / fs/promises in import statements
    if grep -nE 'from[[:space:]]+["'"'"']?(node:fs|fs|fs/promises)["'"'"']?' "$f" >/dev/null; then
      MATCH=$(grep -nE 'from[[:space:]]+["'"'"']?(node:fs|fs|fs/promises)["'"'"']?' "$f" | head -3)
      VIOLATIONS+=("Skill module prohibits direct import of fs: $f"$'\n'"$MATCH")
    fi
  done <<< "$SKILL_TS_CHANGED"
fi

# ── Summary ──
if [[ ${#VIOLATIONS[@]} -gt 0 ]]; then
  echo ""
  echo "==================================================================="
  echo "[skill-queue-isolation] FAIL: ${#VIOLATIONS[@]} red-line violations detected"
  echo "==================================================================="
  for v in "${VIOLATIONS[@]}"; do
    echo "  - $v"
  done
  echo ""
  echo "If bypassing is required (emergency only), set SKIP_SKILL_QUEUE_ISOLATION=1, but the reviewer must +2"
  echo "Refer to ADR: docs/design/2026-06-16-skill-extract-queue.md / 2026-06-16-skill-storage-adapter.md"
  exit 1
fi

echo "[skill-queue-isolation] PASS"
exit 0
