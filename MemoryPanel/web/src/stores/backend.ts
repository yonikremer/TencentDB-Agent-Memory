/**
 * stores/backend.ts — Global backend data store (zustand).
 *
 * Replace the module-level variables in backendStore.ts (_cachedTeams / _cachedAgentsMap / _inflightTeams …).
 *
 * Core design:
 *   - teamsLoaded / agentsLoadedTeamIds: mark "loaded",
 *     to avoid repeated fetch on every component mount.
 *   - invalidate(): called after write operations, clears all caches + broadcasts BACKEND_REFRESH_EVENT.
 *   - invalidateTeam(teamId): called when switching teams, only clears the current team's agents/tasks cache.
 *   - useTeams / useAgents / useTasks: read data from the store + trigger fetch, multiple components share the same state.
 */

import { create } from 'zustand';
import { useEffect, useState } from 'react';
import {
  teamsApi,
  membersApi,
  agentsApi,
  tasksApi,
  type TeamMember as BackendMember,
} from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import i18n from '@/i18n';
import { seedDisplayNameCache } from '@/services/user-profile-store';

// re-import pure functions (adapters / types) from backendStore.ts to avoid circular dependencies
import {
  type Team,
  type Agent,
  type Task,
  adaptTeam,
  adaptMember,
  adaptAgent,
  adaptTask,
  readActiveTeamId,
  writeActiveTeamId,
  ensureValidActiveTeamId,
} from '@/services/backendStore';

// ========================= Event Constants =========================

const BACKEND_REFRESH_EVENT = 'tdai-memory.backend-refresh';
const LOCAL_CHANGE_EVENT = 'tdai-memory.demo-store-change';

function emitBackendRefresh() {
  try { window.dispatchEvent(new Event(BACKEND_REFRESH_EVENT)); } catch { /* ignore */ }
}

// ========================= Store Type =========================

interface BackendState {
  // Data
  teams: Team[];
  activeTeamId: string | null;
  agentsByTeam: Record<string, Agent[]>;
  // Total count (total returned by the kernel), used by the frontend pagination to calculate the total number of pages
  tasksTotalByTeam: Record<string, number>;
  // Backend pagination cache: tasksPagesByTeam[teamId]["offset:limit"] = Task[]
  tasksPagesByTeam: Record<string, Record<string, Task[]>>;
  // loaded marker (to avoid repeated fetch)
  teamsLoaded: boolean;
  teamsLoading: boolean;
  agentsLoadedTeamIds: Set<string>;
  // in-flight deduplication
  inflightTeams: Promise<void> | null;
  inflightAgents: Record<string, Promise<Agent[]>>;
  inflightTasks: Record<string, Promise<Task[]> | undefined>;

  // actions
  fetchTeams: () => Promise<void>;
  /**
   * Force re-fetch of team list (ignore teamsLoaded cache, preserve in-flight deduplication).
   * `silent: true` does not flip teamsLoading at the UI layer —— used for background keeping fresh when expanding dropdowns
   * Scenario, avoid consumers such as TeamManagementPanel from entirely entering due to teamsLoading=true
   * loading placeholder (manifesting as "the dropdown page refreshes when you click once")
   */
  refreshTeams: (opts?: { silent?: boolean }) => Promise<void>;
  fetchAgents: (teamId: string) => Promise<Agent[]>;
  fetchTasks: (teamId: string, params?: { limit?: number; offset?: number; force?: boolean }) => Promise<Task[]>;
  setActiveTeamId: (teamId: string | null) => void;
  invalidate: () => void;
  invalidateTeam: (teamId: string) => void;
  clearAll: () => void;
}

// ========================= Store Implementation =========================

