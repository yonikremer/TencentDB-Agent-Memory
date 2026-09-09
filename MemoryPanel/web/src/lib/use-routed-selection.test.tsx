import { describe, it, expect, beforeEach } from 'vitest';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { hookWrapper, lastSeen, resetSeen, seenPaths } from '@/test-utils';
import { useRoutedSelection } from './use-routed-selection';

function useHarness() {
  const [selected, setSelected] = useState<string | null>(null);
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const sync = useRoutedSelection({
    navigate,
    routeId: id ?? '',
    selectedId: selected,
    listPath: '/items',
    detailPath: (x) => `/items/${x}`,
    onEnter: setSelected,
    onExit: () => setSelected(null),
  });
  return { selected, ...sync };
}

function renderAt(path: string) {
  return renderHook(() => useHarness(), {
    wrapper: hookWrapper(path, '/items/:id?'),
  });
}

beforeEach(() => resetSeen());

describe('useRoutedSelection', () => {
  it('enters detail on deep link', () => {
    const { result } = renderAt('/items/a');
    expect(result.current.selected).toBe('a');
  });

  it('stays on list without id', () => {
    const { result } = renderAt('/items');
    expect(result.current.selected).toBeNull();
  });

  it('openDetail pushes URL and selects', () => {
    const { result } = renderAt('/items');
    act(() => result.current.openDetail('b'));
    expect(lastSeen()).toBe('/items/b');
    expect(result.current.selected).toBe('b');
  });

  it('openDetail on the same id is a no-op', () => {
    const { result } = renderAt('/items/a');
    const n = seenPaths.length;
    act(() => result.current.openDetail('a'));
    expect(seenPaths.length).toBe(n);
    expect(result.current.selected).toBe('a');
  });

  it('closeDetail returns to list and clears', () => {
    const { result } = renderAt('/items/a');
    act(() => result.current.closeDetail());
    expect(lastSeen()).toBe('/items');
    expect(result.current.selected).toBeNull();
  });
});
