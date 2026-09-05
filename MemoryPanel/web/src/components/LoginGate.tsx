/**
 * LoginGate — The login page before entering the app (integrates with the new panel Control, see 09 design doc §3.3).
 *
 * Login flow (no Cookie, no OAuth, dual-credential authentication via Header):
 *   1. GET /api/v1/meta/instances              → Select memory instance
 *   2. User inputs self-held user_key (sk-mem-…)
 *   3. POST /api/v1/meta/auth/verify（Header only X-Tdai-Service-Id, body with user_key）
 *      → data.valid === true login successful; data.user written to session
 *   4. Frontend caches { instance_id, user_key, user } to localStorage (see lib/panelSession.ts),
 *       After that, each meta request reads the injected double Header from here
 *
 * Design: A bright, minimalist single-column centered style — a full-screen dot-ripple animation background (ParticleWaveBackground,
 * Pure Canvas with zero dependencies, visually referencing React Bits' Particles / DotGrid) + a centered frosted glass card,
 * The card contains a "Select Instance + Enter user_key" form.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, Input, Button, Alert } from 'tea-component';
import { authVerifyApi, metaInstancesApi, type MetadataInstance, type PublicUser } from '@/lib/teamApi';
import { getPanelSession, setPanelSession, clearPanelSession } from '@/lib/panelSession';
import ParticleWaveBackground from './ParticleWaveBackground';
import './login-gate.css';

export interface AuthState {
  /** Display username (display_name || username), retaining the old field name for downstream component compatibility */
  user: string;
  /** Backend ULID —— the true key for all ownership determination (owner_user_id / creator_user_id / team_members.user_id) */
  user_id: string;
  instance_id: string;
  instance_name: string;
  loggedInAt: number;
  /**
   * Whether it is a global admin —— from auth/verify response data.user.user_type === 'system_admin'.
   * admin is a global role, unrelated to whether any team has been created or joined (manages teams, not resources);
   * Only ordinary users (user_type !== 'system_admin') need to query roles by team.members table.
   */
  isAdmin: boolean;
}

// Memory cache —— true persistence is handled by localStorage (lib/panelSession.ts, shared across tabs).
// Here, we provide a synchronous mirror cache for legacy components that "have no prop and directly read identity via readAuth()" (ChatMemoryPanel / WikiSourcesPanel /
// CodeSourcesPanel, etc.).
let _authCache: AuthState | null = null;

export function readAuth(): AuthState | null {
  return _authCache;
}

/** Logout / 401 fallback: clear both the in-memory mirror cache and the instance_id+user_key in localStorage. */
export function clearAuth(): void {
  _authCache = null;
  clearPanelSession();
}

function writeAuthCache(auth: AuthState): void {
  _authCache = auth;
}

function toAuthState(user: PublicUser, instanceId: string, instanceName: string): AuthState {
  return {
    user: user.display_name || user.username,
    user_id: user.user_id,
    instance_id: instanceId,
    instance_name: instanceName,
    loggedInAt: Date.now(),
    isAdmin: user.user_type === 'system_admin',
  };
}

/**
 * Attempt to directly restore the login state using the cached { instance_id, user_key, user } from localStorage;
 * The new panel has no Cookie, so "restore session" means reading the local cache, no need to call the backend.
 * Called when the App starts; if successful, write to the in-memory mirror cache and return, if failed (not logged in / cache incomplete) return null.
 */
export async function resumeSession(): Promise<AuthState | null> {
  const session = getPanelSession();
  if (!session?.user) return null;
  const auth = toAuthState(session.user, session.instanceId, session.instanceName ?? '');
  writeAuthCache(auth);
  return auth;
}

