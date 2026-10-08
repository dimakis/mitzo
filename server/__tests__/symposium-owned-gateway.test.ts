import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  lstatSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
function fixture(
  san = 'DNS:localhost,IP:127.0.0.1,DNS:host.containers.internal',
  ca: boolean | 'leaf' = false,
) {
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
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      `subjectAltName=${san}`,
      ...(ca
        ? [
            '-addext',
            `basicConstraints=critical,CA:${ca === true ? 'TRUE' : 'FALSE'}`,
            '-addext',
            ca === true
              ? 'keyUsage=critical,keyCertSign,cRLSign'
              : 'keyUsage=critical,digitalSignature',
          ]
        : []),
      '-keyout',
      options.tls.serverKey,
      '-out',
      options.tls.serverCert,
    ],
    { stdio: 'ignore' },
  );
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
    stopAndWait: vi.fn(async () => {}),
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
  return { options, child, issuer, operations };
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

it('rejects localhost-only certificates before starting gateway or issuer', async () => {
  const { options, operations } = fixture('DNS:localhost,IP:127.0.0.1');
  await expect(OwnedSymposiumGateway.launch(options, operations)).rejects.toThrow(
    'host.containers.internal',
  );
  expect(operations.start).not.toHaveBeenCalled();
  expect(operations.startIssuer).not.toHaveBeenCalled();
});
it('requires an IP SAN for the host issuer', async () => {
  const { options, operations } = fixture('DNS:localhost,DNS:host.containers.internal');
  await expect(OwnedSymposiumGateway.launch(options, operations)).rejects.toThrow('127.0.0.1');
  expect(operations.start).not.toHaveBeenCalled();
});

it('does not accept a wildcard guest SAN', async () => {
  const { options, operations } = fixture('DNS:*.containers.internal,IP:127.0.0.1');
  await expect(OwnedSymposiumGateway.launch(options, operations)).rejects.toThrow(
    'host.containers.internal',
  );
  expect(operations.start).not.toHaveBeenCalled();
});

it('async custody verifies files and process again after asynchronous listener observation', async () => {
  const f = fixture();
  let complete!: (pid: number) => void;
  const operations = {
    ...f.operations,
    listenerPidAsync: vi.fn(
      () =>
        new Promise<number>((resolve) => {
          complete = resolve;
        }),
    ),
  };
  const gateway = await OwnedSymposiumGateway.launch(f.options, operations);
  try {
    const pending = gateway.verifyCustodyAsync();
    const rejected = expect(pending).rejects.toThrow('no longer live');
    await vi.waitFor(() => expect(operations.listenerPidAsync).toHaveBeenCalledTimes(1));
    Object.assign(f.child, { exitCode: 1 });
    complete(4321);
    await rejected;
    expect(operations.listenerPidAsync).toHaveBeenCalledTimes(1);
  } finally {
    gateway.stop();
  }
});

it('rechecks full async custody after an owned token rotation during listener observation', async () => {
  const f = fixture();
  let complete!: (pid: number) => void;
  const listenerPidAsync = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue(4321);
  const gateway = await OwnedSymposiumGateway.launch(f.options, {
    ...f.operations,
    listenerPidAsync,
  });
  try {
    const pending = gateway.verifyCustodyAsync();
    await vi.waitFor(() => expect(listenerPidAsync).toHaveBeenCalledTimes(1));
    f.issuer.tokenBundle.mockReturnValue({
      access_token: 'rotated-host-only',
      expires_at: Math.floor(Date.now() / 1000) + 300,
      issuer: f.issuer.url,
      client_id: 'symposium-host',
    });
    (gateway as unknown as { refreshManagementToken(): void }).refreshManagementToken();
    complete(4321);
    await expect(pending).resolves.toBeUndefined();
    expect(listenerPidAsync).toHaveBeenCalledTimes(2);
  } finally {
    gateway.stop();
  }
});

it('still rejects static launch-material drift when an owned token rotates', async () => {
  const f = fixture();
  let complete!: (pid: number) => void;
  const listenerPidAsync = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue(4321);
  const gateway = await OwnedSymposiumGateway.launch(f.options, {
    ...f.operations,
    listenerPidAsync,
  });
  try {
    const pending = gateway.verifyCustodyAsync();
    const rejected = expect(pending).rejects.toThrow('Owned gateway launch material changed');
    await vi.waitFor(() => expect(listenerPidAsync).toHaveBeenCalledTimes(1));
    f.issuer.tokenBundle.mockReturnValue({
      access_token: 'rotated-host-only',
      expires_at: Math.floor(Date.now() / 1000) + 300,
      issuer: f.issuer.url,
      client_id: 'symposium-host',
    });
    (gateway as unknown as { refreshManagementToken(): void }).refreshManagementToken();
    const [, args] = f.operations.start.mock.calls[0];
    chmodSync(args[1], 0o600);
    writeFileSync(args[1], 'changed');
    chmodSync(args[1], 0o400);
    complete(4321);
    await rejected;
    expect(listenerPidAsync).toHaveBeenCalledTimes(1);
  } finally {
    gateway.stop();
  }
});

