/**
 * useChatMemory —— All state and data logic for the Chat Memory page.
 * The component layer only retains JSX rendering, with state / data logic centralized here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgents, useTeams } from '@/services';
import { readAuth } from '@/components/LoginGate';
import { tea, confirmThenRun } from '@/lib/tea-bridge';
import { chatMemoryApi, type ChatMemoryBlock, type ChatMemorySearchHit } from '@/lib/teamApi';
import { type MemoryBlock, type MemoryLayer, type ScopeTab } from '../constants/types';
import { useScopeTabLabels } from '../constants/constants';
import {
  buildInitialLayerCounts,
  defaultTimeRange,
  isRangeTooLargeError,
  layerPageSize,
  mapLayerItem,
  type TimeRange,
} from '../utils/memory-utils';
import { getLayerCount } from '../utils/utils';

export function useChatMemory(props: { activeTeamId?: string | null } = {}) {
  const { t } = useTranslation();
  const scopeTabLabels = useScopeTabLabels();
  const auth = readAuth();
  const { activeTeamId: storeActiveTeamId, activeTeam } = useTeams();
  const currentUserId = auth?.user_id ?? '';
  const activeTeamId = props.activeTeamId ?? storeActiveTeamId;
  const { agents: teamAgents } = useAgents(activeTeamId);
  const ownedTeamAgents = useMemo(
    () => teamAgents.filter((a) => a.owner_user_id === currentUserId),
    [teamAgents, currentUserId],
  );

  const [blocks, setBlocks] = useState<MemoryBlock[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layer, setLayer] = useState<MemoryLayer>('L1');
  const [layerPages, setLayerPages] = useState<
    Record<string, Partial<Record<MemoryLayer, number>>>
  >({});
  // Total count of items within the current time window for each layer (key: `${blockId}|${layer}`).
  // layerCounts stores the full total (obtained when limit=1 with selected blocks); with time filter (L0/L1)
  // Only the res.total returned by the BFF represents the count within the window, pagination must use it, otherwise the page count is inflated.
  const [windowTotals, setWindowTotals] = useState<
    Record<string, Partial<Record<MemoryLayer, number>>>
  >({});
  const [layerLoading, setLayerLoading] = useState(false);
  const [layerItemLoadingId, setLayerItemLoadingId] = useState<string | null>(null);
  // Detail page time filter (only effective for L0 / L1), default "previous day ~ current"
  const [timeRange, setTimeRange] = useState<TimeRange>(() => defaultTimeRange());
  // Backend sets to true when the filter range is too large, BlockDetail displays a prompt instead of an empty state
  const [rangeTooLarge, setRangeTooLarge] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAllocate, setShowAllocate] = useState(false);
  // Default display Agent assets (fixed) to prevent users from mistakenly thinking their assets are in "Team Assets"
  const [scopeTab, setScopeTab] = useState<ScopeTab>('fixed');
  const [agentFilter, setAgentFilter] = useState<string>('');

  useEffect(() => {
    if (ownedTeamAgents.length === 0) {
      setAgentFilter('');
      return;
    }
    if (!agentFilter || !ownedTeamAgents.some((a) => a.agent_id === agentFilter)) {
      setAgentFilter(ownedTeamAgents[0].agent_id);
    }
  }, [ownedTeamAgents, agentFilter]);

  // ── Data Loading ──
  // Prevent race conditions on request sequence: when quickly switching tabs, requests sent first may return later,
  // and data from the old tab may overwrite data from the new tab. Increment the sequence number on each fetch,
  // and when a response returns, verify whether the sequence number is still the latest; if not, discard it.
  const fetchSeqRef = useRef(0);
  // The team from the previous fetch, used to distinguish between "switching team" and "switching tab / switching agent".
  // When switching team, silently refresh (keep the old list until new data arrives), without blanking or skeleton screens;
  // When switching tab / agent, still clear + loading according to the original logic.
  const prevTeamIdRef = useRef(activeTeamId);
  // The maximum consecutive times for "auto-expand time range": within the window, automatically expand 24h backwards to the earliest time,
  // until the backend confirms that the memory block has no records at an earlier time (reload returns empty → l0Ended is set).
  // This count serves as an extreme fallback (to prevent infinite loops in abnormal situations); manual user adjustments to the filter reset with component remount.
  const l0AutoExpandCountRef = useRef(0);

  const fetchBlocks = useCallback(async () => {
    if (!activeTeamId) {
      setBlocks([]);
      setBlocksLoading(false);
      return;
    }
    // fixed tab does not send request when agent is not selected, but ensure loading is closed
    if (scopeTab === 'fixed' && !agentFilter) {
      setBlocks([]);
      setBlocksLoading(false);
      return;
    }
    const seq = ++fetchSeqRef.current;
    // Silently refresh when switching teams (keep the old list until new data arrives), no empty flash or skeleton screen;
    // Switching tabs / agents still clears + loading.
    const teamChanged = prevTeamIdRef.current !== activeTeamId;
    prevTeamIdRef.current = activeTeamId;
    if (!teamChanged) {
      setBlocksLoading(true);
      // Immediately clear old data — otherwise switching tabs will first show the previous tab's list,
      // and new data suddenly replaces it, visually appearing as a "flash".
      setBlocks([]);
    }
    try {
      let res: { items: ChatMemoryBlock[]; total?: number };
      if (scopeTab === 'fixed') {
        res = await chatMemoryApi.agentFixed(agentFilter);
      } else {
        res = await chatMemoryApi.teamAssets(activeTeamId);
      }
      if (seq !== fetchSeqRef.current) return; // Replaced by subsequent request
      const mapped: MemoryBlock[] = res.items.map((b) => ({
        id: b.id,
        title: b.title,
        summary: b.summary ?? '',
        tags: [],
        updated_at_ms: b.updated_at_ms,
        agent_id: b.agent_id ?? undefined,
        uploaded_by_user_id: b.uploaded_by_user_id,
        scope: b.scope,
        layer_counts: b.layer_counts,
        bound_agent_count: b.bound_agent_count,
        layers: { L0: [], L1: [], L2: [], L3: [] },
        // Initially only fill in the **real** count returned by the backend (>0); leave undefined for 0 / unimplemented layers, meaning "unknown".
        // Display a placeholder badge for unknown layers; only request the real count on demand when the user switches to that layer tab,
        // to avoid pinging the other 3 layers once just by selecting a block (pure pre-requests for content the user hasn't seen yet).
        layerCounts: buildInitialLayerCounts(b.layer_counts),
      }));
      setBlocks(mapped);
    } catch (e: unknown) {
      if (seq !== fetchSeqRef.current) return;
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.loadFailed'));
      setBlocks([]);
    } finally {
      if (seq === fetchSeqRef.current) setBlocksLoading(false);
    }
    // Note: no longer setSelectedId here —— previous fetchBlocks useCallback depends on
    // selectedId, causing the entire list to be re-fetched every time a block is selected (main cause of lag).
    // The default selection logic is handled by the independent effect below.
  }, [activeTeamId, scopeTab, agentFilter, t]);

  // Trigger fetchBlocks: depends on the original parameters + fetchBlocks, and uses key for deduplication to prevent repeated triggering within a short time.
  // Previously, directly `useEffect(() => fetchBlocks(), [fetchBlocks])` would trigger multiple times due to changes in fetchBlocks
  // (dependencies like agentFilter sync asynchronously), causing the same interface to be repeatedly requested.
  const fetchKeyRef = useRef<string>('');
  useEffect(() => {
    // Only fixed tabs fetch by agentFilter; the data source (teamAssets) of the team tab is unrelated to the selected
    // agent. If agentFilter is included in the key of team, after ownedTeamAgents is loaded asynchronously,
    // agentFilter will change from '' to the first agent, causing the key to change and triggering another
    // **completely duplicate** teamAssets request (an extra API call is made upon page entry).
    const key =
      scopeTab === 'fixed'
        ? `${activeTeamId}|${scopeTab}|${agentFilter}`
        : `${activeTeamId}|${scopeTab}`;
    if (fetchKeyRef.current === key) return;
    fetchKeyRef.current = key;
    void fetchBlocks();
  }, [activeTeamId, scopeTab, agentFilter, fetchBlocks]);

  // After the list changes, clear the selection only when the currently selected memory block is no longer in the list.
  // Do not automatically select the first one when entering the page (to keep consistent with skill behavior); load the details after the user clicks.
  useEffect(() => {
    if (selectedId && !blocks.some((b) => b.id === selectedId)) {
      setSelectedId(null);
    }
  }, [blocks, selectedId]);

  // ── Layered Pagination Loading ──
  const selected = useMemo(
    () => (selectedId ? (blocks.find((b) => b.id === selectedId) ?? null) : null),
    [selectedId, blocks],
  );
  const layerPage = selected?.id ? (layerPages[selected.id]?.[layer] ?? 0) : 0;
  const pageSize = layerPageSize(layer);
  /** Total count for the current layer within the current time window; falls back to the total count when there is no window cache (L2/L3 always equal the total count) */
  const windowTotal = selected?.id
    ? (windowTotals[selected.id]?.[layer] ?? getLayerCount(selected, layer))
    : 0;

  // ── Layer Counting: Fetch the four-layer counts in parallel for the selected block ──
  // Business confirmation: The layer_counts returned by teamAssets / agentFixed / myAgents are unreliable,
  // so the four layer interfaces for L0/L1/L2/L3 must be called for the selected block to get accurate counts.
  // This was removed during the previous interface optimization, causing the badge count to be incorrect.
  const layerCountSeqRef = useRef(0);
  useEffect(() => {
    if (!selected?.id) return;
    const blockId = selected.id;
    const seq = ++layerCountSeqRef.current;

    const layers: MemoryLayer[] = ['L0', 'L1', 'L2', 'L3'];
    layers.forEach((l) => {
      // Layers with real counts are not requested repeatedly
      if (selected.layerCounts[l] !== undefined) return;

      chatMemoryApi
        .layer(blockId, l, 1, 0)
        .then((res) => {
          if (seq !== layerCountSeqRef.current) return; // has been replaced by a later selection
          setBlocks((prev) =>
            prev.map((b) =>
              b.id === blockId ? { ...b, layerCounts: { ...b.layerCounts, [l]: res.total } } : b,
            ),
          );
        })
        .catch(() => {
          // Single-layer counting failure does not block other layers, silently ignored
        });
    });
  }, [selected?.id]);

  // When switching memory blocks, the time filter resets to the default "previous day ~ current" (business confirmed: resets every time it is opened)
  useEffect(() => {
    setTimeRange(defaultTimeRange());
    setRangeTooLarge(false);
  }, [selected?.id]);

  // When chunking / time range changes, the total cache within the window is invalidated (pagination and total must be recalculated according to the new window)
  useEffect(() => {
    setWindowTotals({});
  }, [selected?.id, timeRange.start, timeRange.end]);

  useEffect(() => {
    if (!selected?.id) {
      setLayerLoading(false);
      return;
    }
    let cancelled = false;
    setLayerLoading(true);
    // Time filtering only applies to L0 / L1; L2 / L3 are aggregation products and do not accept time parameters
    const useTimeFilter = layer === 'L0' || layer === 'L1';
    const timeStart = useTimeFilter ? timeRange.start || undefined : undefined;
    const timeEnd = useTimeFilter ? timeRange.end || undefined : undefined;
    chatMemoryApi
      .layer(
        selected.id,
        layer,
        pageSize,
        layerPage * pageSize,
        undefined,
        undefined,
        timeStart,
        timeEnd,
      )
      .then((res) => {
        if (cancelled) return;
        setRangeTooLarge(false);
        // When filtering by time, res.total is the count within the "current time window", saved separately for pagination
        // (layerCounts remains the full total, cannot be changed). L2/L3 have no time dimension, so the window total = the full total.
        setWindowTotals((prev) => ({
          ...prev,
          [selected.id]: { ...(prev[selected.id] ?? {}), [layer]: res.total },
        }));
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== selected.id) return b;
            const updated = {
              ...b,
              layers: { ...b.layers },
              // Note: When a time range query is used, res.total is the count within the range, not the total count.
              // The total count is obtained via a request with limit=1 when the block is selected and stored in layerCounts,
              // so it cannot be overwritten here, otherwise the badge count / L0 load more judgment will be wrong.
              // Only sync the total count when there is no time filter (L2/L3, or L0/L1 after clearing the time range).
              ...(!useTimeFilter
                ? { layerCounts: { ...b.layerCounts, [layer]: res.total } }
                : {}),
            };
            if (res.layer === 'L0') {
              updated.layers.L0 = res.items;
              // When the first screen / time filter changes and reloads: if there are records in the window → reset "earliest reached",
              // if there are no records → set it (indicating that this memory block also had no data at an earlier time, automatically extending to this point).
              // This is the convergence condition for automatically extending the time range, to avoid extending infinitely backwards.
              updated.l0Ended = res.items.length === 0;
            } else if (res.layer === 'L1') updated.layers.L1 = res.items.map(mapLayerItem);
            else if (res.layer === 'L2') updated.layers.L2 = res.items.map(mapLayerItem);
            else if (res.layer === 'L3') updated.layers.L3 = res.items.map(mapLayerItem);
            return updated;
          }),
        );
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Range too large: no error prompt is shown, and BlockDetail renders the "Too Many Memories" guidance
        if (isRangeTooLargeError(e)) {
          setRangeTooLarge(true);
          return;
        }
        tea.notify.error(e instanceof Error ? e.message : t('memory.notify.layerFailed'));
      })
      .finally(() => {
        if (!cancelled) setLayerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, layer, layerPage, pageSize, timeRange.start, timeRange.end, t]);

  const handleLayerPageChange = useCallback(
    (nextPage: number) => {
      if (!selected?.id) return;
      setLayerPages((prev) => ({
        ...prev,
        [selected.id]: { ...(prev[selected.id] ?? {}), [layer]: Math.max(0, nextPage) },
      }));
    },
    [selected?.id, layer],
  );

  // ── L0 Load More (triggered by pull down/scroll to top) ──
  // L0 fixed consumption of page 0 (latest batch), "load more" uses the timestamp of the last message as the cursor
  // (before_ts) request earlier messages instead of using array length as offset.
  // Reason: VDB has high cost for scan+skip with large offsets, and timestamp filtering can reduce queries from O(offset+limit)
  // Reduce to O(limit). The array maintains the new-to-old order from the backend, and the rendering layer reverses it to old-to-new, with appended items appearing at the top.
  const [l0MoreLoading, setL0MoreLoading] = useState(false);
  const handleL0LoadMore = useCallback(async () => {
    if (!selected?.id || layer !== 'L0' || l0MoreLoading) return;
    const items = selected.layers.L0;
    const total = selected.layerCounts.L0 ?? items.length;
    // Confirmed to arrive earliest within the current time window: no request will be sent (double safeguard, normal entry is hidden by BlockDetail)
    if (selected.l0Ended) return;
    if (items.length >= total) return;
    // Cursor: array ordered from newest to oldest, with the last entry being the oldest loaded message
    const lastItem = items[items.length - 1];
    const beforeTs = lastItem?.created_at;
    setL0MoreLoading(true);
    try {
      // when beforeTs has a value, offset is passed as 0 (the backend filters by time_end); when there is no beforeTs on the first screen, offset=0 is used.
      // Pass through the lower bound of the timeStart time: loading earlier messages cannot exceed the user-defined filter range, consistent with the first screen.
      const timeStart = timeRange.start || undefined;
      const res = await chatMemoryApi.layer(
        selected.id,
        'L0',
        pageSize,
        0,
        undefined,
        beforeTs,
        timeStart,
      );
      const noMore = res.items.length === 0;
      setBlocks((prev) =>
        prev.map((b) => {
          if (b.id !== selected.id) return b;
          // Defensive deduplication: avoid rendering the same message repeatedly when pages overlap due to concurrency/refresh
          const existing = new Set(b.layers.L0.map((m) => m.id));
          const more = res.items.filter((m) => !existing.has(m.id));
          // Note: Under cursor pagination, the total returned by the backend is the remaining count after filtering (time_end < beforeTs),
          // not the total count. Preserve the full total obtained in the first screen to avoid the illusion of "total decreasing after loading more".
          return {
            ...b,
            layers: { ...b.layers, L0: [...b.layers.L0, ...more] },
            // No new items (empty after deduplication) = earliest time window reached, enable hidden "Load Earlier" entry
            l0Ended: b.l0Ended || more.length === 0,
          };
        }),
      );
      // If the window has reached the earliest records, auto-extend the time range (24h earlier) to trigger an L0 reload,
      // so users keep seeing older memories without hand-editing the filter (intent: the time filter should not be
      // a barrier to browsing history). If a reload still returns nothing, the effect sets l0Ended to stop the expansion.
      // count is only an extreme guard against infinite loops; the normal path converges via "empty load after expand -> l0Ended".
      if (noMore && timeRange.start && l0AutoExpandCountRef.current < 30) {
        l0AutoExpandCountRef.current += 1;
        const newStart = new Date(new Date(timeRange.start).getTime() - 24 * 60 * 60 * 1000);
        setL0MoreLoading(false);
        setTimeRange((prev) => ({ ...prev, start: newStart.toISOString() }));
        return;
      }
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.layerFailed'));
    } finally {
      setL0MoreLoading(false);
    }
  }, [selected, layer, l0MoreLoading, pageSize, timeRange.start, t]);

  const handleLayerItemLoad = useCallback(
    async (itemId: string) => {
      if (!selected?.id || layer !== 'L2') return;
      const current = selected.layers.L2.find((item) => item.id === itemId);
      if (!current) return;
      if (current.body.trim()) {
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== selected.id) return b;
            return {
              ...b,
              layers: {
                ...b.layers,
                L2: b.layers.L2.map((item) =>
                  item.id === itemId ? { ...item, body: '', tags: [] } : item,
                ),
              },
            };
          }),
        );
        return;
      }
      setLayerItemLoadingId(itemId);
      try {
        const res = await chatMemoryApi.layer(selected.id, 'L2', 1, 0, itemId);
        const loaded = res.items[0] ? mapLayerItem(res.items[0]) : null;
        if (!loaded) return;
        setBlocks((prev) =>
          prev.map((b) => {
            if (b.id !== selected.id) return b;
            return {
              ...b,
              layers: {
                ...b.layers,
                L2: b.layers.L2.map((item) => (item.id === itemId ? { ...item, ...loaded } : item)),
              },
            };
          }),
        );
      } catch (e: unknown) {
        tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.l2Failed'));
      } finally {
        setLayerItemLoadingId(null);
      }
    },
    [selected?.id, selected?.layers.L2, layer, t],
  );

  // ── Edit: Save single-layer content (Owner-only; optimistically update the corresponding entry body on success) ──
  // L1 = content override; L2 = full scenario body override (BFF strips META before writing, kernel rebuilds META);
  // L3 = full core persona override. Throw on failure, letting the caller (edit dialog) retain input and prompt.
  const handleSaveLayerItem = useCallback(
    async (targetLayer: 'L1' | 'L2' | 'L3', itemId: string, content: string) => {
      if (!selected?.id) return;
      await chatMemoryApi.updateLayer(selected.id, targetLayer, {
        id: itemId,
        content,
      });
      setBlocks((prev) =>
        prev.map((b) => {
          if (b.id !== selected.id) return b;
          return {
            ...b,
            layers: {
              ...b.layers,
              [targetLayer]: b.layers[targetLayer].map((item) =>
                item.id === itemId ? { ...item, body: content } : item,
              ),
            },
          };
        }),
      );
      tea.notify.success(t('memory.notify.editSuccess'));
    },
    [selected?.id, t],
  );

  // ── Search: L0 (Dialog) / L1 (Atomic Memory) Semantics / Keyword Retrieval ──
  // Cross-session recall, returning hit items with score; result state is managed by BlockDetail,
  // Here only the request function is provided (depends on the currently selected block).
  const searchLayer = useCallback(
    async (targetLayer: 'L0' | 'L1', query: string): Promise<ChatMemorySearchHit[]> => {
      if (!selected?.id) return [];
      const res = await chatMemoryApi.searchLayer(selected.id, targetLayer, query, 30);
      return res.items ?? [];
    },
    [selected?.id],
  );

  // ── Filtering and Auxiliary ──
  const filtered = useMemo(() => {
    if (scopeTab === 'fixed')
      return agentFilter ? blocks.filter((b) => b.agent_id === agentFilter) : [];
    return blocks;
  }, [blocks, scopeTab, agentFilter]);

  function agentLabel(id?: string): string {
    if (!id) return '';
    const a = teamAgents.find((x) => x.agent_id === id);
    return a ? a.name : id;
  }

  function selfChatMemoryAgentId(b: MemoryBlock): string | undefined {
    if (!activeTeamId) return undefined;
    const prefix = `chat_memory-${activeTeamId}-`;
    if (b.id.startsWith(prefix)) return b.id.slice(prefix.length) || undefined;
    return b.agent_id;
  }

  function isSelfChatMemory(b: MemoryBlock): boolean {
    // Only count as self when "this chat_memory is the **currently viewed agent's** own memory" — unbinding is not allowed.
    // Previous bug: any asset named `chat_memory-{team}-{agentX}` was judged as self,
    // causing other agents' memories to be borrowed into the current agent (e.g. test3 borrowed from test-bugfix),
    // which was also misjudged as self, so the "unbind" button never appeared.
    // Under the fixed tab, agentFilter is the current agent; the team/personal tabs do not involve the "unbind" semantics,
    // so the original prefix check is retained as a fallback.
    if (!activeTeamId) return false;
    if (scopeTab === 'fixed' && agentFilter) {
      return b.id === `chat_memory-${activeTeamId}-${agentFilter}`;
    }
    const ownerAgentId = selfChatMemoryAgentId(b);
    return !!ownerAgentId && b.id === `chat_memory-${activeTeamId}-${ownerAgentId}`;
  }

  function allocatableAgents(b: MemoryBlock) {
    // Document §4.5 allocate permission rules:
    //   1. agent.owner = me (can only allocate to agents owned by me, otherwise 403 NOT_YOUR_AGENT)
    //   3. Cannot allocate the agent's own chat_memory to itself
    // So the data source uses ownedTeamAgents, excluding the agent that is the memory block itself.
    const ownerAgentId = selfChatMemoryAgentId(b);
    return ownedTeamAgents
      .filter((a) => a.agent_id !== ownerAgentId)
      .map((a) => ({ agent_id: a.agent_id, name: a.name }));
  }

  // ── Operation ──
  async function handleDeleteBlock(id: string) {
    const block = blocks.find((b) => b.id === id);
    const teamId = activeTeamId;
    const agentId = block?.agent_id;
    if (!teamId || !agentId) return;
    await confirmThenRun(
      {
        message: t('memory.confirm.unbind'),
        description: t('memory.confirm.unbind.desc'),
        okText: t('memory.confirm.unbind.ok'),
      },
      async () => {
        await chatMemoryApi.unbind(teamId, id, agentId);
        setBlocks((prev) => prev.filter((b) => b.id !== id));
        if (selectedId === id) setSelectedId(null);
        tea.notify.success(t('memory.notify.unbound'));
      },
      (e) => tea.notify.error((e as Error)?.message || t('memory.notify.unbindFailed')),
    );
  }

  async function handleImport({
    agent_id,
    messages,
  }: {
    agent_id: string;
    messages: Array<{ role: string; content: string }>;
  }) {
    try {
      if (!activeTeamId || !agent_id) {
        tea.notify.warning(t('memory.notify.selectAgent'));
        return;
      }
      await chatMemoryApi.import({ teamId: activeTeamId, agentId: agent_id, messages });
      tea.notify.success(t('memory.notify.importSuccess', { count: messages.length }));
      setShowImport(false);
      fetchBlocks();
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.importFailed'));
    }
  }

  // Shared/Private switch: the unique capability of the original personal tab, migrated after canceling the personal tab
  // On the asset items of the 「Agent asset (fixed)」 tab (only owner can switch, see ChatMemoryPanel rendering).
  async function handleToggleScope(block: MemoryBlock, newScope: 'team' | 'private') {
    if (block.scope === newScope) return;
    // Confirm first when making private: if other agents have already borrowed this memory, they will no longer be able to use it.
    // The explanation only provides awareness, and does not list the list of affected agents (the kernel does not actively prune, so an exact number is also not needed).
    if (newScope === 'private') {
      const ok = await tea.confirm({
        message: t('memory.confirm.private'),
        description: t('memory.confirm.private.desc'),
        okText: t('memory.confirm.private.ok'),
      });
      if (!ok) return;
    }
    try {
      await chatMemoryApi.patchScope(block.id, newScope);
      tea.notify.success(
        newScope === 'team' ? t('memory.notify.scopeTeam') : t('memory.notify.scopePrivate'),
      );
      fetchBlocks();
    } catch (e: unknown) {
      tea.notify.error((e instanceof Error ? e.message : String(e)) || t('memory.notify.scopeFailed'));
    }
  }

  return {
    // context
    activeTeam,
    activeTeamId,
    currentUserId,
    ownedTeamAgents,
    teamAgents,
    scopeTabLabels,
    // state
    blocks,
    blocksLoading,
    selectedId,
    setSelectedId,
    layer,
    setLayer,
    layerPages,
    layerLoading,
    layerItemLoadingId,
    l0MoreLoading,
    timeRange,
    setTimeRange,
    rangeTooLarge,
    showImport,
    setShowImport,
    showAllocate,
    setShowAllocate,
    scopeTab,
    setScopeTab,
    agentFilter,
    setAgentFilter,
    // computed
    selected,
    layerPage,
    pageSize,
    windowTotal,
    filtered,
    // handlers
    fetchBlocks,
    handleLayerPageChange,
    handleL0LoadMore,
    handleLayerItemLoad,
    handleSaveLayerItem,
    searchLayer,
    handleDeleteBlock,
    handleImport,
    handleToggleScope,
    // helpers
    agentLabel,
    allocatableAgents,
    isSelfChatMemory,
  };
}

export type ChatMemoryStore = ReturnType<typeof useChatMemory>;
