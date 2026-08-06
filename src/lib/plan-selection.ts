export interface PlanSelection {
  /** The plan filename or identifier */
  source: string;
  /** Selected text content */
  selectedText: string;
  /** Nearest heading text above the selection (for context) */
  nearestHeading: string;
  /** Block element index for ordering annotations */
  startLine: number;
  endLine: number;
}

const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, pre, tr';
const SELECTION_TEXT_BLOCK_SELECTOR = `${BLOCK_SELECTOR}, .mermaid-block`;
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
export const PLAN_REVIEW_FLOW_SLOT_SELECTOR = '[data-plan-review-flow-slot]';

export interface PlanSelectionRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function getSelectionRange(containerEl: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  return containerEl.contains(range.commonAncestorContainer) ? range : null;
}

function isInPlanReviewFlowSlot(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return Boolean(element?.closest(PLAN_REVIEW_FLOW_SLOT_SELECTOR));
}

function isHiddenSelectionTextNode(node: Node, containerEl: HTMLElement): boolean {
  let element = node.parentElement;
  while (element && element !== containerEl) {
    const tagName = element.tagName.toLowerCase();
    if (
      tagName === 'style' ||
      tagName === 'script' ||
      tagName === 'defs' ||
      tagName === 'metadata' ||
      tagName === 'title' ||
      tagName === 'desc' ||
      element.hasAttribute('hidden') ||
      element.getAttribute('aria-hidden') === 'true'
    ) {
      return true;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    element = element.parentElement;
  }
  return false;
}

function isHiddenSelectionElement(element: Element, containerEl: HTMLElement): boolean {
  let current: Element | null = element;
  while (current && current !== containerEl) {
    const tagName = current.tagName.toLowerCase();
    if (
      tagName === 'style' ||
      tagName === 'script' ||
      tagName === 'defs' ||
      tagName === 'metadata' ||
      tagName === 'title' ||
      tagName === 'desc' ||
      current.hasAttribute('hidden') ||
      current.getAttribute('aria-hidden') === 'true'
    ) {
      return true;
    }

    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    current = current.parentElement;
  }
  return false;
}

function getSelectedTextContent(text: Text, selectedRange: Range): string {
  const start = text === selectedRange.startContainer ? selectedRange.startOffset : 0;
  const end = text === selectedRange.endContainer ? selectedRange.endOffset : text.length;
  return start < end ? text.data.slice(start, end) : '';
}

function getSelectionTextBlock(node: Node, containerEl: HTMLElement): Element | null {
  const element = node.parentElement;
  const block = element?.closest(SELECTION_TEXT_BLOCK_SELECTOR);
  return block && containerEl.contains(block) ? block : null;
}

function getPlanSelectionVisibleText(containerEl: HTMLElement, selectedRange: Range): string {
  const parts: string[] = [];
  let lastBlock: Element | null = null;
  let lastCell: Element | null = null;
  let lastRow: Element | null = null;

  function trimTrailingHorizontalWhitespace(): void {
    const last = parts.at(-1);
    if (last !== undefined) parts[parts.length - 1] = last.replace(/[ \t]+$/u, '');
  }

  function appendBoundary(block: Element | null, cell: Element | null, row: Element | null): void {
    if (parts.length === 0) return;
    if (row && lastRow && row !== lastRow) {
      trimTrailingHorizontalWhitespace();
      parts.push('\n');
    } else if (cell && lastCell && cell !== lastCell && row === lastRow) {
      trimTrailingHorizontalWhitespace();
      parts.push('\t');
    } else if (block && block !== lastBlock) {
      trimTrailingHorizontalWhitespace();
      parts.push('\n');
    }
  }

  function appendTextForNode(node: Text): void {
    if (
      isInPlanReviewFlowSlot(node) ||
      isHiddenSelectionTextNode(node, containerEl) ||
      !selectedRange.intersectsNode(node)
    ) {
      return;
    }

    const rawText = getSelectedTextContent(node, selectedRange);
    if (!rawText) return;

    const parent = node.parentElement;
    const block = getSelectionTextBlock(node, containerEl);
    const cell = parent?.closest('td, th') ?? null;
    const row = parent?.closest('tr') ?? null;
    const isPreformatted = Boolean(parent?.closest('pre'));
    const text = isPreformatted ? rawText : rawText.replace(/\s+/g, ' ');
    if (!block && !text.trim()) return;
    if (!text.trim() && !isPreformatted && parts.length === 0) return;

    appendBoundary(block, cell, row);
    parts.push(text);
    lastBlock = block;
    lastCell = cell;
    lastRow = row;
  }

  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      appendTextForNode(node as Text);
      return;
    }

    if (!(node instanceof Element)) return;
    if (isInPlanReviewFlowSlot(node) || isHiddenSelectionElement(node, containerEl)) return;
    if (node !== containerEl && !selectedRange.intersectsNode(node)) return;

    if (node.tagName === 'BR') {
      parts.push('\n');
      return;
    }

    for (const child of Array.from(node.childNodes)) visit(child);
  }

  visit(containerEl);
  return parts.join('').trim();
}

