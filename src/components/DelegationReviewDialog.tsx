import './Delegation.css';
import { createResource, createSignal, For, Show } from 'solid-js';
import type { DelegationReview } from '../../electron/shared/delegation-types';
import { delegationRequest } from '../store/delegation';
import { clearTaskLandingReview } from '../store/tasks';
import { isLandedTaskState } from '../store/landing';
import type { Task } from '../store/types';
import { Dialog } from './Dialog';
import { theme } from '../lib/theme';

/** The reviewed commits are sent back to main, where approval and merge are one operation. */
export function DelegationReviewDialog(props: { task: Task; open: boolean; onClose: () => void }) {
  const [error, setError] = createSignal('');
  const [merging, setMerging] = createSignal(false);
  const landed = () => isLandedTaskState(props.task.landingState);
  const [review, { refetch }] = createResource(
    () => (props.open && !landed() ? props.task.id : undefined),
    (taskId) => delegationRequest<DelegationReview>({ action: 'review', taskId }),
  );
  async function merge() {
    const snapshot = review();
    if (!snapshot || merging()) return;
    setMerging(true);
    setError('');
    try {
      const { expectedCommit, expectedTargetBranch, expectedTargetCommit } = snapshot;
      await delegationRequest({
        action: 'merge',
        taskId: props.task.id,
        review: { expectedCommit, expectedTargetBranch, expectedTargetCommit },
      });
      props.onClose();
    } catch (err) {
      setError(String(err));
      void refetch();
    } finally {
      setMerging(false);
    }
  }
  return (
    <Dialog
      open={props.open}
      onClose={() => {
        if (!merging()) props.onClose();
      }}
      width="850px"
    >
      <div class="delegation-surface">
        <h2>Review child result: {props.task.name}</h2>
        <Show
          when={landed()}
          fallback={
            <p>Merging approves this child commit and integration target. The worktree is kept.</p>
          }
        >
          <p>This result has already been merged.</p>
          <p>
            {props.task.landedMetadata?.summary ??
              props.task.landingSummary ??
              'No result summary was recorded.'}
          </p>
          <Show when={props.task.landedMetadata}>
            {(metadata) => (
              <p>
                <code>{metadata().landedCommit}</code> → <code>{metadata().targetBranch}</code>
              </p>
            )}
          </Show>
        </Show>
        <section aria-label="Agent completion report">
          <h3>Latest agent completion report</h3>
          <Show when={props.task.completion}>
            {(completion) => (
              <>
                <Show
                  when={
                    props.task.reviewRevision !== undefined &&
                    props.task.reviewRevision !== completion().reviewRevision
                  }
                >
                  <p>Historical report: this completion belongs to an earlier assignment.</p>
                </Show>
                <p>
                  <Show
                    when={completion().sourceCommit}
                    fallback="Completion commit association unknown."
                  >
                    {(commit) => (
                      <>
                        Associated with <code>{commit().slice(0, 10)}</code>.
                        <Show when={review() && commit() !== review()?.expectedCommit}>
                          {' '}
                          Report is stale for the displayed commit.
                        </Show>
                      </>
                    )}
                  </Show>{' '}
                  {completion().snapshotState === 'dirty'
                    ? 'Worktree was dirty at completion.'
                    : completion().snapshotState === 'unknown'
                      ? 'Worktree state at completion unknown.'
                      : 'Worktree was clean at completion.'}
                </p>
              </>
            )}
          </Show>
          <Show
            when={props.task.completion?.result}
            fallback={<p>No structured report provided</p>}
          >
            {(result) => (
              <>
                <p style={{ 'white-space': 'pre-wrap' }}>{result().summary}</p>
                <Show when={result().unresolvedIssues?.length}>
                  <h4>Unresolved issues</h4>
                  <ul>
                    <For each={result().unresolvedIssues}>{(issue) => <li>{issue}</li>}</For>
                  </ul>
                </Show>
                <Show when={result().verification?.checks.length}>
                  <h4>Agent-reported verification</h4>
                  <p>
                    These checks are agent claims. The app has not proven they ran at this commit.
                  </p>
                  <ul>
                    <For each={result().verification?.checks}>
                      {(check) => (
                        <li>
                          {check.name}: {check.result} · <code>{check.command}</code>
                          {check.reason ? ' · ' + check.reason : ''}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={result().artifacts?.length}>
                  <h4>Reported artifacts</h4>
                  <ul>
                    <For each={result().artifacts}>
                      {(artifact) => (
                        <li>
                          {artifact.label ? artifact.label + ': ' : ''}
                          <code>{artifact.path}</code>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </>
            )}
          </Show>
        </section>
        <Show when={review.loading}>
          <p>Loading result…</p>
        </Show>
        <Show when={review.error}>
          <p role="alert">{String(review.error)}</p>
          <button onClick={() => void refetch()}>Retry</button>
        </Show>
        <Show when={!landed() && review()}>
          {(value) => (
            <>
              <p>
                <code>{value().expectedCommit.slice(0, 10)}</code> →{' '}
                <code>{value().expectedTargetBranch}</code> at{' '}
                <code>{value().expectedTargetCommit.slice(0, 10)}</code>
              </p>
              <pre
                tabIndex={0}
                aria-label="Child result diff"
                style={{
                  'white-space': 'pre-wrap',
                  'overflow-wrap': 'anywhere',
                  'max-height': '55vh',
                  overflow: 'auto',
                  background: theme.bgInput,
                  padding: '12px',
                }}
              >
                {value().diff || 'No changes to merge.'}
              </pre>
            </>
          )}
        </Show>
        <Show when={error()}>
          <p role="alert" style={{ color: theme.error }}>
            {error()}
          </p>
        </Show>
        <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
          <button disabled={merging()} onClick={() => props.onClose()}>
            {landed() ? 'Close' : 'Cancel'}
          </button>
          <Show when={props.task.landingState === 'landed_pending_review'}>
            <button
              class="btn-primary"
              onClick={() => {
                clearTaskLandingReview(props.task.id);
                props.onClose();
              }}
            >
              Mark reviewed
            </button>
          </Show>
          <Show when={!landed()}>
            <button
              class="btn-primary"
              disabled={merging() || review.loading || !!review.error || !review()}
              onClick={() => void merge()}
            >
              {merging() ? 'Merging…' : 'Approve and merge this result'}
            </button>
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
