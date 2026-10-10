import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { CreditUsage, UsageResult, UsageWindow } from './shared-types.js';
import { warn as logWarn, errMessage } from '../log.js';
import { clampPercent, finite, parseResetsAt, requestUsage } from './usage-shared.js';

/**
 * Reads the rate-limit windows Claude Code shows under `/usage`, from the same
 * OAuth endpoint the CLI calls. Only subscription logins (Pro/Max) carry these
 * windows; API-key users get `unavailable` and the status bar stays hidden.
 * The endpoint is undocumented, so the parser tolerates both field spellings
 * seen in the wild (`utilization` and `used_percentage`).
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// macOS Claude Code keeps credentials in the login keychain, not on disk.
// Since 2.1 the service name is suffixed with a hash of a custom config dir.
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

const execFileAsync = promisify(execFile);

/** Shape of `execFile` the keychain reader needs; injectable so tests can run the darwin path on Linux. */
export type KeychainExec = (
  file: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string }>;

interface UsageWindowJson {
  utilization?: unknown;
  used_percentage?: unknown;
  resets_at?: unknown;
}

interface RawSpendMinor {
  amount_minor?: unknown;
  currency?: unknown;
  exponent?: unknown;
}

interface RawSpend {
  used?: RawSpendMinor | null;
  limit?: RawSpendMinor | null;
  percent?: unknown;
  enabled?: unknown;
}

interface RawExtraUsage {
  is_enabled?: unknown;
  monthly_limit?: unknown;
  used_credits?: unknown;
  utilization?: unknown;
  currency?: unknown;
  decimal_places?: unknown;
}

export function parseCreditUsage(body: unknown): CreditUsage | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as { extra_usage?: unknown; spend?: unknown };

  if (typeof raw.extra_usage === 'object' && raw.extra_usage !== null) {
    const eu = raw.extra_usage as RawExtraUsage;
    const isEnabled = eu.is_enabled === true;
    const decimals = typeof eu.decimal_places === 'number' ? eu.decimal_places : 2;
    const divisor = 10 ** decimals;
    const rawUsed = finite(eu.used_credits);
    const rawLimit = finite(eu.monthly_limit);
    const used = rawUsed !== null ? rawUsed / divisor : null;
    const limit = rawLimit !== null ? rawLimit / divisor : null;
    const currency = typeof eu.currency === 'string' && eu.currency ? eu.currency : 'USD';
    const usedPercent = finite(eu.utilization);

    if (used !== null && (isEnabled || used > 0)) {
      const calcPercent = limit !== null && limit > 0 ? clampPercent((used / limit) * 100) : null;
      return {
        used,
        limit,
        currency,
        usedPercent: usedPercent !== null ? clampPercent(usedPercent) : calcPercent,
      };
    }
  }

  if (typeof raw.spend === 'object' && raw.spend !== null) {
    const sp = raw.spend as RawSpend;
    const enabled = sp.enabled === true;
    const usedMinor = finite(sp.used?.amount_minor);
    const exp = typeof sp.used?.exponent === 'number' ? sp.used.exponent : 2;
    const divisor = 10 ** exp;
    const used = usedMinor !== null ? usedMinor / divisor : null;
    const limitMinor = finite(sp.limit?.amount_minor);
    const limitExp = typeof sp.limit?.exponent === 'number' ? sp.limit.exponent : exp;
    const limit = limitMinor !== null ? limitMinor / 10 ** limitExp : null;
    const currency =
      typeof sp.used?.currency === 'string' && sp.used.currency ? sp.used.currency : 'USD';
    const percent = finite(sp.percent);

    if (used !== null && (enabled || used > 0)) {
      const calcPercent = limit !== null && limit > 0 ? clampPercent((used / limit) * 100) : null;
      return {
        used,
        limit,
        currency,
        usedPercent: percent !== null ? clampPercent(percent) : calcPercent,
      };
    }
  }

  return null;
}

function parseWindow(value: unknown): UsageWindow | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as UsageWindowJson;
  const usedPercent = finite(raw.utilization) ?? finite(raw.used_percentage);
  if (usedPercent === null) return null;
  return { usedPercent: clampPercent(usedPercent), resetsAt: parseResetsAt(raw.resets_at) };
}

/** Parses the usage endpoint body. Returns null when neither window is present. */
export function parseClaudeUsageResponse(body: unknown, now = Date.now()): UsageResult | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as { five_hour?: unknown; seven_day?: unknown };
  const fiveHour = parseWindow(raw.five_hour);
  const sevenDay = parseWindow(raw.seven_day);
  const creditUsage = parseCreditUsage(body);
  if (!fiveHour && !sevenDay && !creditUsage) return null;
  return {
    status: 'ok',
    fiveHour,
    sevenDay,
    ...(creditUsage ? { creditUsage } : {}),
    fetchedAt: now,
  };
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

export async function readKeychainCredentials(
  configDir: string,
  exec: KeychainExec = execFileAsync,
): Promise<string | null> {
  for (const service of keychainServices(configDir)) {
    try {
      const { stdout } = await exec('security', ['find-generic-password', '-s', service, '-w'], {
        timeout: 5_000,
      });
      if (stdout.trim()) return stdout.trim();
    } catch {
      // `security` exits non-zero when the item is absent; try the next service name.
    }
  }
  return null;
}

async function readCredentialsFile(configDir: string): Promise<string | null> {
  const file = path.join(configDir, '.credentials.json');
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    // Missing file just means no subscription login; anything else is worth a trace.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logWarn('claude-usage', 'credentials file unreadable', { file, err: errMessage(err) });
    }
    return null;
  }
}

async function readCredentialsJson(configDir: string): Promise<string | null> {
  // macOS Claude Code keeps the live token in the keychain; a leftover file
  // there could hold a stale one, so the keychain wins when it has an entry.
  if (process.platform === 'darwin') {
    const fromKeychain = await readKeychainCredentials(configDir);
    if (fromKeychain) return fromKeychain;
  }
  return readCredentialsFile(configDir);
}

export async function fetchClaudeUsage(configDir = claudeConfigDir()): Promise<UsageResult> {
  const json = await readCredentialsJson(configDir);
  const token = json ? parseAccessToken(json) : null;
  if (!token) return { status: 'unavailable', reason: 'No Claude subscription login found' };
  return requestUsage({
    scope: 'claude-usage',
    agent: 'Claude Code',
    url: USAGE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      // Only the CLI talks to this endpoint; present as it does so we get the same response.
      'User-Agent': 'claude-code/2.1.0',
    },
    parse: parseClaudeUsageResponse,
  });
}
