import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { afterEach, expect, it, vi } from 'vitest';
const current = vi.hoisted(() => ({ source: vi.fn(), capture: vi.fn() }));
vi.mock('../staging-native-feature-bootstrap.js', () => ({
  captureOriginalStagingNativeBootstrap: current.capture,
}));
import {
  captureStagingVertexRefreshProfile,
  assertStagingVertexRefreshProfile,
  STAGING_VERTEX_PROFILE_SHA256,
  STAGING_VERTEX_AUTH_SCOPES,
} from '../staging-vertex-refresh-profile.js';
const bytes = () =>
  readFileSync(
    new URL(
      '../../infra/openshell/providers/staging-vertex-seat-endpointless.yaml',
      import.meta.url,
    ),
  );
const gateway = () => ({ workspace: 'fresh-stage-workspace', verifyCustody: vi.fn() });
afterEach(() => vi.resetAllMocks());
it('pins staging-only workspace profile bytes and the actual three-key Google refresh recipe', () => {
  expect(createHash('sha256').update(bytes()).digest('hex')).toBe(STAGING_VERTEX_PROFILE_SHA256);
  const profile = load(bytes().toString()) as {
    id: string;
    endpoints: unknown[];
    credentials: Array<{
      name: string;
      refresh?: { scopes: string[]; token_url: string; material: Array<{ name: string }> };
    }>;
  };
  expect(profile.id).toBe('google-vertex-ai');
  expect(profile.endpoints).toEqual([]);
  const recipe = profile.credentials.find((x) => x.name === 'gcloud_adc_token')!.refresh!;
  expect(recipe.scopes).toEqual(STAGING_VERTEX_AUTH_SCOPES);
  expect(recipe.token_url).toBe('https://oauth2.googleapis.com/token');
  expect(recipe.material.map((x) => x.name)).toEqual([
    'client_id',
    'client_secret',
    'refresh_token',
  ]);
});
it('refuses JSON bootstrap/profile copies and source-byte/default-workspace drift', () => {
  current.capture.mockImplementation(() => {
    throw Error('Missing original brand');
  });
  expect(() =>
    captureStagingVertexRefreshProfile(
      { bootstrap: {} as never, ownerInstance: 'owner' },
      gateway() as never,
      bytes(),
    ),
  ).toThrow('original brand');
  current.capture.mockReturnValue({ assertCurrent: current.source });
  for (const [workspace, input] of [
    ['default', bytes()],
    ['stage', Buffer.from('foreign source')],
  ] as const)
    expect(() =>
      captureStagingVertexRefreshProfile(
        { bootstrap: {} as never, ownerInstance: 'owner' },
        { workspace, verifyCustody: vi.fn() } as never,
        input,
      ),
    ).toThrow('reviewed staging');
  expect(() =>
    assertStagingVertexRefreshProfile(
      {
        profileId: 'google-vertex-ai',
        profileWorkspace: 'stage',
        profileSha256: STAGING_VERTEX_PROFILE_SHA256,
      },
      gateway() as never,
    ),
  ).toThrow('reviewed staging');
});
it('retains the exact original workspace port and rechecks both source and gateway at every use', () => {
  current.capture.mockReturnValue({ assertCurrent: current.source });
  const owner = gateway();
  const profile = captureStagingVertexRefreshProfile(
    { bootstrap: {} as never, ownerInstance: 'owner' },
    owner as never,
    bytes(),
  );
  assertStagingVertexRefreshProfile(profile, owner as never);
  expect(profile.profileWorkspace).toBe(owner.workspace);
  expect(() => assertStagingVertexRefreshProfile({ ...profile }, owner as never)).toThrow();
  expect(() => assertStagingVertexRefreshProfile(profile, { ...owner } as never)).toThrow();
  current.source.mockImplementation(() => {
    throw Error('Original source lost');
  });
  expect(() => assertStagingVertexRefreshProfile(profile, owner as never)).toThrow('source lost');
});

it('uses the original staging workspace and both authenticated scopes in actual provider-create argv', async () => {
  current.capture.mockReturnValue({ assertCurrent: current.source });
  const { GoogleAuth } = await import('google-auth-library');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createSymposiumWorkVertexProvider } =
    await import('../symposium-work-vertex-provider.js');
  const root = mkdtempSync(join(tmpdir(), 'stage-vertex-source-'));
  const owner = {
    ...gateway(),
    cli: '/fake/source-cli',
    gateway: 'fresh-stage',
    managementEnvironment: { HOME: root, XDG_CONFIG_HOME: root, PATH: '/usr/bin' },
  };
  const profile = captureStagingVertexRefreshProfile(
    { bootstrap: {} as never, ownerInstance: 'owner' },
    owner as never,
    bytes(),
  );
  const material = {
    type: 'authorized_user',
    client_id: 'fake-client',
    client_secret: 'fake-secret',
    refresh_token: 'fake-refresh',
  };
  const adc = join(root, 'fresh-stage-adc.json');
  writeFileSync(adc, JSON.stringify(material), { mode: 0o600 });
  const tokenInfo = vi.fn(async () => ({
    email: 'stage@example.test',
    email_verified: true,
    scopes: [...STAGING_VERTEX_AUTH_SCOPES],
  }));
  const scoped = vi.fn();
  const auth = vi.spyOn(GoogleAuth.prototype, 'fromJSON').mockImplementation(function (
    this: InstanceType<typeof GoogleAuth>,
  ) {
    scoped(this.scopes);
    return {
      transporter: { defaults: {} },
      getAccessToken: async () => ({ token: 'fake-stage-access' }),
      getTokenInfo: tokenInfo,
    } as never;
  });
  let name = '';
  const run = vi.fn((_file: string, args: string[]) => {
    if (args.includes('create')) name = args[args.indexOf('--name') + 1];
    return {
      status: 0,
      stdout: args.includes('list')
        ? JSON.stringify({
            providers: [
              { name, id: 'stage-id', workspace: owner.workspace, type: 'google-vertex-ai' },
            ],
            next_page_token: '',
          })
        : '',
    };
  });
  const account = {
    id: 'stage-vertex',
    label: 'Stage',
    provider: 'anthropic-vertex',
    credentialRef: adc,
    expectedPrincipal: 'stage@example.test',
    projectId: 'itpc-ca-638a2a9c7c',
    region: 'global',
    models: [{ id: 'claude-haiku-4-5@20251001', label: 'Haiku' }],
  };
  try {
    await createSymposiumWorkVertexProvider(owner as never, account, {
      stagingProfile: profile,
      run: run as never,
    });
    expect(scoped).toHaveBeenCalledWith([...STAGING_VERTEX_AUTH_SCOPES]);
    expect(run.mock.calls.find(([, args]) => args.includes('create'))![1]).toEqual(
      expect.arrayContaining(['--profile-workspace', owner.workspace]),
    );
    expect(tokenInfo).toHaveBeenCalledWith('fake-stage-access');
    run.mockClear();
    tokenInfo.mockResolvedValue({
      email: 'stage@example.test',
      email_verified: true,
      scopes: [STAGING_VERTEX_AUTH_SCOPES[0]],
    });
    await expect(
      createSymposiumWorkVertexProvider(owner as never, account, {
        stagingProfile: profile,
        run: run as never,
      }),
    ).rejects.toThrow('Vertex provisioning unavailable');
    expect(run).not.toHaveBeenCalled();
  } finally {
    auth.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