export default function LoginGate({
  onLoggedIn,
}: {
  onLoggedIn: (auth: AuthState) => void;
}) {
  const { t } = useTranslation();
  const [instances, setInstances] = useState<MetadataInstance[]>([]);
  const [instanceId, setInstanceId] = useState('');
  const [userKey, setUserKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instancesError, setInstancesError] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    metaInstancesApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setInstancesError(false);
        setInstances(list);
        if (list.length > 0) setInstanceId(list[0].instance_id);
      })
      .catch((err) => {
        if (cancelled) return;
        setInstancesError(true);
        setError(t('login.error.loadInstances', { detail: err instanceof Error ? ` (${err.message})` : '' }));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!instanceId) {
      setError(t('login.error.selectInstance'));
      return;
    }
    const key = userKey.trim();
    if (!key) {
      setError(t('login.error.emptyKey'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { valid, user } = await authVerifyApi.verify(instanceId, key);
      if (!valid) {
        setError(t('login.error.invalidKey'));
        setSubmitting(false);
        return;
      }
      if (!user) {
        setError(t('login.error.noUser'));
        setSubmitting(false);
        return;
      }
      const instance = instances.find((i) => i.instance_id === instanceId) ?? null;
      setPanelSession({ instanceId, instanceName: instance?.name, userKey: key, user });
      const auth = toAuthState(user, instanceId, instance?.name ?? '');
      writeAuthCache(auth);
      onLoggedIn(auth);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !submitting) void submit();
  }

  return (
    <div className="_tdai-login">
      {/* Brightly glowing dot matrix ripple animation background (pure Canvas, zero external dependencies) */}
      <div className="_tdai-login-bg" aria-hidden="true">
        <ParticleWaveBackground
          className="_tdai-login-bg-canvas"
          gap={22}
          dotRadius={1.6}
          speed={1}
        />
      </div>

      <!-- Centered content area -->
      <main className="_tdai-login-main">
        <div className="_tdai-login-card">
          <img src="/logo.png" alt="Memory Hub" className="_tdai-login-logo" />

          <h1 className="_tdai-login-title">{t('login.welcome')}</h1>
          <p className="_tdai-login-subtitle">{t('login.tagline')}</p>

          <form onSubmit={submit} className="_tdai-login-form">
            {/* Memory Instance Selection — GET /api/v1/meta/instances */}
            <div className="_tdai-login-field">
              <label className="_tdai-login-label" htmlFor="tdai-login-instance">
                {t('login.field.instance')}
              </label>
              <Select
                appearance="button"
                size="full"
                value={instanceId}
                onChange={(value) => {
                  setInstanceId(value);
                  setError(null);
                }}
                disabled={submitting || instances.length === 0}
                placeholder={
                  instancesError ? t('login.placeholder.instanceError') : t('login.placeholder.instance')
                }
                options={instances.map((inst) => ({ value: inst.instance_id, text: inst.name }))}
                boxSizeSync
              />
            </div>

            {/* user_key (sk-mem-…), written to the frontend session after verification via auth/verify */}
            <div className="_tdai-login-field">
              <label className="_tdai-login-label" htmlFor="tdai-login-key">
                {t('login.field.userKey')}
              </label>
              <Input.Password
                size="full"
                value={userKey}
                onChange={(value) => {
                  setUserKey(value);
                  setError(null);
                }}
                onKeyDown={onKeyDown}
                placeholder={t('login.placeholder.userKey')}
                autoComplete="current-password"
                disabled={submitting}
                rules={false}
              />
              <p className="_tdai-login-hint">{t('login.hint.userKey')}</p>
            </div>

            {error && (
              <div className="_tdai-login-alert">
                <Alert type="error">{error}</Alert>
              </div>
            )}

            <Button
              type="primary"
              htmlType="submit"
              className="_tdai-login-submit"
              loading={submitting}
              disabled={submitting || !userKey.trim() || !instanceId}
            >
              {submitting ? t('login.submitting') : t('login.submit')}
            </Button>
          </form>
        </div>

        <p className="_tdai-login-footer">{t('login.footer')}</p>
      </main>
    </div>
  );
}
