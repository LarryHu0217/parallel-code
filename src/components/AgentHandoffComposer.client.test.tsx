import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { delegationRequest, refreshDelegationState } from '../store/delegation';
import { loadTaskDiff } from '../lib/load-task-diff';
import type { Task, Agent } from '../store/types';
import { addAgentToTask } from '../store/agents';
import { AgentHandoffComposer } from './AgentHandoffComposer';
import { TourModelMenu } from './understanding/TourModelMenu';

vi.mock('../lib/codex-models', () => ({
  loadCodexModels: vi.fn(),
  codexModels: () => [{ slug: 'codex-test', displayName: 'Codex test' }],
}));

vi.mock('../store/agents', () => ({ addAgentToTask: vi.fn() }));
vi.mock('../store/delegation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/delegation')>()),
  delegationRequest: vi.fn(),
  refreshDelegationState: vi.fn(),
}));
vi.mock('../lib/load-task-diff', () => ({
  loadTaskDiff: vi.fn(),
  getTaskDiffBaseBranch: () => 'main',
}));
const task: Task = {
  id: 'task',
  name: 'Task',
  projectId: 'project',
  branchName: 'feature',
  worktreePath: '/repo',
  agentIds: ['claude', 'codex'],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  savedInitialPrompt: 'Build the handoff',
  gitIsolation: 'worktree',
};
function agent(id: string): Agent {
  return {
    id,
    taskId: task.id,
    def: {
      id,
      name: id,
      command: id,
      args: [],
      resume_args: [],
      skip_permissions_args: [],
      description: '',
    },
    status: 'running',
    generation: 0,
    sessionInstanceId: `${id}-instance`,
    resumed: false,
    exitCode: null,
    signal: null,
    lastOutput: [],
  };
}
let dispose: (() => void) | undefined;
const close = vi.fn();
function button(name: string) {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}
async function mount(selection?: string, recipientAgentId?: string, readyLabel = 'Send') {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <AgentHandoffComposer
        task={store.tasks.task}
        sourceAgentId="claude"
        selection={selection}
        recipientAgentId={recipientAgentId}
        onClose={close}
      />
    ),
    host,
  );
  await vi.waitFor(() => expect(button(readyLabel).disabled).toBe(false));
}
beforeEach(() => {
  setStore('askCodeProvider', 'claude');
  setStore('askCodeModel', 'sonnet');
  setStore('availableAgents', []);
  setStore('tasks', reconcile({ task }));
  setStore('agents', reconcile({ claude: agent('claude'), codex: agent('codex') }));
  vi.mocked(delegationRequest).mockImplementation(async (request) => {
    if (request.action === 'handoffSessions')
      return ['claude', 'codex'].map((agentId) => ({
        agentId,
        taskId: 'task',
        sessionInstanceId: `${agentId}-instance`,
      }));
    return { deliveryId: 'receipt', state: 'waiting' };
  });
  vi.mocked(refreshDelegationState).mockResolvedValue(undefined);
  vi.mocked(loadTaskDiff).mockResolvedValue({
    rawDiff: 'diff --git a/file b/file\n+fix',
    cwd: '/repo',
  });
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.resetAllMocks();
});

it('sends the previewed snapshot once, with exact source and recipient identities', async () => {
  await mount();
  const preview = document.querySelector('pre')?.textContent;
  button('Send').click();
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(delegationRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'handoff',
      sourceAgentId: 'claude',
      sourceSessionInstanceId: 'claude-instance',
      agentId: 'codex',
      sessionInstanceId: 'codex-instance',
      prompt: preview,
    }),
  );
  expect(loadTaskDiff).toHaveBeenCalledOnce();
});

it('preserves custom instructions across preset changes and quotes selected output', async () => {
  await mount('Review finding: restart targets the wrong session.');
  const textarea = document.querySelector('textarea');
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Request type"]');
  if (!textarea || !select) throw new Error('Missing fields');
  textarea.value = 'Verify this finding before editing.';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  select.value = 'plan';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  expect(textarea.value).toBe('Verify this finding before editing.');
  expect(document.querySelector('pre')?.textContent).toContain('Quoted output from');
  expect(loadTaskDiff).not.toHaveBeenCalled();
});

it('keeps draft and request ID after failure, disables duplicate sends while pending', async () => {
  await mount('finding');
  const requests: unknown[] = [];
  vi.mocked(delegationRequest).mockImplementation(async (request) => {
    requests.push(request);
    throw new Error('Queue unavailable');
  });
  button('Send').click();
  expect(button('Queuing…').disabled).toBe(true);
  await vi.waitFor(() => expect(document.body.textContent).toContain('Queue unavailable'));
  button('Send').click();
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0]).toEqual(requests[1]);
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('pre')?.textContent).toContain('finding');
});

