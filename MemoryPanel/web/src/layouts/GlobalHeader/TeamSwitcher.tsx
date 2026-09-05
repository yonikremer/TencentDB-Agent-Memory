/**
 * TeamSwitcher — Team switcher embedded in the global top bar
 *
 * Version of the inline pill style after migrating from the sidebar to the top bar: use Tea `Dropdown` to host the popup panel
 * (with built-in capabilities such as positioning, click-to-close overlay, scroll-to-close, etc.), and assemble the panel internally using `List`/`Input`/`Button`.
 *
 * Team editing entry: on the right side of the current active team row (visible to owner / admin), provide "Edit" and "Delete"
 * Icon button, reuse EditTeamDialog + tea.confirm for secondary confirmation. This TeamManagementPanel
 The "Edit Team / Delete Current Team" entries on the Header have been moved here for unified organization.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dropdown, Input, Button } from 'tea-component';
import { ChevronDownIcon, AddIcon, EditIcon, DeleteIcon } from 'tea-icons-react';
import {
  useTeams,
  writeActiveTeamId,
  invalidateBackendCache,
  isTeamAdmin,
} from '@/services';
import { useBackendStore } from '@/stores/backend';
import { type TeamRole } from '@/services/useCurrentRole';
import { teamsApi } from '@/lib/teamApi';
import { getPanelSession } from '@/lib/panelSession';
import { teamColor } from '@/utils/color';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import EditTeamDialog from '@/components/team/EditTeamDialog';
import './team-switcher.css';

export function TeamSwitcher({ userRole }: { userRole: TeamRole | null }) {
  const { t } = useTranslation();
  const { teams, activeTeamId } = useTeams();
  const refreshTeams = useBackendStore((s) => s.refreshTeams);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamDesc, setNewTeamDesc] = useState('');
  const [creating, setCreating] = useState(false);
  // Edit popup visibility state
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);

  const myTeams = teams;
  const active = myTeams.find((tm) => tm.team_id === activeTeamId) ?? null;
  // Current user user_id (panelSession synchronously readable)
  const currentUserId = getPanelSession()?.user?.user_id ?? '';
  // Whether editable / Delete current active team: global admin or current team's owner / admin
  const canManageActiveTeam =
    !!active && (userRole === 'admin' || isTeamAdmin(active, currentUserId));

  function resetCreateForm() {
    setShowCreateTeam(false);
    setNewTeamName('');
    setNewTeamDesc('');
  }

  function pick(team_id: string, close: () => void) {
    // Only switch activeTeamId, do not invalidateTeamCache:
    //  - useAgents/useTasks bucket cache by teamId; when switching to the target team, if there is already a cache (seen before),
    //     it will open instantly without reloading; only fetch when there is no cache —— this is "auto refresh" rather than
    //    "full page refresh".
    //  - invalidateTeamCache deletes the target team cache + broadcasts BACKEND_REFRESH_EVENT,
    //     causing all pages (including unrelated data such as counts/participation) to be re-fetched after switching teams,
    //    Manifesting that "one switch = one full refresh". The invalidateBackendCache after write operations
    //    already ensures data freshness, so the switch itself does not need to force a refresh.
    writeActiveTeamId(team_id);
    close();
  }

  async function handleCreate() {
    const name = newTeamName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await teamsApi.create({ name, description: newTeamDesc.trim() });
      invalidateBackendCache();
      writeActiveTeamId(created.team_id);
      resetCreateForm();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdateTeam(input: { name: string; description: string }) {
    const id = editingTeamId;
    if (!id) return;
    try {
      await teamsApi.update(id, input);
      invalidateBackendCache();
      setEditingTeamId(null);
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    }
  }

  async function handleDeleteTeam(teamId: string, teamName: string, memberCount: number) {
    // Get agent count once (for cascading display) — use store cache to avoid extra requests
    let agentCount = 0;
    try {
      const cached = useBackendStore.getState().agentsByTeam[teamId];
      if (cached) agentCount = cached.length;
    } catch {
      /* Silent: only used for displaying the cascading range, not obtaining it does not affect deletion */
    }
    const ok = await tea.confirm({
      message: t('teamSwitcher.delete.confirm', { name: teamName }),
      description: t('teamSwitcher.delete.desc', {
        members: memberCount,
        agents: agentCount,
      }),
      okText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await teamsApi.delete(teamId);
      // Delete the current active team by clearing activeTeamId, so ensureValidActiveTeamId
      // automatically falls back to the first remaining team (or empty state) after store refresh.
      if (teamId === activeTeamId) writeActiveTeamId(null);
      invalidateBackendCache();
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
    }
  }

  const editingTeam = editingTeamId ? myTeams.find((tm) => tm.team_id === editingTeamId) ?? null : null;

  return (
    <>
      <Dropdown
        appearance="pure"
        clickClose={false}
        matchButtonWidth={false}
        className="_memory-team-switcher-dropdown"
        boxClassName="_memory-team-switcher-box"
        // Silent refresh: only keep the team list in the dropdown fresh, without flipping teamsLoading,
        // otherwise consumers like TeamManagementPanel will enter an overall loading placeholder (manifesting as
        // "when you open the option box to select team, the member/Agents management page refreshes once").
        onOpen={() => { void refreshTeams({ silent: true }); }}
        onClose={resetCreateForm}
        button={
          <button
            type="button"
            className="_memory-team-switcher-trigger"
            title={active?.name ?? t('teamSwitcher.selectTeam')}
          >
            <span className={`_memory-team-switcher-avatar ${active ? teamColor(active.team_id) : 'bg-primary'}`}>
              {(active?.name ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="_memory-team-switcher-meta">
              <span className="_memory-team-switcher-name">{active?.name ?? t('teamSwitcher.selectTeam')}</span>
              <span className="_memory-team-switcher-id">{active?.team_id ?? t('teamSwitcher.noTeam')}</span>
            </span>
            <ChevronDownIcon size={12} className="_memory-team-switcher-chevron" />
          </button>
        }
      >
        {(close) => (
          <div className="_memory-team-switcher-panel">
            <div className="_memory-team-switcher-panel-header">
              <div className="_memory-team-switcher-panel-title">{t('teamSwitcher.title')}</div>
              <div className="_memory-team-switcher-panel-desc">
                {t('teamSwitcher.desc')}
              </div>
            </div>

            <div className="_memory-team-switcher-panel-label">{t('teamSwitcher.teamCount', { count: myTeams.length })}</div>

            <div className="_memory-team-switcher-list-wrap">
              {myTeams.length === 0 ? (
                <div className="_memory-team-switcher-empty">
                  {userRole === 'admin'
                    ? t('teamSwitcher.empty.admin')
                    : t('teamSwitcher.empty.member')}
                </div>
              ) : (
                // Use native ul/li instead of Tea List: Tea's List.Item selected will automatically render ✓
                // and change the padding, and split="divide" will inject padding/border-top, which repeatedly conflicts with the custom
                // card-style row styles (rounded corners + border + spacing) (manifesting as the left side of selected rows being cropped,
                // and the row divider being pressed down by the previous row). Here we control all styles ourselves, and the behavior is more controllable.
                <ul className="_memory-team-switcher-list">
                  {myTeams.map((tm) => {
                    const isActive = tm.team_id === activeTeamId;
                    // Only show edit/delete buttons for the currently active team row, and only owners/admins can operate
                    const showOps = isActive && canManageActiveTeam;
                    return (
                      <li key={tm.team_id} className="_memory-team-switcher-row">
                        <button
                          type="button"
                          className={`_memory-team-switcher-item${isActive ? ' is-active' : ''}`}
                          aria-current={isActive || undefined}
                          onClick={() => pick(tm.team_id, close)}
                        >
                          <span className={`_memory-team-switcher-item-avatar ${teamColor(tm.team_id)}`}>
                            {tm.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="_memory-team-switcher-item-meta">
                            <span className="_memory-team-switcher-item-name">{tm.name}</span>
                            <span className="_memory-team-switcher-item-count">
                              {t('teamSwitcher.memberCount', { count: tm.members.length })}
                            </span>
                          </span>
                          {/* Selected state is conveyed by background color + border, no extra ✓ is displayed —— to avoid conflict with the right
                              action buttons. The action buttons are an absolutely-positioned overlay taking no inline layout width. */}
                        </button>
                        {showOps && (
                          <span className="_memory-team-switcher-item-ops">
                            <button
                              type="button"
                              className="_memory-team-switcher-item-op"
                              title={t('teamSwitcher.edit.tooltip')}
                              aria-label={t('teamSwitcher.edit.tooltip')}
                              onClick={() => setEditingTeamId(tm.team_id)}
                            >
                              <EditIcon size={14} />
                            </button>
                            <button
                              type="button"
                              className="_memory-team-switcher-item-op _memory-team-switcher-item-op-danger"
                              title={t('teamSwitcher.delete.tooltip')}
                              aria-label={t('teamSwitcher.delete.tooltip')}
                              onClick={() => {
                                void handleDeleteTeam(tm.team_id, tm.name, tm.members.length);
                              }}
                            >
                              <DeleteIcon size={14} />
                            </button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="_memory-team-switcher-footer">
              {userRole !== 'admin' ? null : showCreateTeam ? (
                <div className="_memory-team-switcher-create-form">
                  <Input
                    autoFocus
                    size="full"
                    value={newTeamName}
                    onChange={setNewTeamName}
                    placeholder={t('teamSwitcher.teamNamePlaceholder')}
                  />
                  <Input
                    size="full"
                    value={newTeamDesc}
                    onChange={setNewTeamDesc}
                    placeholder={t('teamSwitcher.teamDescPlaceholder')}
                  />
                  <div className="_memory-team-switcher-create-actions">
                    <Button onClick={resetCreateForm}>{t('teamSwitcher.cancel')}</Button>
                    <Button type="primary"
                      loading={creating}
                      disabled={!newTeamName.trim() || creating}
                      onClick={handleCreate}
                    >
                      {t('teamSwitcher.create')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button type="text"
                  className="_memory-team-switcher-create-trigger"
                  onClick={() => setShowCreateTeam(true)}
                >
                  <AddIcon size={14} />
                  {t('teamSwitcher.newTeam')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Dropdown>

      {/* Edit modal is attached outside Dropdown: to avoid Dropdown clickClose interfering with Modal visibility */}
      {editingTeam && (
        <EditTeamDialog
          team={editingTeam}
          onClose={() => setEditingTeamId(null)}
          onSave={handleUpdateTeam}
          busy={false}
        />
      )}
    </>
  );
}