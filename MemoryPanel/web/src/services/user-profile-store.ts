/**
 * user-profile-store.ts — User display name cache.
 *
 * Fetch display_name from backend usersApi.get() and cache it in memory to avoid repeated requests.
 */

import { useState, useEffect, useCallback } from 'react';

// Memory cache: user_id → display_name
const _displayNameCache = new Map<string, string>();
const _fetching = new Set<string>();
const _subscribers = new Set<() => void>();

function notify() { _subscribers.forEach((fn) => fn()); }

/** Batch write display name cache (e.g., when team-member/list already has username). */
export function seedDisplayNameCache(entries: Array<{ user_id: string; username?: string }>): void {
  let changed = false;
  for (const { user_id, username } of entries) {
    if (!user_id || !username?.trim()) continue;
    const name = username.trim();
    if (_displayNameCache.get(user_id) === name) continue;
    _displayNameCache.set(user_id, name);
    changed = true;
  }
  if (changed) notify();
}

/**
 * Subscribe to the display name of the specified user. Prefer memory cache; asynchronously fetch from the backend when not cached.
 */
export function useUserDisplayName(user_id: string | null | undefined): string {
  const [, force] = useState(0);
  useEffect(() => {
    const sub = () => force((n) => n + 1);
    _subscribers.add(sub);
    return () => { _subscribers.delete(sub); };
  }, []);

  if (!user_id) return '';
  const cached = _displayNameCache.get(user_id);
  if (cached) return cached;

  // Not cached → fetch asynchronously
  if (!_fetching.has(user_id)) {
    _fetching.add(user_id);
    import('@/lib/teamApi').then(({ usersApi }) => {
      usersApi.get(user_id)
        .then((u) => {
          const name = u.display_name || u.username || user_id;
          _displayNameCache.set(user_id, name);
          notify();
        })
        .catch(() => { /* silent failure */ })
        .finally(() => { _fetching.delete(user_id); });
    });
  }

  return user_id; // Display user_id before pull is complete
}

/**
 * Parser for batch scenarios (e.g., list tooltips that need to join multiple usernames).
 * Returns a stable function reference; triggers fetching of uncached ids during rendering, and triggers re-rendering via subscription after the cache is ready.
 * Shares the same cache/subscription as useUserDisplayName, so their parsing results are consistent.
 */
export function useDisplayNameResolver(): (userId: string) => string {
  const [, force] = useState(0);
  useEffect(() => {
    const sub = () => force((n) => n + 1);
    _subscribers.add(sub);
    return () => { _subscribers.delete(sub); };
  }, []);

  return useCallback((userId: string) => {
    if (!userId) return '';
    const cached = _displayNameCache.get(userId);
    if (cached) return cached;
    if (!_fetching.has(userId)) {
      _fetching.add(userId);
      import('@/lib/teamApi').then(({ usersApi }) => {
        usersApi.get(userId)
          .then((u) => {
            const name = u.display_name || u.username || userId;
            _displayNameCache.set(userId, name);
            notify();
          })
          .catch(() => { /* silent failure */ })
          .finally(() => { _fetching.delete(userId); });
      });
    }
    return userId;
  }, []);
}
