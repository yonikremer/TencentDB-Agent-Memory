/**
 * src/core/skill/queue/index.ts
 *
 * Interface types barrel for the Skill extraction module. The old job queue (LocalSkillTaskQueue /
 * RedisSkillTaskQueue / SkillExtractWorkerV2 / SkillExtractJob etc.) was deleted in the
 * 2026-07-17 skill_extract → direct archive refactor, the extraction pipeline now entirely goes through
 * SkillTriggerService + SkillConversationExtractWorker + SkillAgentTaskQueue under `src/core/skill/conversation-add/`.
 *
 * This module only retains Worker/extractor interface layer types (ConversationMessage /
 * ExtractedCandidate / ISkillExtractor / ExtractorLogger), for reuse by
 * conversation-add/extract-worker.ts and skill-extractor.ts.
 */

export type {
  ConversationMessage,
  ExtractedCandidate,
  ISkillExtractor,
  ExtractorLogger,
} from "./types.js";
