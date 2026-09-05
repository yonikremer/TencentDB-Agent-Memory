/**
 * App.tsx — Root Component
 *
 * Responsibilities:
 *   1. Manage login state (zustand auth store, connecting to the sessionStorage session of the new panel Control)
 *   2. Read the local session cache at startup to check if it is valid (checkSession):
 *        - Checking → loading
 *        - Not logged in → LoginGate
 *        - Logged in → RouterProvider (ConsoleLayout + pages)
 *   3.  Initialize event synchronization for team store
 *   4.  Sync react-i18next language → tea-component ConfigProvider,
 *       so that tea-component built-in component text (StatusTip loading, Table no data, etc.)
 *       automatically follows when the user switches language.
 */
import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfigProvider } from 'tea-component';
import LoginGate from '@/components/LoginGate';
import { useAuthStore } from '@/stores/auth';
import { router } from '@/routes';

/** react-i18next language → tea-component locale mapping */
function toTeaLocale(lang: string): 'zh' | 'en' {
  return lang.startsWith('zh') ? 'zh' : 'en';
}

export default function App() {
  const { t, i18n } = useTranslation();
  const auth = useAuthStore((s) => s.auth);
  const setAuth = useAuthStore((s) => s.setAuth);
  const checkSession = useAuthStore((s) => s.checkSession);
  // Current tea-component locale, synced with react-i18next
  const [teaLocale, setTeaLocale] = useState<'zh' | 'en'>(() => toTeaLocale(i18n.language));

  // Listen to react-i18next language switching, and sync to tea-component
  useEffect(() => {
    setTeaLocale(toTeaLocale(i18n.language));
    const handler = (lng: string) => setTeaLocale(toTeaLocale(lng));
    i18n.on('languageChanged', handler);
    return () => i18n.off('languageChanged', handler);
  }, [i18n]);

  // Read whether the { instance_id, user_key, user } cached in sessionStorage at startup is valid
  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const content = (() => {
    if (auth === null) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0f172a]">
          <div className="text-sm text-slate-500 dark:text-slate-400">{t('app.checkingSession')}</div>
        </div>
      );
    }

    if (auth === undefined) {
      return <LoginGate onLoggedIn={(a) => setAuth(a)} />;
    }

    return <RouterProvider router={router} />;
  })();

  return (
    <ConfigProvider locale={teaLocale}>
      {content}
    </ConfigProvider>
  );
}
