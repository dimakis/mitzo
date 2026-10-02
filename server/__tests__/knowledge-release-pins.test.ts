import { expect, it } from 'vitest';
import { updateReleasePins } from '../../scripts/update-openshell-release-lock.mjs';
const hash = 'a'.repeat(64);
const marker = {
  implementation_name: 'cpython',
  implementation_version: '3.13.6',
  os_name: 'posix',
  platform_machine: 'aarch64',
  platform_release: '6.1',
  platform_system: 'Linux',
  platform_version: 'Linux',
  platform_python_implementation: 'CPython',
  python_full_version: '3.13.6',
  python_version: '3.13',
  sys_platform: 'linux',
};
const input = {
  manifest: { schemaVersion: 1, runtime: { seedPayloadSha256: hash }, policy: {} },
  environment: 'MITZO_OPENSHELL_IMAGE=old\n',
  image: 'localhost/mitzo:release-1',
  digest: `sha256:${hash}`,
  mitzoCommit: 'b'.repeat(40),
  mgmtCommit: 'c'.repeat(40),
  policyDigest: hash,
};
const contract = {
  knowledgeSchemaVersion: 1,
  knowledgeCompilerCommit: 'd'.repeat(40),
  knowledgeCompilerSha256: hash,
  knowledgeRecipeSha256: hash,
  dependencyProjectionSha256: hash,
  jiraRuntimeInputsSha256: hash,
  runtimeInputsSha256: hash,
  targetPlatform: 'linux/arm64',
  targetMarkerEnvironmentB64: Buffer.from(JSON.stringify(marker)).toString('base64'),
};
it('records actual runtime attestation without freezing evolving knowledge payloads', () => {
  const output = updateReleasePins({ ...input, knowledgeContract: contract });
  expect(output.manifest.runtime).toMatchObject(contract);
  expect(output.manifest.runtime).not.toHaveProperty('seedPayloadSha256');
  expect(input.manifest.runtime.seedPayloadSha256).toBe(hash);
});
it('rejects incomplete or mismatched target attestations', () => {
  expect(() =>
    updateReleasePins({
      ...input,
      knowledgeContract: { ...contract, knowledgeCompilerSha256: 'missing' },
    }),
  ).toThrow();
  expect(() =>
    updateReleasePins({
      ...input,
      knowledgeContract: { ...contract, targetPlatform: 'linux/amd64' },
    }),
  ).toThrow();
});
