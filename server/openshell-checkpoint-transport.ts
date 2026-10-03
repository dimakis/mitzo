import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';
import type { OpenShellRuntime } from './openshell-runtime.js';
import { openShellSshArgvProcessSpec } from './codex-app-server-client.js';

type Run = (command: string, args: readonly string[], signal: AbortSignal) => Promise<string>;
export interface CheckpointIdentity {
  conversation: string;
  thread: string;
  binding: string;
  image: string;
  policy: string;
  sandboxId: string;
  resourceVersion: string;
  accountProvider: string;
  accountId: string;
  provider: string;
  model: string;
  profileRevision: string;
  runtimeScope: string;
  routeKind: 'api' | 'chatgpt-subscription';
  routeProvider: string;
  routeProviderType?: string;
  routeProviderId?: string;
  routeGrantId?: string;
}
export interface CheckpointManifest extends CheckpointIdentity {
  version: 1;
  digest: string;
  helper: string;
}
const timeout = 120_000;
const log = createLogger('openshell-checkpoint-transport');
const helperPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../docs/spikes/openshell-codex/mitzo-checkpoint.py',
);
// Host-owned migration tooling is separate from immutable image runtime inputs.
// Updating this pin requires the helper and transport to be reviewed together.
const helperSha256 = 'cad3dae4de4e50fe51968e77cd5ceab68cf6fbc985d8214a214fc7e4dd403fcb';
const pythonBootstrap = [
  'import base64,hashlib,sys',
  'source=base64.b64decode(sys.argv[1],validate=True)',
  'if hashlib.sha256(source).hexdigest()!=sys.argv[2]: raise ValueError("checkpoint host helper digest mismatch")',
  'sys.argv=["mitzo-host-checkpoint.py",*sys.argv[3:]]',
  'exec(compile(source,"mitzo-host-checkpoint.py","exec"),{"__name__":"__main__"})',
].join('\n');
function trustedHelperArgs(args: readonly string[]): string[] {
  // Never resolve code through a task root, image helper, user setting or PATH.
  const info = lstatSync(helperPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    realpathSync(helperPath) !== helperPath ||
    info.size > 65536
  )
    throw new Error('Checkpoint host helper path is unsafe');
  const bytes = readFileSync(helperPath);
  if (bytes.length > 65536 || createHash('sha256').update(bytes).digest('hex') !== helperSha256)
    throw new Error('Checkpoint host helper digest differs from accepted release');
  // The validated bytes are frozen in argv; no read/execute path race follows.
  return ['-I', '-c', pythonBootstrap, bytes.toString('base64'), helperSha256, ...args];
}
function command(binary: string, args: readonly string[], signal: AbortSignal) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      binary,
      [...args],
      { signal, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}
