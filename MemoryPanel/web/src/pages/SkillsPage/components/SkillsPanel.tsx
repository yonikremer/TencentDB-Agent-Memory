/**
 * SkillsPanel — single tab in the App-level top-nav. Shows the team's
 * skill library across two lenses and offers three write actions:
 * import / allocate / fork.
 *
 * Tab semantics:
 *   - team   ＝ the union of all agents' fixed assets within the current team (deduplicated by name);
 *               The user's perspective is "all skills owned by the team", and the data has removed the independent "floating pool" concept.
 *   - fixed  ＝ a single agent's fixed assets (isolated by agent_id).
 *
 * Write operation:
 *   - Import  → Only available under the fixed tab, applied to the currently selected agent.
 *   - Assign  → Available under the team tab after selecting a skill. The backend uses the team_to_agent reference,
 *             and the assigned agent receives a "read-only" copy (shares SKILL.md; editing will affect the team version).
 *   - Fork → Available under the team tab after selecting a skill. The frontend assembles `fetchSkillFull → importSkill`,
 *             and saves a new copy as `<originalName>-fork-<agentId>`, with the agent receiving an independent writable copy.
 *
 * Permission model:
 *   - admin user: fully visible + fully operable
 *   - skill owner: can edit their own skill; can choose whether others can view it
 *   - others: can only see skills that the owner has set as visible (visible = copyable + read-only usage)
 *
 * Refresh strategy: poll on tab change + after every write action. No
 * setInterval — skill mutations are user-driven, the auto-refresh cost
 * is not worth it.
 *
 */
import { useTranslation } from 'react-i18next';
import { Button, Select, Segment } from 'tea-component';
import { DeleteIcon } from 'tea-icons-react';
import { tea } from '@/lib/tea-bridge';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import { AssetSplitLayout } from '@/components/asset/AssetSplitLayout';
import {
  AssetListPanel,
  AssetItemHeader,
  AssetItemName,
  AssetItemId,
  AssetItemBadges,
  AssetItemTime,
} from '@/components/asset/AssetListPanel';
import { UserBadge } from '@/components/asset/UserBadge';
import SkillDetailPane from './SkillDetailPane';
import ImportSkillDialog from './ImportSkillDialog';
import ForkSkillDialog from './ForkSkillDialog';
import { TAB_I18N_KEY, useSkillsPanel, type Tab } from '../hooks/useSkillsPanel';
import '../styles/skills-list.css';

