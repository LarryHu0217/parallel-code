/** Renderer side of the GitHub integration: issue/PR lookups and PR actions for tasks. */
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { warn as logWarn } from '../lib/log';
import {
  buildFailedChecksPrompt,
  buildReviewFeedbackPrompt,
  hasReviewFeedback,
} from '../lib/github-prompts';
import { setStore, store } from './core';
import { setPrefillPrompt, setTaskPromptDraftActive } from './tasks';
import { setTaskFocusedPanel } from './focused-panel';
import type {
  GitHubIssueDetails,
  GitHubWorkItem,
  PrFailedCheck,
  PrMergeMethod,
  PrReviewFeedback,
  PullRequestDetails,
} from '../ipc/types';

export function listGitHubWorkItems(
  projectRoot: string,
  search?: string,
): Promise<GitHubWorkItem[]> {
  return invoke<GitHubWorkItem[]>(IPC.ListGitHubWorkItems, { projectRoot, search });
}

export function getGitHubIssue(projectRoot: string, number: number): Promise<GitHubIssueDetails> {
  return invoke<GitHubIssueDetails>(IPC.GetGitHubIssue, { projectRoot, number });
}

export function getPullRequestDetails(prUrl: string): Promise<PullRequestDetails> {
  return invoke<PullRequestDetails>(IPC.GetPullRequestDetails, { prUrl });
}

/** Resolves true when GitHub confirms the merge; false when it is still pending. */
export async function mergePullRequestForTask(
  taskId: string,
  merge: { prUrl: string; method: PrMergeMethod; headSha: string },
): Promise<boolean> {
  const merged = await invoke<boolean>(IPC.MergePullRequest, merge);
  // Re-poll soon so the watcher sees the merge and drops the PR status.
  void invoke(IPC.RefreshPrChecksWatcher, { taskId }).catch((err: unknown) =>
    logWarn('github', 'Failed to refresh PR checks after merge', { err: String(err) }),
  );
  return merged;
}

/** Stages a "fix CI" prompt in the task's prompt input. Returns false when nothing failed. */
export async function stageFailedChecksPrompt(
  taskId: string,
  pr: { number: number; url: string },
): Promise<boolean> {
  const checks = await invoke<PrFailedCheck[]>(IPC.GetPrFailedChecks, { prUrl: pr.url });
  if (checks.length === 0) return false;
  stagePrompt(taskId, buildFailedChecksPrompt(pr, checks));
  return true;
}

/** Stages an "address review" prompt. Returns false when there is no open feedback. */
export async function stageReviewFeedbackPrompt(
  taskId: string,
  pr: { number: number; url: string },
): Promise<boolean> {
  const feedback = await invoke<PrReviewFeedback>(IPC.GetPrReviewFeedback, { prUrl: pr.url });
  if (!hasReviewFeedback(feedback)) return false;
  stagePrompt(taskId, buildReviewFeedbackPrompt(pr, feedback));
  return true;
}

// Prefilled rather than sent: GitHub content is untrusted, so the user reads
// and edits it before the agent sees it. Appended so an unsent draft survives.
function stagePrompt(taskId: string, text: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const draft = task.prefillPrompt ?? task.promptDraft ?? '';
  setTaskPromptDraftActive(taskId, true);
  setStore('showPromptInput', true);
  setPrefillPrompt(taskId, [draft, text].filter(Boolean).join('\n\n'));
  queueMicrotask(() => {
    if (store.tasks[taskId]) setTaskFocusedPanel(taskId, 'prompt');
  });
}
