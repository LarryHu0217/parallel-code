import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const viewer = readFileSync(resolve(__dirname, 'PlanViewerDialog.tsx'), 'utf8');
const selection = readFileSync(resolve(__dirname, '../lib/plan-selection.ts'), 'utf8');
const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');

describe('plan review flow slots', () => {
  it('mounts inputs, comments, and questions in document flow', () => {
    expect(viewer).toContain("slot.className = 'plan-review-flow-slot'");
    expect(viewer).toContain('<Show keyed when={pendingFlowSlot()}>');
    expect(viewer).toContain('<Portal mount={slot}>');
    expect(viewer).toContain('<Portal mount={slot()}>');
    expect(viewer).not.toContain('cardOffsets');
    expect(viewer).not.toContain('selectionY');

    const rule = css.match(/\.plan-review-flow-slot\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/display:\s*flow-root\s*;/);
    expect(rule?.[1]).not.toMatch(/position:\s*absolute\s*;/);
  });

  it('anchors cards to valid rendered blocks and ignores card selections', () => {
    expect(selection).toContain('export function getPlanSelectionFlowAnchor');
    expect(selection).toContain('range.endContainer.nodeType');
    expect(selection).toContain("block.tagName === 'TR'");
    expect(selection).toContain("element.closest('[data-plan-review-flow-slot]')");
    expect(viewer).toContain('eventTarget.closest(PLAN_REVIEW_FLOW_SLOT_SELECTOR)');
  });

  it('starts a fresh review session when the plan identity changes', () => {
    expect(viewer).toContain('const reviewSession = createMemo');
    expect(viewer).toContain('<Show keyed when={reviewSession()}>');
    expect(viewer).toContain('planContent={session.planContent}');
    expect(viewer).toContain('worktreePath={session.worktreePath}');
    expect(viewer).not.toContain('<Show when={props.open}>');
  });
});
