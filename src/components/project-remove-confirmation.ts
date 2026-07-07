import type { Task } from '../store/types';

interface ProjectTaskCountSource {
  taskOrder: readonly string[];
  collapsedTaskOrder: readonly string[];
  tasks: Record<string, Pick<Task, 'projectId'> | undefined>;
}

export function getProjectTaskCount(source: ProjectTaskCountSource, projectId: string): number {
  return [...source.taskOrder, ...source.collapsedTaskOrder].filter(
    (taskId) => source.tasks[taskId]?.projectId === projectId,
  ).length;
}

export function projectRemoveConfirmMessage(taskCount: number): string {
  return taskCount > 0
    ? `This project has ${taskCount} open task(s). Removing it will also close all tasks, delete their worktrees and branches.`
    : 'Are you sure you want to remove this project?';
}

export function projectRemoveConfirmLabel(taskCount: number): string {
  return taskCount > 0 ? 'Remove all' : 'Remove';
}
