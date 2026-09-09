import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderHook } from '@testing-library/react';
import { hookWrapper, lastSeen, resetSeen } from '@/test-utils';
import { useSkillsPanel } from './hooks/useSkillsPanel';
import SkillsPanel from './components/SkillsPanel';

// Stable identities: fresh objects per render would retrigger dependent effects forever.
const stable = vi.hoisted(() => {
  const t = (k: string) => k;
  const teams = { activeTeamId: 't1', activeTeam: { name: 'T' } };
  const session = { user: { user_id: 'u1' } };
  return { t, teams, session };
});
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: stable.t }) };
});
vi.mock('@/services', () => ({
  useTeams: () => stable.teams,
}));
vi.mock('@/lib/panelSession', () => ({
  getPanelSession: () => stable.session,
}));
vi.mock('@/lib/tea-bridge', () => ({
  tea: {
    notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
    confirm: async () => true,
  },
}));
vi.mock('@/services/use-skill-detail-cache', () => ({
  useSkillDetailCache: () => ({
    applyCachedDetail: (s: unknown) => s,
    preload: async () => {},
    cacheVersion: 0,
  }),
}));

const skillMocks = vi.hoisted(() => ({
  listAccessible: vi.fn(async () => []),
  agentsList: vi.fn(async () => []),
  listSkills: vi.fn(async () => ({ items: [] })),
}));
vi.mock('@/lib/teamApi', () => ({
  assetsApi: { listAccessible: skillMocks.listAccessible },
  agentsApi: { list: skillMocks.agentsList },
}));
vi.mock('@/lib/api/skill-api', () => ({
  listSkills: skillMocks.listSkills,
  getSkill: vi.fn(async () => null),
  deleteSkillV3: vi.fn(async () => {}),
  exportSkill: vi.fn(async () => ({})),
}));

beforeEach(() => resetSeen());

describe('useSkillsPanel URL sync', () => {
  it('has no selection at /skills', async () => {
    const { result } = renderHook(() => useSkillsPanel(), {
      wrapper: hookWrapper('/skills', '/skills/:skillId?'),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.selectedSkillId).toBeNull();
  });

  it('selectSkill pushes /skills/:id', async () => {
    const { result } = renderHook(() => useSkillsPanel(), {
      wrapper: hookWrapper('/skills', '/skills/:skillId?'),
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.selectSkill('s9'));
    expect(lastSeen()).toBe('/skills/s9');
    expect(result.current.selectedSkillId).toBe('s9');
  });

  it('syncs selection from deep link /skills/s1', async () => {
    const { result } = renderHook(() => useSkillsPanel(), {
      wrapper: hookWrapper('/skills/s1', '/skills/:skillId?'),
    });
    await waitFor(() => expect(result.current.selectedSkillId).toBe('s1'));
  });
});

describe('SkillsPanel missing id', () => {
  it('renders 404 for unknown skill id', async () => {
    render(
      <MemoryRouter initialEntries={['/skills/missing']}>
        <Routes>
          <Route
            path="/skills/:skillId"
            element={<SkillsPanel currentUser="u1" isAdmin={false} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('404')).toBeTruthy());
  });
});
