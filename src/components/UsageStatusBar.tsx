import { Show, createMemo } from 'solid-js';
import { store, refreshClaudeUsage } from '../store/store';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import type { ClaudeUsageWindow } from '../ipc/types';
import { USAGE_WARN_PERCENT, formatFetchedAt, formatReset, remainingPercent } from './usage-format';

function UsageMeter(props: { label: string; window: ClaudeUsageWindow }) {
  const warn = () => props.window.usedPercent >= USAGE_WARN_PERCENT;
  const color = () => (warn() ? theme.warning : theme.accent);
  const reset = () => formatReset(props.window.resetsAt);

  return (
    <span style={{ display: 'inline-flex', 'align-items': 'center', gap: '6px' }}>
      <span style={{ color: theme.fgSubtle }}>{props.label}</span>
      <span
        role="progressbar"
        aria-label={`${props.label} window used`}
        aria-valuenow={Math.round(props.window.usedPercent)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          width: '56px',
          height: '5px',
          'border-radius': '3px',
          background: theme.bgInput,
          border: `1px solid ${theme.border}`,
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${Math.min(100, props.window.usedPercent)}%`,
            background: color(),
          }}
        />
      </span>
      <span style={{ color: warn() ? theme.warning : theme.fg, 'font-weight': '500' }}>
        {remainingPercent(props.window)}% left
      </span>
      <Show when={reset()}>
        <span style={{ color: theme.fgSubtle }}>{reset()}</span>
      </Show>
    </span>
  );
}

/**
 * Bottom bar with the active Claude subscription's rate-limit windows.
 * Hidden until the first successful read, and permanently when there is no
 * subscription login to read (API-key users).
 */
export function UsageStatusBar() {
  const usage = () => store.claudeUsage;
  const hasSnapshot = createMemo(() => usage().fiveHour !== null || usage().sevenDay !== null);
  const visible = createMemo(() => hasSnapshot() || usage().status === 'error');
  const stale = () => usage().status === 'error' && hasSnapshot();
  const title = () => {
    if (usage().status === 'error') return `Refresh failed: ${usage().error}\nClick to retry`;
    const at = usage().fetchedAt;
    return `${at ? `Updated ${formatFetchedAt(at)}. ` : ''}Click to refresh`;
  };

  return (
    <Show when={visible()}>
      <div
        role="status"
        title={title()}
        onClick={() => void refreshClaudeUsage({ force: true })}
        style={{
          height: '24px',
          'min-height': '24px',
          display: 'flex',
          'align-items': 'center',
          gap: '16px',
          padding: '0 10px',
          'border-top': `1px solid ${theme.border}`,
          'font-family': "'JetBrains Mono', monospace",
          'font-size': sf(11),
          color: theme.fgMuted,
          'white-space': 'nowrap',
          overflow: 'hidden',
          cursor: 'pointer',
          'user-select': 'none',
          'flex-shrink': '0',
          opacity: stale() ? '0.6' : '1',
        }}
      >
        <span
          style={{
            color: theme.fgSubtle,
            'text-transform': 'uppercase',
            'letter-spacing': '0.05em',
          }}
        >
          Claude
        </span>
        <Show when={usage().fiveHour}>{(w) => <UsageMeter label="5h" window={w()} />}</Show>
        <Show when={usage().sevenDay}>{(w) => <UsageMeter label="7d" window={w()} />}</Show>
        <Show when={!hasSnapshot()}>
          <span>usage unavailable · {usage().error}</span>
        </Show>
      </div>
    </Show>
  );
}
