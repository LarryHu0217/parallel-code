import './Delegation.css';
import { For, Show, createMemo, createSignal, createUniqueId, onMount } from 'solid-js';
import {
  store,
  activateTaskFromPointer,
  getTaskDotStatus,
  uncollapseTask,
  showNotification,
} from '../store/store';
import { getCoordinatorChildren } from '../store/sidebar-order';
import { getChildAttentionSummary } from '../store/sidebar-attention';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { StatusDot, getDotTooltip } from './StatusDot';
import { getTaskAttentionState } from '../store/taskStatus';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { Dialog } from './Dialog';
import { CloseIcon, StopIcon, SyncIcon } from './icons';

interface SubTaskStripProps {
  coordinatorTaskId: string;
}

interface MCPLogEntry {
  level: 'info' | 'error';
  msg: string;
  ts: number;
}

function MCPLogModal(props: { onClose: () => void }) {
  const [logs, setLogs] = createSignal<MCPLogEntry[]>([]);
  const [loading, setLoading] = createSignal(true);
  const titleId = createUniqueId();

  onMount(() => {
    void invoke<MCPLogEntry[]>(IPC.GetMCPLogs).then((entries) => {
      setLogs(entries);
      setLoading(false);
    });
  });

  return (
    <Dialog
      open={true}
      onClose={props.onClose}
      width="680px"
      labelledBy={titleId}
      panelStyle={{
        background: theme.bgElevated,
        'border-radius': 'var(--radius-md)',
        padding: '16px',
        'max-height': '60vh',
        gap: '8px',
      }}
    >
      <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
        <span id={titleId} style={{ 'font-size': sf(12), 'font-weight': '600', color: theme.fg }}>
          MCP Logs
        </span>
        <button
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: theme.fgSubtle,
            'font-size': sf(14),
          }}
          onClick={() => props.onClose()}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <div
        style={{
          'overflow-y': 'auto',
          'font-family': "'JetBrains Mono', monospace",
          'font-size': sf(11),
          background: theme.bgInput,
          'border-radius': 'var(--radius-xs)',
          padding: '8px',
          flex: '1',
          'min-height': '0',
        }}
      >
        <Show when={!loading()} fallback={<span style={{ color: theme.fgSubtle }}>Loading…</span>}>
          <Show
            when={logs().length > 0}
            fallback={<span style={{ color: theme.fgSubtle }}>No MCP log entries yet.</span>}
          >
            <For each={logs()}>
              {(entry) => (
                <div
                  style={{
                    color: entry.level === 'error' ? theme.error : theme.fgMuted,
                    'margin-bottom': '2px',
                  }}
                >
                  <span style={{ color: theme.fgSubtle }}>
                    {new Date(entry.ts).toLocaleTimeString()}{' '}
                  </span>
                  <span style={{ color: entry.level === 'error' ? theme.error : theme.fg }}>
                    [{entry.level}]{' '}
                  </span>
                  {entry.msg}
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
      <div style={{ 'font-size': sf(11), color: theme.fgSubtle }}>
        Showing last 200 entries. Refresh to reload.
        <button
          class="btn-with-icon"
          style={{
            'margin-left': '8px',
            background: 'none',
            border: `1px solid ${theme.border}`,
            cursor: 'pointer',
            color: theme.fgMuted,
            'font-size': sf(11),
            'border-radius': 'var(--radius-xs)',
            padding: '1px 6px',
          }}
          onClick={() => {
            setLoading(true);
            void invoke<MCPLogEntry[]>(IPC.GetMCPLogs).then((entries) => {
              setLogs(entries);
              setLoading(false);
            });
          }}
        >
          <SyncIcon size={12} />
          Refresh
        </button>
      </div>
    </Dialog>
  );
}

