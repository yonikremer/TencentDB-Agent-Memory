import type { ReactNode } from 'react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

/** Records every pathname the test router visits (back/forward safe assertions). */
export const seenPaths: string[] = [];
export function resetSeen() {
  seenPaths.length = 0;
}

export function Probe() {
  const loc = useLocation();
  seenPaths.push(loc.pathname);
  return null;
}

export function lastSeen(): string | undefined {
  return seenPaths[seenPaths.length - 1];
}

/** Wrapper for renderHook: mounts the hook under a route so useParams/useNavigate work. */
export function hookWrapper(initial: string, routePath: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path={routePath} element={children} />
        </Routes>
        <Probe />
      </MemoryRouter>
    );
  };
}