it('refuses to silently retarget a restarted recipient', async () => {
  await mount();
  setStore('agents', 'codex', 'sessionInstanceId', 'new-instance');
  expect(button('Send').disabled).toBe(true);
});

it('blocks oversized context without truncating the preview', async () => {
  await mount('finding');
  const textarea = document.querySelector('textarea');
  if (!textarea) throw new Error('Missing instructions');
  textarea.value = 'x'.repeat(65537);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  expect(button('Send').disabled).toBe(true);
  expect(document.body.textContent).toContain('exceeds 64 KiB');
});

it('keeps the remaining recipient selectable after the chosen recipient exits, preserving edits', async () => {
  setStore('agents', 'third', agent('third'));
  setStore('tasks', 'task', 'agentIds', ['claude', 'codex', 'third']);
  vi.mocked(delegationRequest).mockResolvedValue(
    ['claude', 'codex', 'third'].map((agentId) => ({
      agentId,
      taskId: 'task',
      sessionInstanceId: `${agentId}-instance`,
    })),
  );
  await mount('Finding to verify');
  const textarea = document.querySelector('textarea');
  if (!textarea) throw new Error('Missing instructions');
  textarea.value = 'My edited instructions';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  setStore('agents', 'codex', 'status', 'exited');
  const select = document.querySelector('select');
  if (!select) throw new Error('Missing recipient picker');
  expect(button('Send').disabled).toBe(true);
  select.value = 'third';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  expect(button('Send').disabled).toBe(false);
  expect(textarea.value).toBe('My edited instructions');
  expect(document.querySelector('pre')?.textContent).toContain('Finding to verify');
});

it('refreshes restarted sessions only on request and requires explicit reselection without losing the draft', async () => {
  await mount('Keep this selection');
  const before = document.querySelector('pre')?.textContent;
  setStore('agents', 'codex', 'sessionInstanceId', 'replacement');
  vi.mocked(delegationRequest).mockResolvedValue([
    { agentId: 'claude', taskId: 'task', sessionInstanceId: 'claude-instance' },
    { agentId: 'codex', taskId: 'task', sessionInstanceId: 'replacement' },
  ]);
  button('Refresh sessions').click();
  await vi.waitFor(() => expect(button('Refresh sessions').disabled).toBe(false));
  expect(button('Send').disabled).toBe(true);
  const select = document.querySelector('select');
  if (!select) throw new Error('Missing recipient picker');
  select.value = 'codex';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  expect(button('Send').disabled).toBe(false);
  expect(document.querySelector('pre')?.textContent).toBe(before);
  expect(close).not.toHaveBeenCalled();
});

it('renders inline with collapsed context, without a modal, and supports Escape', async () => {
  await mount('finding');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector<HTMLDetailsElement>('.handoff-context')?.open).toBe(false);
  const textarea = document.querySelector('textarea');
  textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(close).toHaveBeenCalledOnce();
});

it('preselects the explicitly named recipient from the selection menu', async () => {
  setStore('agents', 'third', agent('third'));
  setStore('tasks', 'task', 'agentIds', ['claude', 'codex', 'third']);
  vi.mocked(delegationRequest).mockResolvedValue(
    ['claude', 'codex', 'third'].map((agentId) => ({
      agentId,
      taskId: 'task',
      sessionInstanceId: `${agentId}-instance`,
    })),
  );
  await mount('text', 'third');
  expect(document.querySelector('select')?.value).toBe('third');
  button('Send').click();
  await vi.waitFor(() => expect(close).toHaveBeenCalledWith('third'));
});

it('starts a new reviewer only after explicit submission and queues to its exact session', async () => {
  setStore('agents', reconcile({ claude: agent('claude') }));
  setStore('tasks', 'task', 'agentIds', ['claude']);
  setStore('availableAgents', [agent('codex').def]);
  vi.mocked(addAgentToTask).mockImplementation(async () => {
    setStore('agents', 'fresh', { ...agent('fresh'), sessionInstanceId: undefined });
    setStore('tasks', 'task', 'agentIds', ['claude', 'fresh']);
    return 'fresh';
  });
  await mount(undefined, undefined, 'Start codex review');
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(addAgentToTask).not.toHaveBeenCalled();
  button('Start codex review').click();
  await vi.waitFor(() => expect(button('Starting reviewer…').disabled).toBe(true));
  expect(delegationRequest).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: 'handoff' }),
  );
  setStore('agents', 'fresh', 'sessionInstanceId', 'fresh-instance');
  await vi.waitFor(() => expect(close).toHaveBeenCalledWith('fresh'));
  expect(addAgentToTask).toHaveBeenCalledOnce();
  expect(delegationRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'handoff',
      agentId: 'fresh',
      sessionInstanceId: 'fresh-instance',
    }),
  );
});