export default function SkillsPanel({
  currentUser: _currentUser,
  isAdmin: _isAdmin,
}: {
  currentUser: string;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const store = useSkillsPanel();

  const {
    // context
    activeTeam,
    activeTeamId,
    myUserId,
    teamAgents,
    agentNameMap,
    // state
    tab,
    setTab,
    selectedAgent,
    setSelectedAgent,
    loading,
    selectedSkillId,
    setSelectedSkillId,
    showImport,
    setShowImport,
    showFork,
    setShowFork,
    deleteLoading,
    exportLoading,
    visibilityMap,
    skills,
    // cache
    skillsWithCache,
    // handlers
    refresh,
    handleDelete,
    handleExport,
    handleToggleVisibility,
    selectedSkill,
  } = store;

  return (
    <div className="_memory-skills-body">
      {/* The Agent selector for fixed assets and the "Agent Assets" option bar on the Code page maintain the same presentation. */}
      <AssetPageHeader
        title={t('skills.title')}
        subtitle={
          activeTeam
            ? t('skills.subtitle.team', { name: activeTeam.name, count: skills.length })
            : t('skills.subtitle.global', { count: skills.length })
        }
        scope={
          <Segment
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            options={(['team', 'fixed'] as Tab[]).map((t2) => ({
              value: t2,
              text: t(TAB_I18N_KEY[t2]),
            }))}
          />
        }
        agent={
          tab === 'fixed' ? (
            <Select
              appearance="button"
              matchButtonWidth
              value={selectedAgent}
              onChange={(value) => {
                setSelectedAgent(value);
                setSelectedSkillId(null);
              }}
              disabled={teamAgents.length === 0}
              placeholder={t('skills.noAgent')}
              options={teamAgents.map((agent) => ({
                value: agent.id,
                text: `${agent.name}（${agent.id}）`,
              }))}
            />
          ) : undefined
        }
        actions={
          <>
            {(() => {
              const canFork = tab === 'team' && !!selectedSkillId;
              const tooltip =
                tab === 'fixed'
                  ? t('skills.fork.tooltip.fixed')
                  : !selectedSkillId
                    ? t('skills.fork.tooltip.team.empty')
                    : undefined;
              return tab === 'fixed' ? null : (
                <Button onClick={() => setShowFork(true)} disabled={!canFork} tooltip={tooltip}>
                  {t('skills.fork')}
                </Button>
              );
            })()}
            {(() => {
              const canExport = !!selectedSkillId;
              const exportTooltip = !selectedSkillId ? t('skills.export.tooltip.empty') : undefined;
              return (
                <Button
                  onClick={handleExport}
                  disabled={!canExport}
                  tooltip={exportTooltip}
                  loading={exportLoading}
                >
                  {t('skills.export')}
                </Button>
              );
            })()}
            <Button
              type="primary"
              onClick={() => setShowImport(true)}
              disabled={teamAgents.length === 0}
              tooltip={teamAgents.length === 0 ? t('skills.import.tooltip.noAgent') : undefined}
              data-guide="import-skill"
            >
              {t('skills.import')}
            </Button>
          </>
        }
      />

      <!-- === Team Assets / Fixed Assets Tab === -->
      <AssetSplitLayout
        storageKey="skills:assetSplitWidth"
        sidebar={
          <AssetListPanel
            title={
              <>
                {t(TAB_I18N_KEY[tab])}
                {tab === 'fixed' && selectedAgent && (
                  <span className="_alp-title-suffix">
                    {' '}
                    · {agentNameMap[selectedAgent] ?? selectedAgent}
                  </span>
                )}
              </>
            }
            count={t('skills.count', { count: skillsWithCache.length })}
            loading={loading}
            items={skillsWithCache}
            selectedId={selectedSkillId}
            getItemId={(s) => s.skill_id}
            onSelect={(s) => setSelectedSkillId(s.skill_id)}
            emptyText={
              tab === 'fixed' && !selectedAgent
                ? t('skills.empty.fixed.noAgent')
                : tab === 'fixed'
                  ? t('skills.empty.fixed.hasAgent', { agent: selectedAgent })
                  : t('skills.empty.team')
            }
            renderItem={(s) => {
              const ownerIsMe = !!myUserId && s.owner_user_id === myUserId;
              const canManage = ownerIsMe;
              const vis = visibilityMap[s.skill_id];
              return (
                <>
                  <AssetItemHeader>
                    <AssetItemName title={s.name}>{s.name}</AssetItemName>
                    {canManage && (
                      <Button
                        type="text"
                        tooltip={ownerIsMe ? t('skills.delete.own') : t('skills.delete.admin')}
                        className="_memory-skill-item-delete"
                        onClick={async (e: any) => {
                          e?.stopPropagation();
                          const ok = await tea.confirm({
                            message: t('skills.delete.confirm', { name: s.name }),
                            description: t('skills.delete.confirm.desc'),
                            okText: t('skills.delete.okText'),
                            cancelText: t('skills.delete.cancelText'),
                          });
                          if (ok) {
                            void handleDelete(s);
                          }
                        }}
                        disabled={deleteLoading}
                      >
                        <DeleteIcon size={14} />
                      </Button>
                    )}
                  </AssetItemHeader>

                  {/* Line 2: Real asset id, monospace gray (same structure as ChatMemory page) */}
                  <AssetItemId>{s.skill_id}</AssetItemId>

                  <AssetItemBadges>
                    {s.owner_user_id && (
                      <UserBadge
                        userId={s.owner_user_id}
                        isCurrentUser={ownerIsMe}
                        youText={t('skills.ownerTag.you')}
                        getTitle={(name) =>
                          t('skills.ownerTag.title', { name, id: s.owner_user_id })
                        }
                      />
                    )}
                    <AssetItemTime>{new Date(s.updated_at_ms).toLocaleString()}</AssetItemTime>
                  </AssetItemBadges>

                  {/* Shared/private switch: the capability of the original "Personal Assets" tab is migrated to the "Agent Assets" tab,
                      only owner can switch; the owner view's getAssets has disabled visibility filtering,
                      so private skills can also get vis. Even if vis occasionally missing, render as private as fallback,
                      to avoid the switch button disappearing after skill is switched to private, making it impossible to switch back to team. */}
                  {tab === 'fixed' && ownerIsMe && (
                    <div style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
                      <Segment
                        value={vis === 'team' ? 'team' : 'private'}
                        onChange={(v) => handleToggleVisibility(s, v as 'team' | 'private')}
                        options={[
                          { value: 'team', text: t('skills.personal.scope.shared') },
                          { value: 'private', text: t('skills.personal.scope.private') },
                        ]}
                      />
                    </div>
                  )}
                </>
              );
            }}
          />
        }
        detail={
          <SkillDetailPane
            skillName={selectedSkill?.name ?? null}
            // Pass the original selectedSkillId (independent state) rather than selectedSkill?.skill_id (list-derived):
            // It has a value as soon as it is selected, is not affected by the loading or refresh timing of the agent/skill list, and avoids the detail panel flashing an empty state before changing to a loading state.
            skillId={selectedSkillId ?? undefined}
            teamId={activeTeamId ?? undefined}
            userId={myUserId}
            // Edit permission is consistent with delete: only the skill's owner (owner_user_id === current user) can edit
            canEdit={!!myUserId && selectedSkill?.owner_user_id === myUserId}
            onChanged={() => void refresh()}
          />
        }
      />

      {/* Modals (only for team/fixed tabs) */}
      {showImport && (
        // The import dialog can be opened in both the team and fixed tabs.
        // target is always fixed —— all skills belong to a specific agent.
        // agentId is only passed in as the default owner under the fixed tab; it is passed as undefined under the team tab,
        // Fallback to selecting the first option from the "Belonging Agent (Required)" dropdown in the popup.
        <ImportSkillDialog
          target="fixed"
          teamId={activeTeamId ?? ''}
          userId={myUserId}
          agents={teamAgents}
          agentId={tab === 'fixed' ? selectedAgent : undefined}
          onClose={() => setShowImport(false)}
          onImported={() => {
            // After the skill is successfully created, the kernel data plane onSkillCreated hook automatically registers the asset
            // + binds it as a fixed-asset owned by the owner agent (visibility defaults to private).
            // The frontend no longer needs to separately call localStorage to store "my assets" — the data source is already a real backend.
            setShowImport(false);
            void refresh();
          }}
        />
      )}
      {showFork &&
        (() => {
          // The skillId/skillName source for the Fork popup: selectedSkill (list from asset/list-accessible)
          const source = selectedSkill
            ? { skillId: selectedSkill.skill_id, skillName: selectedSkill.name }
            : null;
          if (!source) return null;
          return (
            <ForkSkillDialog
              teamId={activeTeamId ?? ''}
              userId={myUserId}
              skillId={source.skillId}
              skillName={source.skillName}
              agents={teamAgents}
              onClose={() => setShowFork(false)}
              onForked={() => {
                setShowFork(false);
                // the new copy forked out is stored in the database as `<original name>-fork-<agentId>` and will appear as a new entry
                void refresh();
              }}
            />
          );
        })()}
    </div>
  );
}
