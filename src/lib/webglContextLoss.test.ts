import { describe, expect, it } from 'vitest';
import {
  initialWebglLossState,
  recordWebglContextLoss,
  WEBGL_LOSS_RESET_MS,
  WEBGL_MAX_RAPID_LOSSES,
} from './webglContextLoss';

describe('recordWebglContextLoss', () => {
  it('retries after a first loss', () => {
    const { retry } = recordWebglContextLoss(initialWebglLossState(), 1_000);
    expect(retry).toBe(true);
  });

  it('gives up after rapid repeated losses', () => {
    let state = initialWebglLossState();
    let retry = true;
    for (let i = 0; i < WEBGL_MAX_RAPID_LOSSES; i++) {
      ({ state, retry } = recordWebglContextLoss(state, 1_000 + i * 100));
    }
    expect(retry).toBe(false);
  });

  it('always retries isolated losses, e.g. one per sleep/wake cycle', () => {
    let state = initialWebglLossState();
    let retry = false;
    // Far more cycles than the rapid-loss budget, spaced beyond the window.
    for (let i = 0; i < WEBGL_MAX_RAPID_LOSSES * 3; i++) {
      ({ state, retry } = recordWebglContextLoss(state, (i + 1) * (WEBGL_LOSS_RESET_MS + 1)));
      expect(retry).toBe(true);
    }
  });

  it('resets the rapid-loss window after a quiet period', () => {
    let state = initialWebglLossState();
    // Two rapid losses — one short of giving up.
    ({ state } = recordWebglContextLoss(state, 1_000));
    ({ state } = recordWebglContextLoss(state, 1_100));
    // A loss after a quiet period starts a fresh window instead of giving up.
    const late = recordWebglContextLoss(state, 1_100 + WEBGL_LOSS_RESET_MS + 1);
    expect(late.retry).toBe(true);
    expect(late.state.count).toBe(1);
  });
});