it('keeps the draft after a fresh reviewer fails and never spawns a retry automatically', async () => {
  setStore('agents', reconcile({ claude: agent('claude') }));
  setStore('tasks', 'task', 'agentIds', ['claude']);
  setStore('availableAgents', [agent('codex').def]);
  vi.mocked(addAgentToTask).mockImplementation(async () => {
    setStore('agents', 'fresh', { ...agent('fresh'), sessionInstanceId: undefined });
    setStore('tasks', 'task', 'agentIds', ['claude', 'fresh']);
    return 'fresh';
  });
  await mount(undefined, undefined, 'Start codex review');
  const preview = document.querySelector('pre')?.textContent;
  button('Start codex review').click();
  await vi.waitFor(() => expect(button('Starting reviewer…').disabled).toBe(true));
  setStore('agents', 'fresh', 'status', 'exited');
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain('Reviewer did not become available'),
  );
  expect(document.querySelector('pre')?.textContent).toBe(preview);
  expect(addAgentToTask).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});

it('uses the chosen model for a fresh reviewer without changing agent defaults', async () => {
  const def = {
    ...agent('claude').def,
    args: ['--model', 'sonnet'],
    resume_args: ['--model=sonnet', '--resume'],
  };
  setStore('agents', reconcile({ claude: agent('claude') }));
  setStore('tasks', 'task', 'agentIds', ['claude']);
  setStore('availableAgents', [def]);
  await mount(undefined, undefined, 'Start claude review · sonnet');
  document.querySelector<HTMLButtonElement>('[aria-label="Reviewer model"]')?.click();
  button('opus').click();
  button('Start claude review · opus').click();
  await vi.waitFor(() =>
    expect(addAgentToTask).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({
        args: ['--model', 'opus'],
        resume_args: ['--resume', '--model', 'opus'],
      }),
    ),
  );
  expect(store.availableAgents[0].args).toEqual(['--model', 'sonnet']);
});

it('shares model changes in both directions with Generate Tour and switches new reviewer providers', async () => {
  setStore('agents', reconcile({ claude: agent('claude') }));
  setStore('tasks', 'task', 'agentIds', ['claude']);
  setStore('availableAgents', [agent('claude').def, agent('codex').def]);
  await mount(undefined, undefined, 'Start claude review · sonnet');
  const host = document.createElement('div');
  document.body.append(host);
  const disposeTour = render(() => <TourModelMenu />, host);
  try {
    host.querySelector('button')?.click();
    button('opus').click();
    expect(button('Start claude review · opus')).toBeDefined();
    document.querySelector<HTMLButtonElement>('[aria-label="Reviewer model"]')?.click();
    button('Codex test').click();
    expect(store.askCodeProvider).toBe('codex');
    expect(store.askCodeModel).toBe('codex-test');
    expect(document.querySelector('select')?.value).toBe('new:codex');
    expect(host.querySelector('button')?.title).toBe('Model: Codex · codex-test');
    host.querySelector('button')?.click();
    expect(document.querySelector('[aria-checked="true"]')?.textContent?.trim()).toBe('Codex test');
    button('haiku').click();
    expect(document.querySelector('select')?.value).toBe('new:claude');
    expect(button('Start claude review · haiku')).toBeDefined();
  } finally {
    disposeTour();
  }
});

it('closes the model menu on Tab so the dialog can resume keyboard navigation', async () => {
  setStore('availableAgents', [agent('claude').def]);
  setStore('agents', reconcile({ claude: agent('claude') }));
  setStore('tasks', 'task', 'agentIds', ['claude']);
  await mount(undefined, undefined, 'Start claude review · sonnet');
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Reviewer model"]');
  trigger?.focus();
  trigger?.click();
  button('opus').focus();
  button('opus').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  const recipient = document.querySelector('select');
  expect(document.activeElement).toBe(recipient);
  const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  recipient?.dispatchEvent(arrow);
  expect(arrow.defaultPrevented).toBe(false);
});
