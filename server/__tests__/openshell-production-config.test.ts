import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasExactGlobalSetting,
  loadProductionConfig,
  validateStaticConfig,
  verifyAccountBindings,
  verifyOpenAiHeaderAuthentication,
} from '../../scripts/verify-openshell-production.mjs';

const manifest = {
  runtime: { image: 'localhost/mitzo:release-1' },
  defaults: { workspace: 'default', webSearch: 'live' },
  serviceProviders: [{ name: 'google-workspace' }, { name: 'github' }],
  providerPolicy: { automatic: ['github'], grantable: ['google-workspace'] },
};

const config = {
  MITZO_OPENSHELL_ENABLED: '1',
  MITZO_OPENSHELL_IMAGE: 'localhost/mitzo:release-1',
  MITZO_OPENSHELL_SERVICE_PROVIDERS: 'github',
  MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS: 'google-workspace',
  MITZO_OPENSHELL_WEB_SEARCH: 'live',
  OPENSHELL_WORKSPACE: 'default',
};

describe('OpenShell production bundle validation', () => {
  const headerProfile = {
    credentials: [
      { env_vars: ['OPENAI_API_KEY'], auth_style: 'bearer', header_name: 'authorization' },
    ],
    endpoints: [
      {
        host: 'api.openai.com',
        port: 443,
        protocol: 'rest',
        enforcement: 'enforce',
        request_body_credential_rewrite: false,
        allow_uninspected_credentials: false,
      },
    ],
  };

  it('accepts inspected OpenAI header authentication without body substitution', () => {
    expect(() => verifyOpenAiHeaderAuthentication(headerProfile)).not.toThrow();
  });

  it.each(['request_body_credential_rewrite', 'allow_uninspected_credentials'])(
    'rejects live OpenAI profile drift enabling %s',
    (flag) => {
      const profile = {
        ...headerProfile,
        endpoints: [{ ...headerProfile.endpoints[0], [flag]: true }],
      };
      expect(() => verifyOpenAiHeaderAuthentication(profile)).toThrow(/OpenAI/);
    },
  );

  it.each(['request_body_credential_rewrite', 'allow_uninspected_credentials'])(
    'rejects live OpenAI profile drift omitting %s',
    (flag) => {
      const endpoint: Record<string, unknown> = { ...headerProfile.endpoints[0] };
      delete endpoint[flag];
      expect(() =>
        verifyOpenAiHeaderAuthentication({ ...headerProfile, endpoints: [endpoint] }),
      ).toThrow(/OpenAI/);
    },
  );

  it('rejects missing bearer-header metadata and non-inspected endpoints', () => {
    expect(() => verifyOpenAiHeaderAuthentication({ ...headerProfile, credentials: [] })).toThrow(
      /OpenAI/,
    );
    expect(() => verifyOpenAiHeaderAuthentication({ ...headerProfile, endpoints: [] })).toThrow(
      /OpenAI/,
    );
    expect(() =>
      verifyOpenAiHeaderAuthentication({
        ...headerProfile,
        endpoints: [{ ...headerProfile.endpoints[0], protocol: 'tcp' }],
      }),
    ).toThrow(/OpenAI/);
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

  it('makes the release env authoritative over inherited deploy variables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mitzo-release-env-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'MITZO_OPENSHELL_IMAGE=release-image\n');

    expect(
      loadProductionConfig(envPath, { MITZO_OPENSHELL_IMAGE: 'stale-shell-image' })
        .MITZO_OPENSHELL_IMAGE,
    ).toBe('release-image');
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

  it('keeps release creation serialized, remote-complete, and atomic', () => {
    const release = readFileSync(
      new URL('../../scripts/create-release.sh', import.meta.url),
      'utf8',
    );
    expect(release).toContain('+refs/heads/*:refs/remotes/origin/*');
    expect(release).toContain('canonical runtime .env is missing');
    expect(release).toContain('shlock -f "$LOCK_FILE" -p "$$"');
    expect(release).toContain('mktemp -d "$RELEASE_ROOT/.build.XXXXXX"');
    expect(release).toContain(
      'MITZO_OPENSHELL_STACK_MANIFEST "$FINAL_RELEASE_DIR/infra/openshell/production-stack.lock.json"',
    );
    expect(release.indexOf('node scripts/verify-openshell-production.mjs .env')).toBeLessThan(
      release.indexOf(
        'MITZO_OPENSHELL_STACK_MANIFEST "$FINAL_RELEASE_DIR/infra/openshell/production-stack.lock.json"',
      ),
    );
    expect(release.indexOf('mv "$RELEASE_DIR" "$FINAL_RELEASE_DIR"')).toBeGreaterThan(
      release.indexOf('node scripts/verify-openshell-production.mjs .env'),
    );
  });
});
