import { expect, it } from 'vitest';
import * as contracts from '../symposium-owned-runtime-contract.js';

it('preserves every image-only default and requires explicit known full-build selection', () => {
  const resolve = (
    contracts as unknown as {
      reviewedSymposiumOwnedBuild: (
        image: string,
        selection?: string,
      ) => typeof contracts.REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build;
    }
  ).reviewedSymposiumOwnedBuild;
  expect(typeof resolve).toBe('function');
  for (const runtime of [
    contracts.REVIEWED_SYMPOSIUM_OWNED_RUNTIME,
    contracts.REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME,
    contracts.REVIEWED_SYMPOSIUM_CODE_MODE_RUNTIME,
    contracts.REVIEWED_SYMPOSIUM_CODEX_01561_RUNTIME,
    contracts.REVIEWED_SYMPOSIUM_CODEX_01591_RUNTIME,
    contracts.REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME,
  ]) {
    expect(contracts.symposiumOwnedBuildVersions(runtime.build)).toEqual({
      cliVersion: runtime.build.version,
      gatewayVersion: runtime.build.version,
    });
    expect(Object.keys(runtime.build)).not.toContain('cliVersion');
    expect(Object.keys(runtime.build)).not.toContain('gatewayVersion');
    expect(resolve(runtime.build.image)).toBe(
      contracts.reviewedSymposiumOwnedRuntime(runtime.build.image).build,
    );
  }
  const image = contracts.REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME.build.image;
  const local = resolve(image, 'local-854b-b20-v1');
  expect(local).toMatchObject({
    version: '0.0.0',
    cliSha256: '6ed96b7aa13655d6ecaeb822aee7526bc2170d85bd00f4506b13330703cb5dff',
    gatewaySha256: '712906577a63c29553e7f2653bf2944c55a7142c3c69643532d1461da1eebe10',
    supervisorImage: 'sha256:baa239a3c804bb889d70f8da465facbe289e302fba4cefb19112200a16fb5013',
  });
  expect(contracts.symposiumOwnedBuildVersions(local)).toEqual({
    cliVersion: '0.0.0',
    gatewayVersion: '0.0.0',
  });
  expect(local.nativeArtifacts).toEqual(
    contracts.REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME.build.nativeArtifacts,
  );
  expect(Object.isFrozen(local)).toBe(true);
  expect(() => resolve(image, 'unknown')).toThrow();
  expect(() =>
    resolve(contracts.REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build.image, 'local-854b-b20-v1'),
  ).toThrow();
  expect(resolve(image).cliSha256).not.toBe(local.cliSha256);
});

it('requires the exact measured routing tuple and explicit trusted diagnostic selection', () => {
  const image = contracts.REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME.build.image;
  const qualified = contracts.reviewedSymposiumRoutingDiagnosticBuild(
    image,
    'local-854b-routing-v1',
  );
  expect(qualified).toMatchObject({
    version: '0.0.1-dev.2+ga8ad99243',
    gatewayVersion: '0.0.117-dev.292+g854b2370b',
    cliSha256: '86153f4bff90b7a20bb01c53e3b1aaf4bb11fa1a456652e06ba8fbe5b69491bc',
    gatewaySha256: contracts.REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build.gatewaySha256,
    supervisorImage: 'sha256:70a6be5fe9ffbae4f6ad152fb5f2092acb034e4148d8027faabf522d1ed25f51',
  });
  expect(contracts.reviewedSymposiumOwnedBuild(image)).not.toBe(qualified);
  expect(contracts.reviewedSymposiumOwnedBuild(image, 'local-854b-routing-v1')).toBe(qualified);
  expect(contracts.symposiumOwnedBuildVersions(qualified)).toEqual({
    cliVersion: qualified.version,
    gatewayVersion: qualified.gatewayVersion,
  });
  expect(qualified.nativeArtifacts).toEqual(
    contracts.REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME.build.nativeArtifacts,
  );
  expect(Object.isFrozen(qualified)).toBe(true);
  expect(Object.isFrozen(qualified.nativeArtifacts)).toBe(true);
  for (const selection of [undefined, 'local-854b-b20-v1', 'unknown'])
    expect(() =>
      contracts.reviewedSymposiumRoutingDiagnosticBuild(image, selection as never),
    ).toThrow();
  expect(() =>
    contracts.reviewedSymposiumRoutingDiagnosticBuild(
      contracts.REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build.image,
      'local-854b-routing-v1',
    ),
  ).toThrow();
});

