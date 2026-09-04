# Codex asset import

Import this machine's Codex **skill / session** into Memory Hub. This manual is sufficient to complete it.


Data root `$CODEX_HOME` (default `~/.codex`).

What to sweep?

| Type | Path |
|---|---|
| Skill | USER `$HOME/.agents/skills/*/SKILL.md`; from `.agents/skills` from git root to cwd; ADMIN `/etc/codex/skills` |
| Session | `$CODEX_HOME/sessions/**/*.jsonl`（`YYYY/MM/DD/rollout-*.jsonl`） |

Skip: `~/.codex/skills`, top-level `skills/` in the repo, `plugins/cache`, and `memories/` inside the repo.

`--sessions <dir>` can scan `.jsonl` and Responses `.json`. If `--sessions` is not provided, it will automatically scan `$CODEX_HOME/sessions`.

## Preamble

Execute in the repository root. Requires Node >= 22, and:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<the sk-mem-... of the agent owner>
# Optional: export CODEX_HOME=/path/to/.codex
```

`--agent-id` / `--team-id` are required; owner must equal `TDAI_USER_KEY` to look up the user.

Usage

The unified entry point is the repository root `agents/asset-import.ts`. Use `--source codex` to specify the IDE corresponding to this manual; if omitted, it defaults to `auto` to automatically detect the IDE used in the current workspace.

```bash
# Interactive Import: List items to import first — skill (number/name/description/source/number of related scripts), session (id/time range/project path), then select "Import All / Do Not Import / Import Partially" (for partial import, enter numbers or IDs separated by commas/spaces, can be multiple)
tsx agents/asset-import.ts --source codex --agent-id <id> --team-id <tid>

# Non-interactive (script/CI, direct full import, no prompts)
tsx agents/asset-import.ts --source codex --agent-id <id> --team-id <tid> -y

Specify project directory
tsx agents/asset-import.ts --source codex --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Specify historical session directory/file (override automatic scanning)
tsx agents/asset-import.ts --source codex --sessions /path/to/sessions --agent-id <id> --team-id <tid>

# Re-import (ignore resume, re-import already imported items)
tsx agents/asset-import.ts --source codex --agent-id <id> --team-id <tid> --force

```



