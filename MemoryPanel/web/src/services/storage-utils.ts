/**
 * storage-utils.ts — Shared foundation for the local demo data layer.
 *
 * Shared by agent-template-store / asset-scope-store / user-asset-store /
 * account-store / user-profile-store :
 *   - safeParse: A fault-tolerant JSON.parse that falls back to a default value when parsing fails;
 *   - emitChange / CHANGE_EVENT: Broadcast a global event after a write operation, working with
 *     useChangeNotifier to automatically re-render subscribers (each useXxx hook);
 *   - useChangeNotifier: A simple forceUpdate, listening to CHANGE_EVENT and the browser
 *     Native 'storage' event (cross-tab sync).
 *
 * These stores are all localStorage implementations for the frontend demo phase, and will be replaced in bulk after the backend goes live
 * fetch is sufficient, no changes needed in the UI layer.
 */

import { useEffect, useState } from 'react';

export const CHANGE_EVENT = 'tdai-memory.demo-store-change';

export function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function emitChange(): void {
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* ignore */
  }
}

/** Simple forceUpdate: +1 after triggering by localStorage / custom events. */
export function useChangeNotifier(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onChange = () => setTick((v) => v + 1);
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onChange); // Cross tab sync
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return tick;
}
