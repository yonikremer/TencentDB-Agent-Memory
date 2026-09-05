/**
 * TaskDetail —— Workspace Task Details (Edit title/description, switch status, view participants, delete).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Segment, Text } from 'tea-component';
import { DeleteIcon, EditIcon, UserIcon, UsergroupIcon } from 'tea-icons-react';
import { canEditTask, type Task, type Team } from '@/services';
import { useUserDisplayName } from '@/services/user-profile-store';
import { tea } from '@/lib/tea-bridge';
import { useStatusLabels, type AgentOption, type TaskParticipationView } from '../utils/workbench-utils';

/**
 * Participant chip: visible text displays display_name (falls back to id if cache miss),
 * title preserves semantic meaning as tooltip + user_id for troubleshooting.
 * Extracting a sub-component is required by Rules of Hooks (cannot call useUserDisplayName in a .map loop).
 */
function UserChip({
  userId,
  currentUser,
  tooltip,
}: {
  userId: string;
  currentUser: string;
  tooltip: string;
}) {
  const { t } = useTranslation();
  const name = useUserDisplayName(userId);
  return (
    <span className="_memory-workbench-chip" title={`${tooltip} · ${userId}`}>
      <UserIcon size={12} />
      <Text theme="text">{name || userId}</Text>
      {userId === currentUser && <span className="_memory-workbench-chip-you">{t('common.you.short')}</span>}
    </span>
  );
}

export default function TaskDetail({
  task,
  onUpdateStatus,
  onUpdateTask,
  onDelete,
  canDelete,
  agents,
  team,
  currentUser,
  participation,
}: {
  task: Task;
  onUpdateStatus: (s: Task['status']) => void;
  onUpdateTask: (patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>>) => void;
  /** Delete the current task (permission verification and secondary confirmation are handled uniformly by the outer layer) */
  onDelete: () => void;
  canDelete: boolean;
  agents: AgentOption[];
  /** The team to which the current task belongs — may be null (theoretically it won't be, but a fallback is needed for the case where the team is deleted) */
  team: Team | null;
  currentUser: string;
  /** Current task observation data passed down from the useTeamParticipation bucket */
  participation: TaskParticipationView;
}) {
  const { t } = useTranslation();
  const statusLabels = useStatusLabels();
  // Edit permission: any member in the team can edit tasks (including switching status).
  const canEdit = canEditTask(task, team, currentUser);

  // —— Edit mode: only entered after the user clicks "Edit"; drafts are maintained independently, and are discarded upon cancellation ——
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [draftDesc, setDraftDesc] = useState(task.description);

  // Sync draft when switching task / exiting edit (to avoid staying on draft A after switching to draft B)
  useEffect(() => {
    setEditing(false);
    setDraftTitle(task.title);
    setDraftDesc(task.description);
  }, [task.task_id]);

  function startEdit() {
    setDraftTitle(task.title);
    setDraftDesc(task.description);
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
  }
  function saveEdit() {
    const patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>> = {};
    const title = draftTitle.trim();
    if (title.length === 0) {
      tea.notify.warning(t('task.titleRequired'));
      return;
    }
    if (title !== task.title) patch.title = title;
    if (draftDesc !== task.description) patch.description = draftDesc;

    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    onUpdateTask(patch);
    setEditing(false);
  }

  // Participant display: creator is listed independently; the rest are added to "participating User".
  // Data source is uniformly via the participation-log observation —— the "users who actually started a session" appended when proxy session init is complete.
  // Creator's own agent starting work also counts as a real participation,
  // so creator is no longer filtered (it appears in both "creator" and "participating User", with different semantics).
  const participantUsers = participation.users;

  // "Actual Agent Participating": the agent observed in the session, mapped to the team's agent name;
  // Those not in the team agents list (e.g., already deleted) retain the agent_id as a fallback for display.
  const sessionAgents = useMemo(() => {
    const nameById = new Map(agents.map((a) => [a.id, a.name]));
    return participation.agentIds.map((id) => ({ id, name: nameById.get(id) ?? id }));
  }, [participation.agentIds, agents]);

  return (
    <div className="_memory-workbench-detail-content">
      {/* === Utility line: edit + status toggle (title / task_id / team already displayed in drawer header) === */}
      <div className="_memory-workbench-detail-toolbar">
        {editing ? (
          <>
            <Input
              value={draftTitle}
              onChange={setDraftTitle}
              placeholder={t('task.titlePlaceholder')}
              size="full"
              className="_memory-workbench-title-input"
            />
            <Button onClick={cancelEdit}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={saveEdit}>{t('task.save')}</Button>
          </>
        ) : (
          <>
            {canEdit && (
              <Button type="text" onClick={startEdit} tooltip={t('task.edit.tooltip')}>
                <EditIcon size={14} />
                {t('task.edit')}
              </Button>
            )}
            <Segment
              value={task.status}
              onChange={(v) => onUpdateStatus(v as Task['status'])}
              disabled={!canEdit}
              options={(Object.keys(statusLabels) as Task['status'][]).map((s) => ({
                value: s,
                text: statusLabels[s],
              }))}
            />
          </>
        )}
      </div>

      <!-- === Participants === -->
      <div className="_memory-workbench-people">
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.creator')}</Text>
          <UserChip
            userId={task.creator_user_id}
            currentUser={currentUser}
            tooltip={t('task.creator.tooltip')}
          />
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.participantUsers')}</Text>
          {participantUsers.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            participantUsers.map((u) => (
              <UserChip
                key={u}
                userId={u}
                currentUser={currentUser}
                tooltip={t('task.participantUsers.tooltip')}
              />
            ))
          )}
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.sessionAgents')}</Text>
          {sessionAgents.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            sessionAgents.map((a) => (
              <span
                key={a.id}
                className="_memory-workbench-chip"
                title={t('task.sessionAgents.tooltip', { id: a.id })}
              >
                <UsergroupIcon size={12} />
                <Text theme="text">{a.name}</Text>
              </span>
            ))
          )}
        </div>
      </div>

      {/* === Description === */}
      <div className="_memory-workbench-block">
        <Text theme="label" className="_memory-workbench-block-label">{t('task.description')}</Text>
        {editing ? (
          <Input.TextArea
            value={draftDesc}
            onChange={setDraftDesc}
            rows={6}
            size="full"
            placeholder={t('task.descriptionPlaceholder')}
          />
        ) : (
          <div className="_memory-workbench-desc-view">{task.description}</div>
        )}
      </div>

      <Text theme="weak" className="_memory-workbench-footer">
        {t('task.footer', { created: new Date(task.created_at_ms).toLocaleString(), updated: new Date(task.updated_at_ms).toLocaleString() })}
      </Text>

      <!-- === Dangerous Operation === -->
      {canDelete && (
        <div className="_memory-workbench-danger">
          <Button type="error" onClick={onDelete}>
            <DeleteIcon size={12} /> {t('task.delete.okText')}
          </Button>
        </div>
      )}
    </div>
  );
}
