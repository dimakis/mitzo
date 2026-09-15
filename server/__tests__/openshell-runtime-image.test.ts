import { execFileSync } from 'node:child_process';
import {
  existsSync,
  chmodSync,
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
const notebookRunner = resolve('docs/spikes/openshell-codex/run-mgmt-notebook');

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
  it('installs the vendored Jira notebook runtime from its checked-in frozen lock', () => {
    const dockerfile = readFileSync(
      resolve('docs/spikes/openshell-codex/Dockerfile.mgmt-runtime'),
      'utf8',
    );
    const build = readFileSync(builder, 'utf8');
    expect(dockerfile).toContain(
      'COPY jira_process/pyproject.toml jira_process/uv.lock /opt/mgmt-jira-runtime/',
    );
    expect(dockerfile).toContain(
      'UV_PROJECT_ENVIRONMENT=/opt/mgmt-jira-venv uv sync --frozen --no-dev --no-install-project',
    );
    expect(dockerfile).toContain('ENV PATH="/opt/mgmt-jira-venv/bin:${PATH}"');
    expect(build).toContain('test -f "$mgmt_repo/jira_process/pyproject.toml"');
    expect(build).toContain('test -f "$mgmt_repo/jira_process/uv.lock"');
    expect(build).toContain('cp "$mgmt_repo/jira_process/pyproject.toml"');
    expect(build).toContain('cp "$mgmt_repo/jira_process/uv.lock"');
    expect(build).not.toContain('uv lock');
  });

  it('constructs a Jupyter notebook execution inside the mounted Jira runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-jira-notebook-'));
    const workspace = join(root, 'mgmt');
    const runtime = join(workspace, 'jira_process');
    const bin = join(root, 'bin');
    const capture = join(root, 'python-args');
    try {
      mkdirSync(join(runtime, 'dashboards'), { recursive: true });
      mkdirSync(bin);
      writeFileSync(join(runtime, 'dashboards', 'smoke.ipynb'), '{}\n');
      writeFileSync(join(bin, 'python'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CAPTURE"\n');
      chmodSync(join(bin, 'python'), 0o700);

      execFileSync('bash', [notebookRunner, 'dashboards/smoke.ipynb'], {
        env: {
          ...process.env,
          MITZO_MGMT_WORKDIR: workspace,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          CAPTURE: capture,
        },
      });

      expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual([
        '-m',
        'jupyter',
        'nbconvert',
        '--to',
        'notebook',
        '--execute',
        '--inplace',
        join(runtime, 'dashboards', 'smoke.ipynb'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects notebook paths outside the mounted Jira runtime', () => {
    try {
      execFileSync('bash', [notebookRunner, '../outside.ipynb'], {
        env: { ...process.env, MITZO_MGMT_WORKDIR: '/unused' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      throw new Error('runner unexpectedly accepted a traversal path');
    } catch (error) {
      expect(String((error as { stderr?: string }).stderr ?? error)).toContain(
        'relative .ipynb path',
      );
    }
  });

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
