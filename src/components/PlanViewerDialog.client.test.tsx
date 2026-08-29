import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanViewerDialog } from './PlanViewerDialog';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function waitForElement<T extends Element>(selector: string): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const element = document.querySelector<T>(selector);
    if (element) return element;
    await Promise.resolve();
  }
  throw new Error(`Element did not render: ${selector}`);
}

function selectText(text: Text): void {
  const range = document.createRange();
  range.selectNodeContents(text);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('PlanViewerDialog inline review flow', () => {
  it('keeps the inline slot connected when a selection becomes a comment', async () => {
    const rangeRects = vi
      .spyOn(Range.prototype, 'getClientRects')
      .mockReturnValue([] as unknown as DOMRectList);
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <PlanViewerDialog
            open
            onClose={() => undefined}
            planContent={'# Plan\n\nFirst paragraph.\n\nSecond paragraph.'}
            planFileName="plan.md"
            taskId="task-a"
            agentId="agent-a"
            worktreePath="/worktree-a"
          />
        ),
        host,
      ),
    );

    const paragraph = await waitForElement<HTMLParagraphElement>('.plan-markdown p');
    selectText(paragraph.firstChild as Text);
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const slot = document.querySelector<HTMLDivElement>('[data-plan-review-flow-slot]');
    expect(slot?.isConnected).toBe(true);
    const input = slot?.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    if (!input) throw new Error('Inline review input did not render');

    input.value = 'Keep this behavior.';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const annotation = document.querySelector<HTMLElement>('.plan-markdown [data-annotation-id]');
    expect(annotation).not.toBeNull();
    expect(annotation?.closest('[data-plan-review-flow-slot]')?.isConnected).toBe(true);
    expect(annotation?.textContent).toContain('Keep this behavior.');
    expect(rangeRects).toHaveBeenCalled();
  });
});
