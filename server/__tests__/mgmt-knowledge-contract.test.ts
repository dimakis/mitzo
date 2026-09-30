import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  canonicalJsonPayload,
  validateSeedBaseline,
  verifyPreparedSeed,
} from '../../scripts/verify-openshell-production.mjs';
import { verifiedOpenShellSeed } from '../openshell-runtime.js';
let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture(commit: string) {
  root ||= mkdtempSync(join(tmpdir(), 'knowledge-contract-'));
  const dir = join(root, commit);
  mkdirSync(join(dir, 'memory', 'manifest'), { recursive: true });
  const files: Record<string, { sha256: string; mode: string }> = {};
  for (const name of ['index.json', 'wikilinks.json', 'by_type.json', 'by_tag.json']) {
    const path = `memory/manifest/${name}`;
    const content = JSON.stringify({ sourceCommit: commit });
    writeFileSync(join(dir, path), content);
    chmodSync(join(dir, path), 0o644);
    files[path] = { sha256: createHash('sha256').update(content).digest('hex'), mode: '0644' };
  }
  const payload = {
    startingCommit: commit,
    runtimeBaseCommit: 'a'.repeat(40),
    runtimeDependencyProjectionSha256: 'b'.repeat(64),
    knowledgeSchemaVersion: 1,
    knowledgeCompilerSha256: 'c'.repeat(64),
    knowledgeRecipeSha256: 'd'.repeat(64),
    files,
  };
  return {
    dir,
    baseline: {
      ...payload,
      payloadSha256: createHash('sha256').update(canonicalJsonPayload(payload)).digest('hex'),
    },
  };
}
const stack = {
  runtime: {
    mgmtSourceCommit: 'a'.repeat(40),
    dependencyProjectionSha256: 'b'.repeat(64),
    targetPlatform: 'linux/amd64',
    targetMarkerEnvironmentB64: Buffer.from(
      JSON.stringify({
        implementation_name: 'cpython',
        implementation_version: '3.11.9',
        os_name: 'posix',
        platform_machine: 'x86_64',
        platform_release: 'fixture',
        platform_system: 'Linux',
        platform_version: 'fixture',
        platform_python_implementation: 'CPython',
        python_full_version: '3.11.9',
        python_version: '3.11',
        sys_platform: 'linux',
      }),
    ).toString('base64'),
    knowledgeSchemaVersion: 1,
    knowledgeCompilerSha256: 'c'.repeat(64),
    knowledgeRecipeSha256: 'd'.repeat(64),
    seedPayloadSha256: '0'.repeat(64),
  },
};
it('accepts A then knowledge-only B with the same runtime lock and independently verified content', () => {
  root = '';
  const a = fixture('a'.repeat(40));
  const b = fixture('e'.repeat(40));
  expect(a.baseline.payloadSha256).not.toBe(b.baseline.payloadSha256);
  expect(() => validateSeedBaseline(a.baseline, stack, a.dir)).not.toThrow();
  expect(() => validateSeedBaseline(b.baseline, stack, b.dir)).not.toThrow();
});
it('fails closed for incompatible schema, compiler, recipe, dependencies and mutated payload', () => {
  root = '';
  const { dir, baseline } = fixture('a'.repeat(40));
  for (const field of [
    'knowledgeCompilerSha256',
    'knowledgeRecipeSha256',
    'runtimeDependencyProjectionSha256',
  ]) {
    expect(() =>
      validateSeedBaseline({ ...baseline, [field]: 'f'.repeat(64) }, stack, dir),
    ).toThrow();
  }
  expect(() =>
    validateSeedBaseline({ ...baseline, knowledgeSchemaVersion: 2 }, stack, dir),
  ).toThrow();
  writeFileSync(join(dir, 'memory/manifest/index.json'), 'tampered');
  expect(() => validateSeedBaseline(baseline, stack, dir)).toThrow(/hash or mode/);
});

it('requires the separate Jira runtime pin when declared by either source or runtime', () => {
  root = '';
  const { dir, baseline } = fixture('a'.repeat(40));
  const jiraStack = { runtime: { ...stack.runtime, jiraRuntimeInputsSha256: '9'.repeat(64) } };
  expect(() => validateSeedBaseline(baseline, jiraStack, dir)).toThrow(/Jira/);
  const jiraBaseline = { ...baseline, runtimeJiraInputsSha256: '9'.repeat(64) };
  const payload: Record<string, unknown> = { ...jiraBaseline };
  delete payload.payloadSha256;
  jiraBaseline.payloadSha256 = createHash('sha256')
    .update(canonicalJsonPayload(payload))
    .digest('hex');
  expect(() => validateSeedBaseline(jiraBaseline, jiraStack, dir)).not.toThrow();
  expect(() => validateSeedBaseline(jiraBaseline, stack, dir)).toThrow(/Jira/);
  expect(() =>
    validateSeedBaseline(
      { ...jiraBaseline, runtimeJiraInputsSha256: '8'.repeat(64) },
      jiraStack,
      dir,
    ),
  ).toThrow(/Jira/);
});

