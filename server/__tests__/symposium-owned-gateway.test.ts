import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SymposiumHostIssuer } from '../symposium-host-issuer.js';
import {
  OwnedSymposiumGateway,
  type OwnedSymposiumGatewayOptions,
} from '../symposium-owned-gateway.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'symposium-owned-test-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const file = (name: string) => {
    const path = join(root, name);
    writeFileSync(path, name, { mode: 0o600 });
    return path;
  };
  const executable = file('binary');
  const options: OwnedSymposiumGatewayOptions = {
    executable,
    systemCaBundle: file('system-ca'),
    cliExecutable: executable,
    cliSha256: createHash('sha256').update('binary').digest('hex'),
    executableSha256: createHash('sha256').update('binary').digest('hex'),
    stateParent: root,
    gateway: 'dedicated',
    workspace: 'symposium',
    port: 18790,
    podmanSocket: '/tmp/podman.sock',
    network: 'symposium',
    workloadImage: `sha256:${'a'.repeat(64)}`,
    sandboxRuntimeImage: `sha256:${'b'.repeat(64)}`,
    supervisorImage: `sha256:${'c'.repeat(64)}`,
    tls: {
      serverCert: file('server-cert'),
      serverKey: file('server-key'),
      clientCa: file('ca'),
      managementCert: file('client-cert'),
      managementKey: file('client-key'),
    },
    jwt: { signingKey: file('jwt-key'), publicKey: file('jwt-pub'), kid: file('jwt-kid') },
  };
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  }) as unknown as ChildProcess;
  const issuer = {
    url: 'https://127.0.0.1:19000',
    assertLive: vi.fn(),
    onLoss: vi.fn(),
    stop: vi.fn(),
    tokenBundle: vi.fn(() => ({
      access_token: 'host-only',
      expires_at: Math.floor(Date.now() / 1000) + 300,
      issuer: 'https://127.0.0.1:19000',
      client_id: 'symposium-host',
    })),
  };
  const operations = {
    startIssuer: vi.fn(async () => issuer as unknown as SymposiumHostIssuer),
    check: vi.fn<(executable: string, args: string[], env: NodeJS.ProcessEnv) => void>(),
    start: vi.fn<(executable: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess>(
      () => child,
    ),
    listenerPid: vi.fn<() => number | null>().mockReturnValueOnce(null).mockReturnValue(4321),
  };
  return { options, child, operations };
}

