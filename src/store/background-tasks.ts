import { batch, createEffect, createRoot, createSignal, untrack } from 'solid-js';
import { store, setStore } from './core';
import { AGENT_HOOK_STALE_MS, getAgentHookStatus, type AgentHookStatus } from './agentHookStatus';
import { scrollTaskIntoView } from './focused-panel';
import { setActiveTask } from './navigation';
import { getCoordinatorChildren } from './sidebar-order';
import { getTaskOpenQuestions, isAgentIdle, type TaskOpenQuestion } from './taskStatus';

// Session-only: restarting the app ends the running agents this baseline describes.
const [backgroundTasks, setBackgroundTasks] = createSignal<ReadonlyMap<string, ActivitySnapshot>>(
  new Map(),
);

export function isTaskBackgrounded(taskId: string): boolean {
  return backgroundOwner(taskId) !== undefined;
}

function backgroundOwner(taskId: string): string | undefined {
  if (backgroundTasks().has(taskId)) return taskId;
  const parentId = store.tasks[taskId]?.coordinatedBy;
  return parentId && backgroundTasks().has(parentId) ? parentId : undefined;
}

function taskBlock(taskId: string): string[] {
  return [taskId, ...getCoordinatorChildren(taskId).active];
}

interface AgentActivity {
  /** Process facts; any change is new activity. */
  process: string;
  /** Facts derived from the hook status or, once it is gone, from output heuristics. */
  activity: string;
  hooked: boolean;
  /** When the working/waiting claim was reported; only such claims expire. */
  claimAt?: number;
}

interface ActivitySnapshot {
  task: string;
  agents: ReadonlyMap<string, AgentActivity>;
}

/** Every waiting event is a new ask. A done one is not: Claude's `idle_prompt`
 * re-reports a finished turn, and a new turn already shows as leaving idle. */
function hookMarker(hook: AgentHookStatus | null): unknown {
  if (!hook || hook.state === 'working') return null;
  return hook.state === 'waiting' ? [hook.event, hook.updatedAt] : 'done';
}

function agentActivity(agentId: string, questions: readonly TaskOpenQuestion[]): AgentActivity {
  const agent = store.agents[agentId];
  const hook = getAgentHookStatus(agentId);
  return {
    process: JSON.stringify([agent?.status, agent?.chatState?.error]),
    activity: JSON.stringify([
      isAgentIdle(agentId),
      questions.find((question) => question.agentId === agentId)?.since,
      hookMarker(hook),
    ]),
    hooked: hook !== null,
    claimAt: hook && hook.state !== 'done' ? hook.updatedAt : undefined,
  };
}

/** Ignore ordinary output and working hook heartbeats, but notice individual
 * agents finishing/resuming even when another agent masks the task's status. */
function activitySnapshot(taskId: string): ActivitySnapshot {
  const agents = new Map<string, AgentActivity>();
  const tasks = taskBlock(taskId).map((id) => {
    const task = store.tasks[id];
    const agentIds = task?.agentIds ?? [];
    const questions = getTaskOpenQuestions(id);
    for (const agentId of agentIds) agents.set(agentId, agentActivity(agentId, questions));
    return {
      // Git-derived readiness can disappear during a refresh without any
      // agent activity. Only explicit review requests belong in this baseline.
      review: Boolean(
        task?.needsReview || task?.stepsContent?.at(-1)?.status === 'awaiting_review',
      ),
      // Agent questions are compared per agent; this covers shell terminals.
      question: questions.find((question) => !agentIds.includes(question.agentId)) ?? null,
      done: task?.signalDoneAt,
      notification: task?.stagedNotification?.batchId,
      agentIds,
    };
  });
  return { task: JSON.stringify(tasks), agents };
}

/** A stale hook claim expires without any new event; the heuristics taking over
 * from it are a new baseline, not activity. */
