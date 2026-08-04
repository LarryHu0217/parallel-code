import { Show, For, createSignal, createEffect, createMemo, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Dialog } from './Dialog';
import { createDialogScroll } from '../lib/dialog-scroll';
import { ReviewProvider, useReview } from './ReviewProvider';
import { ReviewCommentsButton, ReviewSidebarPanel } from './ReviewSidebarPanel';
import { ReviewCommentCard } from './ReviewCommentCard';
import { InlineInput } from './InlineInput';
import { AskCodeCard } from './AskCodeCard';
import { CloseIcon } from './icons';
import { createHighlightedMarkdown } from '../lib/marked-shiki';
import {
  getPlanSelection,
  getPlanSelectionFlowAnchor,
  getPlanSelectionTextRanges,
  PLAN_REVIEW_FLOW_SLOT_SELECTOR,
  trackPlanSelectionGeometry,
  type PlanSelectionRect,
} from '../lib/plan-selection';
import { openFileInEditor } from '../lib/shell';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import type { ReviewAnnotation } from './review-types';

interface PlanViewerDialogProps {
  open: boolean;
  onClose: () => void;
  planContent: string;
  planFileName: string;
  taskId?: string;
  agentId?: string;
  worktreePath?: string;
}

/** Compile review annotations into a prompt string for the agent. */
function compilePlanReview(annotations: ReviewAnnotation[]): string {
  const lines = ['Feedback on the implementation plan:\n'];
  for (const a of annotations) {
    lines.push(`## ${a.filePath}`);
    lines.push('> ' + a.selectedText.split('\n').join('\n> '));
    lines.push('');
    lines.push(a.comment);
    lines.push('');
  }
  return lines.join('\n');
}

export function PlanViewerDialog(props: PlanViewerDialogProps) {
  const reviewSession = createMemo(() => {
    if (!props.open) return undefined;
    return {
      planContent: props.planContent,
      planFileName: props.planFileName,
      taskId: props.taskId,
      agentId: props.agentId,
      worktreePath: props.worktreePath,
    };
  });

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="fit-content"
      panelStyle={{
        height: '70vh',
        'min-width': '360px',
        'max-width': '1000px',
        overflow: 'hidden',
        padding: '0',
        gap: '0',
      }}
    >
      <Show keyed when={reviewSession()}>
        {(session) => (
          <ReviewProvider
            taskId={session.taskId}
            agentId={session.agentId}
            compilePrompt={compilePlanReview}
            onSubmitted={props.onClose}
          >
            <PlanViewerContent
              planContent={session.planContent}
              planFileName={session.planFileName}
              worktreePath={session.worktreePath}
              onClose={props.onClose}
            />
          </ReviewProvider>
        )}
      </Show>
    </Dialog>
  );
}

interface PlanViewerContentProps {
  planContent: string;
  planFileName: string;
  worktreePath?: string;
  onClose: () => void;
}

/** Inner content rendered inside ReviewProvider so it can call useReview(). */
function insertPlanReviewFlowSlot(anchor: HTMLElement): HTMLDivElement {
  const slot = document.createElement('div');
  slot.className = 'plan-review-flow-slot';
  slot.setAttribute('data-plan-review-flow-slot', '');

  if (anchor.tagName === 'LI') {
    anchor.append(slot);
    return slot;
  }

  let insertionPoint: Element = anchor;
  while (insertionPoint.nextElementSibling?.matches(PLAN_REVIEW_FLOW_SLOT_SELECTOR)) {
    insertionPoint = insertionPoint.nextElementSibling;
  }
  insertionPoint.after(slot);
  return slot;
}

