import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hasExactGlobalSetting,
  validateRuntimeImageLabels,
  validateSeedBaseline,
  validateStaticConfig,
  verifyAccountBindings,
  canonicalJsonPayload,
} from '../../scripts/verify-openshell-production.mjs';

const projectionSha = 'd'.repeat(64);
const markerEnvironmentB64 = Buffer.from(
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
).toString('base64');
const manifest = {
  runtime: { image: 'localhost/mitzo:release-1', dependencyProjectionSha256: projectionSha },
  defaults: { workspace: 'default', webSearch: 'disabled' },
  serviceProviders: [{ name: 'google-workspace' }, { name: 'github' }],
  providerPolicy: { automatic: ['github'], grantable: ['google-workspace'] },
};

const config = {
  MITZO_OPENSHELL_ENABLED: '1',
  MITZO_OPENSHELL_IMAGE: 'localhost/mitzo:release-1',
  MITZO_OPENSHELL_SERVICE_PROVIDERS: 'github',
  MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS: 'google-workspace',
  MITZO_OPENSHELL_WEB_SEARCH: 'disabled',
  OPENSHELL_WORKSPACE: 'default',
};

let preparedSeed = '';

afterEach(() => {
  if (preparedSeed) rmSync(preparedSeed, { recursive: true, force: true });
  preparedSeed = '';
});

function digest(contents: string) {
  return createHash('sha256').update(contents).digest('hex');
}

function payloadDigest(
  startingCommit: string,
  files: Record<string, { sha256: string; mode: string }>,
) {
  return digest(
    canonicalJsonPayload({
      startingCommit,
      runtimeBaseCommit: startingCommit,
      runtimeDependencyProjectionSha256: projectionSha,
      files,
    }),
  );
}

function makePreparedSeed(sourceCommit = 'a'.repeat(40)) {
  preparedSeed = mkdtempSync(join(tmpdir(), 'mitzo-prepared-seed-'));
  const manifestDirectory = join(preparedSeed, 'memory', 'manifest');
  mkdirSync(manifestDirectory, { recursive: true });
  const files: Record<string, string> = {
    'knowledge.md': 'immutable knowledge\n',
    '.git/config': '[core]\nrepositoryformatversion = 0\n',
  };
  for (const name of ['index.json', 'wikilinks.json', 'by_type.json', 'by_tag.json']) {
    files[`memory/manifest/${name}`] = JSON.stringify({ sourceCommit }) + '\n';
  }
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(preparedSeed, path);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, contents);
  }
  const baselineFiles = Object.fromEntries(
    Object.entries(files).map(([path, contents]) => [
      path,
      { sha256: digest(contents), mode: '0644' },
    ]),
  );
  return {
    seedPath: preparedSeed,
    baseline: {
      startingCommit: sourceCommit,
      runtimeBaseCommit: sourceCommit,
      runtimeDependencyProjectionSha256: projectionSha,
      payloadSha256: payloadDigest(sourceCommit, baselineFiles),
      files: baselineFiles,
    },
  };
}

function dynamicRuntimeManifest(payloadSha256: string) {
  return {
    runtime: {
      mgmtSourceCommit: 'a'.repeat(40),
      dependencyProjectionSha256: projectionSha,
      seedPayloadSha256: payloadSha256,
      targetMarkerEnvironmentB64: markerEnvironmentB64,
    },
  };
}

