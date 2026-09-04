/**
 * SkillCoreSink — fallback asset registration for skill candidates
 * extracted by SkillConversationExtractWorker.
 *
 * ⚠️ Semantic clarification (fully aligned with the fallback path of the old `/v3/skill/extract` sync branch):
 *   SkillExtractor internally runs a tool-calling review agent — the agent directly calls
 *   `SkillCore.create` via the `create` tool in `<skill_tools>` to persist the skill.
 *   The candidate is merely an "after-the-fact receipt" (carrying skill_id / name / action="create").
 *
 *   Therefore, the sink **should NOT** call SkillCore.create again, as that would:
 *     1) Trigger SKILL_NAME_DUPLICATE for same-name/same-team conflicts
 *     2) The candidate's content field is typically absent (the extractor persists via tool-call args;
 *        the result payload only carries a skill_id / name summary)
 *
 *   The sink only performs fallback asset registration — in standalone mode, SkillVersioning has no
 *   onSkillCreated hook (to avoid coupling core to metadata), so the sink fills in the registration here;
 *   in service mode, buildSkillCore already has the hook registered, so this call to ensureSkillAsset
 *   is idempotent and serves as a double-safety net.
 */

import type { ExtractedCandidate, ExtractorLogger } from "../queue/types.js";
import type { SkillCandidatesSink } from "./extract-worker.js";

/** Aligned with the shape used by the gateway-side MetadataService (only ensureSkillAsset is needed). */
export interface MetadataServiceLike {
  ensureSkillAsset(input: {
    skill_id: string;
    team_id: string;
    agent_id: string;
    name: string;
  }): Promise<unknown>;
}

export interface SkillCoreSinkOptions {
  /** Optional — when a metadata service is present, performs fallback asset registration. When absent, the sink is a no-op. */
  metadata?: MetadataServiceLike;
  logger: ExtractorLogger;
}

/**
 * SkillCoreSink only performs fallback asset registration; it no longer calls create skill.
 * The skill itself was already persisted by SkillExtractor's tool-call review agent via SkillCore.create.
 */
export class SkillCoreSink implements SkillCandidatesSink {
  constructor(private readonly opts: SkillCoreSinkOptions) {}

  async applyCandidates(input: {
    task: {
      team_id: string;
      user_id: string;
      agent_id: string;
      task_ref_id?: string;
      session_id: string;
    };
    candidates: ExtractedCandidate[];
    workerId: string;
  }): Promise<void> {
    const { metadata, logger } = this.opts;
    const { task, candidates, workerId } = input;
    if (!candidates.length) return;
    if (!metadata) return; // No metadata → sink is a no-op (asset registration can only rely on hooks)

    for (const c of candidates) {
      if (c.action !== "create") {
        // Currently only asset-registering "create"; patch/update don't need re-registration (skill_id unchanged)
        continue;
      }
      const skillId = c.skill_id;
      const name = c.name;
      if (!skillId || !name) {
        logger.warn(
          `[skill-core-sink] worker=${workerId} candidate missing skill_id/name — skip asset register`,
        );
        continue;
      }
      try {
        await metadata.ensureSkillAsset({
          skill_id: skillId,
          team_id: task.team_id,
          agent_id: task.agent_id,
          name,
        });
      } catch (err) {
        // Asset registration failure does not affect the main flow — the skill is already in the skills table;
        // the frontend management page may not display it, but ops can re-register later.
        logger.warn(
          `[skill-core-sink] worker=${workerId} ensureSkillAsset failed skill_id=${skillId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }
}
