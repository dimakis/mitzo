import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenShellRuntime } from './openshell-runtime.js';
import { openShellSshProcessSpec } from './codex-app-server-client.js';

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
const helperPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../docs/spikes/openshell-codex/mitzo-checkpoint.py',
);
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
      '/sandbox/mitzo-checkpoint.py',
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
    '/sandbox/mitzo-checkpoint.py',
    action,
    '--input',
    archive,
    ...(action === 'restore'
      ? ['--provider-root', '/sandbox/.codex', '--workspace-root', '/sandbox/workspaces/mgmt']
      : []),
    ...common,
  ];
}
function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
    const spec = openShellSshProcessSpec(
      this.runtime,
      [args[0], ...args.slice(1).map(quote)].join(' '),
    );
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
  async capture(destinationDir: string, identity: CheckpointIdentity, signal: AbortSignal) {
    mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
    const name = `mitzo-${createHash('sha256').update(identity.conversation).digest('hex')}.tar`;
    const remote = `/tmp/${name}`;
    const local = join(destinationDir, name);
    if (existsSync(local)) throw new Error('checkpoint destination already exists');
    const stage = join(destinationDir, `.${name}.${process.pid}.${crypto.randomUUID()}.stage`);
    try {
      await this.ssh(helper('capture', remote, identity), signal);
      await this.run(
        this.runtime.cli,
        [...this.base(), 'download', this.runtime.sandboxName, remote, stage],
        signal,
      );
      const manifest = await this.verify(stage, identity, signal);
      renameSync(stage, local);
      return { path: local, ...manifest };
    } catch (error) {
      rmSync(stage, { force: true });
      throw error;
    }
  }
  async verify(
    archive: string,
    identity: CheckpointIdentity,
    signal: AbortSignal,
  ): Promise<CheckpointManifest> {
    const output = await this.run(
      'python3',
      [
        helperPath,
        'verify',
        '--input',
        archive,
        ...helper('verify', '/tmp/unused.tar', identity).slice(4),
      ],
      signal,
    );
    return validatedManifest(output, identity);
  }
  async restore(archive: string, identity: CheckpointIdentity, signal: AbortSignal) {
    const name = `mitzo-${createHash('sha256').update(identity.conversation).digest('hex')}.tar`;
    const remote = `/tmp/${name}`;
    await this.run(
      'python3',
      [helperPath, 'verify', '--input', archive, ...helper('verify', remote, identity).slice(4)],
      signal,
    );
    await this.run(
      this.runtime.cli,
      [...this.base(), 'upload', this.runtime.sandboxName, archive, '/tmp', '--no-git-ignore'],
      signal,
    );
    await this.ssh([...helper('restore', remote, identity), '--replace-fresh-roots'], signal);
  }
}
