import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { SymposiumOwnedNativeHostBinding } from './symposium-production-gate.js';
import { SymposiumHostIssuer } from './symposium-host-issuer.js';
import type { ArtifactDriverConfig, ArtifactLeaseRequest } from './symposium-artifact-lease.js';

const id = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const image = /^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/;

export interface OwnedSymposiumGatewayOptions {
  executable: string;
  executableSha256: string;
  cliExecutable: string;
  cliSha256: string;
  /** Reviewed public roots for provider HTTPS, combined with the private issuer CA. */
  systemCaBundle: string;
  /** Host-owned, private parent directory. Each launch allocates new isolated state. */
  stateParent: string;
  gateway: string;
  workspace: string;
  port: number;
  podmanSocket: string;
  network: string;
  workloadImage: string;
  sandboxRuntimeImage: string;
  supervisorImage: string;
  /** Provisioned TLS material is copied into the private launch directory. */
  tls: {
    serverCert: string;
    serverKey: string;
    clientCa: string;
    managementCert: string;
    managementKey: string;
  };
  /** JWTs authenticate supervisors without issuing them management certificates. */
  jwt: { signingKey: string; publicKey: string; kid: string };
}

interface HostOperations {
  check(executable: string, args: string[], env: NodeJS.ProcessEnv): void;
  start(executable: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess;
  listenerPid(port: number): number | null;
  startIssuer(cert: Buffer, key: Buffer): Promise<SymposiumHostIssuer>;
}
const host: HostOperations = {
  startIssuer: (cert, key) => SymposiumHostIssuer.start(cert, key),
  check(executable, args, env) {
    const result = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 15_000 });
    if (result.error || result.status !== 0)
      throw new Error('Owned gateway configuration preflight failed');
  },
  start(executable, args, env) {
    return spawn(executable, args, { env, stdio: 'ignore', detached: false });
  },
  listenerPid(port) {
    const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (result.error) throw new Error('Owned gateway listener inspection unavailable');
    if (result.status === 1 && !result.stdout) return null;
    if (result.status !== 0) throw new Error('Owned gateway listener inspection failed');
    const pids = new Set(result.stdout.split('\n').filter((line) => /^p[0-9]+$/.test(line)));
    if (pids.size !== 1) throw new Error('Gateway listener has ambiguous physical ownership');
    return Number([...pids][0].slice(1));
  },
};

