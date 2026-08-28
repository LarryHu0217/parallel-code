import type { FileDiff } from './unified-diff-parser';

/**
 * Changed lines (added + removed) above which a diff is treated as "large" and
 * every file starts collapsed. Rendering thousands of diff rows — each with
 * syntax highlighting and per-hunk context lookups — locks up the dialog, so
 * large diffs render only the file the user asked for.
 */
export const LARGE_DIFF_LINE_THRESHOLD = 2000;

/** Count added + removed lines across all files — the +N/-N shown in the header. */
export function countChangedLines(files: readonly FileDiff[]): number {
  let total = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type !== 'context') total++;
      }
    }
  }
  return total;
}

export function isLargeDiff(files: readonly FileDiff[]): boolean {
  return countChangedLines(files) > LARGE_DIFF_LINE_THRESHOLD;
}

/**
 * Initial collapsed-file set for a freshly loaded diff. Small diffs render
 * fully expanded (empty set); large ones collapse everything except the file
 * the user clicked to open the dialog.
 */
export function getInitialCollapsedFiles(
  files: readonly FileDiff[],
  keepExpandedPath: string | null,
): ReadonlySet<string> {
  if (!isLargeDiff(files)) return new Set<string>();
  const collapsed = new Set<string>();
  for (const file of files) {
    if (file.path !== keepExpandedPath) collapsed.add(file.path);
  }
  return collapsed;
}

/** Number of occurrences of `query` in one file's diff lines (case-insensitive). */
export function countFileSearchMatches(file: FileDiff, query: string | undefined): number {
  if (!query) return 0;
  const needle = query.toLowerCase();
  let count = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const haystack = line.content.toLowerCase();
      let idx = haystack.indexOf(needle);
      while (idx !== -1) {
        count++;
        idx = haystack.indexOf(needle, idx + needle.length);
      }
    }
  }
  return count;
}

/** Total occurrences of `query` across every file's diff lines. */
export function countSearchMatches(files: readonly FileDiff[], query: string | undefined): number {
  if (!query) return 0;
  return files.reduce((sum, file) => sum + countFileSearchMatches(file, query), 0);
}
