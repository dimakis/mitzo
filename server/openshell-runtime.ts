import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const Sandbox = z.object({
  name: z.string(),
  phase: z.enum(['Ready', 'Stopped', 'Pending', 'Creating', 'Starting', 'Error']),
  labels: z.record(z.string(), z.string()).optional(),
});
const BootContext = z.object({
  type: z.literal('boot_context'),
  scope: z.literal('sandbox'),
  fullMarkdown: z.string(),
});

export interface OpenShellRuntime {
  sandboxName: string;
  workdir: string;
}

export interface OpenShellRuntimeConfig {
  image: string;
  policy: string;
  seed: string;
  providers: string[];
  workspace: string;
  gateway: string;
  workdir: string;
}

type Run = (args: readonly string[], signal: AbortSignal) => Promise<string>;

function command(args: readonly string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'openshell',
      [...args],
      {
        env: Object.fromEntries(
          ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap((key) =>
            process.env[key] ? [[key, process.env[key]!]] : [],
          ),
        ),
        signal,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

function identifier(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(value))
    throw new Error(`Invalid OpenShell ${label}`);
  return value;
}

export function openShellRuntimeConfig(env: NodeJS.ProcessEnv): OpenShellRuntimeConfig | undefined {
  if (env.MITZO_OPENSHELL_ENABLED !== '1') return undefined;
  const image = env.MITZO_OPENSHELL_IMAGE;
  const policy = env.MITZO_OPENSHELL_POLICY;
  const seed = env.MITZO_OPENSHELL_SEED;
  if (!image || !policy || !seed) throw new Error('OpenShell runtime configuration is incomplete');
  if (!isAbsolute(policy) || !isAbsolute(seed))
    throw new Error('OpenShell policy and seed paths must be absolute');
  const providers = (env.MITZO_OPENSHELL_PROVIDERS || '')
    .split(',')
    .filter(Boolean)
    .map((value) => identifier(value, 'provider'));
  return {
    image,
    policy,
    seed,
    providers,
    workspace: identifier(env.OPENSHELL_WORKSPACE || 'default', 'workspace'),
    gateway: identifier(env.OPENSHELL_GATEWAY || 'openshell', 'gateway'),
    workdir: '/sandbox/workspaces/mgmt',
  };
}

export function sandboxNameForConversation(conversationId: string) {
  return `mitzo-${createHash('sha256').update(conversationId).digest('hex').slice(0, 24)}`;
}

/** Owns lifecycle only. OpenShell owns process/filesystem/network enforcement and providers. */
export class OpenShellRuntimeManager {
  constructor(
    private config: OpenShellRuntimeConfig,
    private run: Run = command,
  ) {}

  private base() {
    return ['--gateway', this.config.gateway, '--workspace', this.config.workspace] as const;
  }

  private async get(name: string, signal: AbortSignal) {
    try {
      return Sandbox.parse(
        JSON.parse(await this.run(['sandbox', ...this.base(), 'get', name, '-o', 'json'], signal)),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/not found|404|does not exist/i.test(message)) return undefined;
      throw error;
    }
  }

  async ensure(conversationId: string, signal: AbortSignal): Promise<OpenShellRuntime> {
    const name = sandboxNameForConversation(conversationId);
    let sandbox = await this.get(name, signal);
    if (!sandbox) {
      const args = [
        'sandbox',
        ...this.base(),
        'create',
        '--name',
        name,
        '--from',
        this.config.image,
        '--policy',
        this.config.policy,
        '--upload',
        `${this.config.seed}:${this.config.workdir}`,
        '--label',
        `mitzo.conversation=${createHash('sha256').update(conversationId).digest('hex')}`,
        '--no-auto-providers',
        '--detach',
      ];
      for (const provider of this.config.providers) args.push('--provider', provider);
      await this.run(args, signal);
      sandbox = await this.get(name, signal);
    } else if (sandbox.phase === 'Stopped') {
      await this.run(['sandbox', ...this.base(), 'start', name], signal);
      sandbox = await this.get(name, signal);
    }
    if (!sandbox || sandbox.phase !== 'Ready')
      throw new Error(`OpenShell sandbox ${name} is ${sandbox?.phase ?? 'unavailable'}`);
    return { sandboxName: name, workdir: this.config.workdir };
  }

  async compileContext(runtime: OpenShellRuntime, signal: AbortSignal) {
    const output = await this.run(
      [
        'sandbox',
        ...this.base(),
        'exec',
        runtime.sandboxName,
        '--',
        '/usr/bin/node',
        '/sandbox/compile-mgmt-context.mjs',
        runtime.workdir,
        '12000',
      ],
      signal,
    );
    const context = BootContext.parse(JSON.parse(output.trim()));
    return context.fullMarkdown;
  }
}
