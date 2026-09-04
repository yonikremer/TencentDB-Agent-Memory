/**
 * Session registration — builds SessionInfo locally instead of calling TMC.
 *
 * The proxy persists session state independently through SessionStore (L1 memory + L2 Redis/SQLite).
 * It no longer needs to POST /api/v1/proxy/sessions to write sessions into TMC. User identity is taken
 * directly from apiKey → auth/verify.
 */

import type { SessionInfo, SessionRegistrationData } from "./types.js";

/**
 * Builds SessionInfo locally (does not call TMC).
 *
 * @param spaceId Kernel instance ID from the request URL path `/proxy/<spaceId>/...`
 *   (e.g. `mem-example001`). The injector uses it when constructing MetadataClient to set the
 *   `x-tdai-service-id` header — if it is an empty string, the kernel returns
 *   `invalid_user_key`, which is expected behavior (the caller already handles it in the
 *   session init bypass).
 */
export function buildSessionInfo(
  data: SessionRegistrationData,
  userKey?: string,
  spaceId?: string,
): SessionInfo {
  const now = new Date().toISOString();
  return {
    session_id: data.session_id,
    team_id: data.team_id,
    agent_id: data.agent_id,
    user_id: data.user_id,
    task_id: data.task_id,
    user_key: userKey,
    space_id: spaceId,
    created_at: now,
  };
}