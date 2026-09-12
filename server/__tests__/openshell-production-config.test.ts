import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  hasExactGlobalSetting,
  validateStaticConfig,
  verifyAccountBindings,
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
