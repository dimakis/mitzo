import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const builder = resolve('docs/spikes/openshell-codex/build-mgmt-runtime.sh');
const initializer = resolve('docs/spikes/openshell-codex/initialize-mitzo-workspace');

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
});
