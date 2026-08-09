import type { GithubCodeQualityResult } from '../ipc/types';
import { invoke } from './ipc';
import type { QualityFinding, QualityFindingProvider } from './quality-findings';
import { IPC } from '../../electron/ipc/channels';

export function createGithubCodeQualityFindingProvider(
  worktreePath: () => string,
): QualityFindingProvider {
  return {
    async loadFindings() {
      const result = await invoke<GithubCodeQualityResult>(IPC.GetGithubCodeQualityFindings, {
        worktreePath: worktreePath(),
      });
      if (result.status === 'not-applicable') return [];
      if (result.status === 'unavailable') throw new Error(result.message);
      return result.findings.map(
        (finding): QualityFinding => ({
          ...finding,
          location: { ...finding.location },
          state: 'open',
          freshness: 'pending',
        }),
      );
    },
  };
}