describe('OpenShell production bundle validation', () => {
  it('allows a newer knowledge seed against its compatible runtime base', () => {
    const runtimeManifest = {
      runtime: { mgmtSourceCommit: 'a'.repeat(40), dependencyProjectionSha256: projectionSha },
    };
    expect(() =>
      validateSeedBaseline(
        { startingCommit: 'b'.repeat(40), runtimeBaseCommit: 'a'.repeat(40) },
        runtimeManifest,
      ),
    ).not.toThrow();
    expect(() =>
      validateSeedBaseline(
        { startingCommit: 'b'.repeat(40), runtimeBaseCommit: 'c'.repeat(40) },
        runtimeManifest,
      ),
    ).toThrow('runtime base');
  });

  it('keeps backward compatibility only when a legacy seed matches the runtime commit', () => {
    const runtimeCommit = 'a'.repeat(40);
    const runtimeManifest = { runtime: { mgmtSourceCommit: runtimeCommit } };
    expect(() =>
      validateSeedBaseline({ startingCommit: runtimeCommit }, runtimeManifest),
    ).not.toThrow();
    expect(() => validateSeedBaseline({ startingCommit: 'b'.repeat(40) }, runtimeManifest)).toThrow(
      'runtime base',
    );
  });

  it('binds a dynamic baseline to the selected immutable seed contents', () => {
    const { baseline, seedPath } = makePreparedSeed();
    const runtimeManifest = dynamicRuntimeManifest(baseline.payloadSha256);
    expect(() => validateSeedBaseline(baseline, runtimeManifest, seedPath)).not.toThrow();

    expect(() =>
      validateSeedBaseline(
        {
          ...baseline,
          files: { ...baseline.files, 'knowledge.md': { sha256: 'b'.repeat(64), mode: '0644' } },
        },
        runtimeManifest,
        seedPath,
      ),
    ).toThrow('file hash');

    writeFileSync(join(seedPath, 'knowledge.md'), 'modified knowledge\n');
    expect(() => validateSeedBaseline(baseline, runtimeManifest, seedPath)).toThrow('file hash');
  });

  it('requires a stack-pinned dynamic seed payload digest', () => {
    const { baseline, seedPath } = makePreparedSeed();
    expect(() =>
      validateSeedBaseline(
        { ...baseline, payloadSha256: undefined },
        dynamicRuntimeManifest(baseline.payloadSha256),
        seedPath,
      ),
    ).toThrow('payload digest is invalid or missing');
    const { seedPayloadSha256: ignoredPayloadDigest, ...runtimeWithoutPayloadDigest } =
      dynamicRuntimeManifest('a'.repeat(64)).runtime;
    void ignoredPayloadDigest;
    const missingPayloadDigest = { runtime: runtimeWithoutPayloadDigest };
    expect(() => validateSeedBaseline(baseline, missingPayloadDigest, seedPath)).toThrow(
      'stack lock dynamic seed payload digest is invalid or missing',
    );
    expect(() =>
      validateSeedBaseline(baseline, dynamicRuntimeManifest('b'.repeat(64)), seedPath),
    ).toThrow('does not match the stack lock');
    expect(() =>
      validateSeedBaseline(
        { ...baseline, payloadSha256: 'b'.repeat(64) },
        dynamicRuntimeManifest(baseline.payloadSha256),
        seedPath,
      ),
    ).toThrow('does not match its file manifest');
  });

  it('rejects dynamic seeds whose payload mode differs from the baseline', () => {
    const { baseline, seedPath } = makePreparedSeed();
    const runtimeManifest = dynamicRuntimeManifest(baseline.payloadSha256);
    chmodSync(join(seedPath, 'knowledge.md'), 0o755);
    expect(() => validateSeedBaseline(baseline, runtimeManifest, seedPath)).toThrow('hash or mode');
  });

  it('rejects a setuid mode added after seed publication', () => {
    const { baseline, seedPath } = makePreparedSeed();
    const runtimeManifest = dynamicRuntimeManifest(baseline.payloadSha256);
    chmodSync(join(seedPath, 'knowledge.md'), 0o4755);
    expect(() => validateSeedBaseline(baseline, runtimeManifest, seedPath)).toThrow('hash or mode');
  });

  it('rejects dynamic seeds with extra, missing, or symlinked payload files', () => {
    let fixture = makePreparedSeed();
    const runtimeManifest = dynamicRuntimeManifest(fixture.baseline.payloadSha256);
    writeFileSync(join(fixture.seedPath, 'extra.txt'), 'extra\n');
    expect(() => validateSeedBaseline(fixture.baseline, runtimeManifest, fixture.seedPath)).toThrow(
      'exactly match',
    );

    rmSync(fixture.seedPath, { recursive: true, force: true });
    preparedSeed = '';
    fixture = makePreparedSeed();
    unlinkSync(join(fixture.seedPath, 'knowledge.md'));
    expect(() => validateSeedBaseline(fixture.baseline, runtimeManifest, fixture.seedPath)).toThrow(
      'exactly match',
    );

    rmSync(fixture.seedPath, { recursive: true, force: true });
    preparedSeed = '';
    fixture = makePreparedSeed();
    symlinkSync(join(fixture.seedPath, 'knowledge.md'), join(fixture.seedPath, 'escaped-link'));
    expect(() => validateSeedBaseline(fixture.baseline, runtimeManifest, fixture.seedPath)).toThrow(
      'unsafe symlink',
    );
  });

  it('binds the uploaded portable Git repository to the dynamic baseline', () => {
    const fixture = makePreparedSeed();
    const runtimeManifest = dynamicRuntimeManifest(fixture.baseline.payloadSha256);
    mkdirSync(join(fixture.seedPath, '.git', 'hooks'));
    writeFileSync(join(fixture.seedPath, '.git', 'hooks', 'post-commit'), '#!/bin/sh\nexit 0\n');
    expect(() => validateSeedBaseline(fixture.baseline, runtimeManifest, fixture.seedPath)).toThrow(
      'exactly match',
    );

    rmSync(fixture.seedPath, { recursive: true, force: true });
    preparedSeed = '';
    const linked = makePreparedSeed();
    unlinkSync(join(linked.seedPath, '.git', 'config'));
    symlinkSync(join(linked.seedPath, 'knowledge.md'), join(linked.seedPath, '.git', 'config'));
    expect(() => validateSeedBaseline(linked.baseline, runtimeManifest, linked.seedPath)).toThrow(
      'unsafe symlink',
    );
  });

  it.each(['index.json', 'wikilinks.json', 'by_type.json', 'by_tag.json'])(
    'requires %s to attest to the baseline source commit',
    (name) => {
      const { baseline, seedPath } = makePreparedSeed();
      const path = join(seedPath, 'memory', 'manifest', name);
      const contents = JSON.stringify({ sourceCommit: 'b'.repeat(40) }) + '\n';
      writeFileSync(path, contents);
      const altered = {
        ...baseline,
        files: {
          ...baseline.files,
          [`memory/manifest/${name}`]: { sha256: digest(contents), mode: '0644' },
        },
      };
      altered.payloadSha256 = payloadDigest(altered.startingCommit, altered.files);
      const runtimeManifest = dynamicRuntimeManifest(altered.payloadSha256);
      expect(() => validateSeedBaseline(altered, runtimeManifest, seedPath)).toThrow(
        'manifest source commit',
      );
    },
  );

  it('rejects malformed seed commit identifiers', () => {
    const runtimeCommit = 'a'.repeat(40);
    const runtimeManifest = { runtime: { mgmtSourceCommit: runtimeCommit } };
    expect(() =>
      validateSeedBaseline(
        { startingCommit: 'b'.repeat(41), runtimeBaseCommit: runtimeCommit },
        runtimeManifest,
      ),
    ).toThrow('source commit');
    expect(() =>
      validateSeedBaseline(
        { startingCommit: 'b'.repeat(40), runtimeBaseCommit: 'not-a-commit' },
        runtimeManifest,
      ),
    ).toThrow('runtime base commit is invalid');
    expect(() => validateSeedBaseline(null, runtimeManifest)).toThrow('baseline must be an object');
  });

  it('requires runtime image labels to match both source locks', () => {
    const runtimeManifest = {
      runtime: {
        mitzoSourceCommit: 'a'.repeat(40),
        mgmtSourceCommit: 'b'.repeat(40),
        baseImage: 'docker.io/library/debian@sha256:fixture',
      },
    };
    const labels = {
      'io.mitzo.source-commit': runtimeManifest.runtime.mitzoSourceCommit,
      'io.mitzo.mgmt-source-commit': runtimeManifest.runtime.mgmtSourceCommit,
      'io.mitzo.openshell.base-image': runtimeManifest.runtime.baseImage,
    };
    expect(() => validateRuntimeImageLabels(labels, runtimeManifest)).not.toThrow();
    expect(() =>
      validateRuntimeImageLabels(
        { ...labels, 'io.mitzo.mgmt-source-commit': 'c'.repeat(40) },
        runtimeManifest,
      ),
    ).toThrow('MGMT provenance');
  });

  it('matches only active global settings with exact values', () => {
    expect(hasExactGlobalSetting('providers_v2_enabled = true', 'providers_v2_enabled', true)).toBe(
      true,
    );
    expect(
      hasExactGlobalSetting('# providers_v2_enabled = true', 'providers_v2_enabled', true),
    ).toBe(false);
    expect(
      hasExactGlobalSetting('providers_v2_enabled = trueish', 'providers_v2_enabled', true),
    ).toBe(false);
    expect(
      hasExactGlobalSetting(
        '# providers_v2_enabled = true\nproviders_v2_enabled = false',
        'providers_v2_enabled',
        true,
      ),
    ).toBe(false);
  });

  it('accepts a pinned image and exact provider ordering', () => {
    expect(validateStaticConfig(config, manifest)).toEqual({
      enabled: true,
      image: 'localhost/mitzo:release-1',
      configuredProviders: ['github'],
      grantableProviders: ['google-workspace'],
    });
  });

  it('rejects overlapping automatic and grantable provider policies', () => {
    const overlapping = {
      ...manifest,
      providerPolicy: { automatic: ['github'], grantable: ['github'] },
    };
    expect(() =>
      validateStaticConfig(
        {
          ...config,
          MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS: 'github',
        },
        overlapping,
      ),
    ).toThrow('overlap');
  });

  it('pins the production service-provider contract for GWS and GitHub CLI', () => {
    const lock = JSON.parse(
      readFileSync(
        new URL('../../infra/openshell/production-stack.lock.json', import.meta.url),
        'utf8',
      ),
    );
    expect(lock.runtime.requiredBinaries).toEqual([
      '/usr/bin/codex',
      '/usr/bin/gws',
      '/usr/bin/gh',
    ]);
    expect(lock.serviceProviders).toEqual([
      {
        name: 'google-workspace',
        type: 'mitzo-google-workspace-spike',
        credentialKeys: ['GOOGLE_WORKSPACE_CLI_TOKEN'],
      },
      { name: 'github', type: 'github', credentialKeys: ['GITHUB_TOKEN'] },
    ]);
    expect(lock.providerPolicy).toEqual({
      automatic: ['github'],
      grantable: ['google-workspace'],
    });
  });

  it.each(['localhost/mitzo', 'localhost/mitzo:latest', 'localhost/mitzo:dev'])(
    'rejects mutable image reference %s',
    (image) => {
      expect(() =>
        validateStaticConfig({ ...config, MITZO_OPENSHELL_IMAGE: image }, manifest),
      ).toThrow();
    },
  );

  it('requires brokered subscription fields to match the gateway provider', () => {
    const provider = { name: 'personal-chatgpt', id: 'provider-1' };
    const account = {
      id: 'personal',
      provider: 'openai-codex',
      sandboxProvider: provider.name,
      sandboxProviderType: 'openai-codex-oauth',
      sandboxProviderId: provider.id,
      sandboxGrantId: 'grant-1',
    };
    expect(() => verifyAccountBindings([account], [provider])).not.toThrow();
    expect(() =>
      verifyAccountBindings([{ ...account, credentialRef: '/host/login' }], [provider]),
    ).toThrow(/mixes host/);
    expect(() =>
      verifyAccountBindings([{ ...account, sandboxGrantId: undefined }], [provider]),
    ).toThrow(/incomplete/);
  });

  it('keeps the OpenAI API-key profile on REST without a conflicting websocket endpoint', () => {
    const profile = readFileSync(
      new URL(
        '../../docs/spikes/openshell-codex/openai-keychain-spike-profile.yaml',
        import.meta.url,
      ),
      'utf8',
    );
    expect(profile).toContain('protocol: rest');
    expect(profile).not.toContain('protocol: websocket');
  });

  it('keeps sandbox-native Google Workspace reads within the requested data services', () => {
    const profile = readFileSync(
      new URL(
        '../../docs/spikes/openshell-codex/google-workspace-spike-profile.yaml',
        import.meta.url,
      ),
      'utf8',
    );
    for (const scope of [
      'drive.readonly',
      'documents.readonly',
      'calendar.readonly',
      'gmail.readonly',
      'spreadsheets.readonly',
    ])
      expect(profile).toContain(scope);
    for (const host of [
      'www.googleapis.com',
      'docs.googleapis.com',
      'gmail.googleapis.com',
      'sheets.googleapis.com',
    ])
      expect(profile).toContain(`host: ${host}`);
    expect(profile).not.toContain('access: read-write');
  });

  it('starts the Podman machine before OpenShell production preflight', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy.sh', import.meta.url), 'utf8');
    const readiness = deploy.indexOf("podman machine inspect --format '{{.State}}'");
    const preflight = deploy.indexOf('node scripts/verify-openshell-production.mjs');
    expect(readiness).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(readiness);
  });
});
