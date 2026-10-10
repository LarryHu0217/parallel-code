import { For, Show, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { createAnchorEffect, placeBelow, type BelowAnchor } from '../lib/floating';
import { CheckIcon, ChevronDownIcon } from './icons';

const MENU_WIDTH = 190;
const MENU_HEIGHT = 230;

interface ModelMenuChoice {
  value: string;
  label: string;
  title?: string;
}
interface ModelMenuGroup {
  heading: string;
  choices: ModelMenuChoice[];
  empty?: string;
}
interface ModelMenuProps {
  label: string;
  title?: string;
  groups: ModelMenuGroup[];
  value: string;
  onSelect: (value: string) => void;
  onOpen?: () => void;
  disabled?: boolean;
  style?: JSX.CSSProperties;
  class?: string;
}

function ModelList(props: ModelMenuProps & { position: BelowAnchor; onClose: () => void }) {
  let menu: HTMLDivElement | undefined;
  const items = () =>
    Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);

  onMount(() => {
    // The chevron that opened the menu gets the focus back when it goes.
    const opener = document.activeElement;
    const list = items();
    const checked = list.find((item) => item.getAttribute('aria-checked') === 'true');
    const frame = requestAnimationFrame(() => (checked ?? list[0])?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        props.onClose();
        return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const current = items();
      const at = current.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      current[(at + step + current.length) % current.length]?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKey, true);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    });
  });

  return (
    <Portal>
      <div
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
        onContextMenu={() => props.onClose()}
        style={{ position: 'fixed', inset: '0', 'z-index': '2000' }}
      >
        <div
          ref={menu}
          role="menu"
          aria-label={props.label}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: `${props.position.top}px`,
            right: `${props.position.right}px`,
            width: `${MENU_WIDTH}px`,
            background: theme.bgElevated,
            border: `1px solid ${theme.border}`,
            'border-radius': 'var(--radius-md)',
            'box-shadow': '0 6px 20px rgba(0, 0, 0, 0.35)',
            padding: '4px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '1px',
          }}
        >
          <For each={props.groups}>
            {(group) => (
              <>
                <div
                  role="presentation"
                  style={{
                    padding: '6px 8px 2px',
                    'font-size': sf(10),
                    'text-transform': 'uppercase',
                    'letter-spacing': '0.06em',
                    color: theme.fgMuted,
                  }}
                >
                  {group.heading}
                </div>
                <Show when={group.empty && group.choices.length === 0}>
                  <div
                    role="presentation"
                    style={{
                      padding: '5px 8px 5px 26px',
                      'font-size': sf(12),
                      color: theme.fgSubtle,
                    }}
                  >
                    {group.empty}
                  </div>
                </Show>
                <For each={group.choices}>
                  {(choice) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={props.value === choice.value}
                      title={choice.title}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onSelect(choice.value);
                        props.onClose();
                      }}
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        gap: '6px',
                        padding: '5px 8px',
                        background: 'transparent',
                        border: 'none',
                        'border-radius': 'var(--radius-sm)',
                        color: theme.fg,
                        cursor: 'pointer',
                        'text-align': 'left',
                        font: 'inherit',
                        'font-size': sf(12),
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = theme.bgHover)}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      {/* The space is reserved on every row, so the labels line up. */}
                      <span
                        aria-hidden="true"
                        style={{
                          width: '12px',
                          'flex-shrink': '0',
                          color: theme.success,
                          display: 'inline-flex',
                        }}
                      >
                        <Show when={props.value === choice.value}>
                          <CheckIcon size={12} />
                        </Show>
                      </span>
                      <span>{choice.label}</span>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
      </div>
    </Portal>
  );
}

export function ModelMenu(props: ModelMenuProps) {
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<BelowAnchor>({ top: 0, right: 0, maxHeight: 0 });
  let trigger: HTMLButtonElement | undefined;

  createAnchorEffect(open, () => {
    if (!trigger) return;
    setPosition(
      placeBelow(
        trigger.getBoundingClientRect(),
        MENU_WIDTH,
        { width: window.innerWidth, height: window.innerHeight },
        12,
        MENU_HEIGHT,
      ),
    );
  });

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open()}
        title={props.title ?? props.label}
        disabled={props.disabled}
        class={props.class}
        style={props.style}
        onClick={(event) => {
          // The notes overlay behind the button reacts to clicks of its own.
          event.stopPropagation();
          // Load choices only when the user opens the menu.
          if (!open()) props.onOpen?.();
          setOpen(!open());
        }}
      >
        <ChevronDownIcon size={12} />
      </button>
      <Show when={open()}>
        <ModelList {...props} position={position()} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}