it('awaits exact gateway child exit and issuer shutdown rather than accepting SIGTERM as proof', async () => {
  const f = fixture();
  const gateway = await OwnedSymposiumGateway.launch(f.options, f.operations);
  let complete = false;
  const pending = gateway.stopAndWait(new AbortController().signal).then(() => {
    complete = true;
  });
  await Promise.resolve();
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(complete).toBe(false);
  Object.assign(f.child, { exitCode: 0 });
  f.child.emit('exit', 0, null);
  await pending;
  expect(complete).toBe(true);
});

it('reports aborted child-exit observation as incomplete and removes the waiter', async () => {
  const f = fixture();
  const gateway = await OwnedSymposiumGateway.launch(f.options, f.operations);
  const controller = new AbortController();
  const before = f.child.listenerCount('exit');
  const pending = gateway.stopAndWait(controller.signal);
  const rejected = expect(pending).rejects.toThrow('deadline');
  controller.abort(new Error('deadline'));
  await rejected;
  expect(f.child.listenerCount('exit')).toBe(before);
  expect(f.child.exitCode).toBeNull();
});

describe('trusted owned upstream proxy configuration', () => {
  it('preserves exact frozen public and private modes under restrictive umask', async () => {
    const f = fixture(undefined, true);
    const ca = readFileSync(f.options.tls.serverCert);
    f.options.upstreamProxy = {
      url: 'http://proxy.example:18443',
      caBundle: f.options.tls.serverCert,
      caBundleSha256: createHash('sha256').update(ca).digest('hex'),
    };
    const previous = process.umask(0o077);
    try {
      const owned = await OwnedSymposiumGateway.launch(f.options, f.operations);
      expect(lstatSync(join(owned.stateDirectory, 'upstream-proxy-ca.pem')).mode & 0o777).toBe(
        0o444,
      );
      expect(lstatSync(owned.stateDirectory).mode & 0o777).toBe(0o700);
      for (const name of Object.keys(f.options.tls))
        expect(lstatSync(join(owned.stateDirectory, `${name}.pem`)).mode & 0o777).toBe(0o400);
      for (const name of Object.keys(f.options.jwt))
        expect(lstatSync(join(owned.stateDirectory, `${name}.jwt`)).mode & 0o777).toBe(0o400);
      expect(() => owned.verifyCustody()).not.toThrow();
      owned.stop();
    } finally {
      process.umask(previous);
    }
  });
  it('freezes the pinned public CA and writes only source-supported proxy fields', async () => {
    const f = fixture(undefined, true);
    const ca = readFileSync(f.options.tls.serverCert);
    f.options.upstreamProxy = {
      url: 'http://proxy.example:18443',
      caBundle: f.options.tls.serverCert,
      caBundleSha256: createHash('sha256').update(ca).digest('hex'),
    };
    const owned = await OwnedSymposiumGateway.launch(f.options, f.operations);
    const config = readFileSync(f.operations.start.mock.calls[0][1][1], 'utf8');
    expect(config).toContain('https_proxy = "http://proxy.example:18443"');
    const frozen = join(owned.stateDirectory, 'upstream-proxy-ca.pem');
    expect(config).toContain(`proxy_ca_bundle = ${JSON.stringify(frozen)}`);
    expect(readFileSync(frozen)).toEqual(ca);
    // A public-only CA file bind must be readable by the distinct supervisor UID.
    expect(lstatSync(frozen).mode & 0o777).toBe(0o444);
    expect(lstatSync(owned.stateDirectory).mode & 0o777).toBe(0o700);
    for (const name of Object.keys(f.options.tls))
      expect(lstatSync(join(owned.stateDirectory, `${name}.pem`)).mode & 0o777).toBe(0o400);
    for (const name of Object.keys(f.options.jwt))
      expect(lstatSync(join(owned.stateDirectory, `${name}.jwt`)).mode & 0o777).toBe(0o400);
    for (const drift of [0o400, 0o600]) {
      chmodSync(frozen, drift);
      expect(() => owned.verifyCustody()).toThrow();
      chmodSync(frozen, 0o444);
      expect(() => owned.verifyCustody()).not.toThrow();
    }
    expect(config).toContain('enable_bind_mounts = false');
    expect(config).not.toMatch(/no_proxy|proxy_auth_file|proxy_connect_by_hostname|insecure/);
    writeFileSync(f.options.tls.serverCert, 'changed original source');
    expect(() => owned.verifyCustody()).not.toThrow();
    chmodSync(frozen, 0o600);
    writeFileSync(frozen, 'changed owned copy');
    chmodSync(frozen, 0o400);
    expect(() => owned.verifyCustody()).toThrow();
    owned.stop();
  });
  it.each([
    'http://user:secret@proxy.example:18443',
    'http://proxy.example:18443/path',
    'http://proxy.example:18443?token=x',
    'http://proxy.example:18443#x',
    'http://proxy.example',
    'socks5://proxy.example:18443',
  ])('rejects unsupported proxy URI before issuer or gateway start: %s', async (url) => {
    const f = fixture(undefined, true);
    f.options.upstreamProxy = {
      url,
      caBundle: f.options.tls.serverCert,
      caBundleSha256: createHash('sha256')
        .update(readFileSync(f.options.tls.serverCert))
        .digest('hex'),
    };
    await expect(OwnedSymposiumGateway.launch(f.options, f.operations)).rejects.toThrow();
    expect(f.operations.startIssuer).not.toHaveBeenCalled();
    expect(f.operations.start).not.toHaveBeenCalled();
  });
  it('rejects changed CA digest before issuer or gateway start', async () => {
    const f = fixture(undefined, true);
    f.options.upstreamProxy = {
      url: 'https://proxy.example:18443',
      caBundle: f.options.tls.serverCert,
      caBundleSha256: '0'.repeat(64),
    };
    await expect(OwnedSymposiumGateway.launch(f.options, f.operations)).rejects.toThrow();
    expect(f.operations.startIssuer).not.toHaveBeenCalled();
  });
});

