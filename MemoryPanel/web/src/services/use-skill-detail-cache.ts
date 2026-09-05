/**
 * useSkillDetailCache — Load skill data detail cache on demand.
 *
 * Background: The asset list returned by the asset/list-accessible interface only contains asset-layer fields
 * (version is always 1, and there is no owner_agent_id); the real version and
 * owner_agent_id of the skill data face need to be obtained by calling getSkill()
 * The old implementation, after loading the list, concurrently called getSkill() N times (N+1) for each skill, pulling all the details back before the user even opened any of them.
 *
 * This hook is now on-demand: the list is first rendered with the default values from the asset layer, when the user selects a skill
 * then pull the data details for that record and write them to the cache, and subsequent hits of the same skill read directly from the cache.
 *
 * Usage (parent component):
 *   const { getFromCache, preload, applyCachedDetail } = useSkillDetailCache(activeTeamId);
 *   useEffect(() => { if (selectedId) void preload(selectedId); }, [selectedId]);
 *    List rendering: const s = applyCachedDetail(skill);
 */

import { useRef, useState, useCallback } from 'react';
import { getSkill } from '@/lib/api/skill-api';

export interface CachedSkillDetail {
  version: number;
  owner_agent_id: string;
}

export function useSkillDetailCache(teamId: string | null | undefined) {
  /** skill_id → fetched data plane details (version + owner_agent_id). */
  const cacheRef = useRef(new Map<string, CachedSkillDetail>());

  /** The set of skill_ids currently being requested, to prevent concurrent duplicate requests for the same skill. */
  const inFlightRef = useRef(new Set<string>());

  /** Increment by 1 after each cache write; the parent component uses this value to recompute list items in useMemo. */
  const [cacheVersion, setCacheVersion] = useState(0);

  /** Synchronously read cache (does not trigger a request). */
  const getFromCache = useCallback((skillId: string): CachedSkillDetail | undefined => {
    return cacheRef.current.get(skillId);
  }, []);

  /** Preload the data details of a skill (idempotent; skip directly if already cached or being requested). */
  const preload = useCallback(async (skillId: string) => {
    if (!teamId || !skillId) return;
    if (cacheRef.current.has(skillId) || inFlightRef.current.has(skillId)) return;
    inFlightRef.current.add(skillId);
    try {
      const full = await getSkill({
        skill_id: skillId,
        team_id: teamId,
        include_content: false,
        include_manifest: false,
      });
      cacheRef.current.set(skillId, {
        version: full.version,
        owner_agent_id: full.owner_agent_id,
      });
      setCacheVersion((n) => n + 1);
    } catch {
      // Silent failure: list still uses asset default value (v1 / empty owner_agent_id)
    } finally {
      inFlightRef.current.delete(skillId);
    }
  }, [teamId]);

  /**
   * Overwrite the `version` and `owner_agent_id` fields of the skill object with the latest value from the cache.
   * Return as-is on cache miss, without affecting rendering.
   */
  const applyCachedDetail = useCallback(<T extends { skill_id: string; version: number; owner_agent_id: string }>(
    skill: T,
  ): T => {
    const cached = cacheRef.current.get(skill.skill_id);
    if (!cached) return skill;
    return { ...skill, version: cached.version, owner_agent_id: cached.owner_agent_id };
  }, []);

  return { getFromCache, preload, applyCachedDetail, cacheRef, cacheVersion };
}
