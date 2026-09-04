# Hermes Asset Import

Import this machine's Hermes Agent **skill / session** into Memory Hub. This manual is sufficient to complete it.


Data root `$HERMES_HOME` (default `~/.hermes`). Session reads SQLite, requires **Node >= 22** (`node:sqlite`).

What to sweep?

**Skill** (Same name: globally overrides the built-in repository; subdirectories containing `SKILL.md`, allowing deeper categorization such as `mlops/inference/llama-cpp`)

| Priority | Path |
|---|---|
| 1 | `$HERMES_HOME/skills/<category>/<name>/SKILL.md` |
| 2 | `<hermes-agent repo>/skills/` |
| 3 | `<hermes-agent repo>/optional-skills/` |

Repository root: `HERMES_AGENT_ROOT`, otherwise `$HERMES_HOME/hermes-agent`. Also recognizes `HERMES_BUNDLED_SKILLS` / `HERMES_OPTIONAL_SKILLS`.

Do not scan nested `SKILL.md` in `.hermes/skills` / `.agents/skills`, `skills.external_dirs`, `.hub`, pending, `references/`.

**Memory**: No longer scans local files; memory is only extracted from Sessions (see below).

**Session**

| Storage | Path | Imported |
|---|---|---|
| Primary database | `$HERMES_HOME/state.db` | Yes: `sessions` metadata + `messages` `user`/`assistant` |
| Raw dump | `$HERMES_HOME/sessions/request_dump_*.json` | No |

Do not scan `session_{sid}.json`, `moa-traces/`. `--workspace` does not restrict session. Session scanning is skipped when below Node 22.

## Preamble

Execute in the repository root:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<the agent owner's sk-mem-...>
# Optional: HERMES_HOME / HERMES_AGENT_ROOT
```

`--agent-id` / `--team-id` are required. If the skill is in the repository `optional-skills/`, point `--workspace` to the root of the hermes-agent repository, or set `HERMES_AGENT_ROOT`.

Usage

The unified entry point is the repository root `agents/asset-import.ts`. Use `--source hermes` to specify the IDE corresponding to this manual; if omitted, it defaults to `auto` to automatically detect the IDE used in the current workspace.

```bash
# Interactive Import: List items to import first — skill (number/name/description/source/number of related scripts), session (id/time range/project path), then select "Import All / Do Not Import / Import Partially" (for partial import, enter numbers or IDs separated by commas/spaces, can be multiple)
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid>

# Non-interactive (script/CI, direct full import, no prompts)
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid> -y

Specify project directory
tsx agents/asset-import.ts --source hermes --workspace /path/to/hermes-agent --agent-id <id> --team-id <tid>

# Re-import (ignore resume, re-import already imported items)
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid> --force

```


