# CodeBuddy Asset Import

Import this machine's CodeBuddy **skill / session** into Memory Hub. This manual is sufficient to complete it.


What to sweep?

| Type | Path |
|---|---|
| Skill | `~/.codebuddy/skills/*/SKILL.md`; project `<cwd>/.codebuddy/skills/*/SKILL.md` |
| Session | `~/.codebuddy/projects/<project>/*.jsonl` |

`--workspace` changes the project path to this directory (does not exclude the global `~/.codebuddy`).

## Preamble

Execute in the repository root. Requires Node >= 22, and:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<the agent owner's sk-mem-...>
```

`--agent-id` / `--team-id` are required; owner must equal `TDAI_USER_KEY` to look up the user.

Usage

The unified entry point is the repository root `agents/asset-import.ts`. Use `--source codebuddy` to specify the IDE corresponding to this manual; when omitted, it defaults to `auto` to automatically identify the IDE used in the current workspace.

```bash
# Interactive Import: List items to import first — skill (ID/Name/Description/Source/Number of related scripts), session (ID/Time range/Project path), then select "Import All / Do Not Import / Import Partially" (for partial import, enter IDs or numbers separated by commas/spaces, can be multiple)
tsx agents/asset-import.ts --source codebuddy --agent-id <id> --team-id <tid>

# Non-interactive (script/CI, direct full import, no prompts)
tsx agents/asset-import.ts --source codebuddy --agent-id <id> --team-id <tid> -y

Specify project directory
tsx agents/asset-import.ts --source codebuddy --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Re-import (ignore resume, re-import already imported items)
tsx agents/asset-import.ts --source codebuddy --agent-id <id> --team-id <tid> --force

```



