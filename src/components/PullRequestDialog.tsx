import { For, Show, createEffect, createResource, createSignal, on } from 'solid-js';
import { Dialog } from './Dialog';
import { errMessage } from '../lib/log';
import { bannerStyle, dialogButtonStyle, theme } from '../lib/theme';
import {
  getPullRequestDetails,
  mergePullRequestForTask,
  stageFailedChecksPrompt,
  stageReviewFeedbackPrompt,
} from '../store/github';
import { getPrChecks } from '../store/store';
import { showNotification } from '../store/notification';
import type { PrCheckBucket, PrMergeMethod, PullRequestDetails } from '../ipc/types';
import type { Task } from '../store/types';
import { CommentIcon, GitHubIcon, GitMergeIcon, ToolsIcon } from './icons';

interface PullRequestDialogProps {
  open: boolean;
  task: Task;
  prUrl: string;
  onClose: () => void;
}

type Busy = 'fix-ci' | 'review' | 'merge' | null;

const METHOD_LABELS: Record<PrMergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge',
};

const BUCKET_COLORS: Record<PrCheckBucket, string> = {
  pass: theme.success,
  skipping: theme.fgSubtle,
  pending: theme.warning,
  fail: theme.error,
  cancel: theme.error,
};

/** Why merging is not offered, or null when GitHub may accept it. */
function mergeBlocker(pr: PullRequestDetails): string | null {
  if (pr.state === 'MERGED') return 'Already merged.';
  if (pr.state === 'CLOSED') return 'The pull request is closed.';
  if (pr.isDraft) return 'Draft pull requests cannot be merged. Mark it ready on GitHub first.';
  if (pr.mergeable === 'CONFLICTING') return 'The branch has conflicts with its base branch.';
  if (pr.mergeStateStatus === 'BEHIND')
    return 'The branch must be updated with its base branch first.';
  if (pr.mergeStateStatus === 'BLOCKED') {
    return 'GitHub blocks merging until required reviews or checks pass.';
  }
  if (pr.mergeMethods.length === 0) return 'The repository allows no merge method you can use.';
  if (!pr.headRefOid) return 'GitHub did not report the head commit; reopen to retry.';
  return null;
}

