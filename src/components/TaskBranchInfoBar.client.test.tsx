import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';

const { mockStage, mockNotify } = vi.hoisted(() => ({
  mockStage: vi.fn(),
  mockNotify: vi.fn(),
}));

vi.mock('../store/store', () => ({
  store: { editorCommand: null },
  getProject: vi.fn(() => undefined),
  showNotification: mockNotify,
  getPrChecks: vi.fn(() => ({
    overall: 'failure',
    passing: 1,
    pending: 0,
    failing: 1,
    checks: [],
    checkedAt: '2026-08-04T10:00:00.000Z',
  })),
  getBranchDivergence: vi.fn(() => null),
}));
vi.mock('../store/github', () => ({ stageFailedChecksPrompt: mockStage }));

import { TaskBranchInfoBar } from './TaskBranchInfoBar';

const task = {
  id: 'task-1',
  name: 'Fix CI',
  projectId: 'project-1',
  branchName: 'task/fix-ci',
  worktreePath: '/repo/.worktrees/fix-ci',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
  prUrl: 'https://github.com/acme/app/pull/12',
} as Task;

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function clickFixCi(): void {
  dispose = render(() => <TaskBranchInfoBar task={task} onEditProject={vi.fn()} />, document.body);
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Fix CI');
  if (!found) throw new Error('no Fix CI button');
  found.click();
}

describe('TaskBranchInfoBar Fix CI', () => {
  it('stages the failed checks prompt for the task PR', async () => {
    mockStage.mockResolvedValue(true);
    clickFixCi();

    expect(mockStage).toHaveBeenCalledWith('task-1', {
      number: 12,
      url: 'https://github.com/acme/app/pull/12',
    });
    await vi.waitFor(() =>
      expect(mockNotify).toHaveBeenCalledWith(
        'Prompt staged in the task input. Review it, then send.',
      ),
    );
  });

  it('reports when GitHub lists no failed checks', async () => {
    mockStage.mockResolvedValue(false);
    clickFixCi();

    await vi.waitFor(() => expect(mockNotify).toHaveBeenCalledWith('No failed checks found.'));
  });
});
