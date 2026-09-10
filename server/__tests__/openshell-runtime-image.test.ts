import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const builder = resolve('docs/spikes/openshell-codex/build-mgmt-runtime.sh');

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
});
