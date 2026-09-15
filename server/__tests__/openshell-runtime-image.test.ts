import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const builder = resolve('docs/spikes/openshell-codex/build-mgmt-runtime.sh');
const initializer = resolve('docs/spikes/openshell-codex/initialize-mitzo-workspace');
const apiRunner = resolve('docs/spikes/openshell-codex/run-mitzo-app-server');
const subscriptionRunner = resolve('docs/spikes/openshell-codex/run-mitzo-subscription-app-server');

function rejectedBase(base: string): string {
  try {
    execFileSync(builder, ['/unused/mgmt', 'localhost/mitzo:test', base], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    throw new Error('builder unexpectedly accepted a mutable base image');
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
}

describe('OpenShell runtime image builder', () => {
  it('disables Codex request compression in every OpenShell app-server launcher', () => {
    for (const runner of [apiRunner, subscriptionRunner])
      expect(readFileSync(runner, 'utf8')).toContain('features.enable_request_compression=false');
  });
  it.each([
    'ghcr.io/nvidia/openshell-community/sandboxes/base:latest',
    'ghcr.io/nvidia/openshell-community/sandboxes/base:0.0.116',
    'sha256:bcf4897ab8f95ec875847998297da98d16a44c8741c62c738d917f0eb8d35097',
    'ghcr.io/nvidia/openshell-community/sandboxes/base@sha256:ab-not-a-digest',
    `ghcr.io/nvidia/openshell-community/sandboxes/base@sha256:${'a'.repeat(63)}`,
    `ghcr.io/nvidia/openshell-community/sandboxes/base@sha256:${'a'.repeat(65)}`,
  ])('rejects mutable or registry-less base reference %s', (base) => {
    expect(rejectedBase(base)).toContain('base image must use an immutable @sha256 digest');
  });

  it.each(['localhost/mitzo-mgmt-runtime:latest', 'localhost/mitzo-mgmt-runtime:dev'])(
    'rejects reserved mutable output tag %s',
    (tag) => {
      expect(() =>
        execFileSync(
          builder,
          [
            '/unused/mgmt',
            tag,
            'ghcr.io/nvidia/openshell-community/sandboxes/base@sha256:04dd51f785ae52557ac53d4b12b3a0611a7347e5b8738e6278203465e6fb726e',
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ),
      ).toThrow(/output tag must be unique/);
    },
  );

  it.each(['localhost/mitzo-mgmt-runtime', 'localhost:5000/mitzo-mgmt-runtime'])(
    'rejects output image without an explicit tag %s',
    (tag) => {
      expect(() =>
        execFileSync(
          builder,
          [
            '/unused/mgmt',
            tag,
            'ghcr.io/nvidia/openshell-community/sandboxes/base@sha256:04dd51f785ae52557ac53d4b12b3a0611a7347e5b8738e6278203465e6fb726e',
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ),
      ).toThrow(/explicit unique tag/);
    },
  );

  it('fails on a stale checked-in lock without mutating the MGMT checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-runtime-stale-lock-'));
    const mgmt = join(root, 'mgmt');
    const bin = join(root, 'bin');
    try {
      mkdirSync(mgmt);
      mkdirSync(bin);
      const lock = join(mgmt, 'uv.lock');
      const lockContents = '# stale reviewed lock\n';
      writeFileSync(
        join(mgmt, 'pyproject.toml'),
        '[project]\nname = "fixture"\nversion = "0"\nrequires-python = ">=3.11"\n',
      );
      writeFileSync(lock, lockContents);
      execFileSync('git', ['init', '-q', mgmt]);
      execFileSync('git', ['-C', mgmt, 'config', 'user.name', 'Fixture']);
      execFileSync('git', ['-C', mgmt, 'config', 'user.email', 'fixture@example.invalid']);
      execFileSync('git', ['-C', mgmt, 'add', '.']);
      execFileSync('git', ['-C', mgmt, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
      const uv = join(bin, 'uv');
      writeFileSync(uv, '#!/bin/sh\nexit 17\n');
      chmodSync(uv, 0o755);

      expect(() =>
        execFileSync(
          builder,
          [
            mgmt,
            'localhost/mitzo-mgmt-runtime:stale-lock',
            `registry.invalid/base@sha256:${'a'.repeat(64)}`,
          ],
          {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      ).toThrow();
      expect(readFileSync(lock, 'utf8')).toBe(lockContents);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds dependency inputs from the exact labeled commit, not a dirty MGMT checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-runtime-exact-inputs-'));
    const mgmt = join(root, 'mgmt');
    const bin = join(root, 'bin');
    const podmanArgs = join(root, 'podman-args');
    try {
      mkdirSync(mgmt);
      mkdirSync(bin);
      writeFileSync(
        join(mgmt, 'pyproject.toml'),
        '# committed runtime input\n[project]\nname = "fixture"\nversion = "0"\nrequires-python = ">=3.11"\n',
      );
      writeFileSync(join(mgmt, 'uv.lock'), '# committed runtime lock\n');
      execFileSync('git', ['init', '-q', mgmt]);
      execFileSync('git', ['-C', mgmt, 'config', 'user.name', 'Fixture']);
      execFileSync('git', ['-C', mgmt, 'config', 'user.email', 'fixture@example.invalid']);
      execFileSync('git', ['-C', mgmt, 'add', '.']);
      execFileSync('git', ['-C', mgmt, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
      // If the builder copied the checkout rather than git-showing HEAD, this
      // fake lock verifier aborts before the fake Podman invocation.
      writeFileSync(join(mgmt, 'pyproject.toml'), '# dirty divergent input\n');
      writeFileSync(join(mgmt, 'uv.lock'), '# dirty divergent lock\n');
      writeFileSync(
        join(bin, 'uv'),
        '#!/bin/sh\ngrep -q "committed runtime input" pyproject.toml || exit 23\nexit 0\n',
      );
      writeFileSync(
        join(bin, 'podman'),
        '#!/bin/sh\nprintf "%s" "$*" > "$MITZO_TEST_PODMAN_ARGS"\nexit 31\n',
      );
      chmodSync(join(bin, 'uv'), 0o755);
      chmodSync(join(bin, 'podman'), 0o755);

      expect(() =>
        execFileSync(
          builder,
          [
            mgmt,
            'localhost/mitzo-mgmt-runtime:exact-commit',
            `registry.invalid/base@sha256:${'a'.repeat(64)}`,
          ],
          {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              MITZO_TEST_PODMAN_ARGS: podmanArgs,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      ).toThrow();
      expect(readFileSync(podmanArgs, 'utf8')).toContain('image inspect');
      expect(readFileSync(join(mgmt, 'pyproject.toml'), 'utf8')).toContain('dirty divergent');
      expect(readFileSync(builder, 'utf8')).toContain(
        '--build-arg "MGMT_SOURCE_COMMIT=$mgmt_source_commit"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('initializes an idempotent portable Git baseline inside the sandbox workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-sandbox-workspace-'));
    const workspace = join(root, 'sandbox', 'workspaces', 'mgmt');
    try {
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, 'fixture.txt'), 'seed\n');

      const env = { ...process.env, MITZO_WORKSPACE_ROOT: join(root, 'sandbox', 'workspaces') };
      execFileSync(initializer, [workspace], { env });
      execFileSync(initializer, [workspace], { env });

      expect(
        execFileSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' }),
      ).toBe('');
      expect(
        execFileSync('git', ['-C', workspace, 'rev-list', '--count', 'HEAD'], {
          encoding: 'utf8',
        }),
      ).toBe('1\n');
      expect(execFileSync('git', ['-C', workspace, 'remote'], { encoding: 'utf8' })).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['traversal', 'symlink'] as const)(
    'rejects a %s path that resolves outside the configured workspace root',
    (kind) => {
      const root = mkdtempSync(join(tmpdir(), 'mitzo-sandbox-escape-'));
      const workspaceRoot = join(root, 'sandbox', 'workspaces');
      const outside = join(root, 'sandbox', 'other');
      try {
        mkdirSync(workspaceRoot, { recursive: true });
        mkdirSync(outside, { recursive: true });
        const candidate =
          kind === 'traversal'
            ? join(workspaceRoot, '..', 'other')
            : join(workspaceRoot, 'outside-link');
        if (kind === 'symlink') symlinkSync(outside, candidate);

        expect(() =>
          execFileSync(initializer, [candidate], {
            env: { ...process.env, MITZO_WORKSPACE_ROOT: workspaceRoot },
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        ).toThrow(/workspace must be inside/);
        expect(existsSync(join(outside, '.git'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
