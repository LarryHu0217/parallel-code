import { renderToString } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';

import { removePrChecks, setPrChecks } from '../store/pr-checks-state';
import { StatusDot, getDotTooltip } from './StatusDot';

function prChecks(overall: 'pending' | 'success' | 'failure' | 'none') {
  return { overall, passing: 0, pending: 0, failing: 0, checks: [], checkedAt: '' };
}

describe('getDotTooltip', () => {
  afterEach(() => removePrChecks('t1'));

  it('describes review status', () => {
    expect(getDotTooltip('review')).toBe('Ready for review');
  });

  it('describes busy status', () => {
    expect(getDotTooltip('busy')).toBe('Busy — agent recently active');
  });

  it('uses attention state before dot status', () => {
    expect(getDotTooltip('ready', 'needs_input')).toBe('Waiting for input');
  });

  // A review-flagged task whose agent is still active is dot status 'busy' with
  // attention 'review' — the purple dot must not read "Busy".
  it('describes review attention over a busy dot status', () => {
    expect(getDotTooltip('busy', 'review')).toBe('Ready for review');
  });

  // `ready` only means no known failure, so pending CI must not claim mergeability.
  it('names the ready state after the PR checks', () => {
    expect(getDotTooltip('ready', 'ready', 't1')).toBe('Ready');
    setPrChecks('t1', prChecks('pending'));
    expect(getDotTooltip('ready', 'ready', 't1')).toBe('CI running');
    setPrChecks('t1', prChecks('success'));
    expect(getDotTooltip('ready', 'ready', 't1')).toBe('Ready to merge');
  });
});

describe('StatusDot', () => {
  it('attaches the tooltip to the dot element', () => {
    const html = renderToString(() => StatusDot({ status: 'review' }));

    expect(html).toContain('title="Ready for review"');
  });

  it('uses attention state for the rendered tooltip', () => {
    const html = renderToString(() => StatusDot({ status: 'ready', attention: 'needs_input' }));

    expect(html).toContain('title="Waiting for input"');
  });

  it('adds activity provenance separately from the aggregate task status', () => {
    const html = renderToString(() => StatusDot({ status: 'review', taskId: 'missing' }));
    expect(html).toContain('Ready for review\nActivity evidence unavailable');
  });
});

describe('status glyph shapes', () => {
  it('spins while an agent is working and asks with a question mark when blocked', () => {
    expect(renderToString(() => StatusDot({ status: 'busy', attention: 'active' }))).toContain(
      'status-glyph-spinner',
    );
    const asking = renderToString(() => StatusDot({ status: 'busy', attention: 'needs_input' }));
    expect(asking).toContain('status-glyph-question');
    expect(asking).not.toContain('status-glyph-spinner');
  });

  it('rests as a plain dot when idle, errored, or under review', () => {
    for (const attention of ['idle', 'error', 'review', 'ready'] as const) {
      const html = renderToString(() => StatusDot({ status: 'busy', attention }));
      expect(html, attention).not.toContain('status-glyph-spinner');
      expect(html, attention).not.toContain('status-glyph-question');
    }
  });
});
