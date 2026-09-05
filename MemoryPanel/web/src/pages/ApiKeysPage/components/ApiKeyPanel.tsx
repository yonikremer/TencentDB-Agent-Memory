/**
 * ApiKeyPanel — User_Key Management (Organization and Permission Groups).
 *
 * Simplified version: the list only displays 4 core fields — key_id / user_id / key_prefix / creation time,
 * No longer display the "name" and "expiration time" columns (correspondingly, the new creation modal no longer requires filling in the name).
 * Tea component: the list uses Table + autotip, the header uses Justify + H3,
 * Destructive operations uniformly go through Modal.confirm for secondary confirmation, and the new creation modal reuses the site-wide unified Modal shell.
 *
 * Backend chain: the new panel (stateless) goes through the meta action `user-key/list|create|revoke`,
 * Transparently proxied by Control to the kernel /v3/meta. The frontend does not directly call the kernel, nor does it use the old REST path.
 * The owner is inferred from the logged-in user_key; the frontend does not need to and cannot pass another user's user_id — naturally satisfying
 * "Users can only see / manage their own keys".
 *
 * Security design (existing kernel behavior, not a trade-off of this component):
 *   - The plaintext `key` only appears once in the `create` response; subsequent `list`/`get` will no longer return it;
 *   - `key_prefix` is a displayable prefix provided by the kernel (e.g., `sk-mem-ab12****`), used for passwordless recognition
 *      and is not equivalent to the plaintext key;
 *   - Therefore, existing keys in the list cannot be "expanded to display the full key"; they can only be revoked.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Moment } from 'moment';
import moment from 'moment';
import {
  Table,
  Card,
  Button,
  Alert,
  Copy,
  Text,
  DatePicker,
  Justify,
  H3,
  Form,
  Modal,
} from 'tea-component';
import { AddIcon } from 'tea-icons-react';
import { userKeysApi, metaInstancesApi, type UserKey } from '@/lib/teamApi';
import { useCurrentRole } from '@/services/useCurrentRole';
import { useAuthStore } from '@/stores/auth';
import { tea } from '@/lib/tea-bridge';
import '../styles/api-key-panel.css';

const { autotip } = Table.addons;

export default function ApiKeyPanel() {
  const { t } = useTranslation();
  const role = useCurrentRole();
  const { auth } = useAuthStore();
  const [keys, setKeys] = useState<UserKey[]>([]);
  const [loading, setLoading] = useState(true);
  // Client access base address (from the current logged-in instance metadata; each instance is different).
  // Prefer proxy_endpoint —— when open-source core+proxy are deployed separately locally, the client should connect to proxy;
  // Fall back to gateway_endpoint when not configured, equivalent to the old behavior (online gateway is in front of proxy, the two are combined).
  const [clientBaseUrl, setClientBaseUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!auth?.instance_id) {
      setClientBaseUrl(null);
      return;
    }
    void metaInstancesApi
      .list()
      .then((list) => {
        if (cancelled) return;
        const hit = list.find((i) => i.instance_id === auth.instance_id);
        setClientBaseUrl(hit?.proxy_endpoint ?? hit?.gateway_endpoint ?? null);
      })
      .catch(() => {
        if (!cancelled) setClientBaseUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [auth?.instance_id]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await userKeysApi.list();
      // Sort by creation time in descending order (the kernel may not guarantee the order)
      list.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
      // Revoked keys are no longer displayed
      setKeys(list.filter((k) => !k.revoked_at));
    } catch (e) {
      tea.notify.error(e);
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- Create new popup ----
  // No longer collect "Name" — the list itself does not display a name column, so users do not need to fill it in when creating.
  const [showCreate, setShowCreate] = useState(false);
  const [newExpiresAt, setNewExpiresAt] = useState<Moment | null>(null);
  const [creating, setCreating] = useState(false);
  // The newly created key (contains full plaintext, displayed only once)
  const [freshKey, setFreshKey] = useState<{ keyId: string; secret: string } | null>(null);

  async function handleCreate() {
    setCreating(true);
    try {
      const key = await userKeysApi.create({
        expires_at: newExpiresAt ? newExpiresAt.endOf('day').toISOString() : undefined,
      });
      setNewExpiresAt(null);
      setShowCreate(false);
      if (key.key_value) {
        setFreshKey({ keyId: key.key_id, secret: key.key_value });
      }
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(key: UserKey) {
    const ok = await tea.confirm({
      message: t('apiKey.confirm.revoke', { name: key.key_prefix || key.key_id }),
      description: t('apiKey.confirm.revoke.desc'),
      okText: t('apiKey.confirm.revoke.ok'),
    });
    if (!ok) return;
    try {
      await userKeysApi.revoke(key.key_id);
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    }
  }

  const formatTime = (iso?: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return (
    <div className="_memory-apikey-body">
      {/* ===== Newly Created Key Hint (Displayed Only Once) ===== */}
      {freshKey && (
        <Alert type="success" onClose={() => setFreshKey(null)}>
          <div className="_memory-apikey-fresh">
            <p className="_memory-apikey-fresh-desc">
              {t('apiKey.fresh.desc', { keyId: freshKey.keyId })}
            </p>
            <div className="_memory-apikey-fresh-code-row">
              <code className="_memory-apikey-fresh-code">{freshKey.secret}</code>
              <Copy
                text={freshKey.secret}
                onCopy={() => {
                  // After successful copy, automatically close the full Key display to avoid plaintext lingering on the screen
                  setFreshKey(null);
                }}
              />
            </div>
          </div>
        </Alert>
      )}

      {/* ===== Page Header (Justify Left-Right Layout) ===== */}
      <Justify
        left={
          <div>
            <H3>{t('apiKey.title')}</H3>
            <Text theme="text" parent="div" style={{ marginTop: 4 }}>
              {t('apiKey.desc')}
            </Text>
          </div>
        }
        right={
          role !== 'admin' ? (
            <Button
              type="primary"
              onClick={() => {
                setShowCreate(true);
                setNewExpiresAt(null);
              }}
              data-guide="create-key"
            >
              <AddIcon size={14} />
              {t('apiKey.create')}
            </Button>
          ) : null
        }
      />

      {/* ===== Key list: key_id / key_prefix / creation time + operations ===== */}
      <Card>
        <Table
          verticalTop
          records={keys}
          recordKey="key_id"
          columns={[
            {
              key: 'key_id',
              header: t('apiKey.table.keyId'),
              render: (key) => (
                <Text
                  parent="code"
                  copyable
                  style={{
                    fontSize: 12,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 2,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {key.key_id}
                </Text>
              ),
            },
            {
              key: 'key_prefix',
              header: t('apiKey.table.keyPrefix'),
              render: (key) => (
                <Text parent="code" style={{ fontSize: 12 }}>
                  {key.key_prefix || '—'}
                </Text>
              ),
            },
            {
              key: 'created_at',
              header: t('apiKey.table.createdAt'),
              width: 180,
              render: (key) => <Text theme="text">{formatTime(key.created_at)}</Text>,
            },
            {
              key: 'expires_at',
              header: t('apiKey.table.expiresAt'),
              width: 180,
              render: (key) => {
                if (key.revoked_at) return <Text theme="weak">{t('apiKey.revoked')}</Text>;
                return key.expires_at ? (
                  <Text theme="text">{formatTime(key.expires_at)}</Text>
                ) : (
                  <Text theme="weak">{t('apiKey.neverExpire')}</Text>
                );
              },
            },
            {
              key: 'actions',
              header: t('apiKey.table.actions'),
              width: 100,
              align: 'right',
              render: (key) => (
                <Button
                  type="text"
                  disabled={!!key.revoked_at}
                  onClick={() => void handleDelete(key)}
                >
                  {t('apiKey.revoke')}
                </Button>
              ),
            },
          ]}
          addons={[
            autotip({
              isLoading: loading,
              emptyText: (
                <div className="_memory-apikey-empty">
                  <div className="_memory-apikey-empty-title">{t('apiKey.empty.title')}</div>
                  <div className="_memory-apikey-empty-desc">{t('apiKey.empty.desc')}</div>
                </div>
              ),
              onRetry: () => void refresh(),
            }),
          ]}
        />
      </Card>

      {/* ===== Integration Guide ===== */}
      {/*
        instance-id is injected from the current login state (auth.instance_id) — users no longer need to manually replace it
        [instance-id] placeholder, and no need to look elsewhere to find which instance you are currently connected to.
        Theoretically, this page will not be reached when not logged in (blocked by LoginGate), but the placeholder fallback is still retained as a safeguard.
      */}
      <Card>
        <Card.Body title={t('apiKey.endpoint.title')}>
          {auth?.instance_name && (
            <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--tea-color-text-secondary)' }}>
              {t('apiKey.endpoint.current')}
              <code>{auth.instance_name}</code>
              <span style={{ opacity: 0.6, marginLeft: 6 }}>({auth.instance_id})</span>
            </div>
          )}
          <div className="_memory-apikey-endpoints">
            {(() => {
              // show loading if base is not pulled; prevent users from copying hardcoded URLs
              if (!clientBaseUrl) {
                return (
                  <Text theme="weak" style={{ fontSize: 11 }}>
                    {t('apiKey.endpoint.loading')}
                  </Text>
                );
              }
              // Remove trailing slash to avoid base + /path forming double slashes (! bypasses closure narrowing)
              const base = clientBaseUrl!.replace(/\/+$/, '');
              const iid = auth?.instance_id ?? '[instance-id]';
              const endpoints: Array<{ label: string; url: string }> = [
                { label: 'CodeBuddy', url: `${base}/codebuddy/${iid}` },
                { label: 'Claude Code', url: `${base}/claude-code/${iid}` },
                // WorkBuddy runs at /workbuddy/<spaceId> (spaceId=instance_id, symmetric with codebuddy).
                // The web version uses OpenAI ChatCompletions at the backend, and the desktop version uses the Responses API; proxy support has been adapted.
                { label: 'WorkBuddy', url: `${base}/workbuddy/${iid}` },
                // codex uses OpenAI Responses API (POST /v1/responses); proxy side
                // Both v1/without v1 paths are registered, conventionally using the base without /v1, client
                // In config.toml, just fill in this address for base_url, and set wire_api="responses".
                { label: 'Codex', url: `${base}/codex/${iid}` },
                // dsh (deepseek-harness) — DeepSeek official agent harness, Web UI session
                // Uses OpenAI Chat Completions. **No /v1 at the end** — the dsh client
                // hardcodes ${baseURL}/chat/completions, same family as CB; the proxy side
                // routes /dsh/{spaceId}/chat/completions, already aligned. The baseURL
                // entered by the user is the address here directly, do not add /v1 at the end.
                { label: 'DeepSeek Harness (dsh)', url: `${base}/dsh/${iid}` },
                // OpenCode — sst/opencode universal terminal AI coding Agent, protocol = standard
                // OpenAI Chat Completions (POST /v1/chat/completions), same family as CB/dsh.
                // proxy side agent-adapters/opencode.ts has already adapted form backfill + full mem: command family.
                { label: 'OpenCode', url: `${base}/opencode/${iid}` },
                { label: 'OpenClaw', url: `${base}/openclaw/default` },
                { label: 'Hermes', url: `${base}/hermes/default` },
              ];
              return endpoints.map((ep) => (
                <div className="_memory-apikey-endpoint" key={ep.label}>
                  <Text theme="label" parent="div" style={{ marginBottom: 4 }}>
                    {ep.label}
                  </Text>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code
                      style={{
                        flex: 1,
                        fontSize: 11,
                        wordBreak: 'break-all',
                        background: 'var(--tea-color-bg-secondary-default)',
                        padding: '4px 8px',
                        borderRadius: 4,
                      }}
                    >
                      {ep.url}
                    </code>
                    <Copy text={ep.url}>
                      <Button>{t('apiKey.endpoint.copy')}</Button>
                    </Copy>
                  </div>
                </div>
              ));
            })()}
          </div>
        </Card.Body>
      </Card>
      {/* ===== New popup: only set the "expiration time" (can be left blank = never expires), no longer need for a name ===== */}
      {showCreate && (
        <Modal
          visible
          caption={t('apiKey.create.caption')}
          size="s"
          onClose={() => setShowCreate(false)}
          disableEscape={creating}
        >
          <Modal.Body>
            <Form>
              <Form.Item
                label={t('apiKey.create.expiresAt')}
                extra={t('apiKey.create.expiresAt.extra')}
              >
                <DatePicker
                  value={newExpiresAt ?? undefined}
                  onChange={(v) => setNewExpiresAt(v)}
                  disabledDate={(d) => !d.isBefore(moment().startOf('day'))}
                  placeholder={t('apiKey.create.expiresAt.placeholder')}
                />
              </Form.Item>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="primary"
              onClick={() => void handleCreate()}
              disabled={creating}
              loading={creating}
            >
              {t('apiKey.create.submit')}
            </Button>
            <Button onClick={() => setShowCreate(false)} disabled={creating}>
              {t('apiKey.create.cancel')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  );
}
