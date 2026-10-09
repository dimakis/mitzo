import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { SOURCE_QUALIFIED_SYMPOSIUM_ROUTING_BUILD } from '../symposium-owned-runtime-contract.js';
const directory = fileURLToPath(
  new URL('../../docs/spikes/openshell-codex/routing-diagnostic-native/', import.meta.url),
);
const bytes = (name: string) => readFileSync(join(directory, name));
const json = (name: string) => JSON.parse(bytes(name).toString('utf8'));
const source = json('source-qualification.json');
it('pins actual vendored patch/lock bytes and both native DCO commit objects', () => {
  expect(createHash('sha256').update(bytes('native.patch')).digest('hex')).toBe(source.patchSha256);
  expect(createHash('sha256').update(bytes('Cargo.lock')).digest('hex')).toBe(
    source.cargoLockSha256,
  );
  for (const [name, expected, tree, parent] of [
    ['native-commit.txt', source.nativeCommit, source.sourceTree, source.nativeParentCommit],
    [
      'native-parent-commit.txt',
      source.nativeParentCommit,
      source.nativeParentTree,
      source.upstreamCommit,
    ],
  ]) {
    const value = bytes(name);
    expect(
      createHash('sha1')
        .update(Buffer.from(`commit ${value.length}\0`))
        .update(value)
        .digest('hex'),
    ).toBe(expected);
    expect(value.toString()).toContain(`tree ${tree}\nparent ${parent}\n`);
    expect(value.toString()).toContain('Signed-off-by:');
  }
});
it('binds measured final CLI/version and supervisor config identity to the registered source tuple', () => {
  const selected = SOURCE_QUALIFIED_SYMPOSIUM_ROUTING_BUILD;
  expect(source.cli.sha256).toBe(selected.cliSha256);
  expect(source.cli.versionExecuted).toBe(`openshell ${selected.version}`);
  expect(source.supervisor.versionExecuted).toBe(`openshell-supervisor ${selected.version}`);
  expect(source.unchangedGatewayVersion).toBe(selected.gatewayVersion);
  expect(source.supervisor.imageConfigId).toBe(selected.supervisorImage);
  expect(source.supervisor.imageManifestDigest).toBe(
    'sha256:f55fd2c720c065f7046310f0c015b6bddbb7b07f30316dc1027602eed16efdcc',
  );
  expect(source.supervisor.imageManifestDigest).not.toBe(source.supervisor.imageConfigId);
  expect(
    source.cli.loaderDependencies.every(
      (path: string) => path.startsWith('/System/Library/') || path.startsWith('/usr/lib/'),
    ),
  ).toBe(true);
});
it('qualifies only the exact original image layers plus one ELF replacement and no logging override', () => {
  const image = json('image-qualification.json');
  const version = json('version-qualification.json');
  expect(`sha256:${image.base.Id}`).toBe(
    'sha256:8df2e97c2b25b75031b4c00cb49e4cd487ba2384ebe7d884a0aa12095be20937',
  );
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
  expect(
    bytes('Dockerfile.supervisor')
      .toString()
      .split('\n')
      .filter((line) => line && !line.startsWith('#')),
  ).toEqual([
    `FROM sha256:${image.base.Id}`,
    'COPY --chmod=0555 openshell-supervisor /openshell-supervisor',
  ]);
});
it('accounts for the entire exact public registry closure without credentials or live-owner data', () => {
  const qualified = json('qualified-public-dependencies.json');
  expect(qualified.cargoLockSha256).toBe(source.cargoLockSha256);
  expect(qualified.missing).toEqual([]);
  expect(qualified.credentialFilesCopied).toBe(false);
  const registry = bytes('Cargo.lock')
    .toString()
    .split('[[package]]')
    .filter((block) =>
      block.includes('source = "registry+https://github.com/rust-lang/crates.io-index"'),
    )
    .map((block) => {
      const read = (key: string) => block.match(new RegExp(`^${key} = "([^"]+)"$`, 'm'))![1];
      return `${read('name')}@${read('version')}:${read('checksum')}`;
    })
    .sort();
  expect(
    qualified.qualified
      .map(
        (row: { name: string; version: string; sha256: string }) =>
          `${row.name}@${row.version}:${row.sha256}`,
      )
      .sort(),
  ).toEqual(registry);
  for (const name of [
    'source-qualification.json',
    'image-qualification.json',
    'version-qualification.json',
    'qualified-public-dependencies.json',
    'exact-public-provisioning.json',
  ])
    expect(bytes(name).toString()).not.toMatch(
      /\/Users\/|\.local\/share|instanceId|parentPid|appPid|CONTAINER_CONNECTION/,
    );
  expect(source.adopted).toBe(false);
  expect(source.tests.modelCalls).toBe(0);
});
