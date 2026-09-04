/**
 * mem:help — Returns the list of supported commands and examples
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";

const HELP_TEXT = `## Supported mem: Commands

| Command | Description |
|------|------|
| \`mem:session-reset\` | Reset the team/Agent/task binding for this session, immediately popping up to re-select |
| \`mem:sync\` | Refresh all asset injections for this session (Skill / Memory / Knowledge / Task & Agent descriptions) |
| \`mem:create-skill [prompt]\` | Archive this conversation into a Skill, extracting asynchronously in the background |
| \`mem:create-task [title]\` | Create a Task from the current session context and bind it to this session |
| \`mem:update-task [new_description]\` | Update the description of the bound Task |
| \`mem:help\` | Show this help |

---

### 🆕 \`mem:create-task\` — Create and bind a Task

**Usage**
- **No parameters**: LLM infers title + description from the recent conversation
- **With parameters**: Parameter is used as the title (truncated at 40 chars), LLM only generates the description

**If a real Task is already bound to this session**, returns a preview of the new Task, reply with one of the following:

| Reply | Effect |
|------|------|
| \`mem:create-task confirm\` | ✅ Overwrite binding, create a new Task |
| \`mem:update-task\` or \`mem:update-task <new_description>\` | ⭐ **Recommended** — Continue reusing the current Task, just update the description |
| \`mem:create-task cancel\` | 🚫 Cancel, no changes made |

---

### ✏️ \`mem:update-task\` — Update current Task description

**Usage**
- **No parameters**: LLM compares "current description + recent conversation" to generate a new description
  - If no substantial changes → Returns ℹ️ No update needed (idempotent, safe to retry)
  - If changes found → Returns a preview
- **With parameters**: Parameter is used directly as the new description (skips LLM), returns a preview

**Confirm preview**:
- ✅ \`mem:update-task confirm\` — Confirm
- 🚫 \`mem:update-task cancel\` — Cancel

**Protection Rules**:
- If no Task is bound to this session → Intercepted, prompting to execute \`mem:create-task\` first
- If the bound Task wasn't created by you → Refuses update (cross-user modification not supported), suggests using \`mem:create-task\` to create one belonging to you

---

### Examples

\`\`\`
mem:sync
mem:create-skill Highlight the database migration steps and pitfalls
mem:create-task Refactor SessionRegistrar
mem:create-task confirm
mem:create-task cancel
mem:update-task Add today's completed progress and remaining risks
mem:update-task confirm
mem:update-task cancel
mem:session-reset
mem:help
\`\`\`

> Standard format is \`mem:<command>\`, no spaces after the colon. Command names are case-insensitive.`;

export function getHelpText(): string {
  return HELP_TEXT;
}

export async function executeHelp(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const response = buildMemResponse(HELP_TEXT, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });
  return {
    success: true,
    messageText: HELP_TEXT,
    response,
  };
}