/** PR status for a task, plus actions that feed GitHub feedback to the agent or merge. */
export function PullRequestDialog(props: PullRequestDialogProps) {
  const [busy, setBusy] = createSignal<Busy>(null);
  const [error, setError] = createSignal('');
  const [info, setInfo] = createSignal('');
  const [method, setMethod] = createSignal<PrMergeMethod | null>(null);
  const [confirmingMerge, setConfirmingMerge] = createSignal(false);
  const [details] = createResource(
    () => (props.open ? props.prUrl : null),
    (url) => getPullRequestDetails(url),
  );
  const checks = () => getPrChecks(props.task.id);
  const prRef = () => ({ number: details()?.number ?? 0, url: props.prUrl });
  const blocker = () => {
    const d = details();
    return d ? mergeBlocker(d) : null;
  };

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setError('');
        setInfo('');
        setMethod(null);
        setConfirmingMerge(false);
      },
    ),
  );

  function begin(kind: Exclude<Busy, null>) {
    setBusy(kind);
    setError('');
    setInfo('');
  }

  async function stage(kind: 'fix-ci' | 'review') {
    begin(kind);
    try {
      const stageFn = kind === 'fix-ci' ? stageFailedChecksPrompt : stageReviewFeedbackPrompt;
      if (!(await stageFn(props.task.id, prRef()))) {
        setInfo(kind === 'fix-ci' ? 'No failed checks found.' : 'No open review feedback found.');
        return;
      }
      showNotification('Prompt staged in the task input. Review it, then send.');
      props.onClose();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const chosenMethod = () => method() ?? details()?.mergeMethods[0];

  async function merge() {
    const chosen = chosenMethod();
    const pr = details();
    if (!chosen || !pr) return;
    setConfirmingMerge(false);
    begin('merge');
    try {
      const merged = await mergePullRequestForTask(props.task.id, {
        prUrl: props.prUrl,
        method: chosen,
        headSha: pr.headRefOid,
      });
      showNotification(
        merged
          ? `Merged PR #${pr.number}`
          : `Merge requested for PR #${pr.number}; GitHub has not merged it yet (it may be in a merge queue).`,
      );
      // Closing avoids showing the pre-merge details (and merge button) until
      // a refetch lands; the PR chip updates from the checks watcher.
      props.onClose();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={props.open} onClose={() => !busy() && props.onClose()} width="560px">
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
        <h2 style={{ margin: '0', 'font-size': '17px', color: theme.fg, 'font-weight': '600' }}>
          Pull Request
          <Show when={details()}>
            {(d) => (
              <>
                {' '}
                #{d().number}
                <span style={{ color: theme.fgMuted, 'font-weight': '400' }}> {d().title}</span>
              </>
            )}
          </Show>
        </h2>

        <Show when={details.loading}>
          <span style={{ 'font-size': '13px', color: theme.fgSubtle }}>Loading from GitHub…</span>
        </Show>
        <Show when={details.error}>
          {(err) => (
            <div role="alert" style={{ ...bannerStyle(theme.error), 'font-size': '13px' }}>
              {errMessage(err())}
            </div>
          )}
        </Show>

        <Show when={details()}>
          {(d) => (
            <dl
              style={{
                display: 'grid',
                'grid-template-columns': 'max-content 1fr',
                gap: '6px 14px',
                margin: '0',
                'font-size': '13px',
                color: theme.fg,
              }}
            >
              <dt style={{ color: theme.fgMuted }}>State</dt>
              <dd style={{ margin: '0' }}>
                {d().isDraft && d().state === 'OPEN' ? 'Draft' : d().state.toLowerCase()} · into{' '}
                {d().baseRefName}
              </dd>
              <dt style={{ color: theme.fgMuted }}>Mergeable</dt>
              <dd style={{ margin: '0' }}>
                {d().mergeable === 'CONFLICTING'
                  ? 'Conflicts'
                  : d().mergeable === 'MERGEABLE'
                    ? 'No conflicts'
                    : 'Unknown'}{' '}
                <span style={{ color: theme.fgSubtle }}>
                  ({d().mergeStateStatus.toLowerCase()})
                </span>
              </dd>
              <dt style={{ color: theme.fgMuted }}>Review</dt>
              <dd style={{ margin: '0' }}>
                {checks()?.reviewDecision?.toLowerCase().replace(/_/g, ' ') ?? 'none'}
              </dd>
            </dl>
          )}
        </Show>
        <Show when={details()?.headRefName && details()?.headRefName !== props.task.branchName}>
          <div style={{ ...bannerStyle(theme.warning), 'font-size': '13px' }}>
            This task works on <strong>{props.task.branchName}</strong>, not the PR branch{' '}
            <strong>{details()?.headRefName}</strong>. Pushing from this task does not update the
            PR.
          </div>
        </Show>

        <Show when={checks()?.checks.length}>
          <ul
            aria-label="Checks"
            style={{
              'list-style': 'none',
              margin: '0',
              padding: '0',
              'max-height': '160px',
              'overflow-y': 'auto',
              'font-size': '12px',
            }}
          >
            <For each={checks()?.checks ?? []}>
              {(check) => (
                <li style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: '7px',
                      height: '7px',
                      'border-radius': '50%',
                      background: BUCKET_COLORS[check.bucket],
                    }}
                  />
                  <span style={{ color: theme.fg }}>{check.name}</span>
                  <span style={{ color: theme.fgSubtle }}>{check.bucket}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
          <button
            type="button"
            class="btn-secondary btn-with-icon"
            onClick={() => window.open(props.prUrl, '_blank')}
            style={dialogButtonStyle(false)}
          >
            <GitHubIcon size={14} />
            Open on GitHub
          </button>
          <button
            type="button"
            class="btn-secondary btn-with-icon"
            disabled={!!busy() || !details()}
            title="Collect failed checks and their log tails into a prompt for the agent"
            onClick={() => void stage('fix-ci')}
            style={dialogButtonStyle(false, !!busy() || !details())}
          >
            <ToolsIcon size={14} />
            {busy() === 'fix-ci' ? 'Collecting…' : 'Fix CI'}
          </button>
          <button
            type="button"
            class="btn-secondary btn-with-icon"
            disabled={!!busy() || !details()}
            title="Collect unresolved review comments into a prompt for the agent"
            onClick={() => void stage('review')}
            style={dialogButtonStyle(false, !!busy() || !details())}
          >
            <CommentIcon size={14} />
            {busy() === 'review' ? 'Collecting…' : 'Address review'}
          </button>
        </div>

        <Show when={details()}>
          {(d) => (
            <Show
              when={!blocker()}
              fallback={
                <span style={{ 'font-size': '13px', color: theme.fgMuted }}>{blocker()}</span>
              }
            >
              <Show
                when={confirmingMerge()}
                fallback={
                  <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                    <select
                      aria-label="Merge method"
                      value={chosenMethod()}
                      onChange={(e) => setMethod(e.currentTarget.value as PrMergeMethod)}
                      style={{
                        flex: '1',
                        padding: '8px',
                        background: theme.bgInput,
                        border: `1px solid ${theme.border}`,
                        'border-radius': 'var(--radius-md)',
                        color: theme.fg,
                        'font-size': '13px',
                      }}
                    >
                      <For each={d().mergeMethods}>
                        {(m) => <option value={m}>{METHOD_LABELS[m]}</option>}
                      </For>
                    </select>
                    <button
                      type="button"
                      class="btn-primary btn-with-icon"
                      disabled={!!busy()}
                      onClick={() => setConfirmingMerge(true)}
                      style={dialogButtonStyle(true, !!busy())}
                    >
                      <GitMergeIcon size={14} />
                      {busy() === 'merge' ? 'Merging…' : 'Merge on GitHub…'}
                    </button>
                  </div>
                }
              >
                <div
                  role="alertdialog"
                  aria-label="Confirm merge"
                  style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}
                >
                  <span style={{ flex: '1', 'font-size': '13px', color: theme.fg }}>
                    {METHOD_LABELS[chosenMethod() ?? 'merge']} PR #{d().number} into{' '}
                    {d().baseRefName}?
                    {/* UNSTABLE: non-required checks fail; GitHub allows the merge. */}
                    <Show when={d().mergeStateStatus === 'UNSTABLE'}>
                      {' '}
                      Some checks are failing.
                    </Show>
                  </span>
                  <button
                    type="button"
                    class="btn-secondary"
                    onClick={() => setConfirmingMerge(false)}
                    style={dialogButtonStyle(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="btn-primary btn-with-icon"
                    onClick={() => void merge()}
                    style={dialogButtonStyle(true)}
                  >
                    <GitMergeIcon size={14} />
                    Confirm merge
                  </button>
                </div>
              </Show>
            </Show>
          )}
        </Show>

        <Show when={info()}>
          <div style={{ ...bannerStyle(theme.fgMuted), 'font-size': '13px' }}>{info()}</div>
        </Show>
        <Show when={error()}>
          <div role="alert" style={{ ...bannerStyle(theme.error), 'font-size': '13px' }}>
            {error()}
          </div>
        </Show>

        <div style={{ display: 'flex', 'justify-content': 'flex-end' }}>
          <button
            type="button"
            class="btn-secondary"
            disabled={!!busy()}
            onClick={() => props.onClose()}
            style={dialogButtonStyle(false, !!busy())}
          >
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