it('requires a publisher envelope and binds it to exact baseline bytes and runtime identity', () => {
  root = '';
  const { dir, baseline } = fixture('a'.repeat(40));
  const trustedStack = {
    runtime: { ...stack.runtime, image: 'fixture:runtime', digest: `sha256:${'1'.repeat(64)}` },
  };
  const baselineBytes = JSON.stringify(baseline);
  writeFileSync(join(dir, '..', 'baseline.json'), baselineBytes);
  expect(() => verifyPreparedSeed(dir, trustedStack)).toThrow(/publication/);
  const publication = {
    schemaVersion: 1,
    sourceCommit: baseline.startingCommit,
    builderCommit: '2'.repeat(40),
    payloadSha256: baseline.payloadSha256,
    baselineSha256: createHash('sha256').update(baselineBytes).digest('hex'),
    runtimeImage: trustedStack.runtime.image,
    runtimeDigest: trustedStack.runtime.digest,
    runtimeBaseCommit: baseline.runtimeBaseCommit,
    runtimeDependencyProjectionSha256: baseline.runtimeDependencyProjectionSha256,
    knowledgeSchemaVersion: 1,
    knowledgeCompilerSha256: baseline.knowledgeCompilerSha256,
    knowledgeRecipeSha256: baseline.knowledgeRecipeSha256,
    validation: { pinnedBuilder: true, runtimeContract: true, manifestProvenance: true },
  };
  const recordPath = join(dir, '..', 'publication.json');
  writeFileSync(recordPath, JSON.stringify(publication));
  expect(() => verifyPreparedSeed(dir, trustedStack)).not.toThrow();
  writeFileSync(
    recordPath,
    JSON.stringify({ ...publication, runtimeDigest: `sha256:${'3'.repeat(64)}` }),
  );
  expect(() => verifyPreparedSeed(dir, trustedStack)).toThrow(/runtimeDigest/);
  writeFileSync(recordPath, JSON.stringify(publication));
  writeFileSync(join(dir, '..', 'baseline.json'), baselineBytes + '\n');
  expect(() => verifyPreparedSeed(dir, trustedStack)).toThrow(/baseline/);
});

it('rejects forbidden files and special file modes even with a recomputed integrity digest', () => {
  root = '';
  const { dir, baseline } = fixture('a'.repeat(40));
  writeFileSync(join(dir, '.env'), 'secret');
  chmodSync(join(dir, '.env'), 0o644);
  baseline.files['.env'] = {
    sha256: createHash('sha256').update('secret').digest('hex'),
    mode: '0644',
  };
  const payload: Record<string, unknown> = { ...baseline };
  delete payload.payloadSha256;
  baseline.payloadSha256 = createHash('sha256').update(canonicalJsonPayload(payload)).digest('hex');
  expect(() => validateSeedBaseline(baseline, stack, dir)).toThrow(/allowlist/);
  delete baseline.files['.env'];
  rmSync(join(dir, '.env'));
  baseline.files['memory/manifest/index.json'].mode = '4644';
  expect(() => validateSeedBaseline(baseline, stack, dir)).toThrow(/special/);
});

it('rejects downgrading the first dynamic publication to an unverified legacy baseline', () => {
  root = '';
  const { dir } = fixture('a'.repeat(40));
  const downgraded = { startingCommit: 'a'.repeat(40) };
  writeFileSync(join(dir, '.env'), 'unverified secret');
  writeFileSync(join(dir, '..', 'baseline.json'), JSON.stringify(downgraded));
  const selected = { runtime: { ...stack.runtime, image: 'runtime:fixture' } };
  expect(() => validateSeedBaseline(downgraded, selected, dir)).toThrow(
    /selected.*dynamic publication/,
  );
  expect(() => verifyPreparedSeed(dir, selected)).toThrow(/selected.*dynamic publication/);
  expect(() =>
    verifiedOpenShellSeed({
      image: selected.runtime.image,
      seed: dir,
      seedStackManifest: selected,
    }),
  ).toThrow(/selected.*dynamic publication/);
  const legacy = {
    runtime: { image: selected.runtime.image, mgmtSourceCommit: downgraded.startingCommit },
  };
  expect(() => verifyPreparedSeed(dir, legacy)).not.toThrow();
});
it.each([
  ['knowledgeSchemaVersion', 1],
  ['knowledgeCompilerSha256', 'c'.repeat(64)],
  ['knowledgeRecipeSha256', 'd'.repeat(64)],
  ['dependencyProjectionSha256', 'b'.repeat(64)],
  ['targetMarkerEnvironmentB64', 'e30='],
  ['targetPlatform', 'linux/amd64'],
  ['jiraRuntimeInputsSha256', '9'.repeat(64)],
])('rejects a partial selected dynamic runtime contract declaring only %s', (field, value) => {
  const baseline = { startingCommit: 'a'.repeat(40) };
  const selected = { runtime: { mgmtSourceCommit: baseline.startingCommit, [field]: value } };
  expect(() => validateSeedBaseline(baseline, selected)).toThrow(/selected.*dynamic publication/);
});
