/**
 * useSkillsPanel —— The state and data logic for the Skills page.
 * The component layer only retains JSX rendering, with state and data logic centralized here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { assetsApi, agentsApi, type Asset } from '@/lib/teamApi';
import {
  listSkills,
  getSkill,
  deleteSkillV3,
  exportSkill,
  type SkillSummary,
} from '@/lib/api/skill-api';
import { getPanelSession } from '@/lib/panelSession';
import { useTeams } from '@/services';
import { useSkillDetailCache } from '@/services/use-skill-detail-cache';
import { tea } from '@/lib/tea-bridge';

export type Tab = 'team' | 'fixed';

export const TAB_I18N_KEY: Record<Tab, string> = {
  team: 'skills.scope.team',
  fixed: 'skills.scope.fixed',
};

export function useSkillsPanel() {
  const { t } = useTranslation();
  // Default display Agent assets (fixed) to prevent users from mistakenly thinking their assets are in "Team Assets"
  const [tab, setTab] = useState<Tab>('fixed');
  const { activeTeamId, activeTeam } = useTeams();
  const myUserId = getPanelSession()?.user?.user_id ?? '';
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [skills, setSkills] = useState<SkillSummary[]>([]);

  // team agent data —— a full pull, the frontend derives two copies, to avoid previously being
  // Send agent/list twice for 「name mapping (full)」 and 「my owner's agent (fixed dropdown)」:
  //   - agentNameMap: id→name of **all** agents in the team (others' will appear in team assets
  //     agent's skill, needs to be able to display the agent name it belongs to).
  //   - teamAgents: frontend filters out **my owner's agents** by owner_user_id === myUserId
  //     (fixed tab dropdown / import / fork used; agent private visibility semantics).
  const [teamAgents, setTeamAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [agentNameMap, setAgentNameMap] = useState<Record<string, string>>({});
  // agent list loading state: fixed tab depends on agent (dropdown + fetch skill by agent),
  // initial true makes the first screen show the loading state, avoiding the left list flashing empty state before switching to loading state during agent request.
  const [agentsLoading, setAgentsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!activeTeamId) {
      setAgentNameMap({});
      setTeamAgents([]);
      setAgentsLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setAgentsLoading(true);
    agentsApi
      .list(activeTeamId)
      .then((agents) => {
        if (cancelled) return;
        setAgentNameMap(Object.fromEntries(agents.map((a) => [a.agent_id, a.name])));
        setTeamAgents(
          agents
            .filter((a) => !!myUserId && a.owner_user_id === myUserId)
            .map((a) => ({ id: a.agent_id, name: a.name })),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        // agent loading failure is not fatal (list fallback displays agent_id), but a warning is still provided.
        tea.notify.error(err?.message || t('skills.notify.loadAgentsFailed'));
        setAgentNameMap({});
        setTeamAgents([]);
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTeamId, myUserId]);

  const [loading, setLoading] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showFork, setShowFork] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  // The visibility of each skill under the team tab (fetched from meta_assets), used for list badge display.
  // key = skill_id (=asset_id). Leave blank for the fixed tab.
  const [visibilityMap, setVisibilityMap] = useState<Record<string, Asset['visibility']>>({});

  // ── On-demand skill detail cache ──
  // The team tab list data source is asset/list-accessible, which does not include skill data fields such as version / owner_agent_id;
  // no longer concurrently calls getSkill() N times for each skill,
  // instead, it is fetched on demand and written to this cache only after the user selects it.
  const {
    applyCachedDetail,
    preload: preloadSkillDetail,
    cacheVersion,
  } = useSkillDetailCache(activeTeamId);

  // Apply cache to skills list: update already-fetched skills to their real version / owner_agent_id.
  const skillsWithCache = useMemo(
    () => skills.map((s) => applyCachedDetail(s)),
    [skills, cacheVersion],
  );

  // Pre-fetch the data details of a selected skill on demand (idempotent, skip if already cached).
  // No list-level batch pre-fetching: sending getSkill() once per skill is wasteful,
  // details are loaded on demand only when the user opens them.
  useEffect(() => {
    if (selectedSkillId) void preloadSkillDetail(selectedSkillId);
  }, [selectedSkillId, preloadSkillDetail]);

  // ============================
  // Data fetching
  // ============================

  // Request sequence number anti-race: when quickly switching tabs/agents, requests sent first may return later,
  // Old tab data will overwrite new tab data.
  const refreshSeqRef = useRef(0);
  // The last refreshed team, used to distinguish between "switching teams" and "switching tabs / switching agents".
  // When switching teams, silently refresh (keep the old list until new data arrives), without blanking or skeleton screens;
  // When switching tabs / agents, still clear + loading according to the original logic (to avoid seeing the list from the previous tab).
  const prevTeamIdRef = useRef(activeTeamId);

  const refresh = useCallback(async () => {
    if (!activeTeamId) {
      setSkills([]);
      setVisibilityMap({});
      return;
    }
    const seq = ++refreshSeqRef.current;
    const teamChanged = prevTeamIdRef.current !== activeTeamId;
    prevTeamIdRef.current = activeTeamId;
    const silent = teamChanged;
    if (!silent) {
      setLoading(true);
      // Immediately clear old data —— otherwise switching tabs will first show the list from the previous tab,
      // and new data suddenly replaces it, visually appearing as a "flash".
      setSkills([]);
      setVisibilityMap({});
    }
    try {
      if (tab === 'team') {
        // Team asset tab semantics: **only display shared (visibility=team) skills**,
        // Private skills (including those owned by yourself) do not appear here. Your own private ones go to
        // View and manage the "My Assets Allocation" tab.
        //
        // Data source (strictly filtered by the server, you cannot get what you shouldn't see even via packet capture):
        //   asset/list-accessible + visibility='team'
        //     → The kernel SQL layer directly filters private, so the HTTP response body does not contain anyone's
        //       private, nor does it contain your own private, which is secure.
        //
        // Why not call skill/list:
        //    The data plane skill/list has no visibility concept, which will also include others' private
        //    return (although the kernel permission-checker will later intercept reads, but the list response
        //    Still returns metadata such as name/owner, frontend filtering = data already leaked).
        //
        // Load version / owner_agent_id on demand:
        //   asset table has no these two fields; the old implementation here concurrently runs N times for each skill
        //   getSkill() (N+1), fetching all details before the user opens any one.
        //   First render with the asset default value, with version/owner_agent_id and other user-selected
        //    only then is it fetched on demand by useSkillDetailCache and written to the cache.
        const accessible = await assetsApi.listAccessible(activeTeamId, {
          asset_type: 'skill',
          action: 'read',
          visibility: 'team',
        });
        if (seq !== refreshSeqRef.current) return; // has been replaced by a subsequent request
        const visMap: Record<string, Asset['visibility']> = {};
        for (const a of accessible) visMap[a.asset_id] = a.visibility;
        const toMs = (iso: string): number => new Date(iso).getTime();
        const items: SkillSummary[] = accessible.map((a) => ({
          skill_id: a.asset_id,
          name: a.name,
          description: a.description ?? '',
          version: a.version ?? 1,
          is_head: true,
          status: a.status === 'archived' ? 'archived' : 'active',
          owner_user_id: a.owner_user_id,
          owner_agent_id: '',
          team_id: a.team_id,
          task_id: '',
          created_at_ms: toMs(a.created_at),
          updated_at_ms: toMs(a.updated_at),
        })) as SkillSummary[];
        // No additional waiting; directly render using the asset default value, and automatically update after cache hit.
        setSkills(items);
        setVisibilityMap(visMap);
      } else {
        // Fixed assets = skills owned by the specified agent; this tab focuses on "what skills an agent is equipped with",
        // determined by the owner permission, without adding visibility filtering (an agent owner can always see their own skills).
        // meta_assets main table, written from the same source as assetsApi.update, with consistent read and write.
        if (!selectedAgent) {
          if (seq !== refreshSeqRef.current) return;
          setSkills([]);
          setVisibilityMap({});
        } else {
          const [listRes, accessible] = await Promise.all([
            listSkills({
              team_id: activeTeamId,
              filters: { owner_agent_id: selectedAgent, status: ['active'] },
              pagination: { limit: 200 },
            }),
            assetsApi
              .listAccessible(activeTeamId, { asset_type: 'skill', action: 'read' })
              .catch(() => [] as Asset[]),
          ]);
          if (seq !== refreshSeqRef.current) return; // has been replaced by a subsequent request
          const vm: Record<string, Asset['visibility']> = {};
          for (const a of accessible) vm[a.asset_id] = a.visibility;
          setSkills(listRes.items);
          setVisibilityMap(vm);
        }
      }
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      tea.notify.error(err);
      setSkills([]);
      setVisibilityMap({});
    } finally {
      if (seq === refreshSeqRef.current) setLoading(false);
    }
  }, [tab, selectedAgent, activeTeamId]);

  // Sync selectedAgent to teamAgents:
  //   - After switching teams, the old selectedAgent may no longer be in the new team, so it needs to be reset;
  //   - Also provide a default value for selectedAgent during the first render.
  useEffect(() => {
    if (teamAgents.length === 0) {
      if (selectedAgent) setSelectedAgent('');
      return;
    }
    if (!selectedAgent || !teamAgents.some((a) => a.id === selectedAgent)) {
      setSelectedAgent(teamAgents[0].id);
    }
  }, [teamAgents, selectedAgent]);

  // Trigger refresh: depends on the original parameters + refresh, and uses key to deduplicate to prevent repeated triggering in a short time.
  // Previously, directly `useEffect(() => refresh(), [refresh])` would trigger multiple times due to refresh reference changes
  // (such as dependencies like selectedAgent being asynchronously synchronized), causing interfaces like asset/list-accessible to be repeatedly requested.
  const fetchKeyRef = useRef<string>('');
  useEffect(() => {
    // Only fixed tabs are included in selectedAgent —— team tab's data source
    // asset/list-accessible is unrelated to the selected agent. If selectedAgent is included in the team's key,
    // after teamAgents is loaded asynchronously, selectedAgent will change from '' to the first agent, causing the key to change
    // and triggering another **completely duplicate** list-accessible (an extra API call is made upon page entry).
    const key =
      tab === 'fixed' ? `${activeTeamId}|${tab}|${selectedAgent}` : `${activeTeamId}|${tab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void refresh();
  }, [activeTeamId, tab, selectedAgent, refresh]);

  // Clear selection when the selected item is not in the list.
  // Skip the loading intermediate state: refresh first setsSkills([]) and then refetches,
  // If we judge at the moment of clearing, it will mistakenly clear the selection (refreshing after editing and saving will lose the current selection).
  // Wait until refresh is complete (loading=false) and the list is filled, then judge, and keep the selection if the selected item is still there.
  useEffect(() => {
    if (loading) return;
    if (selectedSkillId && !skillsWithCache.find((s) => s.skill_id === selectedSkillId)) {
      setSelectedSkillId(null);
    }
  }, [skillsWithCache, selectedSkillId, loading]);

  const selectedSkill = useMemo(
    () =>
      selectedSkillId
        ? (skillsWithCache.find((s) => s.skill_id === selectedSkillId) ?? null)
        : null,
    [selectedSkillId, skillsWithCache],
  );

  // ============================
  // Delete handler
  // ============================

  const handleDelete = useCallback(
    async (skill: SkillSummary) => {
      if (!activeTeamId) return;
      setDeleteLoading(true);
      try {
        // Data-plane soft delete requires owner_agent_id + expected_version optimistic locking.
        // The team tab data source comes from asset/list-accessible, and that data has no owner_agent_id
        // and version (the asset table has no these two fields), so skill.owner_agent_id in the list will be ''.
        // Here, we fetch skill/get once more as needed to fill it in.
        let ownerAgentId = skill.owner_agent_id;
        let version = skill.version;
        if (!ownerAgentId) {
          const full = await getSkill({
            skill_id: skill.skill_id,
            team_id: activeTeamId,
            include_content: false,
            include_manifest: false,
          });
          ownerAgentId = full.owner_agent_id;
          version = full.version;
        }
        await deleteSkillV3({
          user_id: myUserId,
          team_id: activeTeamId,
          agent_id: ownerAgentId,
          skill_id: skill.skill_id,
          expected_version: version,
        });
        if (selectedSkillId === skill.skill_id) {
          setSelectedSkillId(null);
        }
        tea.notify.success(t('skills.notify.deleted', { name: skill.name }));
        void refresh();
      } catch (err) {
        tea.notify.error(err);
      } finally {
        setDeleteLoading(false);
      }
    },
    [selectedSkillId, refresh, activeTeamId, myUserId],
  );

  // ============================
  // Export handler
  // ============================

  const handleExport = useCallback(async () => {
    const exportSkillId = selectedSkillId;
    if (!exportSkillId) return;
    setExportLoading(true);
    try {
      const result = await exportSkill({
        team_id: activeTeamId ?? '',
        skill_id: exportSkillId,
      });
      // base64 → Blob → download
      const byteChars = atob(result.zip_base64);
      const byteNums = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        byteNums[i] = byteChars.charCodeAt(i);
      }
      const blob = new Blob([new Uint8Array(byteNums)], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (result.warnings.length > 0) {
        tea.notify.warning(t('skills.export.partial', { warnings: result.warnings.join('; ') }));
      }
    } catch (err: unknown) {
      const errorName = err instanceof Error ? err.name : '';
      const msg =
        errorName === 'AbortError' || errorName === 'TimeoutError'
          ? t('skills.export.timeout')
          : (err instanceof Error ? err.message : String(err));
      tea.notify.error({ description: msg });
    } finally {
      setExportLoading(false);
    }
  }, [selectedSkillId, activeTeamId]);

  // ============================
  // Visibility toggle (shared/private)
  // ============================
  // Shared/Private switch: the capability of the original "Personal Assets" tab is migrated to the asset items of the "Agent Assets (fixed)" tab,
  // Only the owner can switch (the rendering location in SkillsPanel determines based on owner_user_id). skill_id === asset_id.
  const handleToggleVisibility = useCallback(
    async (skill: SkillSummary, scope: 'team' | 'private') => {
      const current = visibilityMap[skill.skill_id];
      // Fallback to private when current is missing: from the owner's perspective, getAssets does not filter,
      // so visibility can be obtained normally; if it is still missing (old data/interface exception),
      // it is also allowed to switch rather than directly returning, to avoid getting stuck and unable to switch back to team.
      if (current === scope) return;
      try {
        await assetsApi.update(skill.skill_id, { visibility: scope });
        // Locally update the visibility badge to avoid full-table flicker
        setVisibilityMap((prev) => ({ ...prev, [skill.skill_id]: scope }));
      } catch (err) {
        tea.notify.error(err);
      }
    },
    [visibilityMap],
  );

  // List loading state (used by the left AssetListPanel).
  // fixed tab depends on agent, so it needs to cover three "data not ready" periods, otherwise it will flash an empty state first:
  //   1) agentsLoading: agent list request in progress
  //   2) teamAgents ready but selectedAgent not yet set by effect gap
  //   3) loading: skill list request in progress based on agent
  // team tab does not depend on agent, directly uses skill list loading.
  const listLoading =
    tab === 'fixed'
      ? agentsLoading || loading || (teamAgents.length > 0 && !selectedAgent)
      : loading;

  return {
    // context
    activeTeam,
    activeTeamId,
    myUserId,
    teamAgents,
    agentNameMap,
    // state
    tab,
    setTab,
    selectedAgent,
    setSelectedAgent,
    skills,
    loading: listLoading,
    selectedSkillId,
    setSelectedSkillId,
    showImport,
    setShowImport,
    showFork,
    setShowFork,
    deleteLoading,
    exportLoading,
    visibilityMap,
    // cache
    skillsWithCache,
    preloadSkillDetail,
    applyCachedDetail,
    cacheVersion,
    // handlers
    refresh,
    handleDelete,
    handleExport,
    handleToggleVisibility,
    selectedSkill,
  };
}

export type SkillsStore = ReturnType<typeof useSkillsPanel>;
