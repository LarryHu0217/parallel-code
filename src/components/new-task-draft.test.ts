import { describe, expect, it } from 'vitest';
import { hasNewTaskDraft } from './new-task-draft';

describe('hasNewTaskDraft', () => {
  it('ignores empty dialog fields', () => {
    expect(hasNewTaskDraft('', '')).toBe(false);
    expect(hasNewTaskDraft('  \n ', '  ')).toBe(false);
  });

  it('detects a prompt draft', () => {
    expect(hasNewTaskDraft('fix the failing tests', '')).toBe(true);
  });

  it('detects a task-name draft without a prompt', () => {
    expect(hasNewTaskDraft('', 'release notes cleanup')).toBe(true);
  });
});
