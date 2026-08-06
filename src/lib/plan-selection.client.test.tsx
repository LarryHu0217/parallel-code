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

function findTextNode(container: Node, value: string): Text {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.textContent === value) return node as Text;
    node = walker.nextNode();
  }
  throw new Error(`Could not find text node: ${value}`);
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

    expect(selection?.selectedText).toBe('Before plan text\nAfter plan text');
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

  it('preserves rendered block breaks between selected code and prose', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <pre class="shiki-block"><code>const x = 1;</code></pre>
      <p>After step</p>
    `;
    document.body.append(container);

    const codeText = container.querySelector('code')?.firstChild as Text;
    const proseText = container.querySelector('p')?.firstChild as Text;
    selectText(codeText, proseText);

    expect(getPlanSelection(container, 'plan.md')?.selectedText).toBe('const x = 1;\nAfter step');
  });

  it('excludes hidden Mermaid SVG text from selected prompt text', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <div class="mermaid-block mermaid-rendered" data-mermaid="graph TD"></div>
      <p>After diagram</p>
    `;
    const mermaid = container.querySelector('.mermaid-block') as HTMLDivElement;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = '.node { fill: red; }';
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const hidden = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    hidden.textContent = 'Hidden marker';
    const visible = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    visible.textContent = 'Visible diagram label';
    defs.append(hidden);
    svg.append(style, defs, visible);
    mermaid.append(svg);
    document.body.append(container);

    const hiddenText = findTextNode(container, 'Hidden marker');
    const proseText = container.querySelector('p')?.firstChild as Text;
    selectText(hiddenText, proseText);

    expect(getPlanSelection(container, 'plan.md')?.selectedText).toBe(
      'Visible diagram label\nAfter diagram',
    );
  });

  it('preserves native inline whitespace between selected formatted text', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p><strong>Hello</strong> <em>world</em></p>';
    document.body.append(container);

    const strongText = container.querySelector('strong')?.firstChild as Text;
    const emphasizedText = container.querySelector('em')?.firstChild as Text;
    selectText(strongText, emphasizedText);

    expect(getPlanSelection(container, 'plan.md')?.selectedText).toBe('Hello world');
  });

  it('preserves rendered soft and hard line breaks in selected Markdown text', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>Soft\nbreak<br>Hard break</p>';
    document.body.append(container);

    const firstText = container.querySelector('p')?.firstChild as Text;
    const lastText = container.querySelector('p')?.lastChild as Text;
    selectText(firstText, lastText);

    expect(getPlanSelection(container, 'plan.md')?.selectedText).toBe('Soft break\nHard break');
  });

  it('preserves table cell and row separators in selected Markdown tables', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <table>
        <tbody>
          <tr><td>A</td><td>B</td></tr>
          <tr><td>C</td><td>D</td></tr>
        </tbody>
      </table>
    `;
    document.body.append(container);

    const cells = container.querySelectorAll('td');
    selectText(cells[0].firstChild as Text, cells[3].firstChild as Text);

    expect(getPlanSelection(container, 'plan.md')?.selectedText).toBe('A\tB\nC\tD');
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
