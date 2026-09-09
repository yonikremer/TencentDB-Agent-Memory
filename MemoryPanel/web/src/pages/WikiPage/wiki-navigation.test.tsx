import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderHook } from '@testing-library/react';
import { hookWrapper, lastSeen, resetSeen } from '@/test-utils';
import { useWikiSources } from './hooks/useWikiSources';
import { WikiPage } from './index';
import { WikiDetailView } from './components/wiki-detail-view';
import type { WikiSourcesStore } from './hooks/useWikiSources';

// Stable identities: fresh objects per render would retrigger t/agent-dependent effects forever.
const stable = vi.hoisted(() => {
  const t = (k: string) => k;
  const teams = { activeTeamId: 't1', activeTeam: { name: 'T' } };
  const agents = { agents: [] as unknown[] };
  const auth = { user_id: 'u1' };
  return { t, teams, agents, auth };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stable.t }),
}));
vi.mock('@/services', () => ({
  useTeams: () => stable.teams,
  useAgents: () => stable.agents,
}));
vi.mock('@/components/LoginGate', () => ({
  readAuth: () => stable.auth,
}));
vi.mock('@/lib/tea-bridge', () => ({
  tea: {
    notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
    confirm: async () => true,
  },
  confirmThenRun: async (_o: unknown, fn: () => Promise<void>) => {
    await fn();
  },
}));
vi.mock('@/pages/WikiPage/components/KnowledgeGraph', () => ({
  KnowledgeGraph: () => null,
}));

const wikiMocks = vi.hoisted(() => ({
  teamAssets: vi.fn(async () => [{ wiki_id: 'w1', name: 'W1', status: 'ready', page_count: 1 }]),
  agentFixed: vi.fn(async () => []),
  graph: vi.fn(async () => null),
  pages: vi.fn(async () => []),
  get: vi.fn(async () => null),
}));
vi.mock('@/lib/api/knowledge-api', () => ({
  knowledgeApi: { wiki: wikiMocks },
  wikiProgressPercent: () => 0,
  wikiStageLabel: () => '',
}));

beforeEach(() => resetSeen());

describe('useWikiSources URL sync', () => {
  it('stays on the list at /wiki', async () => {
    const { result } = renderHook(() => useWikiSources(), {
      wrapper: hookWrapper('/wiki', '/wiki/:wikiId?/:wikiTab?'),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.subView).toBe('list');
    expect(result.current.selectedWikiId).toBe('');
  });

  it('opens detail on deep link /wiki/w1/overview', async () => {
    const { result } = renderHook(() => useWikiSources(), {
      wrapper: hookWrapper('/wiki/w1/overview', '/wiki/:wikiId?/:wikiTab?'),
    });
    await waitFor(() => expect(result.current.subView).toBe('detail'));
    expect(result.current.selectedWikiId).toBe('w1');
    expect(wikiMocks.graph).toHaveBeenCalledWith('w1');
    expect(wikiMocks.pages).toHaveBeenCalledWith('w1');
  });

  it('openDetail pushes /wiki/:id/overview', async () => {
    const { result } = renderHook(() => useWikiSources(), {
      wrapper: hookWrapper('/wiki', '/wiki/:wikiId?/:wikiTab?'),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.openDetail('w2'));
    expect(lastSeen()).toBe('/wiki/w2/overview');
    expect(result.current.selectedWikiId).toBe('w2');
  });

  it('selectTab pushes /wiki/:id/:tab', async () => {
    const { result } = renderHook(() => useWikiSources(), {
      wrapper: hookWrapper('/wiki/w1/overview', '/wiki/:wikiId?/:wikiTab?'),
    });
    await waitFor(() => expect(result.current.subView).toBe('detail'));
    act(() => result.current.selectTab('graph'));
    expect(lastSeen()).toBe('/wiki/w1/graph');
    expect(result.current.activeTab).toBe('graph');
  });

  it('closeDetail returns to /wiki list', async () => {
    const { result } = renderHook(() => useWikiSources(), {
      wrapper: hookWrapper('/wiki/w1/overview', '/wiki/:wikiId?/:wikiTab?'),
    });
    await waitFor(() => expect(result.current.subView).toBe('detail'));
    act(() => result.current.closeDetail());
    expect(lastSeen()).toBe('/wiki');
    await waitFor(() => expect(result.current.subView).toBe('list'));
  });
});

describe('WikiPage routing', () => {
  it('renders 404 for an unknown tab', () => {
    render(
      <MemoryRouter initialEntries={['/wiki/w1/bogus']}>
        <Routes>
          <Route path="/wiki/:wikiId/:wikiTab" element={<WikiPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('404')).toBeTruthy();
  });
});

describe('WikiDetailView missing id', () => {
  function stub(over: Partial<WikiSourcesStore> = {}) {
    return {
      sources: [],
      selectedWikiId: 'missing',
      loading: false,
      closeDetail: vi.fn(),
      selectTab: vi.fn(),
      fetchSources: vi.fn(),
      ...over,
    } as unknown as WikiSourcesStore;
  }

  it('renders 404 for unknown wiki id', () => {
    render(
      <MemoryRouter initialEntries={['/wiki/missing']}>
        <WikiDetailView store={stub()} />
      </MemoryRouter>,
    );
    expect(screen.getByText('404')).toBeTruthy();
  });

  it('shows loading instead of a false 404', () => {
    render(
      <MemoryRouter initialEntries={['/wiki/missing']}>
        <WikiDetailView store={stub({ loading: true })} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('404')).toBeNull();
  });
});
