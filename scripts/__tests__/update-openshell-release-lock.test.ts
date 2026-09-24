import { describe, expect, it } from 'vitest';
import { updateReleasePins } from '../update-openshell-release-lock.mjs';

const baseInput = {
  manifest: {
    schemaVersion: 1,
    runtime: {
      image: 'localhost/mitzo:release-old',
      digest: `sha256:${'1'.repeat(64)}`,
      mitzoSourceCommit: '1'.repeat(40),
      mgmtSourceCommit: '2'.repeat(40),
      baseImage: `example/base@sha256:${'3'.repeat(64)}`,
    },
    gateway: { version: 'unchanged' },
  },
  environment: 'MITZO_OPENSHELL_ENABLED=1\nMITZO_OPENSHELL_IMAGE=localhost/mitzo:release-old\n',
  image: 'localhost/mitzo:release-new',
  digest: `sha256:${'a'.repeat(64)}`,
  mitzoCommit: 'b'.repeat(40),
  mgmtCommit: 'c'.repeat(40),
};

describe('OpenShell release lock updater', () => {
  it('updates all runtime pins and keeps the environment example synchronized', () => {
    const result = updateReleasePins(baseInput);

    expect(result.manifest).toMatchObject({
      gateway: { version: 'unchanged' },
      runtime: {
        image: baseInput.image,
        digest: baseInput.digest,
        mitzoSourceCommit: baseInput.mitzoCommit,
        mgmtSourceCommit: baseInput.mgmtCommit,
        baseImage: baseInput.manifest.runtime.baseImage,
      },
    });
    expect(result.environment).toContain(`MITZO_OPENSHELL_IMAGE=${baseInput.image}`);
    expect(result.environment).not.toContain('release-old');
  });

  it.each(['localhost/mitzo:latest', 'localhost/mitzo:dev', 'localhost/mitzo'])(
    'rejects mutable or untagged image %s',
    (image) => {
      expect(() => updateReleasePins({ ...baseInput, image })).toThrow(/immutable tag/);
    },
  );

  it('rejects malformed provenance before changing files', () => {
    expect(() => updateReleasePins({ ...baseInput, digest: 'sha256:short' })).toThrow(/digest/);
    expect(() => updateReleasePins({ ...baseInput, mgmtCommit: 'short' })).toThrow(
      /MGMT source commit/,
    );
  });
});
