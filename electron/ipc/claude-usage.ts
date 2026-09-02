import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ClaudeUsageResult, ClaudeUsageWindow } from './shared-types.js';
import { warn as logWarn, errMessage } from '../log.js';

/**
 * Reads the rate-limit windows Claude Code shows under `/usage`, from the same
 * OAuth endpoint the CLI calls. Only subscription logins (Pro/Max) carry these
 * windows; API-key users get `unavailable` and the status bar stays hidden.
 * The endpoint is undocumented, so the parser tolerates both field spellings
 * seen in the wild (`utilization` and `used_percentage`).
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REQUEST_TIMEOUT_MS = 10_000;
// macOS Claude Code keeps credentials in the login keychain, not on disk.
// Since 2.1 the service name is suffixed with a hash of a custom config dir.
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

const execFileAsync = promisify(execFile);

interface UsageWindowJson {
  utilization?: unknown;
  used_percentage?: unknown;
  resets_at?: unknown;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `resets_at` has shipped as ISO strings and as epoch seconds; accept both. */
export function parseResetsAt(value: unknown): number | null {
  const num = finite(value);
  // 1e10 separates any seconds epoch (< year 2286) from any ms epoch (> 2001).
  if (num !== null) return num > 1e10 ? num : num * 1000;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function parseWindow(value: unknown): ClaudeUsageWindow | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as UsageWindowJson;
  const usedPercent = finite(raw.utilization) ?? finite(raw.used_percentage);
  if (usedPercent === null) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    resetsAt: parseResetsAt(raw.resets_at),
  };
}

/** Parses the usage endpoint body. Returns null when neither window is present. */
export function parseClaudeUsageResponse(
  body: unknown,
  now = Date.now(),
): ClaudeUsageResult | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as { five_hour?: unknown; seven_day?: unknown };
  const fiveHour = parseWindow(raw.five_hour);
  const sevenDay = parseWindow(raw.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { status: 'ok', fiveHour, sevenDay, fetchedAt: now };
}

/** Extracts the OAuth access token from a Claude credentials JSON document. */
export function parseAccessToken(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = parsed?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function keychainServices(configDir: string): string[] {
  if (configDir === path.join(os.homedir(), '.claude')) return [KEYCHAIN_SERVICE];
  const suffix = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return [`${KEYCHAIN_SERVICE}-${suffix}`, KEYCHAIN_SERVICE];
}

async function readKeychainCredentials(configDir: string): Promise<string | null> {
  for (const service of keychainServices(configDir)) {
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', service, '-w'],
        { timeout: 5_000 },
      );
      if (stdout.trim()) return stdout.trim();
    } catch {
      // `security` exits non-zero when the item is absent; try the next service name.
    }
  }
  return null;
}

async function readCredentialsJson(configDir: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(path.join(configDir, '.credentials.json'), 'utf8');
  } catch {
    // No file: on macOS the keychain is the normal home for these credentials.
    return process.platform === 'darwin' ? readKeychainCredentials(configDir) : null;
  }
}

async function requestUsage(token: string): Promise<ClaudeUsageResult> {
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      // Only the CLI talks to this endpoint; present as it does so we get the same response.
      'User-Agent': 'claude-code/2.1.0',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    return {
      status: 'error',
      message: `Claude login token rejected (HTTP ${res.status}) — start a Claude Code session to refresh it`,
    };
  }
  if (!res.ok) return { status: 'error', message: `Usage endpoint returned HTTP ${res.status}` };
  const parsed = parseClaudeUsageResponse(await res.json());
  return parsed ?? { status: 'unavailable', reason: 'No rate-limit windows in response' };
}

export async function fetchClaudeUsage(configDir = claudeConfigDir()): Promise<ClaudeUsageResult> {
  const json = await readCredentialsJson(configDir);
  const token = json ? parseAccessToken(json) : null;
  if (!token) return { status: 'unavailable', reason: 'No Claude subscription login found' };
  try {
    return await requestUsage(token);
  } catch (err) {
    logWarn('claude-usage', 'fetch failed', { err: errMessage(err) });
    return { status: 'error', message: errMessage(err) };
  }
}
