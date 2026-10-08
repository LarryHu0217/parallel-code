import { describe, expect, it } from 'vitest';
import { describeGhError, parsePrRef } from './gh.js';

describe('describeGhError', () => {
  it('explains a missing gh binary', () => {
    const err = Object.assign(new Error('spawn gh ENOENT'), {
      code: 'ENOENT',
      path: 'gh',
      syscall: 'spawn gh',
    });
    expect(describeGhError(err)).toMatch(/not found.*gh auth login/);
  });

  it('does not blame gh for a missing working directory', () => {
    const err = Object.assign(new Error('spawn /bin/sh ENOENT'), { code: 'ENOENT', path: '/x' });
    expect(describeGhError(err)).toBe('spawn /bin/sh ENOENT');
  });

  it('explains missing auth', () => {
    expect(describeGhError({ stderr: 'You are not logged into any GitHub hosts.' })).toMatch(
      /not logged in/,
    );
  });

  it('explains an ambiguous repository', () => {
    const stderr =
      'X No default remote repository has been set. To learn more about the default repository, run: gh repo set-default --help\n';
    expect(describeGhError({ stderr })).toMatch(/Run "gh repo set-default" in the project folder/);
  });

  it('reports the last stderr line otherwise', () => {
    expect(describeGhError({ stderr: 'warning\nGraphQL: Not Found\n' })).toBe(
      'gh: GraphQL: Not Found',
    );
  });
});

describe('parsePrRef', () => {
  it('parses a canonical PR URL', () => {
    expect(parsePrRef('https://github.com/o/r.js/pull/12')).toEqual({
      owner: 'o',
      repo: 'r.js',
      number: 12,
    });
    expect(parsePrRef('https://github.com/o/r/pull/12/files')?.number).toBe(12);
  });

  it.each([
    'http://github.com/o/r/pull/1',
    'https://gitlab.com/o/r/pull/1',
    'https://user:pw@github.com/o/r/pull/1',
    'https://github.com/o/r/issues/1',
    'https://github.com/o/r/pull/abc',
    'not a url',
  ])('rejects %s', (url) => {
    expect(parsePrRef(url)).toBeNull();
  });
});
