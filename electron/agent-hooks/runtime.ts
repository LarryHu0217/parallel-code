import { app, type BrowserWindow } from 'electron';
import path from 'path';
import { IPC } from '../ipc/channels.js';
import { setAgentHookRuntime } from '../ipc/pty.js';
import { error as logError, info as logInfo } from '../log.js';
import { startAgentHookServer, type AgentHookServer } from './server.js';
import type { AgentHookEventPayload } from './status.js';

let server: AgentHookServer | null = null;

/**
 * Brings up the loopback hook receiver and hands its env/settings to the PTY
 * layer so every Claude Code launch from here on reports its own status.
 * Failure is logged and otherwise ignored: the PTY heuristics keep working.
 */
export async function startAgentHookRuntime(getWindow: () => BrowserWindow | null): Promise<void> {
  const dir = path.join(app.getPath('userData'), 'agent-hooks');
  // Resolved per event: the server starts before the window exists so that no
  // Claude launch can race it, and the window may be recreated later.
  const forward = (event: AgentHookEventPayload): void => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC.AgentHookEvent, event);
  };
  try {
    server = await startAgentHookServer({ dir, onEvent: forward });
  } catch (err) {
    logError('agent-hooks', 'failed to start hook server; using PTY heuristics only', err);
    return;
  }
  setAgentHookRuntime({
    claudeSettingsPath: server.claudeSettingsPath,
    buildPtyEnv: server.buildPtyEnv,
  });
  logInfo('agent-hooks', 'hook server listening', { port: server.port, dir });
}

export function stopAgentHookRuntime(): void {
  setAgentHookRuntime(null);
  const current = server;
  server = null;
  current?.close().catch((err: unknown) => {
    logError('agent-hooks', 'failed to close hook server', err);
  });
}
