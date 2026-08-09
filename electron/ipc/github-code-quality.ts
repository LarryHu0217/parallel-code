import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GithubCodeQualityFinding, GithubCodeQualityResult } from './shared-types.js';

const exec = promisify(execFile);
const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 8 * 1024 * 1024;
const GITHUB_API_VERSION = '2026-03-10';

interface ApiFinding {
  number?: unknown;
  state?: unknown;
  rule?: unknown;
  location?: unknown;
  message?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function parseFinding(repository: string, value: unknown): GithubCodeQualityFinding | null {
  const finding = record(value) as ApiFinding | null;
  const rule = record(finding?.rule);
  const location = record(finding?.location);
  const message = record(finding?.message);
  const number = positiveInteger(finding?.number);
  const ruleId = nonEmptyString(rule?.['id']);
  const category = rule?.['category'];
  const severity = rule?.['severity'];
  const filePath = nonEmptyString(location?.['path']);
  const startLine = positiveInteger(location?.['start_line']);
  const explanation =
    nonEmptyString(message?.['text']) ??
    nonEmptyString(rule?.['description']) ??
    nonEmptyString(rule?.['title']);

  if (
    !number ||
    finding?.state !== 'open' ||
    !ruleId ||
    (category !== 'reliability' && category !== 'maintainability') ||
    (severity !== 'error' && severity !== 'warning' && severity !== 'note') ||
    !filePath ||
    !startLine ||
    !explanation
  ) {
    return null;
  }

  const startColumn = positiveInteger(location?.['start_column']);
  const endLine = positiveInteger(location?.['end_line']);
  const endColumn = positiveInteger(location?.['end_column']);
  return {
    id: `github-code-quality:${repository}:${number}`,
    source: 'github-code-quality',
    ruleId,
    category,
    severity,
    location: {
      filePath,
      startLine,
      ...(startColumn ? { startColumn } : {}),
      ...(endLine ? { endLine } : {}),
      ...(endColumn ? { endColumn } : {}),
    },
    explanation,
  };
}

export function parseGithubCodeQualityFindings(
  repository: string,
  stdout: string,
): GithubCodeQualityFinding[] {
  const findings = new Map<string, GithubCodeQualityFinding>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error('GitHub returned an unexpected Code Quality response.');
    }
    const finding = parseFinding(repository, parsed);
    if (finding) findings.set(finding.id, finding);
  }
  return [...findings.values()];
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? '');
  const value = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [value.message, value.stderr, value.stdout]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
}

function unavailable(message: string): GithubCodeQualityResult {
  return { status: 'unavailable', message };
}

export function classifyGithubCodeQualityError(
  error: unknown,
  stage: 'repository' | 'findings',
): GithubCodeQualityResult {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const text = errorText(error);
  if (code === 'ENOENT') {
    return unavailable('GitHub CLI is not installed. Install gh, then try again.');
  }
  if (/not logged into|authentication required|gh auth login/i.test(text)) {
    return unavailable('GitHub CLI is not authenticated. Run gh auth login, then try again.');
  }
  if (
    stage === 'repository' &&
    /no git remotes|none of the git remotes|not a git repository|unable to determine.*repository/i.test(
      text,
    )
  ) {
    return { status: 'not-applicable' };
  }
  if (/HTTP 403|not authorized to view code quality/i.test(text)) {
    return unavailable(
      'GitHub Code Quality is unavailable for this repository or your account lacks read access.',
    );
  }
  if (/HTTP 404/i.test(text)) {
    return unavailable('GitHub Code Quality is not available for this repository.');
  }
  if (/HTTP 503/i.test(text)) {
    return unavailable('GitHub Code Quality is temporarily unavailable. Try again later.');
  }
  return unavailable('GitHub Code Quality findings could not be loaded. Try again later.');
}

function parseRepository(stdout: string): string | null {
  const repository = stdout.trim();
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !part || !/^[A-Za-z0-9_.-]+$/.test(part))) {
    return null;
  }
  return repository;
}

export async function loadGithubCodeQualityFindings(
  worktreePath: string,
): Promise<GithubCodeQualityResult> {
  let repositoryStdout: string;
  try {
    ({ stdout: repositoryStdout } = await exec(
      'gh',
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      { cwd: worktreePath, timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER },
    ));
  } catch (error) {
    return classifyGithubCodeQualityError(error, 'repository');
  }

  const repository = parseRepository(repositoryStdout);
  if (!repository) return { status: 'not-applicable' };

  try {
    const { stdout } = await exec(
      'gh',
      [
        'api',
        '--method',
        'GET',
        `repos/${repository}/code-quality/findings`,
        '-f',
        'state=open',
        '-f',
        'per_page=100',
        '--paginate',
        '--jq',
        '.[] | @json',
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
      ],
      { cwd: worktreePath, timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER },
    );
    return {
      status: 'available',
      findings: parseGithubCodeQualityFindings(repository, stdout),
    };
  } catch (error) {
    return classifyGithubCodeQualityError(error, 'findings');
  }
}
