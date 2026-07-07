import { describe, expect, it } from 'vitest';
import {
  getProjectTaskCount,
  projectRemoveConfirmLabel,
  projectRemoveConfirmMessage,
} from './project-remove-confirmation';

describe('project remove confirmation helpers', () => {
  it('counts open and collapsed tasks for the project', () => {
    expect(
      getProjectTaskCount(
        {
          taskOrder: ['task-1', 'task-2', 'missing-task'],
          collapsedTaskOrder: ['collapsed-1', 'collapsed-other'],
          tasks: {
            'task-1': { projectId: 'project-a' },
            'task-2': { projectId: 'project-b' },
            'collapsed-1': { projectId: 'project-a' },
            'collapsed-other': { projectId: 'project-c' },
          },
        },
        'project-a',
      ),
    ).toBe(2);
  });

  it('uses the task-closing confirmation copy when tasks exist', () => {
    expect(projectRemoveConfirmMessage(3)).toContain('3 open task(s)');
    expect(projectRemoveConfirmLabel(3)).toBe('Remove all');
  });

  it('uses the simple confirmation copy when no tasks exist', () => {
    expect(projectRemoveConfirmMessage(0)).toBe('Are you sure you want to remove this project?');
    expect(projectRemoveConfirmLabel(0)).toBe('Remove');
  });
});
