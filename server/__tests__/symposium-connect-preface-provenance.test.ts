import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { SOURCE_QUALIFIED_SYMPOSIUM_CONNECT_PREFACE_BUILD } from '../symposium-owned-runtime-contract.js';

const directory = fileURLToPath(
  new URL('../../docs/spikes/openshell-codex/connect-preface-native/', import.meta.url),
);
const bytes = (name: string) => readFileSync(join(directory, name));
const json = (name: string) => JSON.parse(bytes(name).toString('utf8'));
const source = json('source-qualification.json');

it('reconstructs the exact signed-off successor of the retained diagnostic source', () => {
  const parent = JSON.parse(
    readFileSync(join(directory, '../routing-diagnostic-native/source-qualification.json'), 'utf8'),
  );
  expect(source.nativeParentCommit).toBe(parent.nativeCommit);
  expect(source.upstreamCommit).toBe(parent.upstreamCommit);
  expect(source.cargoLockSha256).toBe(parent.cargoLockSha256);
  expect(createHash('sha256').update(bytes('native.patch')).digest('hex')).toBe(source.patchSha256);
  const commit = bytes('native-commit.txt');
  expect(
    createHash('sha1')
      .update(Buffer.from(`commit ${commit.length}\0`))
      .update(commit)
      .digest('hex'),
  ).toBe(source.nativeCommit);
  expect(commit.toString()).toContain(`tree ${source.sourceTree}\nparent ${parent.nativeCommit}\n`);
  expect(commit.toString()).toContain('Signed-off-by:');
});

it('binds the source-derived CLI and supervisor to their executed versions and measured image', () => {
  const build = SOURCE_QUALIFIED_SYMPOSIUM_CONNECT_PREFACE_BUILD;
  expect(source.cli.sha256).toBe(build.cliSha256);
  expect(source.cli.versionExecuted).toBe(`openshell ${build.version}`);
  expect(source.supervisor.versionExecuted).toBe(`openshell-supervisor ${build.version}`);
  expect(source.supervisor.imageConfigId).toBe(build.supervisorImage);
  expect(source.unchangedGatewayVersion).toBe(build.gatewayVersion);
  expect(source.supervisor.imageManifestDigest).not.toBe(source.supervisor.imageConfigId);
  expect(source.tests.modelCalls).toBe(0);
  expect(source.adopted).toBe(false);
});

it('preserves the original image configuration and all base layers with one ELF replacement', () => {
  const image = json('image-qualification.json');
  const version = json('version-qualification.json');
  expect(image.base.Id).toBe('8df2e97c2b25b75031b4c00cb49e4cd487ba2384ebe7d884a0aa12095be20937');
  expect(image.base.Layers).toHaveLength(29);
  expect(image.image.Layers).toHaveLength(30);
  expect(image.image.Layers.slice(0, 29)).toEqual(image.base.Layers);
  for (const key of ['Architecture', 'OS', 'Entrypoint', 'User', 'RustLogMarkers'])
    expect(image.image[key]).toEqual(image.base[key]);
  expect(image.image.RustLogMarkers).toBe('');
  expect(image.onlyReplacementLayer).toBe(true);
  expect(`sha256:${image.image.Id}`).toBe(source.supervisor.imageConfigId);
  expect(image.image.Digest).toBe(source.supervisor.imageManifestDigest);
  expect(image.elfSha256).toBe(source.supervisor.sha256);
  expect(version.elfSha256).toBe(source.supervisor.sha256);
  expect(version.imageConfigId).toBe(source.supervisor.imageConfigId);
  expect(version.version).toBe(source.supervisor.versionExecuted);
  expect(version.cleanupConfirmed).toBe(true);
  expect(bytes('Dockerfile.supervisor').toString().trim()).toBe(
    `FROM sha256:${image.base.Id}\nCOPY --chmod=0555 openshell-supervisor /openshell-supervisor`,
  );
});

it('retains only public build data in the source and artifact receipts', () => {
  for (const name of [
    'source-qualification.json',
    'image-qualification.json',
    'version-qualification.json',
  ])
    expect(bytes(name).toString()).not.toMatch(
      /\/Users\/|\.local\/share|instanceId|parentPid|appPid|CONTAINER_CONNECTION/,
    );
});
