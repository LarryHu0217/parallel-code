import { describe, expect, it } from 'vitest';

import {
  LARGE_DIFF_LINE_THRESHOLD,
  countChangedLines,
  countFileSearchMatches,
  countSearchMatches,
  getInitialCollapsedFiles,
  isLargeDiff,
} from './diff-collapse';
import type { DiffLine, FileDiff } from './unified-diff-parser';

function makeFile(path: string, lines: DiffLine[]): FileDiff {
  return {
    path,
    status: 'M',
    binary: false,
    hunks: [{ oldStart: 1, oldCount: lines.length, newStart: 1, newCount: lines.length, lines }],
  };
}

function changedLines(count: number, content = 'x'): DiffLine[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'add' as const,
    content,
    oldLine: null,
    newLine: i + 1,
  }));
}

describe('countChangedLines', () => {
  it('counts added and removed lines but not context', () => {
    const file = makeFile('a.ts', [
      { type: 'add', content: 'a', oldLine: null, newLine: 1 },
      { type: 'remove', content: 'b', oldLine: 1, newLine: null },
      { type: 'context', content: 'c', oldLine: 2, newLine: 2 },
    ]);
    expect(countChangedLines([file])).toBe(2);
  });

  it('sums across files and hunks', () => {
    expect(
      countChangedLines([makeFile('a.ts', changedLines(3)), makeFile('b.ts', changedLines(4))]),
    ).toBe(7);
  });

  it('returns zero for binary files with no hunks', () => {
    expect(countChangedLines([{ path: 'img.png', status: 'A', binary: true, hunks: [] }])).toBe(0);
  });
});

describe('isLargeDiff', () => {
  it('treats a diff at the threshold as small', () => {
    expect(isLargeDiff([makeFile('a.ts', changedLines(LARGE_DIFF_LINE_THRESHOLD))])).toBe(false);
  });

  it('treats a diff one line above the threshold as large', () => {
    expect(isLargeDiff([makeFile('a.ts', changedLines(LARGE_DIFF_LINE_THRESHOLD + 1))])).toBe(true);
  });
});

describe('getInitialCollapsedFiles', () => {
  it('collapses nothing for a small diff', () => {
    const files = [makeFile('a.ts', changedLines(10)), makeFile('b.ts', changedLines(10))];
    expect(getInitialCollapsedFiles(files, 'a.ts').size).toBe(0);
  });

  it('collapses every file except the one the user opened', () => {
    const files = [
      makeFile('a.ts', changedLines(LARGE_DIFF_LINE_THRESHOLD + 1)),
      makeFile('b.ts', changedLines(5)),
      makeFile('c.ts', changedLines(5)),
    ];
    expect([...getInitialCollapsedFiles(files, 'b.ts')]).toEqual(['a.ts', 'c.ts']);
  });

  it('collapses every file when no file was opened', () => {
    const files = [
      makeFile('a.ts', changedLines(LARGE_DIFF_LINE_THRESHOLD + 1)),
      makeFile('b.ts', changedLines(5)),
    ];
    expect([...getInitialCollapsedFiles(files, null)]).toEqual(['a.ts', 'b.ts']);
  });
});

describe('countFileSearchMatches', () => {
  it('counts every case-insensitive occurrence, including repeats on one line', () => {
    const file = makeFile('a.ts', [
      { type: 'add', content: 'foo Foo bar', oldLine: null, newLine: 1 },
      { type: 'context', content: 'FOO', oldLine: 2, newLine: 2 },
    ]);
    expect(countFileSearchMatches(file, 'foo')).toBe(3);
  });

  it('does not count overlapping occurrences twice', () => {
    const file = makeFile('a.ts', [{ type: 'add', content: 'aaaa', oldLine: null, newLine: 1 }]);
    expect(countFileSearchMatches(file, 'aa')).toBe(2);
  });

  it('returns zero for an empty query', () => {
    expect(countFileSearchMatches(makeFile('a.ts', changedLines(3, 'foo')), '')).toBe(0);
    expect(countFileSearchMatches(makeFile('a.ts', changedLines(3, 'foo')), undefined)).toBe(0);
  });
});

describe('countSearchMatches', () => {
  it('sums matches across files', () => {
    const files = [
      makeFile('a.ts', changedLines(2, 'foo')),
      makeFile('b.ts', changedLines(3, 'foo')),
    ];
    expect(countSearchMatches(files, 'foo')).toBe(5);
  });
});