/** Return the selected text ranges that belong to plan content, excluding inline review UI. */
export function getPlanSelectionTextRanges(containerEl: HTMLElement): Range[] {
  const selectedRange = getSelectionRange(containerEl);
  if (!selectedRange) return [];

  const ranges: Range[] = [];
  const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (!isInPlanReviewFlowSlot(node) && selectedRange.intersectsNode(node)) {
      const text = node as Text;
      const start = node === selectedRange.startContainer ? selectedRange.startOffset : 0;
      const end = node === selectedRange.endContainer ? selectedRange.endOffset : text.length;
      if (start < end) {
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, end);
        ranges.push(range);
      }
    }
    node = walker.nextNode();
  }
  return ranges;
}

export function getPlanSelectionRects(
  containerEl: HTMLElement,
  ranges: readonly Range[],
): PlanSelectionRect[] {
  const containerRect = containerEl.getBoundingClientRect();
  const rects: PlanSelectionRect[] = [];
  for (const range of ranges) {
    for (const rect of range.getClientRects()) {
      rects.push({
        top: rect.top - containerRect.top,
        left: rect.left - containerRect.left,
        width: rect.width,
        height: rect.height,
      });
    }
  }
  return rects;
}

/** Keep persisted selection overlays aligned while inline cards reflow the plan. */
export function trackPlanSelectionGeometry(
  containerEl: HTMLElement,
  ranges: readonly Range[],
  onChange: (rects: PlanSelectionRect[]) => void,
): () => void {
  const refresh = () => onChange(getPlanSelectionRects(containerEl, ranges));
  refresh();

  if (typeof ResizeObserver === 'undefined') return () => undefined;
  const observer = new ResizeObserver(refresh);
  observer.observe(containerEl);
  return () => observer.disconnect();
}

/**
 * Extract structured selection info from the current DOM selection
 * within a plan viewer container. Returns null if no valid selection.
 */
export function getPlanSelection(containerEl: HTMLElement, source: string): PlanSelection | null {
  const range = getSelectionRange(containerEl);
  if (!range) return null;

  const selectedText = getPlanSelectionVisibleText(containerEl, range);
  if (!selectedText) return null;

  const nearestHeading = findNearestHeading(containerEl, range.startContainer);
  const blocks = Array.from(containerEl.querySelectorAll(BLOCK_SELECTOR)).filter(
    (block) => !block.closest(PLAN_REVIEW_FLOW_SLOT_SELECTOR),
  );
  const blockIndex = countBlocksBefore(blocks, range.startContainer);
  const endBlockIndex = countBlocksBefore(blocks, range.endContainer);

  return {
    source,
    selectedText,
    nearestHeading,
    startLine: blockIndex,
    endLine: Math.max(blockIndex, endBlockIndex),
  };
}

/** Find the block that should own an inline review card for the current selection. */
export function getPlanSelectionFlowAnchor(containerEl: HTMLElement): HTMLElement | null {
  const range = getSelectionRange(containerEl);
  if (!range) return null;

  let element: Element | null =
    range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as Element)
      : range.endContainer.parentElement;
  if (!element || element.closest(PLAN_REVIEW_FLOW_SLOT_SELECTOR)) return null;

  const block = element.closest(BLOCK_SELECTOR);
  if (block && block !== containerEl && containerEl.contains(block)) {
    // A div cannot be a child of a table row, so place table comments after the table.
    if (block.tagName === 'TR') {
      const table = block.closest('table');
      if (table instanceof HTMLElement && containerEl.contains(table)) return table;
    }
    if (block instanceof HTMLElement) return block;
  }

  // Fallback for rendered blocks such as Mermaid diagrams that are not in BLOCK_SELECTOR.
  while (element.parentElement && element.parentElement !== containerEl) {
    element = element.parentElement;
  }
  return element instanceof HTMLElement && element.parentElement === containerEl ? element : null;
}

/** Walk backwards from the selection start to find the nearest heading. */
function findNearestHeading(container: HTMLElement, startNode: Node): string {
  let node: Node | null = startNode;

  // Walk up to find an element inside container
  while (node && node !== container && !(node instanceof HTMLElement)) {
    node = node.parentNode;
  }

  if (!node || node === container) {
    // Fallback: check if startNode is inside a heading
    return '';
  }

  const el = node as HTMLElement;

  // Check if we're inside a heading
  if (el.matches(HEADING_SELECTOR)) {
    return el.textContent?.trim() ?? '';
  }

  // Walk backwards through previous siblings and parent siblings
  let current: Element | null = el;
  while (current && container.contains(current)) {
    // Check previous siblings
    let sibling: Element | null = current.previousElementSibling;
    while (sibling) {
      // Check if sibling itself is a heading
      if (sibling.matches(HEADING_SELECTOR)) {
        return sibling.textContent?.trim() ?? '';
      }
      // Check for headings inside sibling (last one wins since we walk backwards)
      const headings = sibling.querySelectorAll(HEADING_SELECTOR);
      if (headings.length > 0) {
        return headings[headings.length - 1].textContent?.trim() ?? '';
      }
      sibling = sibling.previousElementSibling;
    }
    // Move to parent and continue
    current = current.parentElement;
    if (current === container) break;
  }

  return '';
}

/** Count block elements before the given node from a pre-queried list. */
function countBlocksBefore(blocks: readonly Element[], node: Node): number {
  let count = 0;
  for (const block of blocks) {
    // Is this block before or containing the node?
    const position = block.compareDocumentPosition(node);
    // If node is contained by or equal to block, stop here
    if (block === node || block.contains(node)) return count;
    // If block is before node (DOCUMENT_POSITION_FOLLOWING means node follows)
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      count++;
    } else {
      break;
    }
  }
  return count;
}
