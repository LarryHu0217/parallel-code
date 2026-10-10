import {
  createMemo,
  createEffect,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from 'solid-js';
import type { SessionCaller } from '../../electron/shared/delegation-types';
import { HANDOFF_PRESETS, compileHandoff, type HandoffPreset } from '../lib/agent-handoff';
import { getTaskDiffBaseBranch, loadTaskDiff } from '../lib/load-task-diff';
import { dialogButtonStyle } from '../lib/theme';
import { errMessage } from '../lib/log';
import { store } from '../store/core';
import { delegationRequest, refreshDelegationState } from '../store/delegation';
import { addAgentToTask } from '../store/agents';
import { setAskCodeProvider } from '../store/ui';
import { isSupportedDelegationAgent, hasUserMcpConfiguration } from '../store/delegation';
import { Dialog } from './Dialog';
import { isAgentChat } from '../store/agent-chat';
import type { Task } from '../store/types';
import { SendIcon } from './icons';
import { AgentModelMenu } from './AgentModelMenu';
import { defaultAskCodeModel, type AskCodeProvider } from '../../electron/shared/ask-code-models';
import { reviewerWithModel } from '../lib/agent-handoff';
import './AgentHandoffComposer.css';

export function AgentHandoffComposer(props: {
  task: Task;
  sourceAgentId: string;
  selection?: string;
  recipientAgentId?: string;
  onClose: (recipientAgentId?: string) => void;
}) {
  const initial = untrack(() => ({
    selection: props.selection,
    taskPrompt: props.task.savedInitialPrompt,
    gitIsolation: props.task.gitIsolation,
  }));
  const titleId = createUniqueId();
  const [sessions, setSessions] = createSignal<SessionCaller[]>([]);
  const [starting, setStarting] = createSignal<{
    id: string;
    from: SessionCaller;
    prompt: string;
  }>();
  const reviewerDefs = () =>
    store.availableAgents.filter(
      (def) =>
        def.available !== false &&
        isSupportedDelegationAgent(def) &&
        !hasUserMcpConfiguration(def.args),
    );
  const newReviewer = () => reviewerDefs().find((def) => recipient() === `new:${def.id}`);
  const [recipient, setRecipient] = createSignal('');
  const reviewerProvider = (): AskCodeProvider | undefined => {
    const command = newReviewer()?.command.split('/').pop();
    return command === 'claude' || command === 'codex' ? command : undefined;
  };
  const model = () => {
    const provider = reviewerProvider();
    return provider
      ? provider === store.askCodeProvider
        ? store.askCodeModel
        : defaultAskCodeModel(provider)
      : '';
  };
  const reviewerProviders = () =>
    (['claude', 'codex'] as const).filter((provider) =>
      reviewerDefs().some((def) => def.command.split('/').pop() === provider),
    );
  const [preset, setPreset] = createSignal<HandoffPreset>(initial.selection ? 'custom' : 'review');
  const [instructions, setInstructions] = createSignal(
    initial.selection
      ? 'Please inspect this and suggest concrete improvements.'
      : HANDOFF_PRESETS.review,
  );
  const [instructionsEdited, setInstructionsEdited] = createSignal(false);
  const [includeTask, setIncludeTask] = createSignal(Boolean(initial.taskPrompt));
  const [includeSelection, setIncludeSelection] = createSignal(Boolean(initial.selection));
  const [includeDiff, setIncludeDiff] = createSignal(
    !initial.selection && initial.gitIsolation !== 'none',
  );
  const [diff, setDiff] = createSignal<{ text: string; capturedAt: string; base: string }>();
  const [loading, setLoading] = createSignal(true);
  const [loadingDiff, setLoadingDiff] = createSignal(false);
  const [diffError, setDiffError] = createSignal('');
  const [error, setError] = createSignal('');
  const [sending, setSending] = createSignal(false);
  createEffect(
    on(
      () => store.askCodeProvider,
      (provider) => {
        // Follow shared preference changes only for an unsent, fresh reviewer.
        if (!newReviewer() || sending()) return;
        const def = reviewerDefs().find((item) => item.command.split('/').pop() === provider);
        if (def && reviewerProvider() !== provider) setRecipient(`new:${def.id}`);
      },
      { defer: true },
    ),
  );
  let instructionsRef: HTMLTextAreaElement | undefined;
  let disposed = false;
  let request: { key: string; id: string } | undefined;
  onCleanup(() => {
    disposed = true;
  });
  const label = (id: string) => {
    const agent = store.agents[id];
    return `${agent?.def.name ?? 'Agent'} · ${props.task.agentIds.indexOf(id) + 1}`;
  };
  const available = (s: SessionCaller) => {
    const agent = store.agents[s.agentId];
    return (
      !!agent &&
      agent.status !== 'exited' &&
      !isAgentChat(props.task, s.agentId) &&
      agent.sessionInstanceId === s.sessionInstanceId &&
      props.task.agentIds.includes(s.agentId)
    );
  };
  const recipients = () =>
    sessions().filter((s) => s.agentId !== props.sourceAgentId && available(s));
  const source = () => sessions().find((s) => s.agentId === props.sourceAgentId && available(s));
  const target = () => recipients().find((s) => s.agentId === recipient());
  const message = createMemo(() =>
    compileHandoff({
      instructions: instructions(),
      taskPrompt: includeTask() ? props.task.savedInitialPrompt : undefined,
      selection:
        includeSelection() && props.selection
          ? { agent: label(props.sourceAgentId), text: props.selection }
          : undefined,
      diff: includeDiff() ? diff() : undefined,
    }),
  );
  const tooLarge = () => new TextEncoder().encode(message()).length > 64 * 1024;
  const canSend = () =>
    !loading() &&
    !sending() &&
    !!source() &&
    (!!target() || !!newReviewer()) &&
    !!instructions().trim() &&
    !tooLarge() &&
    (!includeDiff() || (!!diff() && !loadingDiff() && !diffError()));

  async function captureDiff() {
    if (loadingDiff()) return;
    setLoadingDiff(true);
    setDiffError('');
    try {
      const baseBranch = getTaskDiffBaseBranch(props.task.gitIsolation, props.task.baseBranch);
      const result = await loadTaskDiff({ worktreePath: props.task.worktreePath, baseBranch });
      if (disposed) return;
      setDiff({
        text: result.rawDiff || '(No text changes returned)',
        capturedAt: new Date().toISOString(),
        base: baseBranch ?? 'automatic task baseline',
      });
    } catch (err) {
      if (!disposed) setDiffError(errMessage(err));
    } finally {
      if (!disposed) setLoadingDiff(false);
    }
  }
  async function loadSessions(selectInitial = false) {
    setLoading(true);
    setError('');
    try {
      const result = await delegationRequest<SessionCaller[]>({
        action: 'handoffSessions',
        taskId: props.task.id,
      });
      if (disposed) return;
      setSessions(result);
      // Refresh requires a new explicit choice; never target a replacement silently.
      setRecipient(
        selectInitial
          ? untrack(() => {
              if (
                props.recipientAgentId &&
                recipients().some((s) => s.agentId === props.recipientAgentId)
              )
                return props.recipientAgentId;
              if (props.recipientAgentId) return ''; // Never replace an explicitly chosen, stale recipient.
              const existing = recipients()[0];
              if (existing) return existing.agentId;
              const suggested =
                reviewerDefs().find(
                  (def) => def.command.split('/').pop() === store.askCodeProvider,
                ) ??
                reviewerDefs().find(
                  (def) => def.id !== store.agents[props.sourceAgentId]?.def.id,
                ) ??
                reviewerDefs()[0];
              return suggested ? `new:${suggested.id}` : '';
            })
          : '',
      );
    } catch (err) {
      if (!disposed) setError(errMessage(err));
    } finally {
      if (!disposed) setLoading(false);
    }
  }
  onMount(() => {
    instructionsRef?.focus();
    void loadSessions(true);
    if (includeDiff()) void captureDiff();
  });
  function changePreset(value: HandoffPreset) {
    // Presets never discard the user's edits.
    if (!instructions().trim() || !instructionsEdited()) {
      setInstructions(HANDOFF_PRESETS[value]);
      setInstructionsEdited(false);
    }
    setPreset(value);
    setIncludeDiff(value === 'review' && props.task.gitIsolation !== 'none');
    if (includeDiff() && !diff()) void captureDiff();
  }
  async function queue(
    from: SessionCaller,
    to: { agentId: string; sessionInstanceId: string },
    prompt: string,
  ) {
    const key = JSON.stringify([
      from.agentId,
      from.sessionInstanceId,
      to.agentId,
      to.sessionInstanceId,
      prompt,
    ]);
    if (request?.key !== key) request = { key, id: crypto.randomUUID() };
    try {
      await delegationRequest({
        action: 'handoff',
        taskId: props.task.id,
        sourceAgentId: from.agentId,
        sourceSessionInstanceId: from.sessionInstanceId,
        agentId: to.agentId,
        sessionInstanceId: to.sessionInstanceId,
        prompt,
        requestId: request.id,
      });
      void refreshDelegationState(props.task.id).catch(() => undefined);
      if (!disposed) props.onClose(to.agentId);
    } catch (err) {
      if (!disposed) setError(errMessage(err));
    } finally {
      if (!disposed) setSending(false);
    }
  }
  // Spawning is user initiated. Wait for the exact launched session before queuing;
  // prompt readiness and trust questions are still handled by the existing delivery queue.
  createEffect(() => {
    const pending = starting();
    if (!pending) return;
    const agent = store.agents[pending.id];
    if (agent?.sessionInstanceId && agent.status !== 'exited') {
      setStarting(undefined);
      void queue(
        pending.from,
        { agentId: pending.id, sessionInstanceId: agent.sessionInstanceId },
        pending.prompt,
      );
      return;
    }
    const fail = () => {
      setStarting(undefined);
      setSending(false);
      setError(
        'Reviewer did not become available. Inspect its terminal, then refresh sessions. Your draft is preserved.',
      );
    };
    if (!agent || agent.status === 'exited') {
      fail();
      return;
    }
    const timer = setTimeout(fail, 30_000);
    onCleanup(() => clearTimeout(timer));
  });
  async function send() {
    const from = source(),
      to = target(),
      def = newReviewer();
    if (!canSend() || !from) return;
    setSending(true);
    setError('');
    const prompt = message();
    if (to) {
      await queue(from, to, prompt);
      return;
    }
    if (!def) {
      setSending(false);
      return;
    }
    try {
      const agentId = await addAgentToTask(props.task.id, reviewerWithModel(def, model()));
      if (disposed) return;
      if (!agentId) throw new Error('Could not start reviewer');
      setRecipient(agentId); // Retain the new pane on failure; retry must not spawn another.
      setStarting({ id: agentId, from, prompt });
    } catch (err) {
      if (!disposed) {
        setError(errMessage(err));
        setSending(false);
      }
    }
  }
  const content = (
    <section
      class="agent-handoff"
      aria-labelledby={titleId}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !sending()) {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div class="handoff-heading">
        <h2 id={titleId}>{props.selection ? 'Send selected text' : 'Second opinion'}</h2>
        <p class="handoff-note">From {label(props.sourceAgentId)}</p>
      </div>
      <Show when={loading()}>
        <p role="status">Loading live sessions…</p>
      </Show>
      <Show when={!loading() && !source()}>
        <p role="alert">
          The source terminal needs collaboration tools. Restart it with tools enabled if necessary.
        </p>
      </Show>
      <Show
        when={
          !loading() &&
          sessions().length > 1 &&
          (!source() || (!target() && !newReviewer())) &&
          !sending()
        }
      >
        <p role="alert">
          A selected session ended or restarted. Refresh sessions and choose a recipient; your draft
          will stay here.
        </p>
      </Show>
      <div class="handoff-fields">
        <label>
          Recipient
          <select
            class="input-field"
            value={recipient()}
            disabled={sending()}
            onChange={(e) => {
              setRecipient(e.currentTarget.value);
              const provider = reviewerProvider();
              if (provider) setAskCodeProvider(provider);
            }}
          >
            <option value="" disabled>
              Choose a recipient
            </option>
            <For each={reviewerDefs()}>
              {(def) => <option value={`new:${def.id}`}>New {def.name} review…</option>}
            </For>
            <For each={recipients()}>
              {(s) => <option value={s.agentId}>{label(s.agentId)} · existing session</option>}
            </For>
          </select>
        </label>
        <label>
          Request type
          <select
            aria-label="Request type"
            class="input-field"
            value={preset()}
            disabled={sending()}
            onChange={(e) => changePreset(e.currentTarget.value as HandoffPreset)}
          >
            <option value="review">Review changes</option>
            <option value="plan">Critique plan</option>
            <option value="custom">Custom message</option>
          </select>
        </label>
      </div>
      <Show when={!source() || (!target() && !newReviewer())}>
        <button
          class="btn-secondary"
          style={dialogButtonStyle(false, loading() || sending())}
          disabled={loading() || sending()}
          onClick={() => void loadSessions()}
        >
          Refresh sessions
        </button>
      </Show>
      <label class="handoff-instructions">
        Instructions
        <textarea
          ref={instructionsRef}
          aria-label="Instructions"
          class="input-field"
          rows={props.selection ? 4 : 8}
          value={instructions()}
          disabled={sending()}
          onInput={(e) => {
            setInstructions(e.currentTarget.value);
            setInstructionsEdited(true);
          }}
        />
      </label>
      <details class="handoff-context">
        <summary>
          Context and preview{includeTask() ? ' · task prompt' : ''}
          {includeSelection() ? ' · selected text' : ''}
          {includeDiff() ? (loadingDiff() ? ' · capturing diff…' : ' · diff') : ''}
        </summary>
        <fieldset disabled={sending()}>
          <legend>Include context</legend>
          <label>
            <input
              type="checkbox"
              checked={includeTask()}
              disabled={!props.task.savedInitialPrompt}
              onChange={(e) => setIncludeTask(e.currentTarget.checked)}
            />{' '}
            Original task prompt{!props.task.savedInitialPrompt ? ' (unavailable)' : ''}
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeSelection()}
              disabled={!props.selection}
              onChange={(e) => setIncludeSelection(e.currentTarget.checked)}
            />{' '}
            Selected text{!props.selection ? ' (none)' : ''}
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeDiff()}
              disabled={props.task.gitIsolation === 'none'}
              onChange={(e) => {
                setIncludeDiff(e.currentTarget.checked);
                if (includeDiff() && !diff()) void captureDiff();
              }}
            />{' '}
            Task diff
          </label>
        </fieldset>
        <Show when={includeDiff()}>
          <p class="handoff-note">
            {loadingDiff()
              ? 'Capturing diff…'
              : diff()
                ? `Captured ${new Date(diff()?.capturedAt ?? '').toLocaleTimeString()}.`
                : ''}{' '}
            Files remain live. Binary, oversized, or unreadable files may be omitted by the task
            diff viewer.
          </p>
          <button
            class="btn-secondary"
            style={dialogButtonStyle(false, loadingDiff() || sending())}
            disabled={loadingDiff() || sending()}
            onClick={() => void captureDiff()}
          >
            Refresh diff
          </button>
        </Show>
        <details>
          <summary>Preview outgoing message</summary>
          <pre>{message()}</pre>
        </details>
        <p class="handoff-note">
          Requests are not saved across app restarts. “Do not modify files” is advisory.
        </p>
      </details>
      <Show when={includeDiff() && diffError()}>
        <p role="alert">{diffError()}</p>
      </Show>
      <Show when={tooLarge()}>
        <p role="alert">
          Message exceeds 64 KiB. Remove context or use a smaller selection; nothing has been sent.
        </p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <div class="handoff-actions">
        <span class="handoff-note">Waits for clear input · no automatic replies</span>
        <button
          class="btn-secondary"
          style={dialogButtonStyle(false, sending())}
          disabled={sending()}
          onClick={() => props.onClose()}
        >
          Cancel
        </button>
        <div class="handoff-send-group">
          <button
            class="btn-primary"
            style={dialogButtonStyle(true, !canSend())}
            disabled={!canSend()}
            onClick={() => void send()}
          >
            <SendIcon size={12} />{' '}
            {starting()
              ? 'Starting reviewer…'
              : sending()
                ? 'Queuing…'
                : newReviewer()
                  ? `Start ${newReviewer()?.name} review`
                  : 'Send'}
            <Show when={newReviewer() && model()}> · {model()}</Show>
          </button>
          <Show when={reviewerProvider()}>
            <AgentModelMenu
              label="Reviewer model"
              class="btn-primary"
              style={dialogButtonStyle(true, sending())}
              disabled={sending()}
              provider={reviewerProvider()}
              providers={reviewerProviders()}
              onSelect={(provider) => {
                if (reviewerProvider() === provider) return;
                const def = reviewerDefs().find(
                  (item) => item.command.split('/').pop() === provider,
                );
                if (def) setRecipient(`new:${def.id}`);
              }}
            />
          </Show>
        </div>
      </div>
    </section>
  );
  return (
    <Show when={!props.selection} fallback={content}>
      <Dialog
        open
        width="680px"
        panelStyle={{
          'max-width': 'calc(100vw - 32px)',
          'box-sizing': 'border-box',
          padding: '24px',
        }}
        labelledBy={titleId}
        onClose={() => {
          if (!sending()) props.onClose();
        }}
      >
        {content}
      </Dialog>
    </Show>
  );
}
