import { OwnedSymposiumConfigSchema } from '../symposium-owned-config-schema.js';
import { EventStore } from '../event-store.js';
import type { BootstrapTools } from '../symposium-owned-config.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapConfiguredSymposiumHost,
  readOwnedSymposiumHostConfig,
} from '../symposium-owned-config.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'symposium-owned-config-test-'));
  roots.push(root);
  const profile = join(root, 'codex.yaml');
  const policy = join(root, 'policy.yaml');
  writeFileSync(policy, 'mock policy', { mode: 0o600 });
  writeFileSync(profile, 'id: codex\n');
  const sha = 'a'.repeat(64);
  const ref = { provider: 'keychain', service: 'test-service', account: 'work' };
  const config = {
    gateway: {
      executable: '/private/gateway',
      executableSha256: sha,
      cliExecutable: '/private/cli',
      cliSha256: sha,
      stateParent: root,
      systemCaBundle: '/etc/ssl/cert.pem',
      gateway: 'owned',
      workspace: 'workspace',
      port: 18791,
      podmanSocket: '/private/socket',
      network: 'network',
      workloadImage: 'sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161',
      sandboxRuntimeImage: `sha256:${sha}`,
      supervisorImage: `sha256:${sha}`,
      tls: {
        serverCert: '/private/cert',
        serverKey: '/private/key',
        clientCa: '/private/ca',
        managementCert: '/private/client-cert',
        managementKey: '/private/client-key',
      },
      jwt: { signingKey: '/private/sign', publicKey: '/private/public', kid: '/private/kid' },
    },
    attestationPath: join(root, 'pending.json'),
    runtime: {
      policy,
      seed: '/private/seed',
      createDetached: true,
      sandboxIdLength: 13,
    },
    podman: {
      executable: '/bin/podman',
      environment: { HOME: root, PATH: '/usr/bin:/bin' },
      sandboxNamespace: 'namespace',
    },
    personal: {
      workProfiles: [
        {
          id: 'work',
          label: 'Work',
          provider: 'openai',
          credentialRef: ref,
          models: [{ id: 'luna', label: 'Luna' }],
        },
      ],
      accountId: 'personal',
      label: 'Personal',
      selectedModel: 'luna',
      models: [{ id: 'luna', label: 'Luna' }],
    },
    artifacts: [],
    providerProfiles: [
      { path: profile, sha256: createHash('sha256').update(readFileSync(profile)).digest('hex') },
    ],
  };
  const filename = join(root, 'host.json');
  const save = () => writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  save();
  const gateway = {
    cli: '/private/owned/cli',
    gateway: 'owned',
    workspace: 'workspace',
    endpoint: 'https://127.0.0.1:18791',
    stateDirectory: root,
    managementEnvironment: { HOME: root, XDG_CONFIG_HOME: root, PATH: '/usr/bin:/bin' },
    verifyCustody: vi.fn(),
    verifyGatewayDriverConfig: vi.fn(),
    stop: vi.fn(),
  };
  const tools = {
    launch: vi.fn().mockResolvedValue(gateway),
    run: vi.fn().mockReturnValue({ status: 0, stdout: 'configured' }),
    provisionWork: vi.fn().mockImplementation(async (_g, source) => ({
      ...source,
      sandboxProvider: 'new-owned-work',
      sandboxProviderId: 'new-id',
    })),
  };
  return { root, filename, config, save, gateway, tools };
}
describe('explicit private owned startup configuration', () => {
  it('plumbs only a constructor observer into the actual owned host, never persisted config', async () => {
    const f = fixture();
    const observer = vi.fn();
    const facts = new EventStore(join(f.root, 'constructor-events.db'));
    const host = await bootstrapConfiguredSymposiumHost(
      f.filename,
      {
        facts,
        hostGrants: { verifySeat: vi.fn() },
        observeDurableReviewToolResult: observer,
      },
      f.tools as unknown as BootstrapTools,
    );
    expect(host.observeDurableReviewToolResult).toBeTypeOf('function');
    expect(readOwnedSymposiumHostConfig(f.filename)).not.toHaveProperty(
      'observeDurableReviewToolResult',
    );
    host.pauseController();
    await expect(
      host.observeDurableReviewToolResult!({
        sessionId: 'session',
        claimToken: 'claim',
        deliveryId: 'delivery',
        seatId: 'reader',
        membershipGeneration: 1,
        providerThreadId: 'thread',
        providerTurnId: 'turn',
        callId: 'call',
        toolName: 'review',
        arguments: {},
        result: { content: '{}', isError: false },
      }),
    ).rejects.toThrow('no longer current');
    expect(observer).not.toHaveBeenCalled();
    host.stop();
    facts.close();
  });

  it('requires an explicit namespace but permits the exact empty Podman namespace', () => {
    const f = fixture();
    f.config.podman.sandboxNamespace = '';
    f.save();
    expect(readOwnedSymposiumHostConfig(f.filename).podman.sandboxNamespace).toBe('');
    delete (f.config.podman as Partial<typeof f.config.podman>).sandboxNamespace;
    f.save();
    expect(() => readOwnedSymposiumHostConfig(f.filename)).toThrow('private valid');
  });

  it('creates named workspace, imports hash-pinned private copies, then provisions fresh work', async () => {
    const f = fixture();
    const host = await bootstrapConfiguredSymposiumHost(
      f.filename,
      { facts: {} as never, hostGrants: { verifySeat: vi.fn() } },
      f.tools as never,
    );
    expect(f.tools.run.mock.calls[0][1]).toEqual([
      'workspace',
      '--gateway',
      'owned',
      'create',
      '--name',
      'workspace',
    ]);
    expect(f.tools.run.mock.calls[1][1]).toEqual([
      'profile',
      '--gateway',
      'owned',
      '--workspace',
      'workspace',
      'import',
      '--file',
      join(f.root, 'provider-profile-0.yaml'),
    ]);
    expect(f.tools.run.mock.calls[1][2].env).toEqual(f.gateway.managementEnvironment);
    expect(f.tools.provisionWork).toHaveBeenCalledOnce();
    expect(host.currentProfiles().resolve('work', 'luna').accountId).toBe('work');
    expect(
      host.currentProfiles().apiProfile(host.currentProfiles().resolve('work', 'luna'))
        .sandboxProviderId,
    ).toBe('new-id');
    host.stop();
  });
  it('fails before launch on changed profile bytes or unsafe config permissions', async () => {
    const f = fixture();
    writeFileSync(f.config.providerProfiles[0].path, 'changed');
    await expect(
      bootstrapConfiguredSymposiumHost(
        f.filename,
        { facts: {} as never, hostGrants: { verifySeat: vi.fn() } },
        f.tools as never,
      ),
    ).rejects.toThrow('digest');
    expect(f.tools.launch).not.toHaveBeenCalled();
    chmodSync(f.filename, 0o644);
    expect(() => readOwnedSymposiumHostConfig(f.filename)).toThrow('private valid');
  });
  it('rejects secret literals, inherited legacy provider IDs and arbitrary environment keys', () => {
    const f = fixture();
    const bad = f.config as unknown as Record<string, unknown>;
    bad.secret = 'not-allowed';
    f.save();
    expect(() => readOwnedSymposiumHostConfig(f.filename)).toThrow();
    delete bad.secret;
    Object.assign(f.config.personal.workProfiles[0], { sandboxProviderId: 'legacy' });
    f.save();
    expect(() => readOwnedSymposiumHostConfig(f.filename)).toThrow();
    delete (f.config.personal.workProfiles[0] as unknown as Record<string, unknown>)
      .sandboxProviderId;
    Object.assign(f.config.podman.environment, { OPENAI_API_KEY: 'never' });
    f.save();
    expect(() => readOwnedSymposiumHostConfig(f.filename)).toThrow();
  });
  it('does not publish host when profile setup fails and stops the newly owned gateway', async () => {
    const f = fixture();
    f.tools.run.mockReturnValue({ status: 1, stdout: 'unsafe internal detail' });
    await expect(
      bootstrapConfiguredSymposiumHost(
        f.filename,
        { facts: {} as never, hostGrants: { verifySeat: vi.fn() } },
        f.tools as never,
      ),
    ).rejects.toThrow('workspace/profile setup failed');
    expect(f.tools.provisionWork).not.toHaveBeenCalled();
    expect(f.gateway.stop).toHaveBeenCalledOnce();
  });
});
it('accepts explicit publication references and rejects inline credentials', () => {
  const f = fixture();
  const source = {
    id: 'operator-github',
    label: 'Operator GitHub',
    reference: { provider: 'keychain', service: 'publication', account: 'operator' },
  };
  writeFileSync(f.filename, JSON.stringify({ ...f.config, publicationCredentials: [source] }), {
    mode: 0o600,
  });
  expect(readOwnedSymposiumHostConfig(f.filename)).toMatchObject({
    publicationCredentials: [source],
  });
  writeFileSync(
    f.filename,
    JSON.stringify({
      ...f.config,
      publicationCredentials: [{ ...source, token: 'must-not-be-accepted' }],
    }),
    { mode: 0o600 },
  );
  expect(() => readOwnedSymposiumHostConfig(f.filename)).toThrow();
});