function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (
    !isAbsolute(path) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error('Gateway state must be a private host-owned directory');
}
function regularBytes(path: string): Buffer {
  if (!isAbsolute(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error('Gateway input must be an absolute regular file');
  return readFileSync(path);
}

/** A capability held only by the process that launched this dedicated gateway.
 * No persisted receipt or caller assertion can reconstruct it after a restart.
 * Configuration preflight alone is insufficient: every proof also checks the
 * child handle, listener ownership, and the exact executable/config snapshots.
 */
export class OwnedSymposiumGateway {
  private failure = false;
  private constructor(
    readonly gateway: string,
    readonly workspace: string,
    readonly endpoint: string,
    readonly stateDirectory: string,
    readonly cli: string,
    readonly managementEnvironment: Readonly<Record<string, string>>,
    private readonly port: number,
    private readonly child: ChildProcess,
    private readonly files: ReadonlyMap<string, { sha256: string; mode: number }>,
    private readonly operations: HostOperations,
    private readonly issuer: SymposiumHostIssuer,
    private readonly launchIdentity: Readonly<
      Pick<
        SymposiumOwnedNativeHostBinding,
        'cliSha256' | 'gatewaySha256' | 'image' | 'sandboxRuntimeImage' | 'supervisorImage'
      >
    >,
  ) {
    child.once('error', () => {
      this.failure = true;
    });
    child.once('exit', () => {
      this.failure = true;
      issuer.stop();
    });
    issuer.onLoss(() => {
      this.failure = true;
      child.kill('SIGTERM');
    });
  }

  /** Local host operations are injectable for unit tests; never sourced from requests. */
  static async launch(
    options: OwnedSymposiumGatewayOptions,
    operations: HostOperations = host,
  ): Promise<OwnedSymposiumGateway> {
    options = { ...options, tls: { ...options.tls }, jwt: { ...options.jwt } };
    if (
      ![options.gateway, options.workspace, options.network].every((value) => id.test(value)) ||
      !Number.isInteger(options.port) ||
      options.port < 1024 ||
      options.port > 65535 ||
      !digest.test(options.executableSha256) ||
      !digest.test(options.cliSha256) ||
      ![options.workloadImage, options.sandboxRuntimeImage, options.supervisorImage].every(
        (value) => image.test(value),
      ) ||
      !isAbsolute(options.podmanSocket)
    )
      throw new Error('Invalid owned gateway launch identity');
    privateDirectory(options.stateParent);
    if (operations.listenerPid(options.port) !== null)
      throw new Error('Dedicated gateway port is already occupied');
    const binary = regularBytes(options.executable);
    const cliBytes = regularBytes(options.cliExecutable);
    if (hash(cliBytes) !== options.cliSha256) throw new Error('Gateway CLI digest changed');
    if (hash(binary) !== options.executableSha256)
      throw new Error('Gateway executable digest changed');
    const root = mkdtempSync(join(options.stateParent, 'gateway-'));
    chmodSync(root, 0o700);
    const files = new Map<string, { sha256: string; mode: number }>();
    const freeze = (name: string, bytes: Buffer, mode = 0o400) => {
      const path = join(root, name);
      writeFileSync(path, bytes, { mode, flag: 'wx' });
      files.set(path, { sha256: hash(bytes), mode });
      return path;
    };
    const executable = freeze('openshell-gateway', binary, 0o500);
    const cli = freeze('openshell', cliBytes, 0o500);
    const publicRoots = regularBytes(options.systemCaBundle);
    const tls = Object.fromEntries(
      Object.entries(options.tls).map(([name, path]) => [
        name,
        freeze(`${name}.pem`, regularBytes(path)),
      ]),
    );
    const jwt = Object.fromEntries(
      Object.entries(options.jwt).map(([name, path]) => [
        name,
        freeze(`${name}.jwt`, regularBytes(path)),
      ]),
    );
    for (const directory of ['home', 'config', 'state', 'cache'])
      mkdirSync(join(root, directory), { mode: 0o700 });
    // Do not inherit OPENSHELL_*, proxy credentials, DYLD_*, or loader settings.
    const env: Readonly<Record<string, string>> = Object.freeze({
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: join(root, 'home'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CACHE_HOME: join(root, 'cache'),
    });
    const mtls = join('config', 'openshell', 'gateways', options.gateway, 'mtls');
    mkdirSync(join(root, mtls), { recursive: true, mode: 0o700 });
    freeze(join(mtls, 'ca.crt'), readFileSync(tls.clientCa));
    freeze(join(mtls, 'tls.crt'), readFileSync(tls.managementCert));
    freeze(join(mtls, 'tls.key'), readFileSync(tls.managementKey));
    const issuer = await operations.startIssuer(
      readFileSync(tls.serverCert),
      readFileSync(tls.serverKey),
    );
    const q = (value: string) => JSON.stringify(value);
    // Schema pinned to upstream 854b2370b. Driver options belong in the driver
    // table; allowing request JSON never disables upstream resource admission.
    const config = freeze(
      'gateway.toml',
      Buffer.from(`
[openshell]
version = 2
[openshell.gateway]
name = ${q(options.gateway)}
bind_address = ${q(`127.0.0.1:${options.port}`)}
compute_driver = "podman"
disable_tls = false
guest_tls_ca = ${q(tls.clientCa)}
guest_tls_cert = ${q(tls.managementCert)}
guest_tls_key = ${q(tls.managementKey)}
[openshell.gateway.mtls_auth]
enabled = false
[openshell.gateway.oidc]
issuer = ${q(issuer.url)}
audience = "symposium-host"
admin_role = "openshell-admin"
[openshell.gateway.auth]
allow_unauthenticated_users = false
[openshell.gateway.gateway_jwt]
signing_key_path = ${q(jwt.signingKey)}
public_key_path = ${q(jwt.publicKey)}
kid_path = ${q(jwt.kid)}
gateway_id = ${q(options.gateway)}
[openshell.gateway.tls]
cert_path = ${q(tls.serverCert)}
key_path = ${q(tls.serverKey)}
client_ca_path = ${q(tls.clientCa)}
[openshell.drivers.podman]
allow_driver_config = true
enable_bind_mounts = false
socket_path = ${q(options.podmanSocket)}
network_name = ${q(options.network)}
grpc_endpoint = ${q(`https://host.containers.internal:${options.port}`)}
default_image = ${q(options.workloadImage)}
image_pull_policy = "never"
sandbox_runtime_image = ${q(options.sandboxRuntimeImage)}
supervisor_image = ${q(options.supervisorImage)}
[openshell.drivers.podman.resource_admission]
enabled = true
`),
    );
    const args = ['--config', config];
    const trust = freeze(
      'gateway-trust.pem',
      Buffer.concat([publicRoots, Buffer.from('\n'), readFileSync(tls.clientCa)]),
    );
    const gatewayEnv = { ...env, SSL_CERT_FILE: trust };
    try {
      operations.check(executable, ['config', 'preflight', '--', ...args], gatewayEnv);
    } catch (error) {
      issuer.stop();
      throw error;
    }
    const child = operations.start(executable, args, gatewayEnv);
    const owned = new OwnedSymposiumGateway(
      options.gateway,
      options.workspace,
      `https://127.0.0.1:${options.port}`,
      root,
      cli,
      env,
      options.port,
      child,
      files,
      operations,
      issuer,
      Object.freeze({
        cliSha256: options.cliSha256,
        gatewaySha256: options.executableSha256,
        image: options.workloadImage,
        sandboxRuntimeImage: options.sandboxRuntimeImage,
        supervisorImage: options.supervisorImage,
      }),
    );
    try {
      const deadline = Date.now() + 15_000;
      while (true) {
        owned.verifyFilesAndProcess();
        const pid = operations.listenerPid(options.port);
        if (pid !== null) {
          if (pid !== child.pid) throw new Error('Gateway endpoint belongs to a different process');
          break;
        }
        if (Date.now() >= deadline) throw new Error('Owned gateway listener did not become ready');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      freeze(
        join('config', 'openshell', 'gateways', options.gateway, 'metadata.json'),
        Buffer.from(
          JSON.stringify({
            name: options.gateway,
            gateway_endpoint: owned.endpoint,
            is_remote: false,
            gateway_port: options.port,
            auth_mode: 'oidc',
            oidc_issuer: issuer.url,
            oidc_client_id: 'symposium-host',
            oidc_audience: 'symposium-host',
          }),
        ),
      );
      owned.refreshManagementToken();
      owned.verifyCustody();
      return owned;
    } catch (error) {
      owned.stop();
      throw error;
    }
  }

  private tokenSha256?: string;
  private tokenExpiresAt?: number;
  private tokenTimer?: ReturnType<typeof setTimeout>;

  private refreshManagementToken(): void {
    if (this.failure) return;
    const path = join(
      this.stateDirectory,
      'config',
      'openshell',
      'gateways',
      this.gateway,
      'oidc_token.json',
    );
    const bundle = this.issuer.tokenBundle();
    const bytes = Buffer.from(JSON.stringify(bundle));
    this.tokenExpiresAt = bundle.expires_at;
    writeFileSync(`${path}.next`, bytes, { mode: 0o600, flag: 'wx' });
    renameSync(`${path}.next`, path);
    this.tokenSha256 = hash(bytes);
    this.tokenTimer = setTimeout(() => {
      try {
        this.verifyCustody();
        this.refreshManagementToken();
      } catch {
        this.stop();
      }
    }, 60_000);
    this.tokenTimer.unref();
  }

  private verifyFilesAndProcess(): void {
    this.issuer.assertLive();
    if (
      this.failure ||
      !this.child.pid ||
      this.child.killed ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      throw new Error('Owned gateway process is no longer live');
    privateDirectory(this.stateDirectory);
    if (this.tokenSha256) {
      if (!this.tokenExpiresAt || this.tokenExpiresAt <= Math.floor(Date.now() / 1000) + 30)
        throw new Error('Host management token expired');
      const path = join(
        this.stateDirectory,
        'config',
        'openshell',
        'gateways',
        this.gateway,
        'oidc_token.json',
      );
      const stat = lstatSync(path);
      if (
        (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== process.getuid?.() ||
        hash(regularBytes(path)) !== this.tokenSha256
      )
        throw new Error('Host management token cache changed');
    }
    for (const [path, expected] of this.files) {
      const stat = lstatSync(path);
      if (
        (stat.mode & 0o777) !== expected.mode ||
        stat.uid !== process.getuid?.() ||
        hash(regularBytes(path)) !== expected.sha256
      )
        throw new Error('Owned gateway launch material changed');
    }
  }

  verifyOwnedNativeHost(binding: SymposiumOwnedNativeHostBinding): void {
    this.verifyCustody();
    if (
      binding.cli !== this.cli ||
      binding.gateway !== this.gateway ||
      binding.workspace !== this.workspace ||
      binding.gatewayEndpoint !== this.endpoint
    )
      throw new Error('Owned native gateway route changed');
    for (const [key, expected] of Object.entries(this.launchIdentity))
      if (binding[key as keyof typeof this.launchIdentity] !== expected)
        throw new Error('Owned native launch binary or image changed');
    const expected = Object.entries(this.managementEnvironment).sort();
    const actual = Object.entries(binding.cliEnvironment).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error('Owned native management environment changed');
  }

  verifyCustody(): void {
    this.verifyGatewayDriverConfig(this.gateway, this.workspace, 'podman');
  }

  verifyGatewayDriverConfig(gateway: string, workspace: string, driver: 'podman' | 'docker'): void {
    if (gateway !== this.gateway || workspace !== this.workspace || driver !== 'podman')
      throw new Error('Artifact request differs from owned gateway identity');
    this.verifyFilesAndProcess();
    if (this.operations.listenerPid(this.port) !== this.child.pid)
      throw new Error('Gateway endpoint belongs to a different process');
  }

  async verifyGateway(request: ArtifactLeaseRequest, config: ArtifactDriverConfig): Promise<void> {
    this.verifyGatewayDriverConfig(this.gateway, request.workspaceId, request.driver);
    const mounts = config.podman?.mounts;
    if (
      Object.keys(config).length !== 1 ||
      mounts?.length !== 1 ||
      mounts[0].type !== 'volume' ||
      mounts[0].source !== request.volumeName ||
      mounts[0].target !== '/sandbox/symposium-artifacts' ||
      mounts[0].read_only !== (request.access === 'reviewer')
    )
      throw new Error('Artifact driver config differs from lease');
  }

  /** Stops only the exact owned child. Its state is retained for reconciliation. */
  stop(): void {
    this.failure = true;
    if (this.tokenTimer) clearTimeout(this.tokenTimer);
    this.issuer.stop();
    this.child.kill('SIGTERM');
  }
}