export const useBackendStore = create<BackendState>((set, get) => ({
  teams: [],
  activeTeamId: readActiveTeamId(),
  agentsByTeam: {},
  tasksTotalByTeam: {},
  tasksPagesByTeam: {},
  teamsLoaded: false,
  teamsLoading: false,
  agentsLoadedTeamIds: new Set(),
  inflightTeams: null,
  inflightAgents: {},
  inflightTasks: {},

  fetchTeams: async () => {
    const state = get();
    // Already loaded → no repeated fetch (only refetches after invalidate / clearAll)
    if (state.teamsLoaded) return;
    await get().refreshTeams();
  },

  refreshTeams: async (opts?: { silent?: boolean }) => {
    const state = get();
    // in-flight deduplication: only send once when multiple components mount simultaneously
    if (state.inflightTeams) { await state.inflightTeams; return; }

    const silent = opts?.silent === true;
    const promise = (async () => {
      // Silently refresh without flipping teamsLoading —— Consumers (such as TeamManagementPanel) depend on it
      // Display loading placeholder; flipping it in background-freshness scenarios like dropdown expansion causes
      // "Clicking the dropdown makes the entire page flash to loading and then recover".
      if (!silent) set({ teamsLoading: true });
      try {
        const backendTeams = await teamsApi.list();
        // Batch fetch members (N+1 → N, but this is a backend API limitation, no batch interface)
        const memberResults = await Promise.all(
          backendTeams.map((t) => membersApi.list(t.team_id).catch(() => [] as BackendMember[]))
        );
        const adapted = backendTeams.map((bt, i) =>
          adaptTeam(bt, memberResults[i].map(adaptMember))
        );
        seedDisplayNameCache(adapted.flatMap((t) => t.members));
        ensureValidActiveTeamId(adapted);
        set({
          teams: adapted,
          teamsLoaded: true,
          teamsLoading: false,
          activeTeamId: readActiveTeamId(),
        });
      } catch (err) {
        console.error('[backend store] refreshTeams failed:', err);
        set({ teamsLoading: false });
        tea.notify.error(i18n.t('backend.loadTeamsFailed'));
      } finally {
        set({ inflightTeams: null });
      }
    })();

    set({ inflightTeams: promise });
    await promise;
  },

  fetchAgents: async (teamId: string) => {
    const state = get();
    // Already loaded → return cache directly
    if (state.agentsLoadedTeamIds.has(teamId)) {
      return state.agentsByTeam[teamId] ?? [];
    }
    // in-flight deduplication
    if (state.inflightAgents[teamId] != null) {
      return state.inflightAgents[teamId];
    }

    const promise = (async () => {
      try {
        const backendAgents = await agentsApi.list(teamId);
        const adapted = backendAgents.map((ba, i) => adaptAgent(ba, i));
        set((s) => ({
          agentsByTeam: { ...s.agentsByTeam, [teamId]: adapted },
          agentsLoadedTeamIds: new Set(s.agentsLoadedTeamIds).add(teamId),
          inflightAgents: Object.fromEntries(
            Object.entries(s.inflightAgents).filter(([k]) => k !== teamId)
          ),
        }));
        return adapted;
      } catch (err) {
        console.error('[backend store] fetchAgents failed:', err);
        set((s) => ({
          inflightAgents: Object.fromEntries(
            Object.entries(s.inflightAgents).filter(([k]) => k !== teamId)
          ),
        }));
        tea.notify.error(i18n.t('backend.loadAgentsFailed'));
        return [];
      }
    })();

    set((s) => ({ inflightAgents: { ...s.inflightAgents, [teamId]: promise } }));
    return promise;
  },

  fetchTasks: async (teamId: string, params?: { limit?: number; offset?: number; force?: boolean }) => {
    const state = get();
    const limit = params?.limit ?? 20;
    const offset = params?.offset ?? 0;
    // Cache key: granularity of (offset, limit) (teamId is already isolated at the tasksPagesByTeam[teamId] level)
    const cacheKey = `${offset}:${limit}`;
    // Cached and not forced refresh → return directly
    if (!params?.force && state.tasksPagesByTeam[teamId]?.[cacheKey]) {
      return state.tasksPagesByTeam[teamId][cacheKey];
    }
    // in-flight deduplication
    if (state.inflightTasks[cacheKey]) { await state.inflightTasks[cacheKey]; return get().tasksPagesByTeam[teamId]?.[cacheKey] ?? []; }

    const promise = (async () => {
      try {
        const { items: tasksWithAgents, total } = await tasksApi.listWithAgents(teamId, { limit, offset });
        const adapted = tasksWithAgents.map((t) =>
          adaptTask(t, t.agents.filter((a) => a.status === 'active').map((a) => a.agent_id))
        );
        set((s) => {
          const teamPages = s.tasksPagesByTeam[teamId] ?? {};
          return {
            tasksPagesByTeam: { ...s.tasksPagesByTeam, [teamId]: { ...teamPages, [cacheKey]: adapted } },
            tasksTotalByTeam: { ...s.tasksTotalByTeam, [teamId]: total },
            inflightTasks: Object.fromEntries(
              Object.entries(s.inflightTasks).filter(([k]) => k !== cacheKey)
            ),
          };
        });
        return adapted;
      } catch (err) {
        console.error('[backend store] fetchTasks failed:', err);
        set((s) => ({
          inflightTasks: Object.fromEntries(
            Object.entries(s.inflightTasks).filter(([k]) => k !== cacheKey)
          ),
        }));
        tea.notify.error(i18n.t('backend.loadTasksFailed'));
        return [];
      }
    })();

    set((s) => ({ inflightTasks: { ...s.inflightTasks, [cacheKey]: promise } }));
    return promise;
  },

  setActiveTeamId: (teamId) => {
    writeActiveTeamId(teamId);
    set({ activeTeamId: teamId });
  },

  // Called after write operation: clear all cache + broadcast refresh
  invalidate: () => {
    set({
      teams: [],
      teamsLoaded: false,
      teamsLoading: false,
      agentsByTeam: {},
      tasksTotalByTeam: {},
      tasksPagesByTeam: {},
      agentsLoadedTeamIds: new Set(),
      inflightTeams: null,
      inflightAgents: {},
      inflightTasks: {},
    });
    emitBackendRefresh();
  },

  // Called when cutting team: only clears the agents/tasks cache of the current team
  invalidateTeam: (teamId) => {
    set((s) => {
      const agentsLoadedTeamIds = new Set(s.agentsLoadedTeamIds);
      agentsLoadedTeamIds.delete(teamId);
      const agentsByTeam = { ...s.agentsByTeam };
      delete agentsByTeam[teamId];
      const tasksPagesByTeam = { ...s.tasksPagesByTeam };
      delete tasksPagesByTeam[teamId];
      const tasksTotalByTeam = { ...s.tasksTotalByTeam };
      delete tasksTotalByTeam[teamId];
      return { agentsLoadedTeamIds, agentsByTeam, tasksPagesByTeam, tasksTotalByTeam };
    });
    emitBackendRefresh();
  },

  // Call when logout / 401: clear all caches but do not broadcast events
  clearAll: () => {
    set({
      teams: [],
      teamsLoaded: false,
      teamsLoading: false,
      agentsByTeam: {},
      tasksTotalByTeam: {},
      tasksPagesByTeam: {},
      agentsLoadedTeamIds: new Set(),
      inflightTeams: null,
      inflightAgents: {},
      inflightTasks: {},
    });
  },
}));

