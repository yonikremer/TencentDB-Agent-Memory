import { useLayoutEffect, useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import moment, { type Moment } from 'moment';
import { Button, DatePicker, Dropdown, Input, List, Modal, Pagination } from 'tea-component';
import { type MemoryLayer, type MemoryBlock, type AtomicItem } from '../constants/types';
import { useLayers } from '../constants/constants';
import { getLayerCount, stripAtMention, extractRole, formatDisplayTime } from '../utils/utils';
import { stripScenarioMeta, copyToClipboard } from '../utils/memory-utils';
import { useUserDisplayName } from '@/services/user-profile-store';
import { tea } from '@/lib/tea-bridge';
import { MarkdownView } from '@/components/MarkdownView';
import type { ChatMemorySearchHit } from '@/lib/teamApi';
import {
  AppIcon,
  UsergroupIcon,
  ChevronDownIcon,
  InfoCircleIcon,
  TimeIcon,
  SearchIcon,
  MoreIcon,
} from 'tea-icons-react';

const { RangePicker } = DatePicker;

/** L0 Role → Display Grouping: user on the right, system full-width, others (assistant/tool/...) on the left. */
type L0Tone = 'user' | 'assistant' | 'system' | 'tool';
function toneOfRole(role: string): L0Tone {
  if (role === 'user') return 'user';
  if (role === 'system') return 'system';
  if (role === 'tool') return 'tool';
  return 'assistant';
}

/** Title line of a single atomic memory: hierarchy badge + title + time + action menu (three dots) + optional chevron.
 *  Shared by L1 / L2 / L3. L2 additionally renders a chevron via expandable=true and makes the entire line a clickable expandable area.
 *  head always displays the real content (not skeleton due to loading state); only the body area below shows skeleton when loading content. */
function AtomicHead({
  layer,
  tone,
  item,
  time,
  canEditItem,
  canCopyItem,
  onEdit,
  onCopy,
  expandable,
  expanded,
  loading,
  onToggle,
}: {
  layer: MemoryLayer;
  tone: string;
  item: AtomicItem;
  time: string;
  canEditItem: boolean;
  canCopyItem: boolean;
  onEdit?: (item: AtomicItem) => void;
  onCopy: () => void;
  /** L2 is true: render the chevron expand arrow, and the entire row is clickable to expand/collapse */
  expandable: boolean;
  /** Whether it has been expanded (L2: hasBody) */
  expanded: boolean;
  loading: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  const hasActions = canEditItem || canCopyItem;
  const withBody = expandable ? expanded || loading : true;

  const inner = (
    <>
      <span className={`_memory-detail-atomic-layer _memory-detail-atomic-layer--${tone}`}>
        {layer}
      </span>
      <span className="_memory-detail-atomic-title" title={item.title}>
        {item.title}
      </span>
      <span className="_memory-detail-atomic-head-right">
        {time && (
          <span className="_memory-detail-atomic-time" title={item.created_at}>
            {time}
          </span>
        )}
        {/* The action menu (three dots) is placed to the right of the time. Clicking the three dots expands it, supporting editing / copying.
            The head of L2 is the clickable expandable area, and it needs to prevent bubbling to avoid accidental triggering of folding. */}
        {hasActions && (
          <span
            className="_memory-detail-atomic-actions"
            onClick={(e) => e.stopPropagation()}
          >
            <Dropdown
              appearance="pure"
              clickClose
              placement="bottom-end"
              button={
                <Button
                  type="text"
                  className="_memory-detail-atomic-more"
                  tooltip={t('memory.detail.moreActions')}
                >
                  <MoreIcon />
                </Button>
              }
            >
              <List type="option">
                {canEditItem && (
                  <List.Item onClick={() => onEdit!(item)}>
                    {t('memory.detail.edit')}
                  </List.Item>
                )}
                {canCopyItem && (
                  <List.Item onClick={() => void onCopy()}>
                    {t('common.copy')}
                  </List.Item>
                )}
              </List>
            </Dropdown>
          </span>
        )}
        {expandable && (
          <span className="_memory-detail-atomic-chevron-btn" aria-hidden={loading}>
            {loading ? (
              /* Expanding loading: show spinner at chevron position, indicating that the main content is being downloaded */
              <span className="_memory-chat-more-spinner _memory-detail-atomic-spinner" />
            ) : (
              <span
                role="button"
                tabIndex={0}
                aria-label={t('memory.detail.moreActions')}
                onClick={(e) => {
                  // chevron is independently clickable: prevent bubbling to trigger its own expand/collapse,
                  // to avoid falling into the stopPropagation area of the adjacent three-dot dropdown and "not responding".
                  e.stopPropagation();
                  onToggle?.();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggle?.();
                  }
                }}
              >
                <ChevronDownIcon
                  size={12}
                  className={`_memory-detail-atomic-chevron${
                    expanded ? ' _memory-detail-atomic-chevron--open' : ''
                  }`}
                />
              </span>
            )}
          </span>
        )}
      </span>
    </>
  );

  if (expandable) {
    // Use div[role=button] instead of <button>: head contains tea Button (a real button),
    // nesting button inside button is invalid HTML. Disable clicks while loading.
    // Do not add --with-body (hence no bottom line) when not expanded (no content and not loading); add it when expanded or loading.
    return (
      <div
        role="button"
        tabIndex={loading ? -1 : 0}
        aria-disabled={loading}
        className={`_memory-detail-atomic-head _memory-detail-atomic-head--btn${
          withBody ? ' _memory-detail-atomic-head--with-body' : ''
        }`}
        onClick={() => {
          if (!loading) onToggle?.();
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !loading) {
            e.preventDefault();
            onToggle?.();
          }
        }}
      >
        {inner}
      </div>
    );
  }
  return (
    <div className="_memory-detail-atomic-head _memory-detail-atomic-head--with-body">
      {inner}
    </div>
  );
}