function helper(
  action: 'capture' | 'restore' | 'verify',
  archive: string,
  identity: CheckpointIdentity,
) {
  const common = [
    '--conversation',
    identity.conversation,
    '--thread',
    identity.thread,
    '--binding',
    identity.binding,
    '--image',
    identity.image,
    '--policy',
    identity.policy,
    '--sandbox-id',
    identity.sandboxId,
    '--resource-version',
    identity.resourceVersion,
    '--account-provider',
    identity.accountProvider,
    '--account-id',
    identity.accountId,
    '--provider',
    identity.provider,
    '--model',
    identity.model,
    '--profile-revision',
    identity.profileRevision,
    '--runtime-scope',
    identity.runtimeScope,
    '--route-kind',
    identity.routeKind,
    '--route-provider',
    identity.routeProvider,
    ...(identity.routeProviderType ? ['--route-provider-type', identity.routeProviderType] : []),
    ...(identity.routeProviderId ? ['--route-provider-id', identity.routeProviderId] : []),
    ...(identity.routeGrantId ? ['--route-grant-id', identity.routeGrantId] : []),
  ];
  if (action === 'capture')
    return [
      'capture',
      '--provider-root',
      '/sandbox/.codex',
      '--workspace-root',
      '/sandbox/workspaces/mgmt',
      '--output',
      archive,
      '--require-quiescent',
      ...common,
    ];
  return [
    action,
    '--input',
    archive,
    ...(action === 'restore'
      ? ['--provider-root', '/sandbox/.codex', '--workspace-root', '/sandbox/workspaces/mgmt']
      : []),
    ...common,
  ];
}
function validatedManifest(output: string, identity: CheckpointIdentity): CheckpointManifest {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error('checkpoint helper returned invalid JSON');
  }
  if (!value || typeof value !== 'object')
    throw new Error('checkpoint helper returned invalid manifest');
  const manifest = value as Partial<CheckpointManifest>;
  for (const key of [
    'conversation',
    'thread',
    'binding',
    'image',
    'policy',
    'sandboxId',
    'resourceVersion',
    'accountProvider',
    'accountId',
    'provider',
    'model',
    'profileRevision',
    'runtimeScope',
    'routeKind',
    'routeProvider',
    'routeProviderType',
    'routeProviderId',
    'routeGrantId',
  ] as const)
    if (manifest[key] !== identity[key])
      throw new Error('checkpoint helper returned mismatched manifest');
  if (
    manifest.version !== 1 ||
    typeof manifest.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.digest) ||
    manifest.helper !== 'mitzo-checkpoint-v1'
  )
    throw new Error('checkpoint helper returned invalid manifest');
  return manifest as CheckpointManifest;
}
/** Scoped archive transport; caller must hold lifecycle reservation and quiesce writers. */
export class OpenShellCheckpointTransport {
  constructor(
    private runtime: OpenShellRuntime,
    private run: Run = command,
  ) {}
  private ssh(args: string[], signal: AbortSignal) {
    const spec = openShellSshArgvProcessSpec(this.runtime, args);
    return this.run(spec.command, spec.args, signal);
  }
  private base() {
    return [
      'sandbox',
      ...(this.runtime.gatewayEndpoint
        ? [
            '--gateway-endpoint',
            this.runtime.gatewayEndpoint,
            ...(this.runtime.gatewayInsecure ? ['--gateway-insecure'] : []),
          ]
        : ['--gateway', this.runtime.gateway]),
      '--workspace',
      this.runtime.workspace,
    ];
  }
  /** Removes only the hash-derived staging archive, even after caller cancellation. */
  private async cleanupStagingArchive(remote: string, local?: string) {
    const failures: unknown[] = [];
    try {
      await this.ssh(['rm', '-f', '--', remote], AbortSignal.timeout(timeout));
    } catch (error) {
      failures.push(error);
    }
    if (local) {
      try {
        rmSync(local, { force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'OpenShell checkpoint staging archive cleanup failed');
  }
  private async finalizeStagingArchive(remote: string, primaryFailed: boolean, local?: string) {
    try {
      await this.cleanupStagingArchive(remote, local);
    } catch (error) {
      if (!primaryFailed) throw error;
      log.warn('OpenShell checkpoint staging archive cleanup failed after operation failure', {
        remote,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  async capture(destinationDir: string, identity: CheckpointIdentity, signal: AbortSignal) {
    mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
    const name = `mitzo-${createHash('sha256').update(identity.conversation).digest('hex')}.tar`;
    // OpenShell download/upload is deliberately restricted to /sandbox. Keep
    // the transient archive outside both captured roots so it cannot recurse
    // into the checkpoint or be restored as provider/workspace state.
    const remote = `/sandbox/${name}`;
    const local = join(destinationDir, name);
    if (existsSync(local)) throw new Error('checkpoint destination already exists');
    const stage = join(destinationDir, `.${name}.${process.pid}.${crypto.randomUUID()}.stage`);
    let primaryFailed = false;
    try {
      await this.ssh(
        ['/usr/bin/python3', ...trustedHelperArgs(helper('capture', remote, identity))],
        signal,
      );
      await this.run(
        this.runtime.cli,
        [...this.base(), 'download', this.runtime.sandboxName, remote, stage],
        signal,
      );
      const manifest = await this.verify(stage, identity, signal);
      renameSync(stage, local);
      return { path: local, ...manifest };
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      await this.finalizeStagingArchive(remote, primaryFailed, stage);
    }
  }
  async verify(
    archive: string,
    identity: CheckpointIdentity,
    signal: AbortSignal,
  ): Promise<CheckpointManifest> {
    const output = await this.run(
      '/usr/bin/python3',
      trustedHelperArgs(helper('verify', archive, identity)),
      signal,
    );
    return validatedManifest(output, identity);
  }
  async restore(
    archive: string,
    identity: CheckpointIdentity,
    expectedDigest: string,
    signal: AbortSignal,
  ) {
    const name = `mitzo-${createHash('sha256').update(identity.conversation).digest('hex')}.tar`;
    const remote = `/sandbox/${name}`;
    let uploaded = false;
    let primaryFailed = false;
    try {
      const manifest = await this.verify(archive, identity, signal);
      if (manifest.digest !== expectedDigest)
        throw new Error('checkpoint digest does not match record');
      uploaded = true;
      await this.run(
        this.runtime.cli,
        [
          ...this.base(),
          'upload',
          this.runtime.sandboxName,
          archive,
          '/sandbox',
          '--no-git-ignore',
        ],
        signal,
      );
      await this.ssh(
        [
          '/usr/bin/python3',
          ...trustedHelperArgs([...helper('restore', remote, identity), '--replace-fresh-roots']),
        ],
        signal,
      );
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      if (uploaded) await this.finalizeStagingArchive(remote, primaryFailed);
    }
  }
}
