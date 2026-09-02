// Recovery policy for WebGL context loss in terminal panes.
//
// Loss events come in three shapes:
// - An isolated event (GPU process crash, system sleep/wake): a reattach fully
//   recovers. When the GPU process dies, EVERY pane loses its context in the
//   same instant — that burst must count as one event, not many.
// - A sustained eviction rotation: more live contexts than Chromium's cap
//   (see max-active-webgl-contexts in electron/main.ts), where each reattach
//   evicts another pane's context which reattaches in turn. The losses land
//   seconds apart on DIFFERENT panes, so the brake must look at losses across
//   the whole app, not per pane.
// - Genuinely broken WebGL: the attach itself throws (handled at the call
//   site, no retry).
//
// Losses are therefore grouped into "waves" (losses close together share one
// underlying event) counted in a single app-wide window: the first waves
// retry, later waves inside the window mean churn — give up and let affected
// panes settle onto the DOM renderer.
// shortcut: after giving up, a pane stays on the DOM renderer until remount —
// attaching/detaching on visibility edges would make this recoverable and
// keep live contexts ≈ visible panes.

/** Losses within this span belong to the same wave (one underlying event). */
export const WEBGL_LOSS_WAVE_MS = 1_000;
/** A wave this long after the previous one is isolated — the window restarts. */
export const WEBGL_LOSS_RESET_MS = 30_000;
/** Wave count at which the policy stops retrying (waves 1–2 retry, 3 gives up). */
export const WEBGL_MAX_LOSS_WAVES = 3;
/** Delay before a reattach attempt, letting the GPU process settle/respawn. */
export const WEBGL_REATTACH_DELAY_MS = 2_000;

export interface WebglLossState {
  /** Loss waves observed in the current window; 0 = no loss seen yet. */
  waves: number;
  /** Timestamp (ms) of the most recent loss. */
  lastLossAt: number;
}

export function initialWebglLossState(): WebglLossState {
  return { waves: 0, lastLossAt: 0 };
}

/**
 * Record a context loss at time `now` (ms). Returns the next state and whether
 * the affected pane should schedule a reattach attempt.
 */
export function recordWebglContextLoss(
  state: WebglLossState,
  now: number,
): { state: WebglLossState; retry: boolean } {
  const delta = now - state.lastLossAt;
  let waves: number;
  if (state.waves === 0 || delta < 0 || delta > WEBGL_LOSS_RESET_MS) {
    // First loss ever, clock stepped backwards (Date.now() is not monotonic —
    // NTP correction on wake must not read as a rapid repeat), or a quiet
    // period — start a fresh window.
    waves = 1;
  } else if (delta <= WEBGL_LOSS_WAVE_MS) {
    // Same underlying event (e.g. one GPU crash killing every pane at once).
    waves = state.waves;
  } else {
    waves = state.waves + 1;
  }
  return {
    state: { waves, lastLossAt: now },
    retry: waves < WEBGL_MAX_LOSS_WAVES,
  };
}

// Context loss is a renderer-process-wide phenomenon (cap eviction and GPU
// crashes span panes), so every pane records into this one shared window.
let sharedLossState = initialWebglLossState();

/** Record a loss against the app-wide window; true = the pane should reattach. */
export function recordSharedWebglContextLoss(now: number = Date.now()): boolean {
  const { state, retry } = recordWebglContextLoss(sharedLossState, now);
  sharedLossState = state;
  return retry;
}

export function resetSharedWebglLossStateForTest(): void {
  sharedLossState = initialWebglLossState();
}