export function SubTaskStrip(props: SubTaskStripProps) {
  const [showLogs, setShowLogs] = createSignal(false);
  const summary = createMemo(() => getChildAttentionSummary(props.coordinatorTaskId));

  const subTasks = createMemo(() => {
    const { active, collapsed } = getCoordinatorChildren(props.coordinatorTaskId);
    return [...active, ...collapsed].map((id) => store.tasks[id]).filter(Boolean);
  });

  const taskTone = (task: (typeof store.tasks)[string]) => {
    if (task.landingState === 'landed_pending_review') {
      return { color: theme.warning, label: 'Merged · review pending' };
    }
    if (task.landingState === 'reviewed') {
      return { color: theme.success, label: 'Merged' };
    }
    if (
      task.landingState === 'landed_cleanup_failed' ||
      task.landingState === 'landing_escalated'
    ) {
      return {
        color: theme.warning,
        label:
          task.landingState === 'landed_cleanup_failed'
            ? 'Merged · cleanup failed'
            : 'Merge needs attention',
      };
    }
    if (task.landingState === 'landing_failed') {
      return { color: theme.error, label: 'Merge failed' };
    }
    if (task.signalDoneReceived)
      return {
        color: theme.warning,
        label: task.integrationPolicy === 'review' ? 'Awaiting review' : 'Work complete',
      };
    return null;
  };

  return (
    <>
      <Show when={showLogs()}>
        <MCPLogModal onClose={() => setShowLogs(false)} />
      </Show>
      <Show when={subTasks().length > 0 || summary()}>
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            padding: '4px 10px',
            background: theme.bgInput,
            'border-bottom': `1px solid ${theme.border}`,
            'overflow-x': 'auto',
            'flex-shrink': '0',
          }}
        >
          <span
            style={{
              'font-size': sf(11),
              color: theme.fgSubtle,
              'white-space': 'nowrap',
              'flex-shrink': '0',
            }}
          >
            Subtasks:
          </span>
          <Show when={summary()}>
            {(text) => (
              <span style={{ 'font-size': sf(11), color: theme.fgMuted, 'white-space': 'nowrap' }}>
                {text()}
              </span>
            )}
          </Show>
          <For each={subTasks()}>
            {(task) => (
              <span style={{ display: 'inline-flex', gap: '4px', 'align-items': 'center' }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (task.collapsed) {
                      uncollapseTask(task.id);
                    }
                    activateTaskFromPointer(task.id);
                  }}
                  title={`${task.collapsed ? 'Resume and open: ' : ''}${task.name} — ${taskTone(task)?.label ?? getDotTooltip(getTaskDotStatus(task.id), getTaskAttentionState(task.id))}`}
                  style={{
                    display: 'inline-flex',
                    'align-items': 'center',
                    gap: '4px',
                    padding: '5px 8px',
                    'border-radius': 'var(--radius-sm)',
                    background: taskTone(task)
                      ? `color-mix(in srgb, ${taskTone(task)?.color} 12%, transparent)`
                      : `color-mix(in srgb, ${theme.fgSubtle} 8%, transparent)`,
                    border: `1px solid ${taskTone(task) ? `color-mix(in srgb, ${taskTone(task)?.color} 30%, transparent)` : theme.border}`,
                    color: theme.fgMuted,
                    'font-size': sf(11),
                    'font-family': 'var(--font-ui)',
                    cursor: 'pointer',
                    'white-space': 'nowrap',
                    'max-width': '240px',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'flex-shrink': '0',
                  }}
                >
                  <Show
                    when={taskTone(task)}
                    fallback={
                      <StatusDot
                        status={getTaskDotStatus(task.id)}
                        attention={getTaskAttentionState(task.id)}
                        taskId={task.id}
                        size="sm"
                      />
                    }
                  >
                    {(tone) => (
                      <span style={{ color: tone().color, display: 'inline-flex' }}>
                        <span aria-hidden="true">●</span>
                      </span>
                    )}
                  </Show>
                  <span class="subtask-label">
                    <span class="subtask-name">
                      {task.collapsed ? 'Resume: ' : ''}
                      {task.name}
                    </span>
                    <span
                      class="subtask-status"
                      style={{ color: taskTone(task)?.color ?? theme.fgMuted }}
                    >
                      {taskTone(task)?.label ??
                        getDotTooltip(
                          getTaskDotStatus(task.id),
                          getTaskAttentionState(task.id),
                        ).split(' — ')[0]}
                    </span>
                  </span>
                </button>
                <Show when={task.agentIds.some((id) => store.agents[id]?.status === 'running')}>
                  <button
                    class="delegation-button btn-with-icon"
                    title={`Stop ${task.name}; keep its worktree`}
                    onClick={() => {
                      void Promise.all(
                        task.agentIds.map((agentId) => invoke(IPC.KillAgent, { agentId })),
                      ).catch((error: unknown) => showNotification(String(error)));
                    }}
                  >
                    <StopIcon size={12} />
                    Stop
                  </button>
                </Show>
              </span>
            )}
          </For>
          <Show when={store.verboseLogging}>
            <button
              onClick={() => setShowLogs(true)}
              title="View MCP logs"
              style={{
                'margin-left': 'auto',
                'flex-shrink': '0',
                background: 'none',
                border: `1px solid ${theme.border}`,
                'border-radius': 'var(--radius-sm)',
                cursor: 'pointer',
                color: theme.fgSubtle,
                'font-size': sf(11),
                padding: '1px 6px',
                'white-space': 'nowrap',
              }}
            >
              MCP logs
            </button>
          </Show>
        </div>
      </Show>
      <Show when={subTasks().length === 0 && !summary() && store.verboseLogging}>
        <div
          style={{
            display: 'flex',
            'justify-content': 'flex-end',
            padding: '3px 10px',
            background: theme.bgInput,
            'border-bottom': `1px solid ${theme.border}`,
            'flex-shrink': '0',
          }}
        >
          <button
            onClick={() => setShowLogs(true)}
            title="View MCP logs"
            style={{
              background: 'none',
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-sm)',
              cursor: 'pointer',
              color: theme.fgSubtle,
              'font-size': sf(11),
              padding: '1px 6px',
              'white-space': 'nowrap',
            }}
          >
            MCP logs
          </button>
        </div>
      </Show>
    </>
  );
}
