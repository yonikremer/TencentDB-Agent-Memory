import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderHook } from '@testing-library/react';
import { hookWrapper, lastSeen, resetSeen } from '@/test-utils';
import { useChatMemory } from './hooks/useChatMemory';
import { ChatMemoryPage } from './index';
import ChatMemoryPanel from './components/ChatMemoryPanel';

// Stable identities: fresh objects per render would retrigger dependent effects forever.
const stable = vi.hoisted(() => {
  const t = (k: string) => k;
  const teams = { activeTeamId: 't1', activeTeam: { name: 'T' } };
  const agents = { agents: [] as unknown[] };
  const auth = { user_id: 'u1' };
  return { t, teams, agents, auth };
});
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: stable.t }) };
});
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

const memMocks = vi.hoisted(() => ({
  agentFixed: vi.fn(async () => ({ items: [] })),
  teamAssets: vi.fn(async () => ({ items: [] })),
  layer: vi.fn(async () => ({ total: 0, layer: 'L1', items: [] })),
}));
vi.mock('@/lib/teamApi', () => ({
  chatMemoryApi: memMocks,
}));

beforeEach(() => resetSeen());

describe('useChatMemory URL sync', () => {
  it('has no selection at /memory', async () => {
    const { result } = renderHook(() => useChatMemory(), {
      wrapper: hookWrapper('/memory', '/memory/:blockId?/:layer?'),
    });
    await waitFor(() => expect(result.current.blocksLoading).toBe(false));
    expect(result.current.selectedId).toBeNull();
  });

  it('syncs block + layer from /memory/b1/L2', async () => {
    const { result } = renderHook(() => useChatMemory(), {
      wrapper: hookWrapper('/memory/b1/L2', '/memory/:blockId?/:layer?'),
    });
    await waitFor(() => expect(result.current.selectedId).toBe('b1'));
    await waitFor(() => expect(result.current.layer).toBe('L2'));
  });

  it('selectLayer pushes /memory/:id/:layer', async () => {
    const { result } = renderHook(() => useChatMemory(), {
      wrapper: hookWrapper('/memory/b1/L1', '/memory/:blockId?/:layer?'),
    });
    await waitFor(() => expect(result.current.selectedId).toBe('b1'));
    act(() => result.current.selectLayer('L0'));
    expect(lastSeen()).toBe('/memory/b1/L0');
    expect(result.current.layer).toBe('L0');
  });

  it('selectBlock(null) returns to /memory', async () => {
    const { result } = renderHook(() => useChatMemory(), {
      wrapper: hookWrapper('/memory/b1/L1', '/memory/:blockId?/:layer?'),
    });
    await waitFor(() => expect(result.current.selectedId).toBe('b1'));
    act(() => result.current.selectBlock(null));
    expect(lastSeen()).toBe('/memory');
    await waitFor(() => expect(result.current.selectedId).toBeNull());
  });
});

describe('ChatMemoryPage routing', () => {
  it('renders 404 for an unknown layer', () => {
    render(
      <MemoryRouter initialEntries={['/memory/b1/L9']}>
        <Routes>
          <Route path="/memory/:blockId/:layer" element={<ChatMemoryPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('404')).toBeTruthy();
  });

  it('renders 404 for an unknown block id', async () => {
    render(
      <MemoryRouter initialEntries={['/memory/nope']}>
        <Routes>
          <Route path="/memory/:blockId" element={<ChatMemoryPanel />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('404')).toBeTruthy());
  });
});
