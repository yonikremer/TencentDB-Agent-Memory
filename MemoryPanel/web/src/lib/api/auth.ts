/**
 * api/auth.ts — Login verification + environment binding.
 *
 * Login flow:
 *   ① GET /meta/instances to select instance
 *   ② User enters their own user_key (sk-mem-…)
 *   ③ POST /meta/auth/verify (Header only X-Tdai-Service-Id, body with user_key)
 *   ④ data.valid === true → login successful, frontend writes { instance_id, user_key, user } to session
 * No OAuth, no Cookie; see lib/panelSession.ts.
 */
import { request, metaCall } from './base';
import type { PublicUser } from './types';

export const authVerifyApi = {
  /** Login verification: Header only contains instance ID, user_key only in body (meta-api.openapi.yaml §auth/verify) */
  verify: (instanceId: string, userKey: string) =>
    metaCall<{ valid: boolean; user?: PublicUser }>(
      'auth/verify',
      { user_key: userKey },
      { 'X-Tdai-Service-Id': instanceId }
    ),
};

// ========================= Environment Bindings =========================
//
// ⚠️ The current deployment has not registered the /api/v1/users/* route, so the following endpoints may return 404.
// Keep the code for compatibility with environments where this route is still enabled; if any page depends on this set of endpoints, please first confirm that the route is registered.

/**
 * environment_bindings: bind the user's environment in external environments (such as IDEs / programming assistants)
 * The external user_id is associated with the platform user, for proxy to use via (environment, environment_user_id)
 * Reverse-lookup team / agent / task.
 *
 * Unique constraint: (environment, environment_user_id) is globally unique; occupied by another person → 409.
 */
export interface EnvironmentBinding {
  id: string;
  user_id: string;
  environment: string;
  environment_user_id: string;
  created_at: string;
  updated_at: string;
}

export const environmentBindingsApi = {
  /** List all bound items of the currently logged-in user */
  list: () => request<EnvironmentBinding[]>('GET', '/api/v1/users/me/environment-bindings'),

  /** Add a binding (idempotent: repeated POST with the same (env, env_user_id) for the same user does not error) */
  create: (data: { environment: string; environment_user_id: string }) =>
    request<EnvironmentBinding>('POST', '/api/v1/users/me/environment-bindings', data),

  /** Delete a binding (only your own can be deleted; deleting others → 403) */
  remove: (id: string) => request<{ ok: boolean }>('DELETE', `/api/v1/users/me/environment-bindings/${id}`),
};
