import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  validateRuntimeMarkerEnvironment,
  validateSeedBaseline,
} from '../../scripts/verify-openshell-production.mjs';
import { verifiedOpenShellSeed } from '../openshell-runtime.js';

const environment = {
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
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const marker = (patch: Record<string, unknown>) => encode({ ...environment, ...patch });
const incomplete: Partial<typeof environment> = { ...environment };
delete incomplete.platform_version;
const malformed = [
  ['empty object', encode({})],
  [
    'UTF-8 BOM',
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify(environment)),
    ]).toString('base64'),
  ],
  ['noncanonical padding bits', 'e31='],
  [
    'version trailing newline',
    marker({ python_full_version: '3.11.9\n', implementation_version: '3.11.9\n' }),
  ],
  ['implementation trailing newline', marker({ implementation_name: 'cpython\n' })],
  ['array', encode([])],
  ['invalid JSON', Buffer.from('{').toString('base64')],
  ['invalid UTF-8', Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]).toString('base64')],
  ['missing key', encode(incomplete)],
  ['extra key', marker({ extra: '' })],
  ['wrong type', marker({ platform_version: 4 })],
  ['noncanonical base64', encode(environment) + '='],
  ['base64 whitespace', encode(environment) + '\n'],
  ['malformed version', marker({ python_full_version: 'anything' })],
  ['incoherent Python version', marker({ python_version: '3.12' })],
  ['incoherent CPython version', marker({ implementation_version: '3.11.8' })],
  ['incoherent implementation', marker({ platform_python_implementation: 'PyPy' })],
  ['wrong operating system', marker({ sys_platform: 'darwin' })],
  ['wrong machine', marker({ platform_machine: 'aarch64' })],
] as const;
let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

it('accepts the exact observed CPython marker contract and requires an explicit matching platform', () => {
  expect(validateRuntimeMarkerEnvironment(encode(environment), 'linux/amd64')).toEqual(environment);
  expect(() => validateRuntimeMarkerEnvironment(encode(environment), undefined)).toThrow(
    /marker environment/,
  );
  expect(() => validateRuntimeMarkerEnvironment(encode(environment), 'linux/arm64')).toThrow(
    /target platform/,
  );
});

it.each(malformed)('rejects %s consistently with the trusted builder helper', (_label, encoded) => {
  expect(() => validateRuntimeMarkerEnvironment(encoded, 'linux/amd64')).toThrow(
    /marker environment/,
  );
  expect(() =>
    execFileSync(
      'python3',
      [
        '-c',
        "import runpy,sys; runpy.run_path(sys.argv[1])['target_environment'](sys.argv[2],sys.argv[3])",
        resolve('docs/spikes/openshell-codex/runtime-resolution-contract.py'),
        encoded,
        'linux/amd64',
      ],
      { stdio: 'pipe' },
    ),
  ).toThrow();
});

it('rejects a malformed runtime marker contract at both bundle and ordinary sandbox admission', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-marker-admission-'));
  const seed = join(root, 'mgmt');
  mkdirSync(seed);
  const baseline = {
    startingCommit: 'a'.repeat(40),
    runtimeBaseCommit: 'a'.repeat(40),
    runtimeDependencyProjectionSha256: 'b'.repeat(64),
    knowledgeSchemaVersion: 1,
    knowledgeCompilerSha256: 'c'.repeat(64),
    knowledgeRecipeSha256: 'd'.repeat(64),
  };
  const stack = {
    runtime: {
      image: 'runtime:fixture',
      mgmtSourceCommit: baseline.runtimeBaseCommit,
      dependencyProjectionSha256: baseline.runtimeDependencyProjectionSha256,
      knowledgeSchemaVersion: 1,
      knowledgeCompilerSha256: baseline.knowledgeCompilerSha256,
      knowledgeRecipeSha256: baseline.knowledgeRecipeSha256,
      targetPlatform: 'linux/amd64',
      targetMarkerEnvironmentB64: 'e30=',
    },
  };
  writeFileSync(join(root, 'baseline.json'), JSON.stringify(baseline));
  expect(() => validateSeedBaseline(baseline, stack, seed)).toThrow(/marker environment/);
  expect(() =>
    verifiedOpenShellSeed({ image: stack.runtime.image, seed, seedStackManifest: stack }),
  ).toThrow(/marker environment/);
});

it.each([
  ['linux/amd64', environment],
  ['linux/arm64', { ...environment, platform_machine: 'aarch64' }],
  [
    'darwin/arm64',
    {
      ...environment,
      sys_platform: 'darwin',
      platform_system: 'Darwin',
      platform_machine: 'aarch64',
    },
  ],
  [
    'win32/amd64',
    { ...environment, sys_platform: 'win32', platform_system: 'Windows', os_name: 'nt' },
  ],
  [
    'linux/amd64',
    {
      ...environment,
      python_full_version: '3.13.0rc1',
      implementation_version: '3.13.0rc1',
      python_version: '3.13',
    },
  ],
  [
    'linux/amd64',
    {
      ...environment,
      implementation_name: 'pypy',
      platform_python_implementation: 'PyPy',
      implementation_version: '7.3.17',
    },
  ],
])('matches the builder helper for valid platform and version variants %s', (platform, value) => {
  const encoded = encode(value);
  const result = JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        "import json,runpy,sys; print(json.dumps(runpy.run_path(sys.argv[1])['target_environment'](sys.argv[2],sys.argv[3])))",
        resolve('docs/spikes/openshell-codex/runtime-resolution-contract.py'),
        encoded,
        platform,
      ],
      { encoding: 'utf8' },
    ),
  );
  delete result.extra;
  expect(validateRuntimeMarkerEnvironment(encoded, platform)).toEqual(result);
});
it('rejects trailing target platform data consistently with the builder helper', () => {
  const platform = 'linux/amd64\n';
  const encoded = marker({ platform_machine: 'amd64\n' });
  expect(() => validateRuntimeMarkerEnvironment(encoded, platform)).toThrow(/marker environment/);
  expect(() =>
    execFileSync(
      'python3',
      [
        '-c',
        "import runpy,sys; runpy.run_path(sys.argv[1])['target_environment'](sys.argv[2],sys.argv[3])",
        resolve('docs/spikes/openshell-codex/runtime-resolution-contract.py'),
        encoded,
        platform,
      ],
      { stdio: 'pipe' },
    ),
  ).toThrow();
});
