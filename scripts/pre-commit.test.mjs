import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const hookSource = readFileSync(new URL('../.husky/pre-commit', import.meta.url), 'utf8');
let fixture = '';
let manifest;

function git(args) {
  return execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: 'pipe' });
}

function stageManifest() {
  writeFileSync(join(fixture, 'package.json'), JSON.stringify(manifest));
  git(['add', 'package.json']);
}

function runHook(env = {}) {
  const result = spawnSync('sh', ['.husky/pre-commit'], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: join(fixture, 'bin') + ':' + process.env.PATH,
      HOOK_COMMAND_LOG: join(fixture, 'commands.log'),
      NPX_EXIT_CODE: '0',
      NPM_EXIT_CODE: '0',
      ...env,
    },
  });
  expect(result.error).toBeUndefined();
  return result;
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'parallel-code-pre-commit-'));
  manifest = {
    name: 'hook-fixture',
    version: '1.0.0',
    scripts: { check: 'old-check', postinstall: 'old-install' },
    dependencies: { example: '1.0.0' },
  };
  git(['init', '--quiet']);
  // Fixture commits use their own ordinary, empty hook directory, never the real worktree hooks.
  git(['config', 'core.hooksPath', '.git/hooks']);
  writeFileSync(join(fixture, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(fixture, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  git(['add', 'package.json', 'package-lock.json']);
  git([
    '-c',
    'user.name=Hook Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'chore: seed hook fixture',
  ]);
  mkdirSync(join(fixture, '.husky'));
  writeFileSync(join(fixture, '.husky', 'pre-commit'), hookSource);
  mkdirSync(join(fixture, 'bin'));
  for (const command of ['npx', 'npm']) {
    const variable = command === 'npx' ? 'NPX_EXIT_CODE' : 'NPM_EXIT_CODE';
    writeFileSync(
      join(fixture, 'bin', command),
      '#!/bin/sh\nprintf "%s\\n" ' +
        command +
        ' >> "$HOOK_COMMAND_LOG"\nexit "$' +
        variable +
        '"\n',
      { mode: 0o755 },
    );
  }
});

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = '';
});

describe('pre-commit lockfile protection', () => {
  it('allows unchanged manifests and still runs both required checks', () => {
    expect(runHook().status).toBe(0);
    expect(readFileSync(join(fixture, 'commands.log'), 'utf8')).toBe('npx\nnpm\n');
  });

  it('allows development-script-only changes without lockfile churn', () => {
    manifest.scripts.check = 'new-check';
    manifest.scripts['test:changed'] = 'new-tests';
    stageManifest();
    expect(runHook().status).toBe(0);
  });

  it('compares JSON values rather than object key order', () => {
    manifest = {
      dependencies: manifest.dependencies,
      scripts: { ...manifest.scripts, check: 'new' },
      version: manifest.version,
      name: manifest.name,
    };
    stageManifest();
    expect(runHook().status).toBe(0);
  });

  it.each([
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'overrides',
  ])('rejects changes to %s without a staged lockfile update', (field) => {
    manifest[field] = { example: '2.0.0' };
    stageManifest();
    expect(runHook().status).not.toBe(0);
  });

  it('rejects package-version changes without a staged lockfile update', () => {
    manifest.version = '2.0.0';
    stageManifest();
    expect(runHook().status).not.toBe(0);
  });

  it.each([
    'preinstall',
    'install',
    'postinstall',
    'preprepare',
    'prepare',
    'postprepare',
    'prepublish',
  ])('does not exempt the installation lifecycle script %s', (script) => {
    manifest.scripts[script] = 'new-install';
    stageManifest();
    expect(runHook().status).not.toBe(0);
  });

  it('retains the existing paired manifest-and-lockfile update path', () => {
    manifest.dependencies.example = '2.0.0';
    stageManifest();
    writeFileSync(
      join(fixture, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, version: '2' }),
    );
    git(['add', 'package-lock.json']);
    expect(runHook().status).toBe(0);
  });

  it('uses the staged manifest, not an unstaged working-tree repair', () => {
    manifest.dependencies.example = '2.0.0';
    stageManifest();
    manifest.dependencies.example = '1.0.0';
    writeFileSync(join(fixture, 'package.json'), JSON.stringify(manifest));
    expect(runHook().status).not.toBe(0);
  });

  it('does not require a lock update for an unrelated unstaged dependency edit', () => {
    manifest.scripts.check = 'new-check';
    stageManifest();
    manifest.dependencies.example = '2.0.0';
    writeFileSync(join(fixture, 'package.json'), JSON.stringify(manifest));
    expect(runHook().status).toBe(0);
  });

  it('rejects malformed staged manifests rather than treating them as script-only', () => {
    writeFileSync(join(fixture, 'package.json'), '{ broken');
    git(['add', 'package.json']);
    expect(runHook().status).not.toBe(0);
  });

  it('retains the lockfile gate for nested package manifests', () => {
    mkdirSync(join(fixture, 'nested'));
    writeFileSync(
      join(fixture, 'nested', 'package.json'),
      JSON.stringify({ dependencies: { example: '2.0.0' } }),
    );
    git(['add', 'nested/package.json']);
    expect(runHook().status).not.toBe(0);
  });

  it('rejects removal of the tracked lockfile even when it remains on disk', () => {
    git(['rm', '--cached', '--quiet', 'package-lock.json']);
    expect(runHook().status).not.toBe(0);
  });

  it('rejects an ignore rule hiding the lockfile, including an already tracked lockfile', () => {
    writeFileSync(join(fixture, '.gitignore'), 'package-lock.json\n');
    git(['add', '.gitignore']);
    expect(runHook().status).not.toBe(0);
  });

  it('stops when lint-staged fails', () => {
    expect(runHook({ NPX_EXIT_CODE: '1' }).status).not.toBe(0);
    expect(readFileSync(join(fixture, 'commands.log'), 'utf8')).toBe('npx\n');
  });

  it('stops when npm run check fails', () => {
    expect(runHook({ NPM_EXIT_CODE: '1' }).status).not.toBe(0);
  });
});
