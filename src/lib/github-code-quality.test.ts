import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from './ipc';
import { createGithubCodeQualityFindingProvider } from './github-code-quality';
import { IPC } from '../../electron/ipc/channels';

vi.mock('./ipc', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createGithubCodeQualityFindingProvider', () => {
  it('maps IPC findings into pending review findings', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 'available',
      findings: [
        {
          id: 'github-code-quality:acme/widgets:42',
          source: 'github-code-quality',
          ruleId: 'js/no-floating-promises',
          category: 'reliability',
          severity: 'warning',
          location: { filePath: 'src/app.ts', startLine: 9 },
          explanation: 'Await this promise.',
        },
      ],
    });

    const provider = createGithubCodeQualityFindingProvider(() => '/repo/worktree');
    await expect(
      provider.loadFindings({ reviewIdentity: 'task', diffIdentity: 'diff', files: [] }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'github-code-quality:acme/widgets:42',
        state: 'open',
        freshness: 'pending',
      }),
    ]);
    expect(invoke).toHaveBeenCalledWith(IPC.GetGithubCodeQualityFindings, {
      worktreePath: '/repo/worktree',
    });
  });

  it('silently ignores repositories that do not map to GitHub', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 'not-applicable' });
    const provider = createGithubCodeQualityFindingProvider(() => '/repo/local');

    await expect(
      provider.loadFindings({ reviewIdentity: 'task', diffIdentity: 'diff', files: [] }),
    ).resolves.toEqual([]);
  });

  it('surfaces an actionable unavailable state through the provider error path', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 'unavailable',
      message: 'GitHub CLI is not authenticated. Run gh auth login, then try again.',
    });
    const provider = createGithubCodeQualityFindingProvider(() => '/repo/worktree');

    await expect(
      provider.loadFindings({ reviewIdentity: 'task', diffIdentity: 'diff', files: [] }),
    ).rejects.toThrow('Run gh auth login');
  });
});
