import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import {
  fetchClaudeUsage,
  parseAccessToken,
  parseClaudeUsageResponse,
  parseCreditUsage,
  readKeychainCredentials,
  type KeychainExec,
} from './claude-usage.js';

const NOW = 1_700_000_000_000;

describe('parseClaudeUsageResponse', () => {
  it('reads both field spellings and clamps percentages', () => {
    const result = parseClaudeUsageResponse(
      {
        five_hour: { utilization: 23.5, resets_at: 1_738_425_600 },
        seven_day: { used_percentage: 140, resets_at: '2025-02-06T16:00:00Z' },
      },
      NOW,
    );
    expect(result).toEqual({
      status: 'ok',
      fiveHour: { usedPercent: 23.5, resetsAt: 1_738_425_600_000 },
      sevenDay: { usedPercent: 100, resetsAt: Date.parse('2025-02-06T16:00:00Z') },
      fetchedAt: NOW,
    });
  });

  it('keeps a window whose reset time is missing', () => {
    const result = parseClaudeUsageResponse({ five_hour: { utilization: 5 } }, NOW);
    expect(result).toEqual({
      status: 'ok',
      fiveHour: { usedPercent: 5, resetsAt: null },
      sevenDay: null,
      fetchedAt: NOW,
    });
  });

  it('includes creditUsage when extra_usage is present', () => {
    const result = parseClaudeUsageResponse(
      {
        five_hour: { utilization: 10 },
        extra_usage: {
          is_enabled: true,
          monthly_limit: 3000,
          used_credits: 212,
          utilization: 7.07,
          currency: 'USD',
          decimal_places: 2,
        },
      },
      NOW,
    );
    expect(result).toEqual({
      status: 'ok',
      fiveHour: { usedPercent: 10, resetsAt: null },
      sevenDay: null,
      creditUsage: {
        used: 2.12,
        limit: 30,
        currency: 'USD',
        usedPercent: 7.07,
      },
      fetchedAt: NOW,
    });
  });

  it('returns ok if only creditUsage is present without rate limit windows', () => {
    const result = parseClaudeUsageResponse(
      {
        extra_usage: {
          is_enabled: true,
          monthly_limit: 1000,
          used_credits: 500,
        },
      },
      NOW,
    );
    expect(result).toEqual({
      status: 'ok',
      fiveHour: null,
      sevenDay: null,
      creditUsage: {
        used: 5,
        limit: 10,
        currency: 'USD',
        usedPercent: 50,
      },
      fetchedAt: NOW,
    });
  });

  it('returns null when neither windows nor credit usage are present', () => {
    expect(parseClaudeUsageResponse({ five_hour: { resets_at: 1 } })).toBeNull();
    expect(parseClaudeUsageResponse({})).toBeNull();
    expect(parseClaudeUsageResponse(null)).toBeNull();
    expect(parseClaudeUsageResponse('nope')).toBeNull();
  });
});

describe('parseCreditUsage', () => {
  it('parses extra_usage with custom decimal places and currency', () => {
    expect(
      parseCreditUsage({
        extra_usage: {
          is_enabled: true,
          monthly_limit: 5000,
          used_credits: 1250,
          currency: 'EUR',
          decimal_places: 2,
        },
      }),
    ).toEqual({
      used: 12.5,
      limit: 50,
      currency: 'EUR',
      usedPercent: 25,
    });
  });

  it('falls back to spend object when extra_usage is absent', () => {
    expect(
      parseCreditUsage({
        spend: {
          enabled: true,
          used: { amount_minor: 350, currency: 'USD', exponent: 2 },
          limit: { amount_minor: 1000, exponent: 2 },
          percent: 35,
        },
      }),
    ).toEqual({
      used: 3.5,
      limit: 10,
      currency: 'USD',
      usedPercent: 35,
    });
  });

  it('returns null when extra_usage is disabled and 0 credits used', () => {
    expect(
      parseCreditUsage({
        extra_usage: {
          is_enabled: false,
          monthly_limit: 3000,
          used_credits: 0,
        },
      }),
    ).toBeNull();
  });

  it('returns usage if credits have been used even if is_enabled is false', () => {
    expect(
      parseCreditUsage({
        extra_usage: {
          is_enabled: false,
          monthly_limit: 3000,
          used_credits: 150,
        },
      }),
    ).toEqual({
      used: 1.5,
      limit: 30,
      currency: 'USD',
      usedPercent: 5,
    });
  });

  it('returns null for missing, null, or malformed data', () => {
    expect(parseCreditUsage(null)).toBeNull();
    expect(parseCreditUsage({})).toBeNull();
    expect(parseCreditUsage('hello')).toBeNull();
  });
});

