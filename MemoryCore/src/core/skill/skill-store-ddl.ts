/**
 * DDL Constants — Skill Data Layer v2 Refactor
 *
 * See `docs/design/2026-06-17-skill-redesign-v2.md` §2.1 / §2.2 for details.
 *
 * Physical objects belonging to this module:
 *   - skills      — main table, each row = (skill_id, version) immutable snapshot
 *   - skill_fts   — fts5 virtual table (based on head row's name/description/content)
 *   - skill_vec   — vec0 virtual table (created only when dimensions > 0)
 *
 * Intentionally NOT created in this DDL:
 *   - skill_bindings / task_skill_drafts / task_floating_skills / task_fixed_skills (binding/draft/floating concepts moved down to control plane)
 *   - skill_resources (manifest consolidated into skills.manifest_json column)
 *   - assets / task_asset_bindings (global asset system not stored in data plane)
 */

// ═════════════════════════════════════════════════════════════════════
//  skills main table — single table with multiple rows and versions
// ═════════════════════════════════════════════════════════════════════

export const SKILLS_DDL = `
  CREATE TABLE IF NOT EXISTS skills (
    row_id          TEXT PRIMARY KEY,
    skill_id        TEXT NOT NULL,
    version         INTEGER NOT NULL,
    is_head         INTEGER NOT NULL DEFAULT 1,

    user_id         TEXT NOT NULL,
    owner_agent_id  TEXT NOT NULL,
    team_id         TEXT NOT NULL,
    task_id         TEXT NOT NULL DEFAULT '',

    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    manifest_json   TEXT NOT NULL DEFAULT '[]',
    storage_dir     TEXT NOT NULL,

    status          TEXT NOT NULL DEFAULT 'active',
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at_ms   INTEGER NOT NULL,
    updated_at_ms   INTEGER NOT NULL,

    UNIQUE(skill_id, version)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uniq_skills_team_agent_name_head
    ON skills(team_id, owner_agent_id, name) WHERE is_head=1 AND status='active';

  CREATE INDEX IF NOT EXISTS idx_skills_team_head
    ON skills(team_id, is_head, status);

  CREATE INDEX IF NOT EXISTS idx_skills_owner_head
    ON skills(owner_agent_id, is_head, status);

  CREATE INDEX IF NOT EXISTS idx_skills_user
    ON skills(user_id, is_head);

  CREATE INDEX IF NOT EXISTS idx_skills_skill_version
    ON skills(skill_id, version DESC);

  CREATE INDEX IF NOT EXISTS idx_skills_task_audit
    ON skills(task_id, created_at_ms DESC);
`;

// ═════════════════════════════════════════════════════════════════════
//  skill_fts — FTS5 virtual table (indexes head rows only)
// ═════════════════════════════════════════════════════════════════════

export const SKILL_FTS_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS skill_fts USING fts5(
    name,
    description,
    content,
    skill_id UNINDEXED,
    team_id UNINDEXED,
    owner_agent_id UNINDEXED,
    task_id UNINDEXED,
    user_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 1'
  );
`;

// ═════════════════════════════════════════════════════════════════════
//  skill_vec — vec0 virtual table (caller executes when dimensions > 0)
// ═════════════════════════════════════════════════════════════════════

/**
 * `__DIM__` is replaced at init time with the actual dimension (e.g. 1536).
 */
export const SKILL_VEC_DDL_TEMPLATE = `
  CREATE VIRTUAL TABLE IF NOT EXISTS skill_vec USING vec0(
    skill_id TEXT PRIMARY KEY,
    embedding float[__DIM__] distance_metric=cosine
  );
`;

// ═════════════════════════════════════════════════════════════════════
//  Constants
// ═════════════════════════════════════════════════════════════════════

/** Maximum character count of content in FTS index (prevents giant SKILL.md from bloating fts5). */
export const FTS_CONTENT_MAX = 4000;