function PlanViewerContent(props: PlanViewerContentProps) {
  const review = useReview();
  const planHtml = createHighlightedMarkdown(() => props.planContent);

  let contentRef: HTMLDivElement | undefined;
  let scrollRef: HTMLDivElement | undefined;

  const [pendingFlowSlot, setPendingFlowSlot] = createSignal<HTMLDivElement>();
  const [flowSlots, setFlowSlots] = createSignal<Record<string, HTMLDivElement>>({});
  const [highlightRects, setHighlightRects] = createSignal<PlanSelectionRect[]>([]);
  let stopHighlightTracking: (() => void) | undefined;

  createDialogScroll(
    () => scrollRef,
    () => !!props.planContent,
  );

  // Render mermaid blocks after HTML is inserted
  createEffect(() => {
    void planHtml(); // track dependency
    if (!contentRef) return;
    const blocks = contentRef.querySelectorAll('.mermaid-block');
    if (blocks.length === 0) return;
    import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'dark' });
      blocks.forEach((el, i) => {
        const source = el.getAttribute('data-mermaid');
        if (!source) return;
        const id = `mermaid-plan-${Date.now()}-${i}`;
        mermaid.render(id, source).then(({ svg }) => {
          el.innerHTML = svg; // nosemgrep: semgrep.no-inner-html-without-sanitize -- mermaid renders its own sanitized SVG; source is plan text not user HTML
          el.classList.add('mermaid-rendered');
        });
      });
    });
  });

  // Scroll to annotation when scrollTarget changes
  createEffect(() => {
    const target = review.scrollTarget();
    if (!target?.id) return;
    const slot = flowSlots()[target.id];
    if (slot && scrollRef) {
      const scrollRect = scrollRef.getBoundingClientRect();
      const slotRect = slot.getBoundingClientRect();
      const top = scrollRef.scrollTop + slotRect.top - scrollRect.top;
      scrollRef.scrollTo({ top: Math.max(0, top - 100), behavior: 'smooth' });
    }
  });

  // Remove flow slots when their annotation or question is removed elsewhere (for example,
  // from the review sidebar).
  createEffect(() => {
    const activeIds = new Set([
      ...review.annotations().map((annotation) => annotation.id),
      ...review.activeQuestions().map((question) => question.id),
    ]);
    const currentSlots = flowSlots();
    const staleIds = Object.keys(currentSlots).filter((id) => !activeIds.has(id));
    if (staleIds.length === 0) return;

    for (const id of staleIds) {
      currentSlots[id].remove();
    }
    setFlowSlots(
      Object.fromEntries(Object.entries(currentSlots).filter(([id]) => activeIds.has(id))),
    );
  });

  // Clear highlight overlays when pending selection is dismissed
  createEffect(() => {
    if (!review.pendingSelection()) clearHighlightGeometry();
  });

  function clearHighlightGeometry() {
    stopHighlightTracking?.();
    stopHighlightTracking = undefined;
    setHighlightRects([]);
  }

  function handleMouseUp(event: MouseEvent) {
    if (!contentRef) return;
    const eventTarget = event.target;
    if (eventTarget instanceof Element && eventTarget.closest(PLAN_REVIEW_FLOW_SLOT_SELECTOR)) {
      return;
    }

    const sel = getPlanSelection(contentRef, props.planFileName);
    const flowAnchor = getPlanSelectionFlowAnchor(contentRef);
    const textRanges = getPlanSelectionTextRanges(contentRef);
    if (!sel || !flowAnchor || textRanges.length === 0) return;

    stopHighlightTracking?.();
    pendingFlowSlot()?.remove();
    stopHighlightTracking = trackPlanSelectionGeometry(contentRef, textRanges, setHighlightRects);
    setPendingFlowSlot(insertPlanReviewFlowSlot(flowAnchor));
    // Clear native selection — overlay rects provide the visual highlight from here
    window.getSelection()?.removeAllRanges();

    const source = sel.nearestHeading
      ? `${props.planFileName} \u00A7 ${sel.nearestHeading}`
      : props.planFileName;

    review.handleSelection({
      source,
      startLine: sel.startLine,
      endLine: sel.endLine,
      selectedText: sel.selectedText,
    });
  }

  function handleSubmitInFlow(text: string, mode: Parameters<typeof review.handleSubmit>[1]) {
    const slot = pendingFlowSlot();
    const id = review.handleSubmit(text, mode);
    if (!id) return;
    if (slot) setFlowSlots((prev) => ({ ...prev, [id]: slot }));
    setPendingFlowSlot(undefined);
    clearHighlightGeometry();
  }

  function dismissPendingSelection() {
    pendingFlowSlot()?.remove();
    setPendingFlowSlot(undefined);
    review.clearPendingSelection();
  }

  function dismissAnnotation(id: string) {
    review.dismissAnnotation(id);
    removeFlowSlot(id);
  }

  function dismissQuestion(id: string) {
    review.dismissQuestion(id);
    removeFlowSlot(id);
  }

  function removeFlowSlot(id: string) {
    const slot = flowSlots()[id];
    slot?.remove();
    setFlowSlots((prev) => {
      if (!(id in prev)) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([slotId]) => slotId !== id));
    });
  }

  onCleanup(() => {
    stopHighlightTracking?.();
    pendingFlowSlot()?.remove();
    Object.values(flowSlots()).forEach((slot) => slot.remove());
  });

  return (
    <>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          padding: '12px 20px',
          'border-bottom': `1px solid ${theme.border}`,
          'flex-shrink': '0',
        }}
      >
        <span
          style={{
            'font-size': sf(14),
            color: theme.fg,
            'font-weight': '600',
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          {props.planFileName}
        </span>

        <ReviewCommentsButton />

        <span style={{ flex: '1' }} />

        <Show when={props.worktreePath}>
          <button
            onClick={() => {
              if (props.worktreePath) openFileInEditor(props.worktreePath, props.planFileName);
            }}
            style={{
              background: 'transparent',
              border: 'none',
              color: theme.fgMuted,
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              'align-items': 'center',
              'border-radius': '4px',
            }}
            title="Open in editor"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.5 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3a.75.75 0 0 1 1.5 0v3A3 3 0 0 1 12.5 16h-9A3 3 0 0 1 0 12.5v-9A3 3 0 0 1 3.5 0h3a.75.75 0 0 1 0 1.5h-3ZM10 .75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V2.56L8.53 8.53a.75.75 0 0 1-1.06-1.06L13.44 1.5H10.75A.75.75 0 0 1 10 .75Z" />
            </svg>
          </button>
        </Show>

        <button
          onClick={() => props.onClose()}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            'align-items': 'center',
            'border-radius': '4px',
          }}
          title="Close"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: '1', overflow: 'hidden', display: 'flex' }}>
        {/* Scrollable plan content area */}
        <div
          ref={scrollRef}
          style={{
            flex: '1',
            'overflow-y': 'auto',
            padding: '28px 40px',
          }}
        >
          <div style={{ position: 'relative' }}>
            <div
              ref={contentRef}
              class="plan-markdown plan-markdown-dialog"
              style={{
                color: theme.fg,
              }}
              onMouseUp={handleMouseUp}
              // eslint-disable-next-line solid/no-innerhtml -- plan files are local, written by Claude Code in the worktree
              innerHTML={planHtml()}
            />

            {/* Selection highlight overlays — persist after focus moves to inline input */}
            <For each={highlightRects()}>
              {(rect) => (
                <div
                  style={{
                    position: 'absolute',
                    top: `${rect.top}px`,
                    left: `${rect.left}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`,
                    background: 'rgba(100, 149, 237, 0.3)',
                    'pointer-events': 'none',
                    'border-radius': '2px',
                  }}
                />
              )}
            </For>

            {/* Inline input for pending selection — mounted after the selected block */}
            <Show keyed when={pendingFlowSlot()}>
              {(slot) => (
                <Portal mount={slot}>
                  <InlineInput onSubmit={handleSubmitInFlow} onDismiss={dismissPendingSelection} />
                </Portal>
              )}
            </Show>

            {/* Annotation cards — mounted in document flow after the selected block */}
            <For each={review.annotations()}>
              {(annotation) => (
                <Show when={flowSlots()[annotation.id]}>
                  {(slot) => (
                    <Portal mount={slot()}>
                      <div data-annotation-id={annotation.id}>
                        <ReviewCommentCard
                          annotation={annotation}
                          onDismiss={() => dismissAnnotation(annotation.id)}
                        />
                      </div>
                    </Portal>
                  )}
                </Show>
              )}
            </For>

            {/* Active questions — mounted in document flow after the selected block */}
            <For each={review.activeQuestions()}>
              {(q) => (
                <Show when={flowSlots()[q.id]}>
                  {(slot) => (
                    <Portal mount={slot()}>
                      <AskCodeCard
                        requestId={q.id}
                        question={q.question}
                        filePath={q.source}
                        startLine={q.startLine}
                        endLine={q.endLine}
                        selectedText={q.selectedText}
                        worktreePath={props.worktreePath ?? ''}
                        onDismiss={() => dismissQuestion(q.id)}
                      />
                    </Portal>
                  )}
                </Show>
              )}
            </For>
          </div>
        </div>

        {/* Sidebar */}
        <ReviewSidebarPanel />
      </div>
    </>
  );
}
