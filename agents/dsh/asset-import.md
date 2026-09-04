# DeepSeek Harness Asset Import

Import the **skill / session** of the local dsh into Memory Hub. This manual is sufficient to complete it.

Data root `$DSH_HOME` (default `~/.dsh`). Project root = nearest ancestor containing `.git`, or `--workspace` / cwd if not found.

What to sweep?

**Skill** (same name, lower rank number takes priority; scan only one level, do not recursively scan `**/SKILL.md`)

| Rank | Path |
|---|---|
| 100 | `<project root>/.dsh/skills/` |
| 200 | `<project root>/.agents/skills/` |
| 300 | `customSkillDirs` of `settings.yaml`, or `DSH_CUSTOM_SKILL_DIRS` |
| 400 | `$DSH_HOME/skills/` (skip `.system`) |
| 500 | `~/.agents/skills/` (root can be changed via `DSH_AGENTS_HOME`) |
| 600 | `$DSH_BUNDLED_SKILL_DIR` / settings `bundledSkillDir` (skip if not configured) |

Directory-style `<name>/SKILL.md` or flat `<name>.md`.

**Memory**: No longer scans local files; memory is only extracted from Sessions (see below).

**Session**

Recursively `$DSH_HOME/sessions/**/session.jsonl.zstd` (or `session.jsonl` if uncompressed). `--workspace` does not affect sessions; `--sessions` can change the scan root. Only parse `user/message` + `assistant/message`, and skip empty sessions.

## Preamble

Execute in the repository root. Requires Node >= 22, and:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<the sk-mem-... of the agent owner>
# Optional: DSH_HOME / DSH_AGENTS_HOME / DSH_CUSTOM_SKILL_DIRS / DSH_BUNDLED_SKILL_DIR
```

`--agent-id` / `--team-id` are required.

Usage

The unified entry point is the repository root `agents/asset-import.ts`. Use `--source dsh` to specify the IDE corresponding to this manual; when omitted, it defaults to `auto` to automatically detect the IDE used in the current workspace.

```bash
# Interactive import: first list the items to import — skill (number/name/description/source/number of related scripts), session (id/time range/project path), then select "import all / do not import / import partially" (for partial import, enter numbers or IDs separated by commas or spaces, can be multiple)
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid>

# Non-interactive (script/CI, direct full import, no prompts)
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid> -y

Specify project directory
tsx agents/asset-import.ts --source dsh --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Re-import (ignore resume, re-import already imported items)
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid> --force

```