// ========================= React Hooks =========================

/**
 * useTeams — Read team list from store + activeTeamId.
 *
 * Multiple components calling useTeams() will only trigger a single fetchTeams (teamsLoaded flag + in-flight deduplication).
 * After write operations, call invalidate() → teamsLoaded=false → fetch again on next component mount/render.
 * Switching teams via setActiveTeamId → write to localStorage + update state.
 */
export function useTeams(): {
  teams: Team[];
  activeTeamId: string | null;
  activeTeam: Team | null;
  loading: boolean;
} {
  const teams = useBackendStore((s) => s.teams);
  const teamsLoaded = useBackendStore((s) => s.teamsLoaded);
  const teamsLoading = useBackendStore((s) => s.teamsLoading);
  const activeTeamId = useBackendStore((s) => s.activeTeamId);
  const fetchTeams = useBackendStore((s) => s.fetchTeams);

  useEffect(() => {
    if (!teamsLoaded && !teamsLoading) {
      void fetchTeams();
    }
  }, [teamsLoaded, teamsLoading, fetchTeams]);

  // Listen for localStorage changes (triggered when TeamSwitcher writes activeTeamId)
  const [, force] = useState(0);
  useEffect(() => {
    const onLocalChange = () => {
      useBackendStore.setState({ activeTeamId: readActiveTeamId() });
      force((n) => n + 1);
    };
    window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
    return () => window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
  }, []);

  const activeTeam = teams.find((t) => t.team_id === activeTeamId) ?? null;
  return { teams, activeTeamId, activeTeam, loading: teamsLoading };
}

