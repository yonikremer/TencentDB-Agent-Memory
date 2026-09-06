/**
 * skill-fork-flow.test.ts — guide section 3.1 as executable contract.
 *
 * Sharing a skill = fork: re-create the same SKILL.md under each target
 * agent (runtime injection filters by owner_agent_id; ACL does not mount).
 * Drives the real gateway handlers (create/get/list/delete) over a real
 * SkillCore (SQLite temp + local storage backend). No metadata service
 * attached (asset auto-register skipped), no LLM involved.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteSkillStore } from "../core/skill/skill-store.js";
import { SkillResourceStore } from "../core/skill/skill-resource-store.js";
import { SkillVersioning } from "../core/skill/skill-versioning.js";
import { SkillCore } from "../core/skill/skill-core.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { handleCreate, handleGet, handleList, handleDelete } from "./skill-handlers.js";
import type { SkillRouterDeps } from "./skill-handlers.js";

const TEAM = "team-fork-1";
const AGENT_A = "agt-fork-a";
const AGENT_B = "agt-fork-b";
const USER = "usr-fork-1";
const CONTENT =
  "---\nname: playbook\ndescription: Team playbook.\n---\n\n# Playbook\n\nFollow the steps.\n";

let tmp = "";
let db: DatabaseSync;
let deps: SkillRouterDeps;
const auth = { apiKey: "k", serviceId: "svc-fork-1" } as any;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "skill-fork-"));
  db = new DatabaseSync(join(tmp, "skills.db"));
  const store = new SqliteSkillStore({ db });
  store.init();
  const storage = new StorageAdapter(new LocalStorageBackend(join(tmp, "storage")) as any) as any;
  const resources = new SkillResourceStore({ storage });
  const versioning = new SkillVersioning({ store, resources, storage });
  const core = new SkillCore({ store, resources, versioning });
  const noop = () => {};
  deps = { getSkillCore: () => core, logger: { debug: noop, info: noop, warn: noop, error: noop } as any } as SkillRouterDeps;
});

afterAll(() => {
  try { db.close(); } catch { /* ignore */ }
  rmSync(tmp, { recursive: true, force: true });
});

describe("guide 3.1: fork shares skill across agents", () => {
  let srcId = "";
  let forkId = "";

  it("create on owner agent", async () => {
    const r = await handleCreate(
      { user_id: USER, team_id: TEAM, agent_id: AGENT_A, name: "playbook", content: CONTENT },
      auth, "req-1", deps,
    );
    expect(r.code).toBe(0);
    srcId = (r.data as any).skill_id;
    expect((r.data as any).owner_agent_id).toBe(AGENT_A);
  });

  it("same name under SAME agent rejected (duplicate)", async () => {
    const r = await handleCreate(
      { user_id: USER, team_id: TEAM, agent_id: AGENT_A, name: "playbook", content: CONTENT },
      auth, "req-2", deps,
    );
    expect(r.code).not.toBe(0);
  });

  it("fork: same name+content under teammate agent gets own skill_id", async () => {
    const src = await handleGet(
      { user_id: USER, team_id: TEAM, skill_id: srcId, include_content: true },
      auth, "req-3", deps,
    );
    expect(src.code).toBe(0);
    const r = await handleCreate(
      {
        user_id: USER, team_id: TEAM, agent_id: AGENT_B, name: "playbook",
        content: (src.data as any).content,
        metadata: { forked_from: { skill_id: srcId, name: "playbook" } },
      },
      auth, "req-4", deps,
    );
    expect(r.code).toBe(0);
    forkId = (r.data as any).skill_id;
    expect(forkId).not.toBe(srcId);
    expect((r.data as any).owner_agent_id).toBe(AGENT_B);
  });

  it("list by owner_agent_id shows each copy on its own agent", async () => {
    const a = await handleList(
      { user_id: USER, team_id: TEAM, filters: { owner_agent_id: AGENT_A }, pagination: { limit: 10, offset: 0 } },
      auth, "req-5", deps,
    );
    const b = await handleList(
      { user_id: USER, team_id: TEAM, filters: { owner_agent_id: AGENT_B }, pagination: { limit: 10, offset: 0 } },
      auth, "req-6", deps,
    );
    expect((a.data as any).items.map((s: any) => s.skill_id)).toContain(srcId);
    expect((b.data as any).items.map((s: any) => s.skill_id)).toContain(forkId);
    expect((b.data as any).items.map((s: any) => s.skill_id)).not.toContain(srcId);
  });

  it("delete archives with optimistic lock", async () => {
    const d = await handleDelete(
      { user_id: USER, team_id: TEAM, agent_id: AGENT_B, skill_id: forkId, expected_version: 1 },
      auth, "req-7", deps,
    );
    expect(d.code).toBe(0);
    expect((d.data as any).archived).toBe(true);
  });
});
