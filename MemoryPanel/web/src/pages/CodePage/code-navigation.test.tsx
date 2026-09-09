import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderHook } from '@testing-library/react';
import { hookWrapper, lastSeen, resetSeen } from '@/test-utils';
import { useCodeSources } from './hooks/useCodeSources';
import { CodeDetailView } from './components/code-detail-view';
import type { CodeSourcesStore } from './hooks/useCodeSources';

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
  tea: { notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } },
}));

const codeMocks = vi.hoisted(() => ({
  teamAssets: vi.fn(async () => [
    {
      code_graph_id: 'c1',
      repo_name: 'r',
      repo_url: 'https://example.com/r.git',
      branch: 'main',
      status: 'ready',
    },
  ]),
  agentFixed: vi.fn(async () => []),
  get: vi.fn(async () => null),
}));
vi.mock('@/lib/api/knowledge-api', () => ({
  knowledgeApi: { code: codeMocks },
}));

beforeEach(() => resetSeen());

describe('useCodeSources URL sync', () => {
  it('stays on the list at /code', async () => {
    const { result } = renderHook(() => useCodeSources(), {
      wrapper: hookWrapper('/code', '/code/:codeId?'),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.subView).toBe('list');
    expect(result.current.selectedCgId).toBe('');
  });

  it('opens detail on deep link /code/c1', async () => {
    const { result } = renderHook(() => useCodeSources(), {
      wrapper: hookWrapper('/code/c1', '/code/:codeId?'),
    });
    await waitFor(() => expect(result.current.subView).toBe('detail'));
    expect(result.current.selectedCgId).toBe('c1');
  });

  it('openDetail pushes /code/:id and closeDetail returns to /code', async () => {
    const { result } = renderHook(() => useCodeSources(), {
      wrapper: hookWrapper('/code', '/code/:codeId?'),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.openDetail('c9'));
    expect(lastSeen()).toBe('/code/c9');
    expect(result.current.selectedCgId).toBe('c9');
    act(() => result.current.closeDetail());
    expect(lastSeen()).toBe('/code');
    await waitFor(() => expect(result.current.subView).toBe('list'));
  });
});

describe('CodeDetailView missing id', () => {
  function stub(over: Partial<CodeSourcesStore> = {}) {
    return {
      selected: null,
      loading: false,
      closeDetail: vi.fn(),
      ...over,
    } as unknown as CodeSourcesStore;
  }

  it('renders 404 for unknown code id', () => {
    render(
      <MemoryRouter initialEntries={['/code/nope']}>
        <CodeDetailView store={stub()} />
      </MemoryRouter>,
    );
    expect(screen.getByText('404')).toBeTruthy();
  });

  it('shows loading instead of a false 404', () => {
    render(
      <MemoryRouter initialEntries={['/code/c1']}>
        <Routes>
          <Route
            path="/code/:codeId"
            element={<CodeDetailView store={stub({ loading: true })} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText('404')).toBeNull();
  });
});
