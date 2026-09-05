/**
 * TaskWorkbench — User Workbench.
 *
 * Converges to two things:
 *   1. List/create/manage tasks under this team;
 *   2. View task history through the log tab.
 *
 * Layout: The page enters as a full-width card grid; clicking a card pulls out a Drawer to view details and settings.
 * (Change status, edit title/description, delete).
 *
 * Data flows through the backend chain A (services/backendStore.ts, internally calling the meta interface of @/lib/teamApi).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Text } from 'tea-component';
import {
  useTasks,
  useTeams,
  createTask,
  deleteTask,
  updateTask,
  updateTaskStatus,
  canDeleteTask,
  canEditTask,
} from '@/services';
import { tea } from '@/lib/tea-bridge';
import { TeamHeaderCard } from '@/components/team/TeamHeaderCard';
import TaskCreateDialog, { type TaskDraft } from './TaskCreateDialog';
import BoardView from './BoardView';
import { useTeamParticipation } from '../hooks/useTeamParticipation';
import { errMsg, type AgentOption, type WorkbenchTab } from '../utils/workbench-utils';
import '../styles/task-workbench.css';

function EmptyTeam() {
  const { t } = useTranslation();
  return (
    <Card>
      <Card.Body className="_memory-workbench-empty-card">
        <Text theme="strong" className="_memory-workbench-empty-title">{t('task.emptyTeam.title')}</Text>
        <Text theme="weak" className="_memory-workbench-empty-desc">
          {t('task.emptyTeam.desc')}
        </Text>
      </Card.Body>
    </Card>
  );
}

export default function TaskWorkbench(props: {
  tab?: WorkbenchTab;
  onTabChange?: (tab: WorkbenchTab) => void;
  /** The currently active team id (can be empty: only shows empty state when not selected) */
  activeTeamId: string | null;
  /** Current username (task's creator_user_id) */
  currentUser: string;
  /** The list of Agents that can be associated under the current team (from the same-source data of TeamManagementPanel) */
  agents: AgentOption[];
  /** Whether it is a global admin (retains interface compatibility; admin no longer has task privileges) */
  isAdmin?: boolean;
}) {
  const { t } = useTranslation();
  const { activeTeamId, currentUser, agents } = props;
  // Backend pagination: useTasks calls the Panel aggregation interface based on page + pageSize, and the kernel only returns the current page
  const PAGE_SIZE = 12;
  const [currentPage, setCurrentPage] = useState(1);
  const { tasks, total: tasksTotal, loading: tasksLoading } = useTasks(activeTeamId, currentPage, PAGE_SIZE);
  const { teams, activeTeam } = useTeams();
  const participationByTask = useTeamParticipation(activeTeamId);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Switch to team and reset to page 1
  useEffect(() => { setCurrentPage(1); }, [activeTeamId]);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => b.updated_at_ms - a.updated_at_ms);
  }, [tasks]);

  const selected = useMemo(
    () => (selectedId ? tasks.find((t) => t.task_id === selectedId) ?? null : null),
    [selectedId, tasks]
  );

  /**
   * Create task: team_id is entirely determined by the currently active team and no longer allows dialog to select a team
   * (The only entry point for switching teams is the global TeamSwitcher in the top right corner).
   */
  async function handleCreate(draft: TaskDraft) {
    // Whoever clicks "Create Task" is the creator_user_id.
    const team = teams.find((t) => t.team_id === draft.team_id);
    if (!team) {
      tea.notify.error(`team "${draft.team_id}" ${t('task.emptyTeam.title')}`);
      return;
    }
    try {
      const task = await createTask({
        team_id: draft.team_id,
        creator_user_id: currentUser,
        title: draft.title,
        description: draft.description,
        source_type: draft.source_type,
        source_url: draft.source_url,
        linked_agents: draft.linked_agents
      });
      setSelectedId(task.task_id);
      setShowCreate(false);
    } catch (err) {
      tea.notify.error(errMsg(err));
    }
  }

  return (
    <div className="_memory-workbench-body">
      {!activeTeamId ? (
        <EmptyTeam />
      ) : (
        <>
          {/* Current team overview (same component as team management page) */}
          {activeTeam && <TeamHeaderCard team={activeTeam} />}
          <BoardView
          tasks={sortedTasks}
          tasksLoading={tasksLoading}
          tasksTotal={tasksTotal}
          currentPage={currentPage}
          setCurrentPage={setCurrentPage}
          pageSize={PAGE_SIZE}
          selected={selected}
          onSelect={(id) => setSelectedId(id)}
          onCreate={() => setShowCreate(true)}
          onDelete={async (task) => {
            // Permission: deleting task only allowed for creator / team admin / global admin
            const team = teams.find((t) => t.team_id === task.team_id) ?? null;
            if (!canDeleteTask(task, team, currentUser)) {
              tea.notify.warning(
                t('task.delete.noPermission', { title: task.title, creator: task.creator_user_id })
              );
              return;
            }
            const ok = await tea.confirm({
              message: t('task.delete.confirm', { title: task.title }),
              description: t('task.delete.description', { id: task.task_id }),
              okText: t('task.delete.okText'),
              cancelText: t('task.delete.cancelText'),
            });
            if (ok) {
              try {
                await deleteTask(task.task_id);
                if (selectedId === task.task_id) setSelectedId(null);
              } catch (err) {
                tea.notify.error(errMsg(err));
              }
            }
          }}
          onUpdateStatus={async (task, status) => {
            // Permission: Edit task (including switching status) allows any member / admin within the team
            const team = teams.find((t) => t.team_id === task.team_id) ?? null;
            if (!canEditTask(task, team, currentUser)) {
              tea.notify.warning(t('task.noPermissionEdit'));
              return;
            }
            try {
              await updateTaskStatus(task.task_id, status, currentUser);
            } catch (err) {
              tea.notify.error(errMsg(err));
            }
          }}
          onUpdateTask={async (task, patch) => {
            const team = teams.find((t) => t.team_id === task.team_id) ?? null;
            if (!canEditTask(task, team, currentUser)) {
              tea.notify.warning(t('task.noPermissionEdit'));
              return;
            }
            try {
              await updateTask(task.task_id, patch, currentUser);
            } catch (err) {
              tea.notify.error(errMsg(err));
            }
          }}
          agents={agents}
          teams={teams}
          currentUser={currentUser}
          participationByTask={participationByTask}
          />
        </>
      )}

      {showCreate && activeTeam && (
        // team is determined by the global TeamSwitcher in the top-right corner, and users no longer select it in the dialog;
        // activeTeam here must be non-empty, because the !activeTeamId branch above has already gone to EmptyTeam
        <TaskCreateDialog
          team={{ team_id: activeTeam.team_id, name: activeTeam.name }}
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}
