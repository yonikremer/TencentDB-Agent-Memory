# Claude Code Asset Import

Import local Claude Code **skill / session** data into Memory Hub. This guide completes the process.

## What to Scan

| Type   | Path |
|--------|------|
| Skill   | `~/.claude/skills/*/SKILL.md`; project `./claude/skills/*/SKILL.md` |
| Session | `~/.claude/projects/*/*.jsonl` |

Use `--workspace` to point to the project-specific directory (global `~/.claude` is also possible).

## Prerequisites

Run from the repository root. Requires Node >= 22 and the following environment variables:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<agent owner sk-mem-...>
```

`--agent-id` and `--team-id` are required; the owner must match `TDAI_USER_KEY`.

## Usage

The entry point is `agents/asset-import.ts` at the repo root. Use `--source claude-code` to target this IDE; omit for `auto` detection.

```bash
# Interactive import: list items (skill: number/name/description/source/associated scripts; session: id/time range/project path), then choose "full / none / partial" (partial accepts numbers or IDs, comma/space separated, multiple allowed)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid>

# Non‑interactive (script/CI, full import without prompts)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid> -y

# Specify project directory
tsx agents/asset-import.ts --source claude-code --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Re‑import (ignore checkpoints, re‑import already imported items)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid> --force
```

Import this machine's Claude Code **skill / session** into Memory Hub. This manual is sufficient to complete it.


What to sweep?

| Type | Path |
|---|---|
| Skill | `~/.claude/skills/*/SKILL.md`; project `<cwd>/.claude/skills/*/SKILL.md` |
| Session | `~/.claude/projects/*/*.jsonl` |

`--workspace` changes the project-side path to this directory (without excluding the global `~/.claude`).

## Preamble

Execute in the repository root. Requires Node >= 22, and:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<the agent owner's sk-mem-...>
```

`--agent-id` / `--team-id` are required; owner must equal `TDAI_USER_KEY` to look up the user.

Usage

The unified entry point is the repository root `agents/asset-import.ts`. Use `--source claude-code` to specify the IDE corresponding to this manual; when omitted, it defaults to `auto` to automatically detect the IDE used in the current workspace.

```bash
# Interactive Import: List items to import first — skill (number/name/description/source/number of related scripts), session (id/time range/project path), then select "Import All / Do Not Import / Import Partially" (for partial import, enter numbers or IDs separated by commas/spaces, can be multiple)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid>

# Non-interactive (script/CI, direct full import, no prompts)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid> -y

# Specified project directory
tsx agents/asset-import.ts --source claude-code --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Re-import (ignore resume, re-import already imported items)
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid> --force

```


