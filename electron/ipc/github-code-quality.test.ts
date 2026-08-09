import { execFile } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => {
  const mockExecFile = vi.fn();
  (mockExecFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
    (file: unknown, args: unknown, opts: unknown): Promise<{ stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        mockExecFile(file, args, opts, (error: Error | null, stdout: string, stderr: string) => {
          if (error) reject(Object.assign(error, { stderr }));
          else resolve({ stdout, stderr });
        });
      });
  return { execFile: mockExecFile };
});

import {
  classifyGithubCodeQualityError,
  loadGithubCodeQualityFindings,
  parseGithubCodeQualityFindings,
} from './github-code-quality.js';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecHandler = (command: string, args: string[], callback: ExecCallback) => void;

function stubExec(handler: ExecHandler): Array<{ command: string; args: string[]; cwd: string }> {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  vi.mocked(execFile).mockImplementation(((
    command: string,
    args: string[],
    options: { cwd: string },
    callback: ExecCallback,
  ) => {
    calls.push({ command, args, cwd: options.cwd });
    handler(command, args, callback);
  }) as unknown as typeof execFile);
  return calls;
}

function apiFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    state: 'open',
    rule: {
      id: 'js/no-floating-promises',
      title: 'Promise is not handled',
      description: 'Handle the promise.',
      severity: 'warning',
      category: 'reliability',
    },
    location: {
      path: 'src/app.ts',
      start_line: 9,
      start_column: 4,
      end_line: 9,
      end_column: 18,
    },
    message: {
      text: 'Await this promise or explicitly handle its rejection.',
      markdown: 'Await **this promise**.',
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseGithubCodeQualityFindings', () => {
  it('maps newline-delimited pages into stable provider findings', () => {
    const first = apiFinding();
    const second = apiFinding({
      number: 43,
      rule: {
        id: 'js/complexity',
        title: 'Complex function',
        severity: 'note',
        category: 'maintainability',
      },
      location: { path: 'src/util.ts', start_line: 4 },
      message: {},
    });

    expect(
      parseGithubCodeQualityFindings(
        'acme/widgets',
        `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      ),
    ).toEqual([
      {
        id: 'github-code-quality:acme/widgets:42',
        source: 'github-code-quality',
        ruleId: 'js/no-floating-promises',
        category: 'reliability',
        severity: 'warning',
        location: {
          filePath: 'src/app.ts',
          startLine: 9,
          startColumn: 4,
          endLine: 9,
          endColumn: 18,
        },
        explanation: 'Await this promise or explicitly handle its rejection.',
      },
      {
        id: 'github-code-quality:acme/widgets:43',
        source: 'github-code-quality',
        ruleId: 'js/complexity',
        category: 'maintainability',
        severity: 'note',
        location: { filePath: 'src/util.ts', startLine: 4 },
        explanation: 'Complex function',
      },
    ]);
  });

  it('deduplicates pages and skips closed or malformed findings', () => {
    const valid = apiFinding();
    const output = [
      valid,
      valid,
      apiFinding({ number: 44, state: 'dismissed' }),
      apiFinding({ number: 45, location: { path: 'src/app.ts', start_line: 0 } }),
      apiFinding({ number: 46, rule: { id: 'unknown', severity: 'critical' } }),
    ]
      .map((finding) => JSON.stringify(finding))
      .join('\n');

    expect(parseGithubCodeQualityFindings('acme/widgets', output)).toHaveLength(1);
  });

  it('rejects output that is not newline-delimited JSON', () => {
    expect(() => parseGithubCodeQualityFindings('acme/widgets', 'not json')).toThrow(
      'unexpected Code Quality response',
    );
  });
});

describe('classifyGithubCodeQualityError', () => {
  it('returns actionable missing CLI and authentication messages', () => {
    expect(
      classifyGithubCodeQualityError(
        Object.assign(new Error('spawn gh'), { code: 'ENOENT' }),
        'repository',
      ),
    ).toEqual({
      status: 'unavailable',
      message: 'GitHub CLI is not installed. Install gh, then try again.',
    });
    expect(
      classifyGithubCodeQualityError(
        Object.assign(new Error('failed'), {
          stderr: 'authentication required; run gh auth login',
        }),
        'repository',
      ),
    ).toEqual({
      status: 'unavailable',
      message: 'GitHub CLI is not authenticated. Run gh auth login, then try again.',
    });
  });

  it('treats repositories without a GitHub remote as not applicable', () => {
    expect(
      classifyGithubCodeQualityError(
        Object.assign(new Error('failed'), { stderr: 'no git remotes found' }),
        'repository',
      ),
    ).toEqual({ status: 'not-applicable' });
  });

  it.each([
    [
      403,
      'GitHub Code Quality is unavailable for this repository or your account lacks read access.',
    ],
    [404, 'GitHub Code Quality is not available for this repository.'],
    [503, 'GitHub Code Quality is temporarily unavailable. Try again later.'],
  ])('maps HTTP %s without exposing raw command output', (status, message) => {
    expect(
      classifyGithubCodeQualityError(
        Object.assign(new Error('failed'), { stderr: `sensitive details (HTTP ${status})` }),
        'findings',
      ),
    ).toEqual({ status: 'unavailable', message });
  });
});

describe('loadGithubCodeQualityFindings', () => {
  it('uses the current GitHub repository and a read-only paginated API request', async () => {
    const calls = stubExec((_command, args, callback) => {
      if (args[0] === 'repo') callback(null, 'acme/widgets\n', '');
      else callback(null, `${JSON.stringify(apiFinding())}\n`, '');
    });

    await expect(loadGithubCodeQualityFindings('/repo/worktree')).resolves.toMatchObject({
      status: 'available',
      findings: [{ id: 'github-code-quality:acme/widgets:42' }],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      command: 'gh',
      args: ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      cwd: '/repo/worktree',
    });
    expect(calls[1].args).toContain('GET');
    expect(calls[1].args).toContain('repos/acme/widgets/code-quality/findings');
    expect(calls[1].args).toContain('state=open');
    expect(calls[1].args).toContain('--paginate');
  });

  it('returns a non-blocking 403 result from the findings request', async () => {
    stubExec((_command, args, callback) => {
      if (args[0] === 'repo') callback(null, 'acme/widgets\n', '');
      else callback(Object.assign(new Error('failed'), { code: 1 }), '', 'HTTP 403');
    });

    await expect(loadGithubCodeQualityFindings('/repo/worktree')).resolves.toEqual({
      status: 'unavailable',
      message:
        'GitHub Code Quality is unavailable for this repository or your account lacks read access.',
    });
  });
});
