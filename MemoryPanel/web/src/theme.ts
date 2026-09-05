/**
 * theme — dark / light mode state + DOM application.
 *
 * Activation mechanism (Tea + Tailwind both class-driven):
 *   - Tailwind: `dark:` variants keyed on `.dark` (see tailwind.config.js `darkMode: 'class'`).
 *   - Tea Design: dark tokens scoped under `.tea-theme-dark` / `[theme-mode="dark"]`
 *     (see tea-component `default-dark.css`). Our semantic vars in index.css alias
 *     `--tea-color-*`, so they follow automatically once the attribute is set.
 *   - KnowledgeGraph observes `document.body[class, theme-mode]` to rebuild canvas palette.
 *
 * Persistence: explicit choice in localStorage `tdai-memory.theme`.
 * No stored value → follow OS `prefers-color-scheme`, live-updates on OS change.
 */
import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'tdai-memory.theme';
const CHANGE_EVENT = 'tdai-theme-change';

export function getStoredTheme(): ThemeMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null;
  }
}

export function getSystemTheme(): ThemeMode {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function resolveTheme(): ThemeMode {
  return getStoredTheme() ?? getSystemTheme();
}

/** Apply mode to <html> + <body>; persists explicit choice + notifies hook instances. */
export function applyTheme(mode: ThemeMode): void {
  const dark = mode === 'dark';
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.classList.toggle('tea-theme-dark', dark);
  root.classList.toggle('tea-theme-light', !dark);
  root.setAttribute('theme-mode', mode);
  root.style.colorScheme = mode;
  // KnowledgeGraph watches body attributes for palette rebuild — mirror there too.
  document.body.classList.toggle('dark', dark);
  document.body.setAttribute('theme-mode', mode);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* storage unavailable — theme still applies for session */
  }
  window.dispatchEvent(new CustomEvent<ThemeMode>(CHANGE_EVENT, { detail: mode }));
}

export function toggleTheme(): ThemeMode {
  const next: ThemeMode = resolveTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}

/** Sync theme on mount (covers FOUC fallback + body mirror) + OS / cross-tab updates. */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(() =>
    typeof window === 'undefined' ? 'light' : resolveTheme(),
  );

  useEffect(() => {
    applyTheme(resolveTheme());
  }, []);

  useEffect(() => {
    const onCustom = (e: Event) => setTheme((e as CustomEvent<ThemeMode>).detail);
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setTheme(resolveTheme());
    };
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystem = () => {
      if (!getStoredTheme()) applyTheme(getSystemTheme());
    };
    window.addEventListener(CHANGE_EVENT, onCustom);
    window.addEventListener('storage', onStorage);
    mq.addEventListener?.('change', onSystem);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onCustom);
      window.removeEventListener('storage', onStorage);
      mq.removeEventListener?.('change', onSystem);
    };
  }, []);

  const toggle = useCallback(() => setTheme(toggleTheme()), []);
  return { theme, toggle };
}
