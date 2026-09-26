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
      workloadImage: `sha256:${sha}`,
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
      policy: '/private/policy',
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
