/**
 * Auth Store (zustand)
 *
 * Connect to new panel Control (no Cookie, no stateful proxy, see 09 design doc §3.3).
 * Login credentials (instance_id + user_key) are cached in localStorage (lib/panelSession.ts),
 * "Log out"/"Session expired" both only clear the local cache; Control has no logout API and no server-side session table.
 *
 * Multi-tab sync: listen to localStorage changes via storage events.
 *   - Other tabs log in → this tab automatically restores login state (checkSession)
 *   - Other tabs log out / 401 → this tab automatically exits to LoginGate
 *
 * auth three states:
 *   - null       Detect logged-in state (call checkSession at App startup to read localStorage cache)
 *   - undefined Confirm not logged in → render LoginGate
 *   - AuthState logged in → render main interface
 */
import { create } from 'zustand';
import { readAuth, clearAuth, resumeSession, type AuthState } from '@/components/LoginGate';
import { onUnauthorized } from '@/lib/teamApi';
import { clearBackendCache, writeActiveTeamId } from '@/services';

const PANEL_SESSION_KEY = 'tdai-panel.session';

interface AuthStore {
  auth: AuthState | null | undefined;
  /** Login success write (LoginGate's onLoggedIn callback) */
  setAuth: (auth: AuthState) => void;
  /** Logout: clear local localStorage session and return to LoginGate (no backend call) */
  logout: () => Promise<void>;
  /** Read localStorage cache when App starts; regardless of the result, advance auth from null to a determined state */
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  auth: null,

  setAuth: (auth) => {
    set({ auth });
  },

  logout: async () => {
    // The new panel has no server-side session, so clearing the local cache on logout is sufficient; there is no (and no need for) backend logout endpoint.
    // Clear the module-level backend cache (teams/agents/tasks) to avoid new users briefly seeing the previous user's list after login.
    // Use clearBackendCache instead of invalidateBackendCache: the latter broadcasts an event that triggers refetch listeners on mounted pages,
    // causing requests to be sent with the old session Header and re-fetching old data;
    // here we only clear the cache, allowing the newly logged-in user's mounted component to naturally perform the first fetch.
    clearBackendCache();
    // activeTeamId may point to a team that only old users have access to, clear it to avoid new users selecting a team without permissions after login.
    writeActiveTeamId(null);
    clearAuth();
    set({ auth: undefined });
  },

  checkSession: async () => {
    const cached = readAuth();
    if (cached) {
      set({ auth: cached });
      return;
    }
    const auth = await resumeSession();
    set({ auth: auth ?? undefined });
  },
}));

/**
 * Cross-tab sync: listen to the storage event of localStorage.
 *
 * The `storage` event is only triggered when `localStorage` is modified in "other tabs" (writes in this tab do not trigger it),
 * It is very suitable for cross-tab state synchronization.
 *
 *   - Other tab login (write tdai-panel.session) → restore login state in this tab
 *   - Other tab logout / 401 (delete tdai-panel.session) → exit this tab to LoginGate
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== PANEL_SESSION_KEY) return;

    if (e.newValue === null) {
      // Other tabs logged out → This tab exits synchronously
      clearBackendCache();
      writeActiveTeamId(null);
      clearAuth();
      useAuthStore.setState({ auth: undefined });
    } else {
      // Other tab logged in → This tab restores login state
      void useAuthStore.getState().checkSession();
    }
  });
}

// When any meta request returns HTTP 401 (such as a Control validation error falling under this code), clear the global session and return to the login page.
// Under the new panel, this is not the primary logout trigger path (active logout goes through logout()), it is only a fallback.
// Clear the cache just like logout(), otherwise after re-logging in due to 401, you will still briefly see the previous user's list.
// Just register it once when the store module is loaded.
onUnauthorized(() => {
  clearBackendCache();
  writeActiveTeamId(null);
  clearAuth();
  useAuthStore.setState({ auth: undefined });
});