const EMPTY_AGENTS: Agent[] = [];
const EMPTY_TASKS: Task[] = [];

/**
 * useAgents — Read the specified team's agent list from the store.
 *
 * Multiple components in the same teamId trigger only one fetch.
 * It will only re-fetch after invalidate() or invalidateTeam(teamId).
 */
export function useAgents(teamId: string | null | undefined): {
  agents: Agent[];
  loading: boolean;
} {
  // Cache the previous teamId with ref to avoid selector returning different references each time
  const agents = useBackendStore((s) =>
    teamId ? (s.agentsByTeam[teamId] ?? EMPTY_AGENTS) : EMPTY_AGENTS
  );
  const loaded = useBackendStore((s) => (teamId ? s.agentsLoadedTeamIds.has(teamId) : true));
  const fetchAgents = useBackendStore((s) => s.fetchAgents);

  useEffect(() => {
    if (!teamId) return;
    if (!loaded) {
      void fetchAgents(teamId);
    }
  }, [teamId, loaded, fetchAgents]);

  return { agents, loading: !!teamId && !loaded };
}

/**
 * useTasks — Read the task list for the specified team from the store.
 */
export function useTasks(teamId: string | null | undefined, page: number = 1, pageSize: number = 12): {
  tasks: Task[];
  total: number;
  loading: boolean;
} {
  const offset = (page - 1) * pageSize;
  const cacheKey = `${offset}:${pageSize}`;
  const tasks = useBackendStore((s) =>
    teamId ? (s.tasksPagesByTeam[teamId]?.[cacheKey] ?? EMPTY_TASKS) : EMPTY_TASKS
  );
  const total = useBackendStore((s) =>
    teamId ? (s.tasksTotalByTeam[teamId] ?? 0) : 0
  );
  const loaded = useBackendStore((s) =>
    teamId ? !!s.tasksPagesByTeam[teamId]?.[cacheKey] : true
  );
  const fetchTasks = useBackendStore((s) => s.fetchTasks);

  useEffect(() => {
    if (!teamId || loaded) return;
    void fetchTasks(teamId, { limit: pageSize, offset });
  }, [teamId, offset, pageSize, loaded, fetchTasks]);

  return { tasks, total, loading: !!teamId && !loaded };
}

/**
 * readActiveTeamAgents — Synchronously reads the cached agent list (does not trigger a request).
 * Used by scenarios such as SkillsPanel that only need to "reference the list".
 */
export function readActiveTeamAgents(teamId: string | null): Array<{ id: string; name: string }> {
  if (!teamId) return [];
  const cached = useBackendStore.getState().agentsByTeam[teamId];
  if (cached) return cached.map((a) => ({ id: a.agent_id, name: a.name }));
  // Cache miss: trigger background fetch
  void useBackendStore.getState().fetchAgents(teamId);
  return [];
}

// ========================= Export invalidate / clearAll (for mutations to call) =========================

export function invalidateBackendCache(): void {
  useBackendStore.getState().invalidate();
}

export function clearBackendCache(): void {
  useBackendStore.getState().clearAll();
}

export function invalidateTeamCache(teamId: string): void {
  useBackendStore.getState().invalidateTeam(teamId);
}