import { collectOwnedAdmissionEvidence } from '../symposium-owned-evidence.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';
it('collector uses only trusted host build choice and never request selection or activation', () => {
  const root = mkdtempSync(join(tmpdir(), 'owned-build-selection-'));
  try {
    const seed = join(root, 'seed'),
      policy = join(root, 'policy');
    mkdirSync(seed);
    writeFileSync(policy, 'policy');
    const config = {
      image: contracts.REVIEWED_SYMPOSIUM_CODEX_01591_IDENTITY_RUNTIME.build.image,
      seed,
      policy,
      cli: '/synthetic-cli',
      gateway: 'synthetic',
      workspace: 'synthetic',
    } as OpenShellRuntimeConfig;
    const selection = {
      providerInstances: [
        { name: 'synthetic', id: 'original-provider-id', type: 'openai', profileName: 'openai' },
      ],
      artifactVolume: { driver: 'podman', name: 'original-volume' },
      allowedRoles: ['coder', 'reviewer'],
      allowedAccountProviders: ['openai'],
    };
    const invoke = vi.fn(() => JSON.stringify({ id: 'openai', provider: 'openai' })),
      verify = vi.fn(),
      custody = vi.fn();
    const host = {
      config,
      endpoint: 'https://localhost:1234',
      physical: {} as never,
      custody,
      buildSelection: 'local-854b-b20-v1' as const,
    };
    const candidate = collectOwnedAdmissionEvidence(host, selection, { invoke, verify });
    expect(candidate.cliSha256).toBe(
      contracts.SOURCE_QUALIFIED_SYMPOSIUM_LOCAL_B20_BUILD.cliSha256,
    );
    expect(candidate.contract).toBe('openshell-v0.1-owned-native-seats');
    if (candidate.contract !== 'openshell-v0.1-owned-native-seats')
      throw new Error('Wrong candidate contract');
    expect(candidate.supervisorImage).toBe(
      contracts.SOURCE_QUALIFIED_SYMPOSIUM_LOCAL_B20_BUILD.supervisorImage,
    );
    expect(verify).toHaveBeenCalledExactlyOnceWith(
      config,
      candidate,
      host.physical,
      invoke,
      'local-854b-b20-v1',
    );
    expect(custody).toHaveBeenCalledTimes(2);
    expect(() =>
      collectOwnedAdmissionEvidence(
        host,
        { ...selection, buildSelection: 'local-854b-b20-v1' },
        { invoke, verify },
      ),
    ).toThrow();
    expect(() =>
      collectOwnedAdmissionEvidence({ ...host, buildSelection: 'unknown' as never }, selection, {
        invoke,
        verify,
      }),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { collectSessionOwnedAdmissionEvidence } from '../symposium-owned-evidence.js';
import { SymposiumSessionArtifacts } from '../symposium-session-artifacts.js';
import Database from 'better-sqlite3';
it('candidate collection reads the original ready mapping without issuing admission or blocking source import', async () => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-ready-session-'));
  const volumes = new Map<string, unknown>();
  const artifacts = new SymposiumSessionArtifacts(
    join(root, 'artifacts.db'),
    'workspace',
    'custody',
    () => {},
    {
      initializationContract: 'synthetic-unit',
      inspect: async (name) => (volumes.get(name) as never) ?? null,
      create: async (name, labels) => {
        volumes.set(name, { name, labels, driver: 'local', options: {} });
      },
    },
  );
  try {
    await artifacts.ensure('original-session');
    const mapping = artifacts.getReady('original-session')!;
    let revision = 1,
      current = true;
    const raw = {
      sessionId: 'original-session',
      configRevision: 1,
      providerInstances: [
        { name: 'original-provider', id: 'original-id', type: 'openai', profileName: 'openai' },
      ],
      allowedRoles: ['coder', 'reviewer'],
      allowedAccountProviders: ['openai'],
    };
    const collect = vi.fn(async () => ({ contract: 'openshell-v0.1-owned-native-seats' }) as never);
    const deps = {
      readCurrent: (input: { sessionId: string; configRevision: number }) => {
        if (!current || input.sessionId !== 'original-session' || input.configRevision !== revision)
          throw Error('current');
        return artifacts.getReady(input.sessionId)!;
      },
      inspectCurrent: vi.fn(async () => {}),
      collect,
      verifyCandidate: vi.fn(),
    };
    const capability = await collectSessionOwnedAdmissionEvidence(raw, deps);
    const db = new Database(join(root, 'artifacts.db'));
    try {
      expect(
        (
          db.prepare('SELECT admission_issued FROM symposium_session_artifacts').get() as {
            admission_issued: number;
          }
        ).admission_issued,
      ).toBe(0);
    } finally {
      db.close();
    }
    expect(artifacts.sourceImportStatus('original-session').available).toBe(true);
    expect(collect).toHaveBeenCalledExactlyOnceWith({
      providerInstances: raw.providerInstances,
      allowedRoles: raw.allowedRoles,
      allowedAccountProviders: raw.allowedAccountProviders,
      artifactVolume: { driver: 'podman', name: mapping.volumeName },
    });
    await expect(
      collectSessionOwnedAdmissionEvidence({ ...raw, sessionId: 'other' }, deps),
    ).rejects.toThrow('current');
    await expect(
      collectSessionOwnedAdmissionEvidence({ ...raw, configRevision: 2 }, deps),
    ).rejects.toThrow('current');
    revision = 2;
    await expect(capability.assertCurrent()).rejects.toThrow('current');
    revision = 1;
    current = false;
    await expect(capability.assertCurrent()).rejects.toThrow('current');
    current = true;
    expect(
      artifacts.beginSourceImport('original-session', {
        operationId: 'source-operation',
        expectedGeneration: mapping.volumeGeneration,
        source: { synthetic: true },
      }),
    ).toMatchObject(mapping);
  } finally {
    artifacts.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('refuses mapping or custody loss during candidate collection and never returns a stale capability', async () => {
  const raw = {
    sessionId: 'original',
    configRevision: 1,
    providerInstances: [{ name: 'provider', id: 'id', type: 'openai', profileName: 'openai' }],
    allowedRoles: ['coder'],
    allowedAccountProviders: ['openai'],
  };
  let mapping = { volumeName: 'original-volume', volumeGeneration: 'one' };
  const deps = {
    readCurrent: () => mapping,
    inspectCurrent: async () => {},
    verifyCandidate: vi.fn(),
    collect: async () => {
      mapping = { ...mapping, volumeGeneration: 'replacement' };
      return {} as never;
    },
  };
  await expect(collectSessionOwnedAdmissionEvidence(raw, deps)).rejects.toThrow('mapping changed');
});
