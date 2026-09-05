/**
 * TeamManagementPanel — Team Management.
 *
 * Manage "Team + Member + Agent":
 *   - The top displays the current team overview + team-level action entry (only for creating a Team);
 *     Team-level "Edit / Delete" have been unified to the TeamSwitcher dropdown in the top-left corner (right side of the active team row),
 *     with no duplicate entry in this panel.
 *   - The middle section manages the current team's members: add / delete members by user_id
 *   - The bottom section is the current team's Agent card grid: create / edit / delete
 *
 * Data storage (backend persistence):
 *   - team/members/agent all go through @/lib/teamApi;
 *   - After successful write operations, uniformly call invalidateBackendCache() to drive useTeams/useAgents to re-fetch;
 *   - Display fields not yet in the backend schema are serialized into the "ui" namespace of agent.metadata_json.
 *
 * Known limitations (accurately reflect the backend's current capabilities, no fake UI):
 *   - Agent owner is fixed to the currently logged-in user by the backend when created; handover is not supported for now;
 *   - Team deletion is a cascading operation (also deletes members/agents/tasks/assets), and only owner / admin can delete it
 *     (the entry point is the TeamSwitcher dropdown).
 *
 * File splitting (this file only retains the combination/arrangement logic, with specific implementation in the same directory:)
 *   - types.ts / useAgentAssets.ts / shared.tsx / AgentGrid.tsx / MemberSection.tsx /
 *     CreateTeamDialog.tsx / CreateAgentDialog.tsx / AgentEditDialog.tsx
 *   - EditTeamDialog has been moved to TeamSwitcher for shared use (@/layouts/GlobalHeader/TeamSwitcher)
 */

import { useState, useMemo } from 'react';
import { Button } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { UsergroupIcon, AddIcon } from 'tea-icons-react';
import {
  useTeams,
  useAgents,
  isTeamAdmin,
  canManageAsset,
  invalidateBackendCache,
  writeAgentUiMeta,
  type Agent as StoreAgent,
} from '@/services';
import { teamsApi, agentsApi, skillApi } from '@/lib/teamApi';
import { knowledgeApi } from '@/lib/api/knowledge-api';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import './team-management-panel.css';

import { MAX_IMPORTED_CHAT_MEMORIES, importedChatMemoryIds, type AgentCard } from './types';
import { useAgentMountedCounts, syncChatMemoryBindings } from './useAgentAssets';
import AgentGrid from './AgentGrid';
import { TeamHeaderCard } from './TeamHeaderCard';
import { MemberSection, AddMemberDialog, CreatedUserKeyModal } from './MemberSection';
import CreateTeamDialog from './CreateTeamDialog';
import CreateAgentDialog from './CreateAgentDialog';
import AgentEditDialog from './AgentEditDialog';
import DefaultAgentTemplateSection from './DefaultAgentTemplateSection';

function errMsg(e: unknown): string {
  return getErrorMessage(e);
}

// =================== Component ===================