it.each(['leaf', 'expired', 'symlink', 'hardlink', 'oversized', 'private-key'] as const)(
  'rejects unsafe proxy CA %s before effects',
  async (kind) => {
    const f = fixture(undefined, kind === 'leaf' ? 'leaf' : true);
    let caBundle = f.options.tls.serverCert;
    if (kind === 'symlink' || kind === 'hardlink') {
      caBundle = join(f.options.stateParent, 'alias.pem');
      if (kind === 'symlink') symlinkSync(f.options.tls.serverCert, caBundle);
      else linkSync(f.options.tls.serverCert, caBundle);
    }
    if (kind === 'oversized') writeFileSync(caBundle, Buffer.alloc(128 * 1024 + 1));
    if (kind === 'private-key') caBundle = f.options.tls.serverKey;
    f.options.upstreamProxy = {
      url: 'https://proxy.example:18443',
      caBundle,
      caBundleSha256: createHash('sha256').update(readFileSync(caBundle)).digest('hex'),
    };
    const clock =
      kind === 'expired'
        ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 86400000)
        : undefined;
    try {
      await expect(OwnedSymposiumGateway.launch(f.options, f.operations)).rejects.toThrow();
      expect(f.operations.startIssuer).not.toHaveBeenCalled();
      expect(f.operations.start).not.toHaveBeenCalled();
    } finally {
      clock?.mockRestore();
    }
  },
);

describe('trusted paired-supervisor network selection', () => {
  it.each([undefined, 'symposium'])(
    'emits the selector only for explicit same-network opt-in: %s',
    async (supervisorNetwork) => {
      const f = fixture();
      const owned = await OwnedSymposiumGateway.launch(
        { ...f.options, supervisorNetwork },
        f.operations,
      );
      const config = readFileSync(f.operations.start.mock.calls[0][1][1], 'utf8');
      expect(config).toContain('network_name = "symposium"');
      if (supervisorNetwork === undefined) expect(config).not.toContain('supervisor_network_name');
      else expect(config).toContain('supervisor_network_name = "symposium"');
      expect(config).toContain('enable_bind_mounts = false');
      expect(() => owned.verifyCustody()).not.toThrow();
      owned.stop();
    },
  );
  it.each([
    'foreign',
    'host',
    'none',
    'bridge',
    'private',
    'pasta',
    'slirp4netns',
    'container:other',
    '',
    '-bad',
    'with space',
    'a,b',
  ])(
    'rejects invalid or foreign selection before issuer/process launch: %s',
    async (supervisorNetwork) => {
      const f = fixture();
      const options = {
        ...f.options,
        supervisorNetwork,
        network: supervisorNetwork === 'foreign' ? 'symposium' : supervisorNetwork,
      };
      await expect(OwnedSymposiumGateway.launch(options, f.operations)).rejects.toThrow();
      expect(f.operations.startIssuer).not.toHaveBeenCalled();
      expect(f.operations.start).not.toHaveBeenCalled();
    },
  );
});

// Source-shaped creation hook: baseline launch silently ignores this argument.
it('retains the exact newly created gateway before listener discovery', async () => {
  const { options, operations, child } = fixture();
  const record = vi.fn((role, original, current) => {
    expect(role).toBe('gateway');
    expect(original).toBe(child);
    expect(operations.listenerPid).toHaveBeenCalledTimes(1); // Existing preflight vacant-port check only.
    current();
  });
  const owner = await OwnedSymposiumGateway.launch(options, operations, record);
  expect(record).toHaveBeenCalledTimes(1);
  owner.stop();
});

it('fences the original gateway if its creation journal cannot be retained', async () => {
  const { options, operations, child, issuer } = fixture();
  await expect(
    OwnedSymposiumGateway.launch(options, operations, () => {
      throw Error('original journal uncertain');
    }),
  ).rejects.toThrow('original journal uncertain');
  expect(child.kill).toHaveBeenCalled();
  expect(issuer.stop).toHaveBeenCalled();
});