describe('owned upstream gateway evidence', () => {
  it('runs the same private config with a scrubbed environment and proves process plus listener identity', async () => {
    const { options, operations } = fixture();
    const previous = process.env.OPENSHELL_DISABLE_TLS;
    process.env.OPENSHELL_DISABLE_TLS = 'true';
    try {
      const owned = await OwnedSymposiumGateway.launch(options, operations);
      const [executable, args, env] = operations.start.mock.calls[0];
      expect(executable).not.toBe(options.executable);
      expect(env.OPENSHELL_DISABLE_TLS).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual([
        'HOME',
        'PATH',
        'SSL_CERT_FILE',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_STATE_HOME',
      ]);
      expect(operations.check).toHaveBeenCalledWith(
        executable,
        ['config', 'preflight', '--', ...args],
        env,
      );
      const config = readFileSync(args[1], 'utf8');
      expect(config).toContain('allow_driver_config = true');
      expect(config).toContain('enable_bind_mounts = false');
      expect(config).toContain('[openshell.gateway.mtls_auth]\nenabled = false');
      expect(config).toContain('allow_unauthenticated_users = false');
      expect(config).toContain('guest_tls_key');
      expect(config).toContain('[openshell.gateway.oidc]');
      expect(owned.managementEnvironment).not.toHaveProperty('SSL_CERT_FILE');
      expect(() =>
        owned.verifyGatewayDriverConfig('dedicated', 'symposium', 'podman'),
      ).not.toThrow();
      expect(() => owned.verifyGatewayDriverConfig('other', 'symposium', 'podman')).toThrow();
      expect(() => owned.verifyGatewayDriverConfig('dedicated', 'symposium', 'docker')).toThrow();
      owned.stop();
      expect(() => owned.verifyGatewayDriverConfig('dedicated', 'symposium', 'podman')).toThrow(
        /no longer live/,
      );
    } finally {
      if (previous === undefined) delete process.env.OPENSHELL_DISABLE_TLS;
      else process.env.OPENSHELL_DISABLE_TLS = previous;
    }
  });

  it.each(['config', 'binary', 'tls', 'mode', 'listener', 'exit'] as const)(
    'rejects %s drift',
    async (drift) => {
      const { options, operations, child } = fixture();
      const owned = await OwnedSymposiumGateway.launch(options, operations);
      const [executable, args] = operations.start.mock.calls[0];
      if (drift === 'config' || drift === 'binary' || drift === 'tls') {
        const path =
          drift === 'config'
            ? args[1]
            : drift === 'binary'
              ? executable
              : join(owned.stateDirectory, 'serverKey.pem');
        chmodSync(path, 0o600);
        writeFileSync(path, 'changed');
        chmodSync(path, drift === 'binary' ? 0o500 : 0o400);
      } else if (drift === 'mode') chmodSync(args[1], 0o600);
      else if (drift === 'listener') operations.listenerPid.mockReturnValue(9999);
      else child.emit('exit', 0);
      expect(() => owned.verifyGatewayDriverConfig('dedicated', 'symposium', 'podman')).toThrow();
    },
  );

  it('refuses occupied endpoints, changed binaries, and mutable image tags before spawning', async () => {
    for (const reason of ['port', 'binary', 'image']) {
      const { options, operations } = fixture();
      if (reason === 'port') operations.listenerPid.mockReset().mockReturnValue(1234);
      if (reason === 'binary') options.executableSha256 = '0'.repeat(64);
      if (reason === 'image') options.workloadImage = 'runtime:latest';
      await expect(OwnedSymposiumGateway.launch(options, operations)).rejects.toThrow();
      expect(operations.start).not.toHaveBeenCalled();
    }
  });

  it('does not spawn after failed upstream preflight and stops on mismatched listener ownership', async () => {
    const first = fixture();
    first.operations.check.mockImplementation(() => {
      throw new Error('bad config');
    });
    await expect(OwnedSymposiumGateway.launch(first.options, first.operations)).rejects.toThrow(
      'bad config',
    );
    expect(first.operations.start).not.toHaveBeenCalled();
    const second = fixture();
    second.operations.listenerPid.mockReset().mockReturnValueOnce(null).mockReturnValue(9999);
    await expect(OwnedSymposiumGateway.launch(second.options, second.operations)).rejects.toThrow(
      /different process/,
    );
    expect(second.child.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('binds native capability to the exact launched binaries, image references, and private CLI route', async () => {
    const { options, operations } = fixture();
    const owned = await OwnedSymposiumGateway.launch(options, operations);
    const binding = {
      cli: owned.cli,
      cliEnvironment: owned.managementEnvironment,
      cliSha256: options.cliSha256,
      gatewaySha256: options.executableSha256,
      gateway: owned.gateway,
      workspace: owned.workspace,
      gatewayEndpoint: owned.endpoint,
      image: options.workloadImage,
      sandboxRuntimeImage: options.sandboxRuntimeImage,
      supervisorImage: options.supervisorImage,
    };
    expect(() => owned.verifyOwnedNativeHost(binding)).not.toThrow();
    for (const key of [
      'cliSha256',
      'gatewaySha256',
      'image',
      'sandboxRuntimeImage',
      'supervisorImage',
      'cli',
      'gatewayEndpoint',
    ] as const)
      expect(() => owned.verifyOwnedNativeHost({ ...binding, [key]: 'changed' })).toThrow();
    expect(() =>
      owned.verifyOwnedNativeHost({
        ...binding,
        cliEnvironment: { ...binding.cliEnvironment, HOME: '/other' },
      }),
    ).toThrow('environment changed');
    options.supervisorImage = `sha256:${'d'.repeat(64)}`;
    expect(() => owned.verifyOwnedNativeHost(binding)).not.toThrow();
    owned.stop();
    expect(() => owned.verifyOwnedNativeHost(binding)).toThrow();
  });
});
