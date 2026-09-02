// Recovery policy for WebGL context loss in terminal panes.
//
// A lost context has two very different shapes: an isolated event (GPU process
// crash, system sleep/wake, context-cap eviction while the cap was exceeded)
// that a reattach fully recovers from, and a rapid loss loop (WebGL genuinely
// broken, or more panes than the context cap, where each reattach evicts
// another pane's context which reattaches in turn). Retrying forever would turn
// the second shape into permanent churn, so losses are counted within a rolling
// window: isolated losses always retry, rapid repeats settle onto the DOM
// renderer.
// shortcut: after giving up, the pane stays on the DOM renderer until remount —
// reattach on a visibility edge (like the macOS redraw effect) if that bites.

/** Rapid losses tolerated inside one window before giving up on WebGL. */
export const WEBGL_MAX_RAPID_LOSSES = 3;
/** A loss this long after the previous one counts as isolated, not rapid. */
export const WEBGL_LOSS_RESET_MS = 30_000;
/** Delay before a reattach attempt, letting the GPU process settle/respawn. */
export const WEBGL_REATTACH_DELAY_MS = 2_000;

export interface WebglLossState {
  /** Losses observed in the current rapid-loss window. */
  count: number;
  /** Timestamp (ms) of the most recent loss; 0 = never. */
  lastLossAt: number;
}

export function initialWebglLossState(): WebglLossState {
  return { count: 0, lastLossAt: 0 };
}

/**
 * Record a context loss at time `now` (ms). Returns the next state and whether
 * the caller should schedule a reattach attempt.
 */
export function recordWebglContextLoss(
  state: WebglLossState,
  now: number,
): { state: WebglLossState; retry: boolean } {
  const isolated = state.count === 0 || now - state.lastLossAt > WEBGL_LOSS_RESET_MS;
  const count = isolated ? 1 : state.count + 1;
  return {
    state: { count, lastLossAt: now },
    retry: count < WEBGL_MAX_RAPID_LOSSES,
  };
}
