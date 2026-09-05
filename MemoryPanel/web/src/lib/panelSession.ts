/**
 * Panel Session — New Panel Frontend Session Cache (localStorage).
 *
 * Connect to docs/architecture/09-new-panel-control-backend-design.md §3.3.2:
 * New Panel Control is a stateless proxy, does not create Cookie/Session; login credentials
 * (*instance_id + user_key*) is held by the frontend and cached in localStorage
 * (Shared across tabs, remains valid when closing tabs), read and inject Header from here for each meta request:
 *   - X-Tdai-Service-Id (= registry id = kernel x-tdai-service-id; early version documentation once used
 *     The name `X-Metadata-Instance-Id` was renamed, starting from meta-api.openapi.yaml v1.1.0,
 *      *Be sure to use the latest contract as the standard, otherwise Control will report 400 MISSING_INSTANCE_ID）
 *   - X-Tdai-User-Key (except auth/verify)
 *
 * Previously used sessionStorage (tab-level), causing re-login when opening a new tab.
 * After switching to localStorage, multiple tabs share the login state, and logout is synchronized via the storage event.
 */
import type { PublicUser } from './teamApi';

export interface PanelSession {
  /** = Registry id = Kernel x-tdai-service-id; Determined when selecting instance on login page */
  instanceId: string;
  /** For display only (name from the instance list), not required */
  instanceName?: string;
  /** User-held API key sk-mem-…; cached after verification via auth/verify */
  userKey: string;
  /** auth/verify response data.user (optional, for display + as source for owner_user_id/creator_user_id) */
  user?: PublicUser;
}

const STORAGE_KEY = 'tdai-panel.session';

/** Read the current session; return null if there is no session or parsing fails (do not throw errors, the caller handles it as not logged in) */
export function getPanelSession(): PanelSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PanelSession;
  } catch {
    return null;
  }
}

/** Write session after successful login (auth/verify returns valid===true) */
export function setPanelSession(session: PanelSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* Privacy mode / storage quota anomaly: silent failure, does not block the in-memory session after login */
  }
}

/** Logout / 401 fallback: clear session */
export function clearPanelSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
