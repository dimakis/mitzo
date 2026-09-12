import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenShellRuntime } from './openshell-runtime.js';
import { openShellSshProcessSpec } from './codex-app-server-client.js';

type Run = (command: string, args: readonly string[], signal: AbortSignal) => Promise<string>;
export interface CheckpointIdentity {
  conversation: string;
  thread: string;
  binding: string;
  image: string;
  policy: string;
  sandboxId?: string;
  resourceVersion?: string;
  accountProvider?: string;
}
export interface CheckpointManifest extends CheckpointIdentity {
  version: 1;
  digest: string;
  helper: string;
}
const timeout = 120_000;
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
    await this.ssh(helper('capture', remote, identity), signal);
    await this.run(
      this.runtime.cli,
      [...this.base(), 'download', this.runtime.sandboxName, remote, local],
      signal,
    );
    await this.run(
      'python3',
      [
        join(process.cwd(), 'docs/spikes/openshell-codex/mitzo-checkpoint.py'),
        'verify',
        '--input',
        local,
        ...helper('verify', remote, identity).slice(4),
      ],
      signal,
    );
    return local;
  }
  async verify(
    archive: string,
    identity: CheckpointIdentity,
    signal: AbortSignal,
  ): Promise<CheckpointManifest> {
    const output = await this.run(
      'python3',
      [
        join(process.cwd(), 'docs/spikes/openshell-codex/mitzo-checkpoint.py'),
        'verify',
        '--input',
        archive,
        ...helper('verify', '/tmp/unused.tar', identity).slice(4),
      ],
      signal,
    );
    return JSON.parse(output) as CheckpointManifest;
  }
  async restore(archive: string, identity: CheckpointIdentity, signal: AbortSignal) {
    const name = `mitzo-${createHash('sha256').update(identity.conversation).digest('hex')}.tar`;
    const remote = `/tmp/${name}`;
    await this.run(
      'python3',
      [
        join(process.cwd(), 'docs/spikes/openshell-codex/mitzo-checkpoint.py'),
        'verify',
        '--input',
        archive,
        ...helper('verify', remote, identity).slice(4),
      ],
      signal,
    );
    await this.run(
      this.runtime.cli,
      [...this.base(), 'upload', this.runtime.sandboxName, archive, '/tmp', '--no-git-ignore'],
      signal,
    );
    await this.ssh(helper('restore', remote, identity), signal);
  }
}
