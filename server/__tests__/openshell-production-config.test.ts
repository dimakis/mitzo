import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasExactGlobalSetting,
  main,
  validateReleaseIdentity,
  validateReleaseTransport,
  validateStaticConfig,
  validateRollbackRecord,
  verifyBakedBrowserOrigin,
  verifyAccountBindings,
  verifyAccountProfileIntegrity,
  verifyCleanTrackedWorktree,
  verifyCheckoutReleaseProvenance,
  verifyLocalReleaseIdentity,
  verifyReleaseTls,
} from '../../scripts/verify-openshell-production.mjs';

const manifest = {
  runtime: { image: 'localhost/mitzo:release-1' },
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

const releaseTransport = {
  publicOrigin: 'https://dimakis-mac.taildfe858.ts.net:3100',
  webSocketOrigin: 'wss://dimakis-mac.taildfe858.ts.net:3100',
  tlsRequired: true,
};

const certificateBackedProductionOrigin = 'https://dimakis-mac.taildfe858.ts.net:3100';

// A deliberately non-production RSA pair used only to prove the local
// deployment preflight reads the same certs/cert.pem and certs/key.pem paths
// that the server will load. It is valid only for the fixture hostname.
const fixtureCertificate = `-----BEGIN CERTIFICATE-----
MIIDWzCCAkOgAwIBAgIUANvCwQm4lDFkObhMT5jzqMney4cwDQYJKoZIhvcNAQEL
BQAwKDEmMCQGA1UEAwwdZGltYWtpcy1tYWMudGFpbGRmZTg1OC50cy5uZXQwHhcN
MjYwOTE5MjIwOTEwWhcNMzYwOTE2MjIwOTEwWjAoMSYwJAYDVQQDDB1kaW1ha2lz
LW1hYy50YWlsZGZlODU4LnRzLm5ldDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
AQoCggEBAKWGangQeyTsaIfmfO4rggGj0O2tp1l6ATwEylwwKq06fU5bg7S+8QGB
Ao+Sv8uBoc/TAxEpXOs464KUYyKob23q6bWi13tQOmd78R3HcJ2hlmgiG3Juyil/
NpsAGrjUWw/iy58dpZCrC/ysl6GAtoGJUtlkQLmJmykHohYjVjVK+KenJCKb12kX
WrH43mVDV+K/duuGtjKaTA/eqz9WKt4GSjLMhjmyq6fDqFvkfXUg0Hko9WotoirI
uWXNFySOubx6FQowebP/Iyt6/f9HF8+A57RN6JZOBGB/IXbO1jdLp9WQqtlNJSE+
yk2JRfiSde6NOe43m8lUeaPepma6nXkCAwEAAaN9MHswHQYDVR0OBBYEFD4wm2Lb
/w+Idt1UNX8SYYHK+jGjMB8GA1UdIwQYMBaAFD4wm2Lb/w+Idt1UNX8SYYHK+jGj
MA8GA1UdEwEB/wQFMAMBAf8wKAYDVR0RBCEwH4IdZGltYWtpcy1tYWMudGFpbGRm
ZTg1OC50cy5uZXQwDQYJKoZIhvcNAQELBQADggEBAGFjsCsKDyl5aSZ2rA+8xd3c
NMroQRQM1umPrJpEQKnuHOfx7vq6WeTVltIvaRizefeDg4mUFDJaf7TsHd1oel2X
uQdFcj20AKI3YV/dmb7THmoGCzohHEAy0fx82f+2KYNrgKa/TnSwnD78Iqf9369a
JJ0l+1JOxiPLHW3UUDmXeBovtQ0zlJpQt1SfiPj5i3E/T0QgKovW25bTJslqbHQb
1RErKlE65Agc3137o+RSOjT3bHIBKXYzNVTfHhg63mUxrTJxVz3mBglGPDtm21zx
fw4Z+pS15QESJ2LZBcsKdKlxSQfZBxkVSOEo4wkRMUFbUxnUEHYNLS6SC6xjI48=
-----END CERTIFICATE-----
`;

const fixturePrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQClhmp4EHsk7GiH
5nzuK4IBo9DtradZegE8BMpcMCqtOn1OW4O0vvEBgQKPkr/LgaHP0wMRKVzrOOuC
lGMiqG9t6um1otd7UDpne/Edx3CdoZZoIhtybsopfzabABq41FsP4sufHaWQqwv8
rJehgLaBiVLZZEC5iZspB6IWI1Y1SvinpyQim9dpF1qx+N5lQ1fiv3brhrYymkwP
3qs/VireBkoyzIY5squnw6hb5H11INB5KPVqLaIqyLllzRckjrm8ehUKMHmz/yMr
ev3/RxfPgOe0TeiWTgRgfyF2ztY3S6fVkKrZTSUhPspNiUX4knXujTnuN5vJVHmj
3qZmup15AgMBAAECggEAAk4l77gjCqaJkI2i4x6KzU+2JyC5RxJWyWVEwDgRHOQc
HKbtf0CYMK3nwUqrUp3I+CIREXfrRbQuXrK6OSBYVxMW8TyXBSXFOnZDgKurrAus
ih1ESlM80FgSN8AmBYZuABs9GhRna/ZwjF117DmxjL1+qyjPz9J/QqOgPhJJpnnN
aumi9rs36/jWfB0sZnEZWdzZQEHYksm1CiLJ93t0PSuvwzeRg2tJVH4PWSzWcCBU
9/siHCvQ5Oeiy5q+xUiy6fZIze2TZOhn76IAWQlQavwumFNHdwb1REUQzYEHJCy3
U2oijmtkDZg3XBeh76iUQ+SEdpZV/N6wmhvK4Fb/hQKBgQDXlRgUy/WYFTKDQ3Sv
qMMz6n61EtcAlB05khw2iaZm2je+/GsEEMN1GLEtPJgo///Ah1uUuabToHQRz4sa
xd89pj0PmFO6xA2Pz/AnNVu2oSADTs7UP6APxmqHL/0iEv13clR6nyGymqXuqbqo
/Jln8mh47Xbwi77FmovHxO3VdwKBgQDEjtAz0/1njPkJ3/ZEWPDppDQkK5/ASVA5
yIIC1cky7UvN9JTy1w3a+t8RTE8mUejnK0Vzu4+KEf0Un/EHVnBNqQpDtP7C6lC8
/PInN/+Tzq4VtiP7xsUiRjfnUpcvAiVhLCt/tVBIFZ7asXWGpsm2gyanoyFA04Y4
Mn/JmLqgjwKBgQCmxsTWceMRQHTPb4P50MkShLp5QpXp8KubOhlxZ5O/xdmSepwf
jQhosi1/HX1pWoJ0Y0LKD8WrulmQ3cpzb9iATPa39dPwjHMhanATJQhKhOPLK1B+
iqo9Cfanlsxxa9eCbIRGSI09Kr5roAqzaJcU/0crJin5dWKkZCb26LZFiQKBgELF
XPbuQbwGiKcRHMB1EkncTRYod5lDjmxCr9+0rieNst2hA2RHJ97GsDZZHN4gnyTA
b1R0V7uIhteVybQ7aeUH0oPTnWOrY4f/yWcHP9v/LuYTPMAP8vHEtsLvLIp8iSQs
dA5rEn2aUp9p/0mhqQ5GGUCDSw2RjZvTk9Nw/Z0DAoGAWrwQtdr8yl4xZHXC9j8w
EX01U9OLGcBvMMFXxAA7nkfAuX+9wNEG6/mN4arkc6an9IWBImj3M0TWdnaS+gRQ
AlVCaaFUn2RmCUN+mKhrbtKwyFcmOMDjOLfuRCQvjuCZMynFhH/tgC1lI2daQX3/
2gTR4+Q+Z0ulBDjgTELk0Lo=
-----END PRIVATE KEY-----
`;

function writeFixtureTls(root: string) {
  const certs = join(root, 'certs');
  mkdirSync(certs);
  writeFileSync(join(certs, 'cert.pem'), fixtureCertificate);
  writeFileSync(join(certs, 'key.pem'), fixturePrivateKey);
}

const lockedPodmanSupervisor = {
  launchdLabel: 'com.mitzo.podman-machine',
  artifactPath: 'infra/com.mitzo.podman-machine.plist',
  artifactSha256: '50a2d70ddc64ccbbcfe18a9a9af285aa8980947a7ed3606c7cea72f8e17f779b',
};

const fixtureAccountProfiles = JSON.stringify([
  {
    id: 'personal',
    provider: 'openai-codex',
    sandboxProvider: 'personal-chatgpt',
    sandboxProviderType: 'openai-codex-oauth',
    sandboxProviderId: 'provider-1',
    sandboxGrantId: 'grant-1',
  },
]);

const releaseRollbackInputs = {
  accountProfiles: {
    bundleId: 'mitzo-openshell-accounts-v1',
    reference: 'MITZO_ACCOUNT_PROFILES_FILE',
    sha256: createHash('sha256').update(fixtureAccountProfiles).digest('hex'),
  },
  policy: {
    reference: 'MITZO_OPENSHELL_POLICY',
    sha256: 'ad533acbc5838d0e9f8a6dc9b0d20a1e9214a7706a2db4ae0d8c71c6f24e0a20',
  },
  seed: {
    bundleId: 'mgmt',
    baselineReference: 'MITZO_OPENSHELL_SEED/../baseline.json',
    startingCommit: 'c1413c0091075f3d3552993cb1a5468747217e64',
  },
};

describe('OpenShell production bundle validation', () => {
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
    expect(lock.release).toEqual({
      // The release wrapper itself changes this value to its source parent.
      // Keep the assertion tied to the staged release fixture so that wrapper
      // B can point at source commit A without changing source tests.
      mitzoSourceCommit: lock.release.mitzoSourceCommit,
      openshellCli: {
        identity: 'openshell',
        path: '/opt/homebrew/bin/openshell',
        version: '0.0.116-mitzo.2',
        sourceCommit: 'b4c459f92446167afcb0a2dcf7d9fa6c8945e59c',
      },
      gatewayService: 'sh.brew.openshell',
      podmanSupervisor: lockedPodmanSupervisor,
      rollbackInputs: {
        ...releaseRollbackInputs,
        accountProfiles: lock.release.rollbackInputs.accountProfiles,
      },
      transport: {
        publicOrigin: expect.any(String),
        webSocketOrigin: expect.any(String),
        tlsRequired: true,
      },
    });
    // Source commit A must remain testable while it still carries the prior
    // release metadata. The metadata-only wrapper B supplies the real
    // external profile digest; this fixture exercises the required shape and
    // keeps the static provider-contract assertion independent of that
    // external file's contents.
    const releaseFixture = {
      ...lock,
      release: {
        ...lock.release,
        rollbackInputs: {
          ...lock.release.rollbackInputs,
          accountProfiles: {
            ...lock.release.rollbackInputs.accountProfiles,
            sha256: releaseRollbackInputs.accountProfiles.sha256,
          },
        },
      },
    };
    expect(() => validateReleaseIdentity(releaseFixture)).not.toThrow();
  });

  it('pins the certificate-backed Tailnet endpoint in the production environment example', () => {
    const env = readFileSync(
      new URL('../../infra/openshell/production.env.example', import.meta.url),
      'utf8',
    );
    expect(env).toContain(`MITZO_PUBLIC_ORIGIN=${certificateBackedProductionOrigin}`);
    expect(env).toContain('MITZO_REQUIRE_TLS=1');
    expect(releaseTransport.publicOrigin).toBe(certificateBackedProductionOrigin);
    expect(releaseTransport.webSocketOrigin).toBe(
      certificateBackedProductionOrigin.replace(/^https:/, 'wss:'),
    );
  });

  it('pins the external account-profile contents in the release fixture', () => {
    const output = mkdtempSync(join(tmpdir(), 'mitzo-account-profile-integrity-'));
    const accountsPath = join(output, 'accounts.json');
    try {
      writeFileSync(accountsPath, fixtureAccountProfiles);
      const manifest = { release: { rollbackInputs: releaseRollbackInputs } };
      expect(
        verifyAccountProfileIntegrity({ MITZO_ACCOUNT_PROFILES_FILE: accountsPath }, manifest),
      ).toBe(accountsPath);

      writeFileSync(accountsPath, JSON.stringify([{ id: 'replacement-profile' }]));
      expect(() =>
        verifyAccountProfileIntegrity({ MITZO_ACCOUNT_PROFILES_FILE: accountsPath }, manifest),
      ).toThrow('account profiles hash does not match the stack lock');
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it('requires the baked Tailnet HTTPS/WSS transport contract', () => {
    expect(
      validateReleaseTransport(
        {
          MITZO_PUBLIC_ORIGIN: releaseTransport.publicOrigin,
          MITZO_REQUIRE_TLS: '1',
          PORT: '3100',
        },
        { release: { transport: releaseTransport } },
      ),
    ).toEqual(releaseTransport);
    expect(() =>
      validateReleaseTransport(
        {
          MITZO_PUBLIC_ORIGIN: 'http://dimakis-mac.taildfe858.ts.net:3100',
          MITZO_REQUIRE_TLS: '1',
          PORT: '3100',
        },
        { release: { transport: releaseTransport } },
      ),
    ).toThrow('public origin');
    expect(() =>
      validateReleaseTransport(
        {
          MITZO_PUBLIC_ORIGIN: releaseTransport.publicOrigin,
          MITZO_REQUIRE_TLS: '0',
          PORT: '3100',
        },
        { release: { transport: releaseTransport } },
      ),
    ).toThrow('MITZO_REQUIRE_TLS=1');
  });

  it('rejects a public-origin port that differs from the server listener', () => {
    expect(() =>
      validateReleaseTransport(
        {
          MITZO_PUBLIC_ORIGIN: releaseTransport.publicOrigin,
          MITZO_REQUIRE_TLS: '1',
          PORT: '443',
        },
        { release: { transport: releaseTransport } },
      ),
    ).toThrow('port does not match PORT');

    const defaultHttpsOrigin = 'https://dimakis-mac.taildfe858.ts.net';
    const transport = {
      publicOrigin: defaultHttpsOrigin,
      webSocketOrigin: 'wss://dimakis-mac.taildfe858.ts.net',
      tlsRequired: true,
    };
    expect(() =>
      validateReleaseTransport(
        { MITZO_PUBLIC_ORIGIN: defaultHttpsOrigin, MITZO_REQUIRE_TLS: '1', PORT: '3100' },
        { release: { transport } },
      ),
    ).toThrow('port does not match PORT');
    expect(
      validateReleaseTransport(
        { MITZO_PUBLIC_ORIGIN: defaultHttpsOrigin, MITZO_REQUIRE_TLS: '1', PORT: '443' },
        { release: { transport } },
      ),
    ).toEqual(transport);
  });

  it('requires a matching, readable, unexpired certificate with the public hostname SAN', () => {
    const output = mkdtempSync(join(tmpdir(), 'mitzo-release-tls-'));
    try {
      writeFixtureTls(output);
      const config = { MITZO_PUBLIC_ORIGIN: releaseTransport.publicOrigin };
      expect(() =>
        verifyReleaseTls(config, { root: output, now: Date.parse('2026-09-20T00:00:00Z') }),
      ).not.toThrow();
      expect(() =>
        verifyReleaseTls(
          { MITZO_PUBLIC_ORIGIN: 'https://other-host.tail:3100' },
          { root: output, now: Date.parse('2026-09-20T00:00:00Z') },
        ),
      ).toThrow('SAN does not match');
      expect(() =>
        verifyReleaseTls(config, { root: output, now: Date.parse('2036-09-15T00:00:00Z') }),
      ).toThrow('expires too soon');
      writeFileSync(join(output, 'certs', 'cert.pem'), 'not a certificate');
      expect(() => verifyReleaseTls(config, { root: output })).toThrow('valid X.509 certificate');
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it('fails closed when TLS material is missing or the private key does not match', () => {
    const output = mkdtempSync(join(tmpdir(), 'mitzo-release-tls-mismatch-'));
    try {
      const config = { MITZO_PUBLIC_ORIGIN: releaseTransport.publicOrigin };
      expect(() => verifyReleaseTls(config, { root: output })).toThrow(
        'TLS certificate does not exist',
      );
      writeFixtureTls(output);
      const mismatchedPrivateKey = generateKeyPairSync('rsa', {
        modulusLength: 2048,
      }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      });
      writeFileSync(join(output, 'certs', 'key.pem'), mismatchedPrivateKey);
      expect(() => verifyReleaseTls(config, { root: output })).toThrow(
        'does not match the private key',
      );
      writeFileSync(join(output, 'certs', 'key.pem'), fixtureCertificate);
      expect(() => verifyReleaseTls(config, { root: output })).toThrow('valid private key');
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it('fails closed on the locked transport and rollback record even when OpenShell is disabled', () => {
    const output = mkdtempSync(join(tmpdir(), 'mitzo-disabled-preflight-'));
    const buildDir = join(output, 'dist');
    const manifestPath = join(output, 'stack-lock.json');
    const rollbackPath = join(output, 'rollback.json');
    const envPath = join(output, '.env');
    const accountsPath = join(output, 'accounts.json');
    const supervisorArtifact = 'disabled-mode supervisor fixture';
    const release = {
      mitzoSourceCommit: '17c1a346dccbf6b1ccb5eb1e938171efc330c24d',
      openshellCli: {
        identity: 'openshell',
        path: '/opt/homebrew/bin/openshell',
        version: '0.0.116-mitzo.2',
        sourceCommit: 'b4c459f92446167afcb0a2dcf7d9fa6c8945e59c',
      },
      gatewayService: 'sh.brew.openshell',
      podmanSupervisor: {
        launchdLabel: 'com.mitzo.podman-machine',
        artifactPath: 'infra/supervisor.plist',
        artifactSha256: createHash('sha256').update(supervisorArtifact).digest('hex'),
      },
      rollbackInputs: releaseRollbackInputs,
      transport: releaseTransport,
    };
    const lock = {
      schemaVersion: 1,
      runtime: { image: 'fixture', mgmtSourceCommit: releaseRollbackInputs.seed.startingCommit },
      policy: { sha256: releaseRollbackInputs.policy.sha256 },
      release,
    };
    const localIdentityRunCommand = (command: string, args: string[]) => {
      if (command === 'git' && args.includes('status')) return '';
      if (command === 'git') return release.mitzoSourceCommit;
      if (command === release.openshellCli.path && args[0] === '--version')
        return `OpenShell ${release.openshellCli.version}`;
      throw new Error(`unexpected live-service command: ${command} ${args.join(' ')}`);
    };
    const writeDisabledEnv = (overrides: Record<string, string> = {}) => {
      const values = {
        MITZO_OPENSHELL_ENABLED: '0',
        MITZO_OPENSHELL_STACK_MANIFEST: manifestPath,
        MITZO_OPENSHELL_ROLLBACK_RECORD: rollbackPath,
        MITZO_ACCOUNT_PROFILES_FILE: accountsPath,
        MITZO_OPENSHELL_CLI: release.openshellCli.path,
        MITZO_OPENSHELL_GATEWAY_SERVICE: release.gatewayService,
        MITZO_PUBLIC_ORIGIN: releaseTransport.publicOrigin,
        MITZO_REQUIRE_TLS: '1',
        PORT: '3100',
        ...overrides,
      };
      writeFileSync(
        envPath,
        Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n'),
      );
    };
    try {
      writeFixtureTls(output);
      writeFileSync(accountsPath, fixtureAccountProfiles);
      mkdirSync(join(output, 'infra'));
      writeFileSync(join(output, 'infra', 'supervisor.plist'), supervisorArtifact);
      writeFileSync(manifestPath, JSON.stringify(lock));
      const stackLockSha256 = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
      writeFileSync(
        rollbackPath,
        JSON.stringify({
          schemaVersion: 1,
          release: {
            stackLockSha256,
            mitzoSourceCommit: release.mitzoSourceCommit,
            openshellCli: release.openshellCli,
            gatewayService: release.gatewayService,
            podmanSupervisor: release.podmanSupervisor,
            runtime: lock.runtime,
            rollbackInputs: release.rollbackInputs,
          },
        }),
      );
      writeDisabledEnv();
      // The bundle is intentionally isolated from the lock and env fixture so
      // a lock value cannot satisfy the browser-origin check by itself.
      // `main` needs an existing output directory; an asset with the baked
      // origin is enough for this local transport-only preflight.
      mkdirSync(buildDir);
      writeFileSync(join(output, 'dist', 'app.js'), `origin=${releaseTransport.publicOrigin}`);
      const preflight = () =>
        main([envPath], {}, { buildDir, root: output, runCommand: localIdentityRunCommand });
      expect(preflight).not.toThrow();
      writeFileSync(accountsPath, JSON.stringify([{ id: 'replacement-profile' }]));
      expect(preflight).toThrow('account profiles hash does not match the stack lock');
      writeFileSync(accountsPath, fixtureAccountProfiles);
      writeDisabledEnv({ MITZO_REQUIRE_TLS: '0' });
      expect(preflight).toThrow('MITZO_REQUIRE_TLS=1');
      writeDisabledEnv({ MITZO_OPENSHELL_CLI: '/wrong/openshell' });
      expect(preflight).toThrow('CLI path');
      writeDisabledEnv({ MITZO_OPENSHELL_GATEWAY_SERVICE: 'wrong.service' });
      expect(preflight).toThrow('gateway service');
      writeDisabledEnv();
      expect(() =>
        main(
          [envPath],
          {},
          {
            buildDir,
            root: output,
            runCommand: (command: string, args: string[]) =>
              command === 'git' && args.includes('status') ? '' : 'wrong-checkout',
          },
        ),
      ).toThrow('checkout commit');
      expect(() =>
        main(
          [envPath],
          {},
          {
            buildDir,
            root: output,
            runCommand: (command: string, args: string[]) =>
              command === 'git'
                ? args.includes('status')
                  ? ''
                  : release.mitzoSourceCommit
                : 'OpenShell wrong-version',
          },
        ),
      ).toThrow('CLI identity or version');
      writeFileSync(join(output, 'infra', 'supervisor.plist'), 'tampered');
      expect(preflight).toThrow('supervisor artifact digest');
      writeFileSync(join(output, 'infra', 'supervisor.plist'), supervisorArtifact);
      writeFileSync(
        rollbackPath,
        JSON.stringify({
          schemaVersion: 1,
          release: {
            stackLockSha256: '0'.repeat(64),
            mitzoSourceCommit: release.mitzoSourceCommit,
            openshellCli: release.openshellCli,
            gatewayService: release.gatewayService,
            podmanSupervisor: release.podmanSupervisor,
            runtime: lock.runtime,
            rollbackInputs: release.rollbackInputs,
          },
        }),
      );
      expect(() => main([envPath], {}, { buildDir, root: output })).toThrow(
        'rollback record stack lock digest',
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it('requires a clean tracked checkout before checking release provenance', () => {
    const root = '/fixture/mitzo';
    const cleanCommands: Array<[string, string[]]> = [];
    expect(() =>
      verifyCleanTrackedWorktree({
        root,
        runCommand: (command: string, args: string[]) => {
          cleanCommands.push([command, args]);
          return '';
        },
      }),
    ).not.toThrow();
    expect(cleanCommands).toEqual([
      ['git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=no']],
    ]);

    for (const status of ['M  scripts/deploy.sh', ' M server/index.ts', 'UU package-lock.json']) {
      expect(() =>
        verifyCleanTrackedWorktree({
          root,
          runCommand: () => status,
        }),
      ).toThrow('checkout has tracked changes');
    }

    const release = { mitzoSourceCommit: 'a'.repeat(40) };
    expect(() =>
      verifyCheckoutReleaseProvenance(release, {
        root,
        runCommand: (command: string, args: string[]) => {
          if (command !== 'git') throw new Error(`unexpected command: ${command}`);
          if (args.includes('status')) return 'M  scripts/verify-openshell-production.mjs';
          throw new Error('provenance must not be read from a dirty checkout');
        },
      }),
    ).toThrow('checkout has tracked changes');
  });

  it('rejects every locally observable release identity mismatch without live services', () => {
    const output = mkdtempSync(join(tmpdir(), 'mitzo-release-identity-'));
    const artifactPath = join(output, 'infra', 'supervisor.plist');
    const artifact = 'podman supervisor fixture';
    const digest = createHash('sha256').update(artifact).digest('hex');
    const release = {
      mitzoSourceCommit: '17c1a346dccbf6b1ccb5eb1e938171efc330c24d',
      openshellCli: {
        identity: 'openshell',
        path: '/fixture/openshell',
        version: '0.0.116-mitzo.2',
        sourceCommit: 'b4c459f92446167afcb0a2dcf7d9fa6c8945e59c',
      },
      gatewayService: 'sh.brew.openshell',
      podmanSupervisor: {
        launchdLabel: 'com.mitzo.podman-machine',
        artifactPath: 'infra/supervisor.plist',
        artifactSha256: digest,
      },
      rollbackInputs: releaseRollbackInputs,
    };
    const manifest = {
      runtime: { mgmtSourceCommit: releaseRollbackInputs.seed.startingCommit },
      policy: { sha256: releaseRollbackInputs.policy.sha256 },
      release,
    };
    const config = {
      MITZO_OPENSHELL_CLI: release.openshellCli.path,
      MITZO_OPENSHELL_GATEWAY_SERVICE: release.gatewayService,
    };
    const runCommand = (command: string, args: string[]) => {
      if (command === 'git' && args.includes('status')) return '';
      if (command === 'git') return release.mitzoSourceCommit;
      if (command === release.openshellCli.path && args[0] === '--version') {
        return `OpenShell ${release.openshellCli.version}`;
      }
      throw new Error(`unexpected local command: ${command}`);
    };
    try {
      mkdirSync(join(output, 'infra'));
      writeFileSync(artifactPath, artifact);
      expect(() =>
        validateReleaseIdentity({
          ...manifest,
          release: {
            ...release,
            rollbackInputs: {
              ...release.rollbackInputs,
              policy: { ...release.rollbackInputs.policy, sha256: '0'.repeat(64) },
            },
          },
        }),
      ).toThrow('policy rollback reference');
      expect(() =>
        verifyLocalReleaseIdentity(config, manifest, { root: output, runCommand }),
      ).not.toThrow();
      expect(() =>
        verifyLocalReleaseIdentity(
          { ...config, MITZO_OPENSHELL_CLI: '/wrong/openshell' },
          manifest,
          { root: output, runCommand },
        ),
      ).toThrow('CLI path');
      expect(() =>
        verifyLocalReleaseIdentity(
          { ...config, MITZO_OPENSHELL_GATEWAY_SERVICE: 'wrong.service' },
          manifest,
          { root: output, runCommand },
        ),
      ).toThrow('gateway service');
      expect(() =>
        verifyLocalReleaseIdentity(config, manifest, {
          root: output,
          runCommand: (command: string, args: string[]) =>
            command === 'git' && args.includes('status') ? '' : 'wrong',
        }),
      ).toThrow('checkout commit');
      expect(() =>
        verifyLocalReleaseIdentity(config, manifest, {
          root: output,
          runCommand: (command: string, args: string[]) =>
            command === 'git'
              ? args.includes('status')
                ? ''
                : release.mitzoSourceCommit
              : 'OpenShell 0.0.115',
        }),
      ).toThrow('CLI identity or version');
      const metadataWrapper = 'f'.repeat(40);
      const metadataWrapperRunCommand = (command: string, args: string[]) => {
        if (command === release.openshellCli.path && args[0] === '--version') {
          return `OpenShell ${release.openshellCli.version}`;
        }
        if (command !== 'git') throw new Error(`unexpected local command: ${command}`);
        if (args.includes('status')) return '';
        if (args.includes('HEAD')) return metadataWrapper;
        if (args.includes(`${metadataWrapper}^`)) return release.mitzoSourceCommit;
        if (args.includes('diff-tree')) {
          return [
            'infra/openshell/production-stack.lock.json',
            'infra/openshell/rollback-record.json',
          ].join('\n');
        }
        throw new Error(`unexpected git command: ${args.join(' ')}`);
      };
      expect(() =>
        verifyLocalReleaseIdentity(config, manifest, {
          root: output,
          runCommand: metadataWrapperRunCommand,
        }),
      ).not.toThrow();
      expect(() =>
        verifyCheckoutReleaseProvenance(release, {
          root: output,
          runCommand: (command: string, args: string[]) => {
            if (command !== 'git') throw new Error(`unexpected command: ${command}`);
            if (args.includes('status')) return '';
            if (args.includes('HEAD')) return metadataWrapper;
            if (args.includes(`${metadataWrapper}^`)) return release.mitzoSourceCommit;
            return 'server/index.ts';
          },
        }),
      ).toThrow('metadata wrapper contains non-release-metadata changes');
      writeFileSync(artifactPath, 'tampered');
      expect(() =>
        verifyLocalReleaseIdentity(config, manifest, { root: output, runCommand }),
      ).toThrow('supervisor artifact digest');
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it('rejects a browser bundle that was built without the locked Tailnet origin', () => {
    const output = mkdtempSync(join(tmpdir(), 'mitzo-release-build-'));
    try {
      writeFileSync(join(output, 'app.js'), 'const origin = "http://localhost:3100";');
      expect(() => verifyBakedBrowserOrigin(releaseTransport.publicOrigin, output)).toThrow(
        'does not contain the locked HTTPS public origin',
      );
      writeFileSync(join(output, 'app.js'), `const origin = "${releaseTransport.publicOrigin}";`);
      expect(() => verifyBakedBrowserOrigin(releaseTransport.publicOrigin, output)).not.toThrow();
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it('keeps a complete, immutable record of the release to restore', () => {
    const lockPath = new URL('../../infra/openshell/production-stack.lock.json', import.meta.url);
    const lockSource = readFileSync(lockPath);
    const lock = JSON.parse(lockSource.toString());
    const rollback = JSON.parse(
      readFileSync(new URL('../../infra/openshell/rollback-record.json', import.meta.url), 'utf8'),
    );
    expect(rollback.release.stackLockSha256).toBe(
      createHash('sha256').update(lockSource).digest('hex'),
    );
    expect(rollback.release.mitzoSourceCommit).toBe(lock.release.mitzoSourceCommit);
    expect(rollback.release.openshellCli).toEqual(lock.release.openshellCli);
    expect(rollback.release.runtime).toEqual(lock.runtime);
    expect(rollback.release.podmanSupervisor).toEqual(lockedPodmanSupervisor);
    expect(rollback.release.rollbackInputs).toEqual(lock.release.rollbackInputs);
    const lockFixture = {
      ...lock,
      release: {
        ...lock.release,
        rollbackInputs: {
          ...lock.release.rollbackInputs,
          accountProfiles: {
            ...lock.release.rollbackInputs.accountProfiles,
            sha256: releaseRollbackInputs.accountProfiles.sha256,
          },
        },
      },
    };
    const rollbackFixture = {
      ...rollback,
      release: {
        ...rollback.release,
        rollbackInputs: lockFixture.release.rollbackInputs,
      },
    };
    expect(() =>
      validateRollbackRecord(lockFixture, rollbackFixture, rollback.release.stackLockSha256),
    ).not.toThrow();
    expect(() =>
      validateRollbackRecord(
        lockFixture,
        {
          ...rollbackFixture,
          release: {
            ...rollbackFixture.release,
            rollbackInputs: {
              ...rollbackFixture.release.rollbackInputs,
              seed: { ...rollbackFixture.release.rollbackInputs.seed, bundleId: 'other-seed' },
            },
          },
        },
        rollback.release.stackLockSha256,
      ),
    ).toThrow('rollback account, policy, or seed references');
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
