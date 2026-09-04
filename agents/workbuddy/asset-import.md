# WorkBuddy Asset Import

Import the **skill / session** of the local WorkBuddy into Memory Hub. This manual is sufficient to complete it.

Desktop data directory defaults to `~/.workbuddy`.

What to sweep?

| Type | Path |
|---|---|
| Skill | `~/.workbuddy/skills/*/SKILL.md`; project `.workbuddy/skills` or `workbuddy/skills` |
| Session | jsonl of OpenAI-style messages in the project |

`--workspace` changes the project-side path to this directory (does not exclude the global `~/.workbuddy`).

## Preamble

Execute in the repository root. Requires Node >= 22, and:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<the agent owner's sk-mem-...>
```

`--agent-id` / `--team-id` are required; owner must equal `TDAI_USER_KEY` to look up the user.

Usage

The unified entry point is the repository root `agents/asset-import.ts`. Use `--source workbuddy` to specify the IDE corresponding to this manual; when omitted, it defaults to `auto` to automatically identify the IDE used in the current workspace.

```bash
# Interactive Import: List items to import first — skill (number/name/description/source/number of related scripts), session (id/time range/project path), then select "Import All / Do Not Import / Import Partially" (for partial import, enter numbers or IDs separated by commas or spaces, can be multiple)
tsx agents/asset-import.ts --source workbuddy --agent-id <id> --team-id <tid>

# Non-interactive (script/CI, direct full import, no prompts)
tsx agents/asset-import.ts --source workbuddy --agent-id <id> --team-id <tid> -y

Specify project directory
tsx agents/asset-import.ts --source workbuddy --workspace /path/to/project --agent-id <id> --team-id <tid>

# Re-import (ignore resume, re-import already imported items)
tsx agents/asset-import.ts --source workbuddy --agent-id <id> --team-id <tid> --force

```