describe('parseAccessToken', () => {
  it('extracts the OAuth access token', () => {
    expect(parseAccessToken('{"claudeAiOauth":{"accessToken":"tok"}}')).toBe('tok');
  });

  it('returns null for missing tokens or malformed JSON', () => {
    expect(parseAccessToken('{"claudeAiOauth":{}}')).toBeNull();
    expect(parseAccessToken('{"claudeAiOauth":{"accessToken":""}}')).toBeNull();
    expect(parseAccessToken('{}')).toBeNull();
    expect(parseAccessToken('not json')).toBeNull();
  });
});

describe('fetchClaudeUsage', () => {
  const dirs: string[] = [];

  function configDir(credentials?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-'));
    dirs.push(dir);
    if (credentials !== undefined)
      fs.writeFileSync(path.join(dir, '.credentials.json'), credentials);
    return dir;
  }

  function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'darwin')(
    'is unavailable without a credentials file',
    async () => {
      const fetchMock = stubFetch(200, {});
      const result = await fetchClaudeUsage(configDir());
      expect(result.status).toBe('unavailable');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('sends the token as a bearer header and returns parsed windows', async () => {
    const fetchMock = stubFetch(200, { five_hour: { utilization: 42, resets_at: 1_738_425_600 } });
    const result = await fetchClaudeUsage(
      configDir('{"claudeAiOauth":{"accessToken":"secret-token"}}'),
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.fiveHour?.usedPercent).toBe(42);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
  });

  it('reports rejected tokens as a recoverable error, not unavailable', async () => {
    stubFetch(401, { error: 'expired' });
    const result = await fetchClaudeUsage(configDir('{"claudeAiOauth":{"accessToken":"stale"}}'));
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toMatch(/401/);
  });

  it('reports other HTTP failures with their status', async () => {
    stubFetch(429, {});
    const result = await fetchClaudeUsage(configDir('{"claudeAiOauth":{"accessToken":"tok"}}'));
    expect(result).toEqual({ status: 'error', message: 'Usage endpoint returned HTTP 429' });
  });

  it('reports network failures without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    const result = await fetchClaudeUsage(configDir('{"claudeAiOauth":{"accessToken":"tok"}}'));
    expect(result).toEqual({ status: 'error', message: 'ECONNRESET' });
  });
});

describe('readKeychainCredentials', () => {
  const SECURITY_ARGS = (service: string) => ['find-generic-password', '-s', service, '-w'];

  it('reads the unscoped service for the default config dir', async () => {
    const exec = vi.fn<KeychainExec>(async () => ({ stdout: '{"claudeAiOauth":{}}\n' }));
    const result = await readKeychainCredentials(path.join(os.homedir(), '.claude'), exec);
    expect(result).toBe('{"claudeAiOauth":{}}');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('security', SECURITY_ARGS('Claude Code-credentials'), {
      timeout: 5_000,
    });
  });

  it('tries the config-dir-scoped service first, then falls back to the unscoped one', async () => {
    const exec = vi
      .fn<KeychainExec>()
      .mockRejectedValueOnce(new Error('item not found'))
      .mockResolvedValueOnce({ stdout: 'creds' });
    await expect(readKeychainCredentials('/custom/dir', exec)).resolves.toBe('creds');
    const suffix = crypto.createHash('sha256').update('/custom/dir').digest('hex').slice(0, 8);
    expect(exec.mock.calls.map(([, args]) => args)).toEqual([
      SECURITY_ARGS(`Claude Code-credentials-${suffix}`),
      SECURITY_ARGS('Claude Code-credentials'),
    ]);
  });

  it('returns null when every lookup fails or comes back empty', async () => {
    const exec = vi.fn<KeychainExec>(async () => ({ stdout: '  \n' }));
    await expect(readKeychainCredentials('/custom/dir', exec)).resolves.toBeNull();
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
