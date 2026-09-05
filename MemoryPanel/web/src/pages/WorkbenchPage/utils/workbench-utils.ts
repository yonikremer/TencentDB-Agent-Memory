/**
 * workbench-utils —— Shared types, constants, and pure utility functions for the workbench.
 * Extracted from TaskWorkbench.tsx.
 */
import { useTranslation } from 'react-i18next';

export type WorkbenchTab = 'board' | 'logs';

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Task status is simplified to a two-state in the demo phase: in progress / completed.
// The historical pending / blocked / archived states have been taken offline (see normalizeTaskStatus in backendStore.ts).
export function useStatusLabels() {
  const { t } = useTranslation();
  return {
    running: t('task.status.running'),
    completed: t('task.status.completed'),
  };
}

export interface AgentOption {
  id: string;
  name: string;
}

/**
 * task layer aggregated view: bucket by task_id and then dedupe each one.
 *
 * Kernel append-only semantics: for the same (user, agent, task), append one entry each time session init occurs,
 * The database table accumulates redundancy; the frontend performs client-side dedupe based on Set, "running 10 sessions" and
 * "Run 1 time" displays consistently.
 */
export interface TaskParticipationView {
  /** deduplicated user_id list */
  users: string[];
  /** deduplicated agent_id list */
  agentIds: string[];
}

export const EMPTY_VIEW: TaskParticipationView = { users: [], agentIds: [] };

export function participationOf(
  byTask: Map<string, TaskParticipationView>,
  taskId: string,
): TaskParticipationView {
  return byTask.get(taskId) ?? EMPTY_VIEW;
}
