import { z } from 'zod';

export const JIRA_ENDPOINT = 'https://redhat.atlassian.net';
export const JIRA_TEMPLATE_ID = 'jira-readonly';
const Provider = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  workspace: z.string().min(1),
  type: z.string().min(1),
  credential_keys: z.array(z.string()).optional(),
});
export interface CommandRunner {
  (
    args: readonly string[],
    options: { env: Record<string, string>; signal: AbortSignal; timeoutMs: number },
  ): Promise<string>;
}
export interface GatewayProvider {
  id: string;
  name: string;
  workspace: string;
  type: string;
  credentialKeys: string[];
}
export interface ConnectionGateway {
  verifyCompatibility(signal: AbortSignal): Promise<void>;
  provision(input: { name: string; token: string }, signal: AbortSignal): Promise<GatewayProvider>;
  rotate(input: { name: string; token: string }, signal: AbortSignal): Promise<void>;
  get(name: string, signal: AbortSignal): Promise<GatewayProvider | undefined>;
  list(signal: AbortSignal): Promise<GatewayProvider[]>;
  delete(name: string, signal: AbortSignal): Promise<void>;
  attachments(providerName: string, signal: AbortSignal): Promise<string[]>;
  stopSandbox(name: string, signal: AbortSignal): Promise<void>;
  sandboxStopped(name: string, signal: AbortSignal): Promise<boolean>;
  detach(sandbox: string, providerName: string, signal: AbortSignal): Promise<void>;
  probe(
    input: { providerName: string; email: string },
    signal: AbortSignal,
  ): Promise<{ identity: string }>;
}
/** Pinned CLI 0.0.116-mitzo.2 table parser. Unknown output must fail closed. */
export function parseProviderAttachments(output: string, sandbox: string): string[] {
  const text = output.trim();
  if (text === `No providers attached to sandbox ${sandbox}.`) return [];
  const lines = text.split(/\r?\n/);
  if (lines[0] !== 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS' || lines.length < 2)
    throw new Error('Gateway attachment output is invalid');
  return lines.slice(1).map((line) => {
    const cells = line.trim().split(/\s+/);
    if (cells.length !== 4 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(cells[0]))
      throw new Error('Gateway attachment output is invalid');
    return cells[0];
  });
}
function safeName(name: string) {
  if (!/^mitzo-conn-[a-f0-9-]{8,64}$/.test(name)) throw new Error('Invalid managed provider name');
  return name;
}
function safeOutput(value: string) {
  try {
    return Provider.array()
      .parse(JSON.parse(value))
      .map((item) => ({
        id: item.id,
        name: item.name,
        workspace: item.workspace,
        type: item.type,
        credentialKeys: item.credential_keys ?? [],
      }));
  } catch {
    throw new Error('Gateway returned invalid provider metadata');
  }
}
/** Thin, deliberately bounded CLI adapter. Browser inputs never choose CLI paths, endpoint, workspace or config. */
export class OpenShellConnectionGateway implements ConnectionGateway {
  constructor(
    private readonly runner: CommandRunner,
    private readonly options: { workspace: string; providerType?: string; timeoutMs?: number } = {
      workspace: 'default',
    },
  ) {}
  private async run(args: string[], signal: AbortSignal, env: Record<string, string> = {}) {
    try {
      return await this.runner(args, { env, signal, timeoutMs: this.options.timeoutMs ?? 15_000 });
    } catch {
      // CLI output can include credential material; never forward it across this boundary.
      throw new Error('Gateway command failed');
    }
  }
  async verifyCompatibility(signal: AbortSignal) {
    await this.run(
      [
        'provider',
        '--workspace',
        this.options.workspace,
        'list',
        '--limit',
        '1',
        '--offset',
        '0',
        '-o',
        'json',
      ],
      signal,
    );
  }
  async provision(input: { name: string; token: string }, signal: AbortSignal) {
    const name = safeName(input.name);
    // The key-only spelling makes the CLI read the secret only from this child environment.
    await this.run(
      [
        'provider',
        '--workspace',
        this.options.workspace,
        'create',
        '--name',
        name,
        '--type',
        this.options.providerType ?? JIRA_TEMPLATE_ID,
        '--credential',
        'JIRA_API_TOKEN',
      ],
      signal,
      { JIRA_API_TOKEN: input.token },
    );
    const provider = await this.get(name, signal);
    if (!provider) throw new Error('Gateway did not create managed provider');
    return provider;
  }
  async rotate(input: { name: string; token: string }, signal: AbortSignal) {
    await this.run(
      [
        'provider',
        '--workspace',
        this.options.workspace,
        'update',
        safeName(input.name),
        '--credential',
        'JIRA_API_TOKEN',
      ],
      signal,
      { JIRA_API_TOKEN: input.token },
    );
  }
  async list(signal: AbortSignal) {
    const all: GatewayProvider[] = [];
    for (let offset = 0; ; offset += 100) {
      const items = safeOutput(
        await this.run(
          [
            'provider',
            '--workspace',
            this.options.workspace,
            'list',
            '--limit',
            '100',
            '--offset',
            String(offset),
            '-o',
            'json',
          ],
          signal,
        ),
      );
      all.push(...items);
      if (items.length < 100) return all;
    }
  }
  async get(name: string, signal: AbortSignal) {
    return (await this.list(signal)).find((item) => item.name === safeName(name));
  }
  async delete(name: string, signal: AbortSignal) {
    await this.run(
      ['provider', '--workspace', this.options.workspace, 'delete', safeName(name)],
      signal,
    );
  }
  async attachments(providerName: string, signal: AbortSignal) {
    const attached: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const sandboxes = z
        .array(z.object({ name: z.string().min(1) }))
        .parse(
          JSON.parse(
            await this.run(
              [
                'sandbox',
                '--workspace',
                this.options.workspace,
                'list',
                '--limit',
                '100',
                '--offset',
                String(offset),
                '-o',
                'json',
              ],
              signal,
            ),
          ),
        );
      for (const sandbox of sandboxes) {
        const table = await this.run(
          ['sandbox', '--workspace', this.options.workspace, 'provider', 'list', sandbox.name],
          signal,
          { NO_COLOR: '1' },
        );
        if (parseProviderAttachments(table, sandbox.name).includes(safeName(providerName)))
          attached.push(sandbox.name);
      }
      if (sandboxes.length < 100) return attached;
    }
  }
  async stopSandbox(name: string, signal: AbortSignal) {
    await this.run(['sandbox', '--workspace', this.options.workspace, 'stop', name], signal);
  }
  async sandboxStopped(name: string, signal: AbortSignal) {
    const result = z
      .object({ phase: z.string() })
      .parse(
        JSON.parse(
          await this.run(
            ['sandbox', '--workspace', this.options.workspace, 'get', name, '-o', 'json'],
            signal,
          ),
        ),
      );
    return result.phase === 'Stopped';
  }
  async detach(sandbox: string, providerName: string, signal: AbortSignal) {
    await this.run(
      [
        'sandbox',
        '--workspace',
        this.options.workspace,
        'provider',
        'detach',
        sandbox,
        safeName(providerName),
      ],
      signal,
    );
  }
  async probe(_input: { providerName: string; email: string }, _signal: AbortSignal) {
    // Probe execution requires the reviewed disposable sandbox runner; do not substitute a host-side fetch.
    throw new Error('Gateway identity probe is not configured');
  }
}
