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
}
