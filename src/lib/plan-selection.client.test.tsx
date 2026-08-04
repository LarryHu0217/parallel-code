import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPlanSelection,
  getPlanSelectionTextRanges,
  PLAN_REVIEW_FLOW_SLOT_SELECTOR,
  trackPlanSelectionGeometry,
  type PlanSelectionRect,
} from './plan-selection';

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function selectText(start: Text, end: Text): void {
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function rect(top: number, left = 0): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    right: left + 40,
    bottom: top + 12,
    width: 40,
    height: 12,
    toJSON: () => undefined,
  };
}

describe('plan selection DOM behavior', () => {
  it('excludes review-card text and blocks from a selection spanning a flow slot', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <p>Before plan text</p>
      <div data-plan-review-flow-slot><p>Review Goal Previous feedback</p></div>
      <p>After plan text</p>
    `;
    document.body.append(container);

    const paragraphs = container.querySelectorAll('p');
    selectText(paragraphs[0].firstChild as Text, paragraphs[2].firstChild as Text);

    expect(window.getSelection()?.toString()).toContain('Previous feedback');
    const selection = getPlanSelection(container, 'plan.md');
    const textRanges = getPlanSelectionTextRanges(container);

    expect(selection?.selectedText).toContain('Before plan text');
    expect(selection?.selectedText).toContain('After plan text');
    expect(selection?.selectedText).not.toContain('Previous feedback');
    expect(selection).toMatchObject({ startLine: 0, endLine: 1 });
    expect(textRanges.map((range) => range.toString()).join('')).not.toContain('Previous feedback');
    expect(
      textRanges.every(
        (range) =>
          range.commonAncestorContainer.parentElement?.closest(PLAN_REVIEW_FLOW_SLOT_SELECTOR) ===
          null,
      ),
    ).toBe(true);
  });

  it('recalculates retained range geometry when the plan reflows', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>First block</p><p>Second block</p>';
    document.body.append(container);
    const paragraphs = container.querySelectorAll('p');
    selectText(paragraphs[0].firstChild as Text, paragraphs[1].firstChild as Text);
    const ranges = getPlanSelectionTextRanges(container);

    let rangeTops = [30, 110];
    ranges.forEach((range, index) => {
      Object.defineProperty(range, 'getClientRects', {
        value: () => [rect(rangeTops[index], 15)] as unknown as DOMRectList,
      });
    });
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => rect(10, 5),
    });

    class FakeResizeObserver {
      static callback: ResizeObserverCallback;
      static instance: FakeResizeObserver;
      static disconnected = false;

      constructor(callback: ResizeObserverCallback) {
        FakeResizeObserver.callback = callback;
        FakeResizeObserver.instance = this;
      }

      observe() {}
      unobserve() {}
      disconnect() {
        FakeResizeObserver.disconnected = true;
      }

      static trigger() {
        FakeResizeObserver.callback([], FakeResizeObserver.instance as unknown as ResizeObserver);
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const updates: PlanSelectionRect[][] = [];
    const stop = trackPlanSelectionGeometry(container, ranges, (rects) => updates.push(rects));
    expect(updates.at(-1)?.map((item) => item.top)).toEqual([20, 100]);

    rangeTops = [30, 50];
    FakeResizeObserver.trigger();
    expect(updates.at(-1)?.map((item) => item.top)).toEqual([20, 40]);

    stop();
    expect(FakeResizeObserver.disconnected).toBe(true);
  });
});
