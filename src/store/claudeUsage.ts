import { setStore } from './core';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { ClaudeUsageResult } from '../ipc/types';

// The usage endpoint rate-limits eager pollers, so refresh slowly and let
// Claude session exits and manual clicks fill in between ticks.
const POLL_INTERVAL_MS = 5 * 60_000;
const MIN_REFRESH_GAP_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastRequestAt = 0;
let inFlight: Promise<void> | null = null;

function applyResult(result: ClaudeUsageResult): void {
  if (result.status === 'ok') {
    setStore('claudeUsage', {
      fiveHour: result.fiveHour,
      sevenDay: result.sevenDay,
      fetchedAt: result.fetchedAt,
      status: 'ok',
      error: null,
    });
  } else if (result.status === 'unavailable') {
    setStore('claudeUsage', { status: 'unavailable', error: result.reason });
  } else {
    setStore('claudeUsage', { status: 'error', error: result.message });
  }
}

/** Re-reads Claude usage. Coalesces concurrent calls and, unless forced, skips
 *  refreshes that land within MIN_REFRESH_GAP_MS of the previous request. */
export function refreshClaudeUsage(opts: { force?: boolean } = {}): Promise<void> {
  if (inFlight) return inFlight;
  if (!opts.force && Date.now() - lastRequestAt < MIN_REFRESH_GAP_MS) return Promise.resolve();
  lastRequestAt = Date.now();
  inFlight = invoke<ClaudeUsageResult>(IPC.GetClaudeUsage)
    .then(applyResult)
    .catch((err: unknown) => {
      setStore('claudeUsage', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function startClaudeUsagePolling(): void {
  if (pollTimer) return;
  void refreshClaudeUsage({ force: true });
  pollTimer = setInterval(() => void refreshClaudeUsage(), POLL_INTERVAL_MS);
}

export function stopClaudeUsagePolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
