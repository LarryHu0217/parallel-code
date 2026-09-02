import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockStoreHarness } from './test-helpers';
import type { ClaudeUsageState } from './types';
import type { ClaudeUsageResult } from '../ipc/types';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
const core = vi.hoisted(() => ({
  harness: undefined as MockStoreHarness<{ claudeUsage: ClaudeUsageState }> | undefined,
}));

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness({
    claudeUsage: { fiveHour: null, sevenDay: null, fetchedAt: null, status: 'idle', error: null },
  });
  return core.harness.moduleMock();
});
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));
vi.mock('../../electron/ipc/channels', () => ({ IPC: { GetClaudeUsage: 'get_claude_usage' } }));

type Slice = typeof import('./claudeUsage');

const OK: ClaudeUsageResult = {
  status: 'ok',
  fiveHour: { usedPercent: 40, resetsAt: 1_000 },
  sevenDay: { usedPercent: 10, resetsAt: 2_000 },
  fetchedAt: 500,
};

function state(): ClaudeUsageState {
  if (!core.harness) throw new Error('store harness not initialised');
  return core.harness.state().claudeUsage;
}

describe('claudeUsage store slice', () => {
  let slice: Slice;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00Z'));
    mockInvoke.mockReset();
    // The slice keeps its throttle and timer in module scope, so every test gets a fresh copy.
    vi.resetModules();
    slice = await import('./claudeUsage');
  });

  afterEach(() => {
    slice.stopClaudeUsagePolling();
    vi.useRealTimers();
  });

  it('applies an ok result', async () => {
    mockInvoke.mockResolvedValueOnce(OK);
    await slice.refreshClaudeUsage();
    expect(state()).toEqual({
      fiveHour: OK.fiveHour,
      sevenDay: OK.sevenDay,
      fetchedAt: 500,
      status: 'ok',
      error: null,
    });
  });

  it('drops the snapshot entirely when the login goes away', async () => {
    mockInvoke.mockResolvedValueOnce(OK);
    await slice.refreshClaudeUsage();
    mockInvoke.mockResolvedValueOnce({ status: 'unavailable', reason: 'logged out' });
    await slice.refreshClaudeUsage({ force: true });
    expect(state()).toEqual({
      fiveHour: null,
      sevenDay: null,
      fetchedAt: null,
      status: 'unavailable',
      error: 'logged out',
    });
  });

  it('keeps the last snapshot on a transient error', async () => {
    mockInvoke.mockResolvedValueOnce(OK);
    await slice.refreshClaudeUsage();
    mockInvoke.mockResolvedValueOnce({ status: 'error', message: 'HTTP 429' });
    await slice.refreshClaudeUsage({ force: true });
    expect(state()).toMatchObject({ fiveHour: OK.fiveHour, status: 'error', error: 'HTTP 429' });
  });

  it('turns a rejected IPC call into an error state', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('bridge down'));
    await slice.refreshClaudeUsage();
    expect(state()).toMatchObject({ status: 'error', error: 'bridge down' });
  });

  it('coalesces concurrent refreshes into one request', async () => {
    mockInvoke.mockResolvedValue(OK);
    await Promise.all([slice.refreshClaudeUsage(), slice.refreshClaudeUsage()]);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('throttles back-to-back refreshes unless forced', async () => {
    mockInvoke.mockResolvedValue(OK);
    await slice.refreshClaudeUsage();
    vi.advanceTimersByTime(10_000);
    await slice.refreshClaudeUsage();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    await slice.refreshClaudeUsage({ force: true });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    await slice.refreshClaudeUsage();
    expect(mockInvoke).toHaveBeenCalledTimes(3);
  });

  it('polls every five minutes, starts once, and stops cleanly', async () => {
    mockInvoke.mockResolvedValue(OK);
    slice.startClaudeUsagePolling();
    slice.startClaudeUsagePolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    slice.stopClaudeUsagePolling();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});