export default function TeamManagementPanel({
  currentUser,
  instanceId: _instanceId,
  isAdmin: _isAdmin,
  section = 'all',
}: {
  currentUser: string;
  instanceId: string;
  isAdmin: boolean;
  /**
   *  Controls which content block this panel renders (used for splitting tabs, functionality remains completely unchanged):
   *   - 'members': Only member management
   *   - 'agents' : Only Agent management
   *   - 'all'    : Render both (backward compatible with old single-page usage)
   */
  section?: 'members' | 'agents' | 'all';
}) {
  const showMembers = section === 'members' || section === 'all';
  const showAgents = section === 'agents' || section === 'all';
  const { activeTeamId, activeTeam, loading: teamsLoading } = useTeams();
  // Only take the current team's agent — agents are strictly tied to their team and will not be displayed across teams
  const { agents: allAgents, loading: agentsLoading } = useAgents(activeTeamId);
  const { t } = useTranslation();
  // Agent Visibility:
  //   - Global admin / current team's admin (owner): can see all agents in the team
  //   - Regular members: can only see agents owned by their owner (created)
  const canSeeAllAgents = !!activeTeam && (_isAdmin || isTeamAdmin(activeTeam, currentUser));
  const agents = useMemo(() => {
    if (!activeTeam || canSeeAllAgents) return allAgents;
    return allAgents.filter((a) => a.owner_user_id === currentUser);
  }, [allAgents, activeTeam, canSeeAllAgents, currentUser]);
  const { counts: mountedCounts, countsLoading } = useAgentMountedCounts(activeTeamId, agents);
  // Display display_name instead of user_id in the notification copy (reuse the global cache, idempotent with no additional requests)
  const resolveUserName = useDisplayNameResolver();

  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [editingAgent, setEditingAgent] = useState<StoreAgent | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdUserKeyInfo, setCreatedUserKeyInfo] = useState<{
    username: string;
    userId: string;
    keyValue: string;
  } | null>(null);

  async function handleCreateAgent(card: Omit<AgentCard, 'id' | 'icon' | 'accent'>) {
    if (!activeTeamId || !activeTeam) return;
    if (
      importedChatMemoryIds(activeTeamId, '__new_agent__', card.chatMemories).length >
      MAX_IMPORTED_CHAT_MEMORIES
    ) {
      tea.notify.error('IMPORT_LIMIT_EXCEEDED');
      return;
    }
    const accents: AgentCard['accent'][] = ['blue', 'purple', 'orange', 'emerald', 'rose', 'slate'];
    const icons = ['🤖', '✨', '⚡', '🎯', '🚀', '🧩'];
    const accent = accents[agents.length % accents.length];
    const icon = icons[agents.length % icons.length];
    setBusy(true);
    try {
      const created = await agentsApi.create(activeTeamId, {
        name: card.name,
        description: card.description,
        prompt: [card.rolePrompt, card.rulesPrompt].filter(Boolean).join('\n\n'),
        visibility: 'team',
      });
      const metadataJson = writeAgentUiMeta(created.metadata_json, {
        role_prompt: card.rolePrompt,
        rules_prompt: card.rulesPrompt,
        icon,
        accent,
      });
      await agentsApi.update(created.agent_id, { metadata_json: metadataJson });

      //  Asset binding uniformly goes through the real mount interface (do not write metadata_json.ui). Execute serially, throw an error if any fails,
      //  and let the outer catch handle the unified prompt — avoid silent failure caused by allSettled leading to "shows bound but actually not bound".
      //   - skill → forkToAgent (copy an independent copy with owner=new agent)
      //   - code_graph / wiki → allocate (reference binding)
      //   - chat_memory → syncChatMemoryBindings
      await syncChatMemoryBindings(activeTeamId, created.agent_id, card.chatMemories);
      for (const skillId of card.skills) {
        await skillApi.forkToAgent(activeTeamId, skillId, created.agent_id);
      }
      for (const id of card.codeGraphs) {
        await knowledgeApi.code.allocate(activeTeamId, id, created.agent_id);
      }
      for (const id of card.llmWikis) {
        await knowledgeApi.wiki.allocate(activeTeamId, id, created.agent_id);
      }

      invalidateBackendCache();
    } catch (err) {
      tea.notify.error(errMsg(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    setShowCreateAgent(false);
  }

  async function handleDeleteAgent(agent: StoreAgent) {
    if (!activeTeamId || !activeTeam) return;
    if (
      !canManageAsset(
        { owner_user_id: agent.owner_user_id, team_id: agent.team_id },
        activeTeam,
        currentUser,
        false,
      )
    ) {
      tea.notify.error(
        t('team.deleteAgent.noPermission', { name: agent.name, id: agent.agent_id, teamName: activeTeam.name, owner: agent.owner_user_id ? resolveUserName(agent.owner_user_id) : t('team.deleteAgent.ownerUnset') }),
      );
      return;
    }
    const ok = await tea.confirm({
      message: t('team.deleteAgent.confirm', { name: agent.name }),
      description: t('team.deleteAgent.desc', { id: agent.agent_id }),
      okText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await agentsApi.delete(agent.agent_id);
      invalidateBackendCache();
    } catch (err) {
      // SKILL_DELETE_FAILED: The console layer deleted part of the skill but was interrupted, and the agent did not archive
      // —— Clearly tell the user to process it in the skill panel and retry, don't just give a single technical error code
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes('SKILL_DELETE_FAILED')) {
        tea.notify.error(
          t('team.deleteAgent.skillFailed', { name: agent.name, raw }),
        );
      } else {
        tea.notify.error(errMsg(err));
      }
    }
  }

  async function handleCreateTeam(input: { name: string; description: string }) {
    setBusy(true);
    try {
      await teamsApi.create(input);
      invalidateBackendCache();
    } catch (err) {
      tea.notify.error(errMsg(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    setShowCreateTeam(false);
  }

  return (
    <div className="_memory-team-mgmt">
      {/* === Header: current team overview + ops ===
        The entry for the team is only in the global TeamSwitcher (App.tsx) in the top-left corner, and it is no longer provided here
        Provide a switch entry for the chips, avoiding two semantically overlapping controls with the global switcher.
        This card only handles three things:
          1. Tell the user "which team I am currently operating on" (name + team_id + number of members + description)
          2. Provide team-level operations (+ Create Team / + Create Agent)
          3. When team has not been selected, provide guidance */}
      {teamsLoading ? (
        <div className="_memory-panel-card">
          <div className="_memory-team-header-row">
            <div className="_memory-team-header-info">
              <div className="_memory-team-header-avatar" style={{ opacity: 0.3 }}>
                …
              </div>
              <div className="_memory-team-header-meta">
                <div className="_memory-team-header-meta-row">
                  <span
                    className="_memory-team-header-name"
                    style={{ color: 'var(--muted-foreground)' }}
                  >
                    {t('team.loading')}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : activeTeam ? (
        <TeamHeaderCard
          team={activeTeam}
          ops={
            <>
              {_isAdmin && (
                <Button onClick={() => setShowCreateTeam(true)} title={t('team.createTeam')}>
                  <AddIcon size={14} /> {t('team.createTeam')}
                </Button>
              )}
            </>
          }
        />
      ) : (
        <div className="_memory-panel-card">
          <div className="_memory-team-header-row">
            <div className="_memory-team-header-empty-hint">
              {t('team.empty.hint')}
            </div>
          </div>
        </div>
      )}

      {teamsLoading ? (
        <div
          className="_memory-panel-card"
          style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted-foreground)' }}
        >
          {t('team.loading')}
        </div>
      ) : !activeTeam ? (
        <EmptyTeamState
          onCreateTeam={_isAdmin ? () => setShowCreateTeam(true) : undefined}
        />
      ) : (
        <>
          {/* === Members === */}
          {showMembers && (
            <MemberSection
              team={activeTeam}
              currentUser={currentUser}
              onAdd={() => setShowAddMember(true)}
              isAdmin={_isAdmin}
            />
          )}

          {/* === Default Agent Template (Visible only to global admin) === */}
          {showAgents && _isAdmin && (
            <DefaultAgentTemplateSection
              teamId={activeTeam.team_id}
              teamName={activeTeam.name}
            />
          )}

          {/* === Agent grid === */}
          {showAgents && (
            <AgentGrid
              activeTeam={activeTeam}
              agents={agents}
              agentsLoading={agentsLoading}
              countsLoading={countsLoading}
              mountedCounts={mountedCounts}
              currentUser={currentUser}
              isAdmin={_isAdmin}
              canSeeAllAgents={canSeeAllAgents}
              onCreateAgent={() => setShowCreateAgent(true)}
              onEditAgent={setEditingAgent}
              onDeleteAgent={handleDeleteAgent}
            />
          )}
        </>
      )}

      {/* Modals */}
      {showCreateTeam && (
        <CreateTeamDialog
          onClose={() => setShowCreateTeam(false)}
          onCreate={handleCreateTeam}
          busy={busy}
        />
      )}
      {showCreateAgent && activeTeam && (
        <CreateAgentDialog
          team={{ team_id: activeTeam.team_id, name: activeTeam.name }}
          currentUser={currentUser}
          onClose={() => setShowCreateAgent(false)}
          onCreated={handleCreateAgent}
          busy={busy}
        />
      )}
      {showAddMember && activeTeam && (
        <AddMemberDialog
          team={activeTeam}
          onClose={() => setShowAddMember(false)}
          onCreatedUser={setCreatedUserKeyInfo}
          currentUser={currentUser}
          isAdmin={_isAdmin}
        />
      )}
      {createdUserKeyInfo && (
        <CreatedUserKeyModal
          info={createdUserKeyInfo}
          onClose={() => setCreatedUserKeyInfo(null)}
        />
      )}
      {editingAgent && activeTeam && (
        <AgentEditDialog
          agent={editingAgent}
          onClose={() => setEditingAgent(null)}
        />
      )}
    </div>
  );
}

// =================== Empty state ===================

/**
 * Empty state guidance.
 *
 * Historical behavior: Any logged-in user can create their own first team (team/create has no admin restriction,
 * the creator automatically becomes the owner), so here admin / non-admin was once not distinguished.
 *
 * Current behavior: The frontend temporarily blocks ordinary users from creating a team,
 * Only admins can see the create CTA; ordinary users only see a "Contact administrator" prompt.
 * The backend team/create itself still has no role restrictions; this blocking is implemented only on the frontend.
 */
function EmptyTeamState({ onCreateTeam }: { onCreateTeam?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="_memory-empty-team">
      <UsergroupIcon size={32} className="_memory-empty-team-icon" />
      <div className="_memory-empty-team-title">{t('team.emptyTeam.title')}</div>
      <div className="_memory-empty-team-desc">
        {onCreateTeam ? t('team.emptyTeam.desc') : t('team.emptyTeam.contactAdmin')}
      </div>
      {onCreateTeam && (
        <Button type="primary" onClick={onCreateTeam} className="_memory-empty-team-cta">
          <AddIcon size={14} /> {t('team.emptyTeam.cta')}
        </Button>
      )}
    </div>
  );
}
