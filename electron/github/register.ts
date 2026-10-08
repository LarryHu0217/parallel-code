/**
 * IPC for GitHub issues and pull requests. Every channel validates its
 * arguments; PR URLs must be canonical github.com URLs before reaching `gh`.
 */
import { ipcMain } from 'electron';
import { IPC } from '../ipc/channels.js';
import { assertInt, assertOptionalString, assertString, validatePath } from '../ipc/validate.js';
import type { PrMergeMethod } from '../ipc/shared-types.js';
import { parsePrRef } from './gh.js';
import { getGitHubIssue, listGitHubWorkItems } from './work-items.js';
import {
  getFailedChecks,
  getPullRequestDetails,
  getReviewFeedback,
  mergePullRequest,
} from './pull-requests.js';

const MAX_SEARCH_LENGTH = 200;
const MERGE_METHODS: readonly PrMergeMethod[] = ['squash', 'merge', 'rebase'];

type IpcArgs = Record<string, unknown>;

function prUrlArg(args: IpcArgs): string {
  assertString(args.prUrl, 'prUrl');
  if (!parsePrRef(args.prUrl)) throw new Error('prUrl must be a GitHub pull request URL');
  return args.prUrl;
}

function positiveIntArg(value: unknown, label: string): number {
  assertInt(value, label);
  if (value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

export function registerGitHubHandlers(): void {
  ipcMain.handle(IPC.ListGitHubWorkItems, (_e, args: IpcArgs) => {
    validatePath(args.projectRoot, 'projectRoot');
    assertOptionalString(args.search, 'search');
    const search = args.search?.trim();
    if (search && search.length > MAX_SEARCH_LENGTH) throw new Error('search is too long');
    return listGitHubWorkItems(args.projectRoot as string, search || undefined);
  });

  ipcMain.handle(IPC.GetGitHubIssue, (_e, args: IpcArgs) => {
    validatePath(args.projectRoot, 'projectRoot');
    return getGitHubIssue(args.projectRoot as string, positiveIntArg(args.number, 'number'));
  });

  ipcMain.handle(IPC.GetPullRequestDetails, (_e, args: IpcArgs) =>
    getPullRequestDetails(prUrlArg(args)),
  );

  ipcMain.handle(IPC.GetPrFailedChecks, (_e, args: IpcArgs) => getFailedChecks(prUrlArg(args)));

  ipcMain.handle(IPC.GetPrReviewFeedback, (_e, args: IpcArgs) => getReviewFeedback(prUrlArg(args)));

  ipcMain.handle(IPC.MergePullRequest, (_e, args: IpcArgs) => {
    const prUrl = prUrlArg(args);
    const method = MERGE_METHODS.find((m) => m === args.method);
    if (!method) throw new Error('method must be squash, merge or rebase');
    assertString(args.headSha, 'headSha');
    if (!/^[0-9a-f]{40}$/.test(args.headSha)) throw new Error('headSha must be a commit SHA');
    return mergePullRequest(prUrl, method, args.headSha);
  });
}