function activityChange(
  baseline: ActivitySnapshot,
  current: ActivitySnapshot,
): 'same' | 'expired' | 'new' {
  if (current.task !== baseline.task) return 'new';
  let change: 'same' | 'expired' = 'same';
  for (const [agentId, now] of current.agents) {
    const then = baseline.agents.get(agentId);
    if (!then || now.process !== then.process) return 'new';
    const expired =
      !now.hooked && then.claimAt !== undefined && Date.now() - then.claimAt >= AGENT_HOOK_STALE_MS;
    // Rebaseline hook expiry even when both sources still report the agent busy.
    if (expired) change = 'expired';
    else if (now.activity !== then.activity) return 'new';
  }
  return change;
}

/** Nearest foreground task, preferring the left neighbor as closing a task does. */
function foregroundNeighbor(taskId: string, block: readonly string[]): string | undefined {
  const index = store.taskOrder.indexOf(taskId);
  const candidates = [
    ...store.taskOrder.slice(0, index).reverse(),
    ...store.taskOrder.slice(index + 1),
  ];
  return candidates.find((id) => !block.includes(id) && !isTaskBackgrounded(id));
}

/** Moving a tile re-inserts its DOM nodes, which drops focus inside it, e.g. in
 * the terminal whose focus just selected this task. Restore it once the DOM settles. */
function keepFocusAcrossReorder(): void {
  if (typeof document === 'undefined') return;
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || focused === document.body) return;
  queueMicrotask(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (lost && focused.isConnected) focused.focus({ preventScroll: true });
  });
}

export function sendTaskToBack(taskId: string): void {
  const task = store.tasks[taskId];
  if (!task || task.collapsed || task.closingStatus || !store.taskOrder.includes(taskId)) return;
  const block = taskBlock(taskId);
  const remaining = store.taskOrder.filter((id) => !block.includes(id));
  const snapshot = activitySnapshot(taskId);
  const neighbor = foregroundNeighbor(taskId, block);
  batch(() => {
    setBackgroundTasks((previous) => {
      const next = new Map(previous);
      for (const id of block) next.delete(id);
      return next.set(taskId, snapshot);
    });
    setStore('taskOrder', [...remaining, ...block]);
    if (store.activeTaskId && block.includes(store.activeTaskId)) {
      if (neighbor) setActiveTask(neighbor);
      else {
        setStore('activeTaskId', null);
        setStore('activeAgentId', null);
      }
    }
  });
}

export function bringTaskToFront(taskId: string): void {
  const owner = backgroundOwner(taskId);
  if (!owner) return;
  batch(() => {
    setBackgroundTasks((previous) => {
      const next = new Map(previous);
      next.delete(owner);
      return next;
    });
    if (!store.taskOrder.includes(owner) || store.tasks[owner]?.collapsed) return;
    const block = taskBlock(owner);
    keepFocusAcrossReorder();
    setStore('taskOrder', [...block, ...store.taskOrder.filter((id) => !block.includes(id))]);
    // Reordering can push the active tile offscreen without changing selection.
    // The helper waits for the DOM update and respects draft focus and focus mode.
    if (store.activeTaskId) scrollTaskIntoView(store.activeTaskId, 'instant');
  });
}

/** Independent of OS notification preferences and window focus. Auto-return
 * changes order only; it never takes focus from the task the user is working on. */
export function startBackgroundTaskWatcher(): () => void {
  return createRoot((dispose) => {
    createEffect(() => {
      for (const [taskId, baseline] of backgroundTasks()) {
        const task = store.tasks[taskId];
        const current = activitySnapshot(taskId);
        const change = activityChange(baseline, current);
        if (
          !task ||
          task.collapsed ||
          !store.taskOrder.includes(taskId) ||
          taskBlock(taskId).includes(store.activeTaskId ?? '') ||
          change === 'new'
        ) {
          untrack(() => bringTaskToFront(taskId));
        } else if (change === 'expired') {
          untrack(() => setBackgroundTasks((previous) => new Map(previous).set(taskId, current)));
        }
      }
    });
    return dispose;
  });
}
