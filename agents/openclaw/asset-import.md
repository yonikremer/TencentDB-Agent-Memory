# OpenClaw Asset Import

Import the local open-source OpenClaw **skill / session** into Memory Hub. This manual is sufficient to complete it.


It scans the client's native data, not this project's `~/.openclaw/context-offload/*`.

What to sweep?

**Skill** (Same name as: User-defined override system overriding built-in)

| Priority | Path |
|---|---|
| 1 | `~/.agents/skills/<name>/SKILL.md` |
| 2 | `~/npm-global/lib/node_modules/openclaw/skills/<name>/SKILL.md` |

With `scripts/` `references/` `assets/` `agents/`. Do not scan workspace / `~/.openclaw/skills` / extraDirs.

**Memory**: No longer scans local files; memory is only extracted from Sessions (see below).

**Session**(`$OPENCLAW_STATE_DIR/agents/<id>/sessions/`, default `~/.openclaw`)

Import the next layer `<sessionId>.jsonl`. Do not scan `sessions.json`, `*.trajectory.jsonl`, `*.lock`, sqlite.

## Preamble

Execute in the repository root. Requires Node >= 22, and:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<the sk-mem-... of the agent owner>
# Optional: OPENCLAW_STATE_DIR / OPENCLAW_WORKSPACE_DIR
```

`--agent-id` / `--team-id` are required; owner must equal `TDAI_USER_KEY` to look up the user.

Usage

The unified entry point is the repository root `agents/asset-import.ts`. Use `--source openclaw` to specify the IDE corresponding to this manual; when omitted, it defaults to `auto` to automatically identify the IDE used in the current workspace.

```bash
# Interactive Import: List items to import first — skill (number/name/description/source/number of related scripts), session (id/time range/project path), then select "Import All / Do Not Import / Import Partially" (for partial import, enter numbers or IDs separated by commas/spaces, can be multiple)
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid>

# Non-interactive (script/CI, direct full import, no prompts)
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid> -y

Specify project directory
tsx agents/asset-import.ts --source openclaw --workspace /path/to/workspace --agent-id <id> --team-id <tid>

# Re-import (ignore resume, re-import already imported items)
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid> --force

```