it('provisions explicit Vertex profiles through the existing bootstrap with pinned endpointless profile', async () => {
  const f = fixture();
  const vertex = {
    id: 'vertex-work',
    label: 'Vertex',
    provider: 'anthropic-vertex',
    credentialRef: join(f.root, 'selected-adc.json'),
    expectedPrincipal: 'selected@example.test',
    projectId: 'selected-project',
    region: 'global',
    models: [{ id: 'claude-haiku-4-5@20251001', label: 'Haiku' }],
  };
  (f.config.personal.workProfiles as unknown[]).push(vertex);
  const bytes = readFileSync(
    new URL('../../infra/openshell/providers/vertex-seat-endpointless.yaml', import.meta.url),
  );
  const path = join(f.root, 'vertex.yaml');
  writeFileSync(path, bytes);
  f.config.providerProfiles.push({
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  f.save();
  const provisionVertex = vi.fn(async (_gateway, input) => {
    const { expectedPrincipal, ...profile } = input;
    expect(expectedPrincipal).toBe(vertex.expectedPrincipal);
    return { ...profile, sandboxProvider: 'fresh-vertex', sandboxProviderId: 'vertex-id' };
  });
  const host = await bootstrapConfiguredSymposiumHost(
    f.filename,
    { facts: {} as never, hostGrants: { verifySeat: vi.fn() } },
    { ...f.tools, provisionVertex } as never,
  );
  expect(provisionVertex).toHaveBeenCalledWith(f.gateway, vertex);
  expect(host.currentProfiles().resolve('vertex-work', 'claude-haiku-4-5@20251001').provider).toBe(
    'anthropic-vertex',
  );
  expect(f.tools.provisionWork).toHaveBeenCalledTimes(1);
  host.stop();
});

it('rejects Vertex bootstrap without the exact endpointless profile before gateway launch', async () => {
  const f = fixture();
  (f.config.personal.workProfiles as unknown[]).push({
    id: 'vertex-work',
    label: 'Vertex',
    provider: 'anthropic-vertex',
    credentialRef: join(f.root, 'selected-adc.json'),
    expectedPrincipal: 'selected@example.test',
    projectId: 'selected-project',
    region: 'global',
    models: [{ id: 'claude-haiku-4-5@20251001', label: 'Haiku' }],
  });
  f.save();
  await expect(
    bootstrapConfiguredSymposiumHost(
      f.filename,
      { facts: {} as never, hostGrants: { verifySeat: vi.fn() } },
      f.tools as never,
    ),
  ).rejects.toThrow('endpointless');
  expect(f.tools.launch).not.toHaveBeenCalled();
});

it('rejects a later broad Vertex profile override before any gateway or credential work', async () => {
  const f = fixture();
  (f.config.personal.workProfiles as unknown[]).push({
    id: 'vertex-work',
    label: 'Vertex',
    provider: 'anthropic-vertex',
    credentialRef: join(f.root, 'selected-adc.json'),
    expectedPrincipal: 'selected@example.test',
    projectId: 'selected-project',
    region: 'global',
    models: [{ id: 'claude-haiku-4-5@20251001', label: 'Haiku' }],
  });
  for (const [name, bytes] of [
    [
      'endpointless',
      readFileSync(
        new URL('../../infra/openshell/providers/vertex-seat-endpointless.yaml', import.meta.url),
      ),
    ],
    ['broad', Buffer.from('id: google-vertex-ai\nendpoints: [{host: "*.googleapis.com"}]\n')],
  ] as const) {
    const path = join(f.root, name + '.yaml');
    writeFileSync(path, bytes);
    f.config.providerProfiles.push({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  f.save();
  await expect(
    bootstrapConfiguredSymposiumHost(
      f.filename,
      { facts: {} as never, hostGrants: { verifySeat: vi.fn() } },
      f.tools as never,
    ),
  ).rejects.toThrow('endpointless');
  expect(f.tools.launch).not.toHaveBeenCalled();
});

it('admits only the finite optional operator proxy configuration and rejects bypass/credential fields', () => {
  const f = fixture();
  const proxy = {
    url: 'https://proxy.example:18443',
    caBundle: '/absolute/public-ca.pem',
    caBundleSha256: 'a'.repeat(64),
  };
  const configured = (upstreamProxy: unknown) => ({
    ...f.config,
    gateway: { ...f.config.gateway, upstreamProxy },
  });
  expect(OwnedSymposiumConfigSchema.parse(configured(proxy)).gateway.upstreamProxy).toEqual(proxy);
  expect(OwnedSymposiumConfigSchema.parse(f.config).gateway.upstreamProxy).toBeUndefined();
  for (const invalid of [
    null,
    { ...proxy, url: 'http://user:password@proxy.example:18443' },
    { ...proxy, url: 'https://proxy.example:18443/path' },
    { ...proxy, caBundle: 'relative' },
    { ...proxy, caBundleSha256: 'bad' },
    { ...proxy, no_proxy: '*' },
    { ...proxy, proxy_auth_file: '/secret' },
  ])
    expect(OwnedSymposiumConfigSchema.safeParse(configured(invalid)).success).toBe(false);
});

it('admits only optional same-network operator supervisor selection in the private schema', () => {
  const f = fixture();
  const selected = (supervisorNetwork: unknown, network = f.config.gateway.network) => ({
    ...f.config,
    gateway: { ...f.config.gateway, network, supervisorNetwork },
  });
  expect(OwnedSymposiumConfigSchema.parse(selected('network')).gateway).toHaveProperty(
    'supervisorNetwork',
    'network',
  );
  expect(OwnedSymposiumConfigSchema.parse(f.config).gateway).not.toHaveProperty(
    'supervisorNetwork',
  );
  for (const value of [
    'foreign',
    null,
    '',
    'host',
    'none',
    'bridge',
    'private',
    'pasta',
    'slirp4netns',
    'container:other',
    '-bad',
    'with space',
    'a,b',
  ]) {
    expect(OwnedSymposiumConfigSchema.safeParse(selected(value)).success).toBe(false);
    if (typeof value === 'string' && value !== 'foreign')
      expect(OwnedSymposiumConfigSchema.safeParse(selected(value, value)).success).toBe(false);
  }
  expect(
    OwnedSymposiumConfigSchema.safeParse({ ...f.config, supervisorNetwork: 'network' }).success,
  ).toBe(false);
});
