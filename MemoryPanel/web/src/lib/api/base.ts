/**
 * api/base.ts — API infrastructure.
 *
 * Rules (No Cookie · Stateless):
 *   - Metadata CRUD uniformly goes through POST /api/v1/meta/{action};
 *   - Authentication is cached by the frontend in sessionStorage as instance_id + user_key (see lib/panelSession.ts),
 *     and each request injects the Header X-Tdai-Service-Id + X-Tdai-User-Key (except auth/verify,
 *     where the user_key is only placed in the body, not in the Header);
 *   - agent-fixed-asset/* does not apply to the general "asset" UI (PANEL_CAPABILITIES.assets is false),
 *     skill mounting goes through the v3 data plane fork (skillApi.forkToAgent);
 *   - All functions return Promise<T>, and throw ApiError on failure.
 */
import { getPanelSession, clearPanelSession } from '../panelSession';
import { formatApiErrorMessage } from '../error-message';
import type { MetaEnvelope, PaginatedResult, PublicUser } from './types';

/**
 * General "assets" capability switch.
 * Before consuming assetsApi / agentsApi.getAssets|getFixedAssets|setFixedAssets via UI, first check
 * `PANEL_CAPABILITIES.assets`; when it is false, display the "Not yet available" placeholder and do not make requests that will inevitably return 501.
 */
export const PANEL_CAPABILITIES = {
  assets: false,
} as const;

// ========================= Error =========================

export class ApiError extends Error {
  public code?: number | string;
  public requestId?: string;
  public rawMessage?: string;

  constructor(
    public status: number,
    public statusText: string,
    public body: string,
    opts: { code?: number | string; requestId?: string; rawMessage?: string } = {}
  ) {
    super(formatApiErrorMessage({
      code: opts.code,
      message: opts.rawMessage ?? statusText,
      requestId: opts.requestId,
      httpStatus: status,
      httpStatusText: statusText,
      body,
    }));
    this.name = 'ApiError';
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.rawMessage = opts.rawMessage ?? statusText;
  }
}

// ========================= Base Request =========================

const AUTH_UNAUTHORIZED_EVENT = 'auth:unauthorized';

/** Emit a 401 event, and the App layer listens to it to clear the auth state and display the login page */
function emitUnauthorized() {
  window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
}

/** Listen to 401 event */
export function onUnauthorized(handler: () => void): () => void {
  window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
  return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
}

function parseMetaErrorEnvelope(text: string): {
  code?: number | string;
  requestId?: string;
  rawMessage?: string;
} {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return {};
  try {
    const env = JSON.parse(trimmed) as MetaEnvelope<unknown>;
    if (typeof env?.message === 'string' && env.message.trim()) {
      return {
        code: env.code,
        requestId: env.request_id,
        rawMessage: env.message,
      };
    }
  } catch {
    /* non-JSON error body */
  }
  return {};
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    emitUnauthorized();
    throw new ApiError(res.status, res.statusText, 'Unauthorized');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const env = parseMetaErrorEnvelope(text);
    throw new ApiError(res.status, res.statusText, text, env);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ========================= Meta API Basics =========================

export const META_PREFIX = '/api/v1/meta';
export const META_PAGE_SIZE = 100;

/**
 * Log out / 401 by clearing the frontend session (instance_id + user_key + user cache).
 * Without a Cookie, "clearing the session" means clearing sessionStorage, without involving backend calls.
 */
export function clearSessionCache(): void {
  clearPanelSession();
}

/** Get the currently logged-in user from the current session; throw an error if not logged in (the caller should ensure they are logged in first). */
export async function getCurrentUser(): Promise<PublicUser> {
  const session = getPanelSession();
  if (!session?.user) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return session.user;
}

/**
 * meta public call for transparent proxy: inject specified Header, POST body, parse envelope.
 * `auth/verify` goes through this function but only passes X-Tdai-Service-Id (without user-key),
 * other actions go through `metaPost` (automatically injects dual Headers from session).
 */export async function metaCall<T>(
  action: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>('POST', `${META_PREFIX}/${action}`, body, headers);
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  if (envelope.data === null || envelope.data === undefined) {
    throw new ApiError(200, envelope.message || 'empty meta response', '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message || 'empty meta response',
    });
  }
  return envelope.data;
}

export async function metaPost<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  if (!session) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return metaCall<T>(action, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
}

/**
 * Fetch the full meta list items via pagination (the kernel DEFAULT_PAGINATION = {limit: 20},
 * not passing limit will only return the first 20 items, so list-type reads must use this tool to get the full list).
 *
 * offset must be stepped by `limit`, **not** by `items.length`: interfaces with filtering semantics
 * (such as agent-fixed-asset/list-with-detail, where `total` is the count before filtering and `items` is the filtered collection)
 * if `items.length < limit`, stepping by `items.length` causes the next page to restart from the wrong position,
 * causing duplicate entries; when the entire page is filtered, it may break early and miss the tail data.
 */
export async function metaListAll<T>(action: string, body: Record<string, unknown>): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await metaPost<PaginatedResult<T>>(action, {
      ...body,
      limit: META_PAGE_SIZE,
      offset,
    });
    const batch = page.items ?? [];
    items.push(...batch);
    const total = typeof page.total === 'number' ? page.total : undefined;
    if (batch.length === 0) {
      // Empty page: usually represents reaching the end. However, intermediate pages of interfaces with filter semantics may be entirely empty
      // (total is still the total before filtering), continue advancing here to avoid missing subsequent valid data.
      if (total !== undefined && offset + META_PAGE_SIZE < total) {
        offset += META_PAGE_SIZE;
        continue;
      }
      break;
    }
    offset += META_PAGE_SIZE;
    if (total !== undefined && offset >= total) break;
  }
  return items;
}

/**
 * "Deduplicate requests in progress": when the same key has a request that has not yet settled, reuse the same Promise,
 * After the request ends, immediately remove it from the table (no result caching).
 *
 * Purpose: eliminate double invocation of effects in React 18 StrictMode development mode and concurrent mounting of components
 Causes duplicate network requests to the same interface.
 *
 * Constraints: can only be used for **idempotent read-only** interfaces (list/get). Write operations such as create/revoke are strictly prohibited from being reused,
 * Otherwise, two independent writes would be merged into one.
 */
const inFlightReads = new Map<string, Promise<unknown>>();
export function dedupeInFlight<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inFlightReads.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = factory().finally(() => {
    inFlightReads.delete(key);
  });
  inFlightReads.set(key, p);
  return p;
}