/** L1 / L3 Atomic memory list: displayed directly in the body (no collapse/expand). */
function AtomicList({
  layer,
  items,
  loadingItemId,
  timeFiltered,
  canEdit,
  onEdit,
}: {
  layer: MemoryLayer;
  items: AtomicItem[];
  loadingItemId?: string | null;
  /** Whether the current layer is affected by time filtering (L1 only): affects the context of empty state copy */
  timeFiltered?: boolean;
  /** Whether to show the edit entry for each item (Asset Owner only) */
  canEdit?: boolean;
  /** Click to edit a single item */
  onEdit?: (item: AtomicItem) => void;
}) {
  const { t } = useTranslation();
  const LAYERS = useLayers();
  const meta = LAYERS.find((l) => l.id === layer)!;
  if (items.length === 0) {
    return (
      <div className="_memory-detail-empty">
        {timeFiltered
          ? t('memory.detail.emptyLayerInRange', { layer: meta.short })
          : t('memory.detail.emptyLayer', { layer: meta.short })}
      </div>
    );
  }
  return (
    <ul className="_memory-detail-atomic-list">
      {items.map((it) => {
        const hasBody = it.body.trim().length > 0;
        const loading = loadingItemId === it.id;
        const time = formatDisplayTime(it.created_at);
        const canEditItem = !!(canEdit && onEdit);
        const canCopyItem = true;
        async function handleCopy() {
          const ok = await copyToClipboard(it.body);
          if (ok) {
            tea.notify.success(t('memory.notify.copied'));
          } else {
            tea.notify.error(t('memory.notify.copyFailed'));
          }
        }
        return (
          <li key={it.id} className="_memory-detail-atomic-item">
            <AtomicHead
              layer={layer}
              tone={meta.tone}
              item={it}
              time={time}
              canEditItem={canEditItem}
              canCopyItem={canCopyItem}
              onEdit={onEdit}
              onCopy={() => void handleCopy()}
              expandable={false}
              expanded={false}
              loading={loading}
            />
            {layer === 'L3' ? (
              hasBody ? (
                <MarkdownView bare className="_memory-detail-atomic-md">
                  {it.body}
                </MarkdownView>
              ) : loading ? (
                <div className="_memory-detail-atomic-body-skel" aria-busy="true">
                  <div className="_memory-detail-atomic-body-skel-line" style={{ width: '88%' }} />
                  <div className="_memory-detail-atomic-body-skel-line" style={{ width: '70%' }} />
                </div>
              ) : (
                <div className="_memory-detail-atomic-no-body">{t('memory.detail.noBody')}</div>
              )
            ) : loading ? (
              <div className="_memory-detail-atomic-body-skel" aria-busy="true">
                <div className="_memory-detail-atomic-body-skel-line" style={{ width: '95%' }} />
                <div className="_memory-detail-atomic-body-skel-line" style={{ width: '72%' }} />
                <div className="_memory-detail-atomic-body-skel-line" style={{ width: '60%' }} />
              </div>
            ) : (
              <pre className="_memory-detail-atomic-body">{it.body}</pre>
            )}
            {it.refs?.length || it.tags?.length ? (
              <div className="_memory-detail-atomic-meta">
                {it.refs?.map((r) => (
                  <span key={r} className="_memory-detail-atomic-ref">
                    {r}
                  </span>
                ))}
                {it.tags?.map((tag) => (
                  <span key={tag} className="_memory-detail-atomic-tag">
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** L2 Scene Memory List: Body loaded on demand, click title/chevron to collapse/expand (with gradual expand animation). */
function L2AtomicList({
  items,
  onLoadItem,
  loadingItemId,
  canEdit,
  onEdit,
}: {
  items: AtomicItem[];
  onLoadItem?: (itemId: string) => void;
  loadingItemId?: string | null;
  /** Whether to show the edit entry for each item (Asset Owner only) */
  canEdit?: boolean;
  /** Click to edit a single item */
  onEdit?: (item: AtomicItem) => void;
}) {
  const { t } = useTranslation();
  const LAYERS = useLayers();
  const meta = LAYERS.find((l) => l.id === 'L2')!;
  if (items.length === 0) {
    return (
      <div className="_memory-detail-empty">
        {t('memory.detail.emptyLayer', { layer: meta.short })}
      </div>
    );
  }
  return (
    <ul className="_memory-detail-atomic-list">
      {items.map((it) => {
        const hasBody = it.body.trim().length > 0;
        const loading = loadingItemId === it.id;
        const time = formatDisplayTime(it.created_at);
        // Edit entry (Owner only). L2 must expand and load the main content before editing to avoid overwriting the file with empty content.
        const canEditItem = !!(canEdit && onEdit && hasBody);
        // Copy entry: L2 can only be copied when there is body text (no body text when not expanded).
        const canCopyItem = hasBody;
        async function handleCopy() {
          // L2 body with META header, remove when copying, only provide pure body, consistent with editor display.
          const ok = await copyToClipboard(stripScenarioMeta(it.body));
          if (ok) {
            tea.notify.success(t('memory.notify.copied'));
          } else {
            tea.notify.error(t('memory.notify.copyFailed'));
          }
        }
        return (
          <li key={it.id} className="_memory-detail-atomic-item">
            <AtomicHead
              layer="L2"
              tone={meta.tone}
              item={it}
              time={time}
              canEditItem={canEditItem}
              canCopyItem={canCopyItem}
              onEdit={onEdit}
              onCopy={() => void handleCopy()}
              expandable
              expanded={hasBody}
              loading={loading}
              onToggle={() => onLoadItem?.(it.id)}
            />
            {/* L2 Body lazy-loaded and collapsible: the outer grid uses a 0fr↔1fr transition to achieve a gradual expand/collapse animation.
                The container remains in the DOM, and its height smoothly expands from 0 when opened, avoiding instantaneous jumps caused by conditional rendering.
                It is also expanded during loading (--open) to display a multi-line skeleton, matching the real form after the body is expanded. */}
            <div
              className={`_memory-detail-atomic-expand${
                hasBody || loading ? ' _memory-detail-atomic-expand--open' : ''
              }`}
            >
              <div className="_memory-detail-atomic-expand-inner">
                {loading ? (
                  <div className="_memory-detail-atomic-body-skel" aria-busy="true">
                    <div className="_memory-detail-atomic-body-skel-line" style={{ width: '92%' }} />
                    <div className="_memory-detail-atomic-body-skel-line" style={{ width: '78%' }} />
                    <div className="_memory-detail-atomic-body-skel-line" style={{ width: '88%' }} />
                    <div className="_memory-detail-atomic-body-skel-line" style={{ width: '45%' }} />
                  </div>
                ) : hasBody ? (
                  <MarkdownView bare className="_memory-detail-atomic-md">
                    {it.body}
                  </MarkdownView>
                ) : null}
              </div>
            </div>
            {it.refs?.length || it.tags?.length ? (
              <div className="_memory-detail-atomic-meta">
                {it.refs?.map((r) => (
                  <span key={r} className="_memory-detail-atomic-ref">
                    {r}
                  </span>
                ))}
                {it.tags?.map((tag) => (
                  <span key={tag} className="_memory-detail-atomic-tag">
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function BlockDetail({
  block,
  layer,
  onLayerChange,
  agentLabel,
  layerPage,
  layerPageSize,
  layerTotal,
  layerLoading,
  onLayerPageChange,
  onLayerItemLoad,
  layerItemLoadingId,
  onL0LoadMore,
  l0MoreLoading,
  timeRange,
  onTimeRangeChange,
  rangeTooLarge,
  canEdit,
  onSaveLayerItem,
  onSearchLayer,
}: {
  block: MemoryBlock;
  layer: MemoryLayer;
  onLayerChange: (l: MemoryLayer) => void;
  agentLabel: (id?: string) => string;
  layerPage: number;
  layerPageSize: number;
  /** Total count for the current layer within the current time window (the window total returned by the backend when time filtering is applied, used for pagination) */
  layerTotal: number;
  layerLoading: boolean;
  onLayerPageChange: (page: number) => void;
  onLayerItemLoad?: (itemId: string) => void;
  layerItemLoadingId?: string | null;
  /** L0 Load more (append earlier conversations); do not show the load entry if not passed */
  onL0LoadMore?: () => void;
  l0MoreLoading?: boolean;
  /** Detail page time filter (only effective for L0 / L1). start / end are ISO8601 strings */
  timeRange?: { start: string; end: string };
  onTimeRangeChange?: (range: { start: string; end: string }) => void;
  /** True when the backend detects that the filter range is too large (VDB cannot support it) */
  rangeTooLarge?: boolean;
  /** Whether to show the edit entry (only Asset Owner can edit) */
  canEdit?: boolean;
  /** Save single-layer content (L1/L2/L3); no edit entry shown if not passed */
  onSaveLayerItem?: (
    l: 'L1' | 'L2' | 'L3',
    id: string,
    content: string,
  ) => Promise<void>;
  /** Layered Semantic Search (L0 = Conversation Messages, L1 = Atomic Memory); no search box is displayed if not passed */
  onSearchLayer?: (l: 'L0' | 'L1', query: string) => Promise<ChatMemorySearchHit[]>;
}) {
  const { t } = useTranslation();
  const LAYERS = useLayers();
  // Pagination only applies to entries within the "current time window": layerTotal is the total count within the window (taken from BFF's
  // res.total for the parent level), and the list data is also within the window, so they are consistent to avoid "full total page count flipping to an empty page".
  // The full total count in layerCounts is only used for layer badge counts and does not participate in pagination.
  const total = layerTotal ?? getLayerCount(block, layer);
  const pageCount = Math.max(1, Math.ceil(total / layerPageSize));
  // L0 Change to "Load More" interaction; L1 / L2 / L3 use a paginator
  const showPager = layer !== 'L0' && total > layerPageSize;
  const safePage = Math.min(layerPage, pageCount - 1);
  // Time filtering only applies to L0 / L1 stored by time
  const showTimeFilter = (layer === 'L0' || layer === 'L1') && !!timeRange && !!onTimeRangeChange;
  const rangeValue: [Moment, Moment] | undefined =
    timeRange && timeRange.start && timeRange.end
      ? [moment(timeRange.start), moment(timeRange.end)]
      : undefined;
  // Uploader display name (fallback to user_id)
  const uploaderName = useUserDisplayName(block.uploaded_by_user_id);

  // ── Edit (L1/L2/L3) ─
  const [editing, setEditing] = useState<{
    layer: 'L1' | 'L2' | 'L3';
    id: string;
    title: string;
  } | null>(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  function openEdit(item: AtomicItem) {
    if (layer === 'L0') return;
    // L2 body with META header, the editor only displays the pure body (the backend will rebuild using the existing META when writing back).
    const draft = layer === 'L2' ? stripScenarioMeta(item.body) : item.body;
    setEditing({ layer: layer as 'L1' | 'L2' | 'L3', id: item.id, title: item.title });
    setEditContent(draft);
  }
  async function saveEdit() {
    if (!editing || !onSaveLayerItem) return;
    setSaving(true);
    try {
      await onSaveLayerItem(editing.layer, editing.id, editContent);
      // Search result state: the optimistic update of the hook only applies to the paginated list, here we synchronously update the search result entries,
      // otherwise the just-edited body text in the search view will not refresh.
      setSearchResults((prev) =>
        prev
          ? prev.map((it) =>
              it.id === editing.id ? { ...it, body: editContent } : it,
            )
          : prev,
      );
      setEditing(null);
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.editFailed'));
    } finally {
      setSaving(false);
    }
  }

  // ── Browse / Search Mode Toggle (L0 / L1 Only) ──
  // Browse: View memories by time range (reverse chronological order, paginated / L0 chat flow).
  // Search: Locate memories by content semantics (sorted by relevance). The two have different intents, so use an explicit mode toggle to mutually present them,
  // to avoid the mental fragmentation caused by "the time filter and search box being side-by-side yet not linked to each other."
  type DetailMode = 'browse' | 'search';
  const [mode, setMode] = useState<DetailMode>('browse');

  // ── Layered Search (L0 Dialogue / L1 Atomic Memory, Cross-session Semantic Recall) ──
  const [searchInput, setSearchInput] = useState('');
  const [searchResults, setSearchResults] = useState<ChatMemorySearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchable = layer === 'L0' || layer === 'L1';
  // Only enter the search results view when in "search mode + results have been generated"; browsing mode always goes through pagination / chat flow.
  const isSearching = searchable && mode === 'search' && searchResults !== null;

  // Clear the search state and return to browse mode when chunking / layering, to avoid carrying over the previous context's results / mode
  useEffect(() => {
    setSearchResults(null);
    setSearchInput('');
    setMode('browse');
  }, [block.id, layer]);

  async function doSearch() {
    const q = searchInput.trim();
    if (!q || !onSearchLayer || !searchable) return;
    setSearching(true);
    try {
      const hits = await onSearchLayer(layer as 'L0' | 'L1', q);
      setSearchResults(hits);
    } catch (e) {
      tea.notify.error(e instanceof Error ? e.message : t('memory.notify.searchFailed'));
    } finally {
      setSearching(false);
    }
  }
  function clearSearch() {
    setSearchResults(null);
    setSearchInput('');
  }

  // ── L0 Scroll Container and Anchor ──
  // l0HasMore: The number of loaded items is less than the total count from the backend. Scroll to the bottom (latest messages) when entering initially or switching blocks;
  // After loading more (inserting old messages at the top), keep the viewport position stable to avoid jumping.
  const l0Total = getLayerCount(block, 'L0');
  // The termination condition is based on whether "loading earlier returns new data" (l0Ended), not merely by comparing
  // the number of loaded items vs. the total count —— under time filtering, the total count is always greater than the number of items in the window,
  // relying solely on length comparison will cause the button to remain displayed and clicking it will have no effect.
  const l0HasMore = !block.l0Ended && block.layers.L0.length < l0Total;
  const l0ScrollRef = useRef<HTMLDivElement>(null);
  const l0AnchorRef = useRef<'bottom' | number | null>(null);
  const l0KeyRef = useRef<string>('');
  const l0PrevScrollTopRef = useRef<number>(Infinity);

  const l0Key = `${block.id}|${layer}`;
  if (l0KeyRef.current !== l0Key) {
    l0KeyRef.current = l0Key;
    // Set the anchor to scroll to the bottom (latest message) when entering L0; also update ref when leaving L0,
    // so that the key changes when switching back from L1 to L0 and triggers scrolling to the bottom again.
    if (layer === 'L0') {
      l0AnchorRef.current = 'bottom';
    }
  }

  useLayoutEffect(() => {
    if (layer !== 'L0') return;
    const el = l0ScrollRef.current;
    if (!el) return;
    const anchor = l0AnchorRef.current;
    if (anchor === 'bottom') {
      el.scrollTop = el.scrollHeight;
      l0AnchorRef.current = null;
    } else if (typeof anchor === 'number') {
      el.scrollTop += el.scrollHeight - anchor;
      l0AnchorRef.current = null;
    }
  }, [layer, block.layers.L0.length, layerLoading]);

  function triggerL0LoadMore() {
    const el = l0ScrollRef.current;
    if (el) l0AnchorRef.current = el.scrollHeight;
    onL0LoadMore?.();
  }

  // Automatically trigger "Load Earlier" when scrolling to the top — avoiding the need for users to click the button each time.
  // Use a ref to record the previous scrollTop position, and only trigger after crossing the atTop threshold (atTop -> atTop does not repeat),
  // to avoid chain automatic loading caused by anchor correction.
  function handleL0Scroll() {
    const el = l0ScrollRef.current;
    if (!el) return;
    const atTop = el.scrollTop <= 24;
    if (atTop && l0PrevScrollTopRef.current > 24 && l0HasMore && !l0MoreLoading && !layerLoading) {
      triggerL0LoadMore();
    }
    l0PrevScrollTopRef.current = el.scrollTop;
  }

  return (
    <div className="_memory-detail">
      <div className="_memory-detail-header">
        <div className="_memory-detail-header-info">
          <div className="_memory-detail-title">
            <span className="_memory-detail-title-name">{block.title}</span>
            {/* name + id combination: the id is weakened and attached to the name, making it easier for users to identify assets with ID-based naming */}
            <span className="_memory-detail-title-id" title={block.id}>
              {block.id}
            </span>
          </div>
          <div className="_memory-detail-meta">
            {block.agent_id ? (
              <span
                className="_memory-badge"
                title={t('memory.detail.fixedTo', { name: agentLabel(block.agent_id) })}
              >
                <AppIcon size={10} />{' '}
                {t('memory.detail.fixedTo', { name: agentLabel(block.agent_id) })}
              </span>
            ) : (
              <span className="_memory-badge" title={t('memory.detail.teamPool')}>
                <UsergroupIcon size={10} /> {t('memory.detail.teamPool')}
              </span>
            )}
            {block.uploaded_by_user_id && (
              <span className="_memory-detail-meta-item">
                {t('memory.list.uploadedBy')}
                <span className="_memory-detail-mono" title={block.uploaded_by_user_id}>
                  {uploaderName || block.uploaded_by_user_id}
                </span>
              </span>
            )}
            <span className="_memory-detail-meta-item">
              {t('memory.detail.updated', { time: new Date(block.updated_at_ms).toLocaleString() })}
            </span>
          </div>
        </div>

        {/* Browse / Search mode toggle + corresponding controls (L0 / L1 only).
            Browse: time range filter; Search: search box. The two are mutually exclusive, eliminating the misleading "control present but unused". */}
        {searchable && (showTimeFilter || onSearchLayer) && (
          <div className="_memory-detail-mode">
            <div className="_memory-detail-mode-switch" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'browse'}
                className={`_memory-detail-mode-btn${mode === 'browse' ? ' _memory-detail-mode-btn--active' : ''}`}
                onClick={() => setMode('browse')}
              >
                <TimeIcon size={12} /> {t('memory.detail.modeBrowse')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'search'}
                className={`_memory-detail-mode-btn${mode === 'search' ? ' _memory-detail-mode-btn--active' : ''}`}
                onClick={() => setMode('search')}
                disabled={!onSearchLayer}
              >
                <SearchIcon size={12} /> {t('memory.detail.modeSearch')}
              </button>
            </div>

            {/* Browsing mode: time range filter (only effective for L0 / L1) */}
            {mode === 'browse' && showTimeFilter && (
              <div className="_memory-detail-timefilter">
                <RangePicker
                  showTime={{ format: 'HH:mm' }}
                  format="YYYY-MM-DD HH:mm"
                  separator="~"
                  clearable={false}
                  disabledDate={(d) => d.isBefore(moment().endOf('day'))}
                  value={rangeValue}
                  onChange={(v) => {
                    if (v && v[0] && v[1]) {
                      onTimeRangeChange!({ start: v[0].toISOString(), end: v[1].toISOString() });
                    }
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="_memory-detail-layers">
        {LAYERS.map((l) => {
          const active = l.id === layer;
          const loadedLen =
            l.id === 'L0' ? block.layers.L0.length : block.layers[l.id as MemoryLayer].length;
          const known = block.layerCounts[l.id as MemoryLayer] !== undefined || loadedLen > 0;
          const cnt = getLayerCount(block, l.id as MemoryLayer);
          return (
            <button
              key={l.id}
              onClick={() => onLayerChange(l.id as MemoryLayer)}
              className={`_memory-detail-layer-btn${active ? ' _memory-detail-layer-btn--active' : ''}`}
            >
              <div className="_memory-detail-layer-btn-top">
                <span className="_memory-detail-layer-label">{l.label}</span>
                <span
                  className="_memory-detail-layer-count"
                  title={known ? undefined : t('memory.detail.clickToLoad')}
                >
                  {known ? cnt : '·'}
                </span>
              </div>
              <div className="_memory-detail-layer-desc">{l.desc}</div>
            </button>
          );
        })}
      </div>

      {/* Layered Semantic Search: L0 Conversation / L1 Atomic Memory (Displayed only in Search Mode) */}
      {searchable && onSearchLayer && mode === 'search' && (
        <div className="_memory-detail-search">
          <Input
            className="_memory-detail-search-input"
            value={searchInput}
            onChange={(v) => setSearchInput(v)}
            placeholder={t(layer === 'L0' ? 'memory.detail.searchPlaceholderL0' : 'memory.detail.searchPlaceholderL1')}
            disabled={searching}
          />
          <Button
            type="primary"
            onClick={() => void doSearch()}
            loading={searching}
            disabled={!searchInput.trim()}
          >
            {t('memory.detail.search')}
          </Button>
          {searchResults !== null && (
            <>
              <Button type="weak" onClick={clearSearch} disabled={searching}>
                {t('memory.detail.clearSearch')}
              </Button>
              <span className="_memory-detail-search-count">
                {t('memory.detail.searchResultCount', { count: searchResults.length })}
              </span>
            </>
          )}
        </div>
      )}

      <div className="_memory-detail-body">
        {layerLoading ? (
          /* Loading state when entering a layer: provide the corresponding skeleton based on the actual form of the current layer,
             avoiding a one-size-fits-all gray bar transition that makes users feel abrupt about what will appear next.
             L0 = IM chat bubble; L1/L2/L3 = atomic memory entries (including expanded rows). */
          <div className={`_memory-detail-skeleton _memory-detail-skeleton--${layer}`}>
            {layer === 'L0' ? (
              /* L0 Chat flow: alternately display user (right) / assistant (left) bubble skeletons */
              <>
                {[0, 1, 2, 3, 4].map((i) => {
                  const isUser = i % 2 === 0;
                  const isSystem = i === 2;
                  if (isSystem) {
                    return (
                      <div key={i} className="_memory-detail-skel-chat-system">
                        <div className="_memory-detail-skel-line _memory-detail-skel-line--xs" />
                      </div>
                    );
                  }
                  return (
                    <div
                      key={i}
                      className={`_memory-detail-skel-chat-row _memory-detail-skel-chat-row--${isUser ? 'user' : 'assistant'}`}
                    >
                      <div className="_memory-detail-skel-chat-avatar" />
                      <div className="_memory-detail-skel-chat-bubble">
                        <div className="_memory-detail-skel-line" />
                        <div className="_memory-detail-skel-line" style={{ width: isUser ? '40%' : '72%' }} />
                      </div>
                    </div>
                  );
                })}
              </>
            ) : layer === 'L3' ? (
              /* L3 Core Memory: Single entry fills, multi-line body skeleton, aligned with MarkdownView rich text */
              <>
                <div className="_memory-detail-skel-atomic">
                  <div className="_memory-detail-skel-atomic-head">
                    <div className="_memory-detail-skel-block _memory-detail-skel-block--layer _memory-detail-skel-block--warning" />
                    <div className="_memory-detail-skel-block _memory-detail-skel-block--title" />
                    <div className="_memory-detail-skel-block _memory-detail-skel-block--time" />
                    <div className="_memory-detail-skel-block _memory-detail-skel-block--more" />
                  </div>
                  <div className="_memory-detail-skel-body">
                    {[96, 88, 92, 76, 84, 68, 50].map((w, i) => (
                      <div
                        key={i}
                        className="_memory-detail-skel-line"
                        style={{ width: `${w}%`, height: i === 0 ? 18 : 12 }}
                      />
                    ))}
                  </div>
                </div>
              </>
            ) : layer === 'L2' ? (
              /* Enter L2: L2 body is loaded on demand (download only when chevron is clicked); no body is present when not expanded.
                 The loading state only renders the title row head (badge / title / time / three-dots / chevron),
                 and does not render the body skeleton below, to avoid misleading users into thinking content will appear immediately. */
              <div className="_memory-detail-skel-atomic _memory-detail-skel-atomic--l2 _memory-detail-skel-atomic--headonly">
                <div className="_memory-detail-skel-atomic-head">
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--layer _memory-detail-skel-block--success" />
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--title" />
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--time" />
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--more" />
                  <div className="_memory-detail-skel-block _memory-detail-skel-block--chevron" />
                </div>
              </div>
            ) : (
              /* L1 Atomic Memory: multiple card skeletons, each = title header + body 1-2 lines */
              <>
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="_memory-detail-skel-atomic _memory-detail-skel-atomic--l1"
                  >
                    <div className="_memory-detail-skel-atomic-head">
                      <div className="_memory-detail-skel-block _memory-detail-skel-block--layer _memory-detail-skel-block--brand" />
                      <div className="_memory-detail-skel-block _memory-detail-skel-block--title" />
                      <div className="_memory-detail-skel-block _memory-detail-skel-block--time" />
                      <div className="_memory-detail-skel-block _memory-detail-skel-block--more" />
                    </div>
                    <div className="_memory-detail-skel-body">
                      <div className="_memory-detail-skel-line" style={{ width: `${88 - i * 6}%` }} />
                      <div className="_memory-detail-skel-line" style={{ width: `${64 - i * 8}%` }} />
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        ) : searchable && mode === 'search' && searchResults === null ? (
          /* Search mode but search not yet executed: provide guidance, do not fall into the browse list (otherwise, after mode switching, the unchanged content will mislead).
             Place before rangeTooLarge — search is not limited by time range and should not be obstructed by "range too large". */
          <div className="_memory-detail-empty">{t('memory.detail.searchPrompt')}</div>
        ) : !isSearching && rangeTooLarge ? (
          <div className="_memory-detail-empty _memory-detail-empty--warn">
            {t('memory.detail.rangeTooLarge')}
          </div>
        ) : layer === 'L0' ? (
          isSearching ? (
            searchResults!.length === 0 ? (
              <div className="_memory-detail-empty">{t('memory.detail.searchEmpty')}</div>
            ) : (
              /* L0 Search Results: Dialog Message Styles (Role + Bubble + Relevance) */
              <div className="_memory-chat-scroll">
                <div className="_memory-chat-list">
                  {searchResults!.map((msg, idx) => {
                    const role = extractRole(msg.role || msg.title || '');
                    const cleanBody = stripAtMention(msg.body);
                    const tone = toneOfRole(role);
                    const time = formatDisplayTime(msg.created_at);
                    return (
                      <div
                        key={msg.id || idx}
                        className={`_memory-chat-row _memory-chat-row--${tone}`}
                      >
                        <div className="_memory-chat-main">
                          <div className="_memory-chat-meta">
                            <span className="_memory-chat-role">{role.toUpperCase()}</span>
                            {time && (
                              <span className="_memory-chat-time" title={msg.created_at}>
                                {time}
                              </span>
                            )}
                            {typeof msg.score === 'number' && (
                              <span className="_memory-detail-search-score">
                                {t('memory.detail.searchScore', { score: msg.score.toFixed(2) })}
                              </span>
                            )}
                          </div>
                          <div className={`_memory-chat-bubble _memory-chat-bubble--${tone}`}>
                            <pre className="_memory-chat-body">{cleanBody}</pre>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )
          ) : block.layers.L0.length > 0 ? (
            <div className="_memory-chat-scroll" ref={l0ScrollRef} onScroll={handleL0Scroll}>
              {/* Top: Load earlier conversations (automatically triggered when scrolling to the top, or clickable).
                  The top hint area stays visible during loading / has-more / reached-end (l0Ended) / spans-more-than-one-page states */}
              {(l0HasMore ||
                l0MoreLoading ||
                block.l0Ended ||
                block.layers.L0.length > layerPageSize) && (
                <div className="_memory-chat-more">
                  {l0MoreLoading ? (
                    <span className="_memory-chat-more-loading">
                      <span className="_memory-chat-more-spinner" />
                      {t('memory.detail.loading')}
                    </span>
                  ) : l0HasMore ? (
                    <button
                      type="button"
                      className="_memory-chat-more-btn"
                      onClick={triggerL0LoadMore}
                    >
                      {t('memory.detail.loadMore')}
                    </button>
                  ) : (
                    <span className="_memory-chat-more-end">{t('memory.detail.allLoaded')}</span>
                  )}
                </div>
              )}
              <div className="_memory-chat-list">
                {/* Backend returns from the latest conversation top to bottom, and the chat view needs to reverse it to "old on top, new on bottom" */}
                {[...block.layers.L0].reverse().map((msg, idx) => {
                  const role = extractRole(msg.role || msg.title || '');
                  const cleanBody = stripAtMention(msg.body);
                  const tone = toneOfRole(role);
                  const time = formatDisplayTime(msg.created_at);

                  // system: Centered full-width capsule prompt, not avatar + bubble layout
                  if (tone === 'system') {
                    return (
                      <div key={msg.id || idx} className="_memory-chat-system">
                        <InfoCircleIcon size={12} />
                        <span className="_memory-chat-system-text">{cleanBody}</span>
                        {time && <span className="_memory-chat-system-time">{time}</span>}
                      </div>
                    );
                  }

                  return (
                    <div
                      key={msg.id || idx}
                      className={`_memory-chat-row _memory-chat-row--${tone}`}
                    >
                      <div className="_memory-chat-main">
                        <div className="_memory-chat-meta">
                          <span className="_memory-chat-role">{role.toUpperCase()}</span>
                          {time && (
                            <span className="_memory-chat-time" title={msg.created_at}>
                              {time}
                            </span>
                          )}
                        </div>
                        <div className={`_memory-chat-bubble _memory-chat-bubble--${tone}`}>
                          <pre className="_memory-chat-body">{cleanBody}</pre>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="_memory-detail-empty">
              {showTimeFilter ? t('memory.detail.noL0InRange') : t('memory.detail.noL0')}
            </div>
          )
        ) : isSearching ? (
          searchResults!.length === 0 ? (
            <div className="_memory-detail-empty">{t('memory.detail.searchEmpty')}</div>
          ) : (
            /* L1 Search Results: Atomic Memory Styles (L0 Search has already rendered Chat Styles in the L0 branch) */
            <AtomicList
              layer={layer}
              items={searchResults!}
              loadingItemId={layerItemLoadingId}
              timeFiltered={layer === 'L1' && showTimeFilter && !isSearching}
              canEdit={canEdit && !!onSaveLayerItem}
              onEdit={openEdit}
            />
          )
        ) : layer === 'L2' ? (
          /* L2 Scene Memory: Standalone component, body loaded on demand + collapse/expand animation */
          <L2AtomicList
            items={block.layers.L2}
            onLoadItem={onLayerItemLoad}
            loadingItemId={layerItemLoadingId}
            canEdit={canEdit && !!onSaveLayerItem}
            onEdit={openEdit}
          />
        ) : (
          <AtomicList
            layer={layer}
            items={block.layers[layer]}
            loadingItemId={layerItemLoadingId}
            timeFiltered={layer === 'L1' && showTimeFilter && !isSearching}
            canEdit={canEdit && !!onSaveLayerItem}
            onEdit={openEdit}
          />
        )}
        {showPager && !isSearching && (
          <div className="_memory-detail-pager">
            <Pagination
              pageIndex={safePage + 1}
              pageSize={layerPageSize}
              recordCount={total}
              pageSizeVisible={false}
              onPagingChange={(query) => {
                if (query.pageIndex) onLayerPageChange(query.pageIndex - 1);
              }}
            />
          </div>
        )}
      </div>

      {/* Edit Modal (L1/L2/L3 general): body uses multi-line input to overwrite */}
      {editing && (
        <Modal
        visible
        caption={t('memory.detail.editTitle', { layer: editing.layer })}
        size="xl"
        onClose={() => {
          if (!saving) setEditing(null);
        }}
        disableEscape={saving}
        >
        <Modal.Body>
          <div className="_memory-detail-edit-name" title={editing.title}>
            {editing.title}
          </div>
          <Input.TextArea
            size="full"
            className="_memory-detail-edit-textarea"
            value={editContent}
            onChange={(v) => setEditContent(v)}
            disabled={saving}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="primary" onClick={() => void saveEdit()} loading={saving}>
            {t('memory.detail.save')}
          </Button>
          <Button onClick={() => setEditing(null)} disabled={saving}>
            {t('memory.detail.cancel')}
          </Button>
        </Modal.Footer>
        </Modal>
        )}
        </div>
        );
        }
