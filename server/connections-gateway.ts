import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
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
const JiraProfile = z
  .object({
    id: z.literal('jira-readonly'),
    resource_version: z.literal(1),
    display_name: z.string().min(1),
    description: z.string().min(1),
    category: z.literal('data'),
    inference_capable: z.literal(false),
    credentials: z
      .array(
        z
          .object({
            name: z.literal('api_token'),
            description: z.string().min(1),
            env_vars: z.tuple([z.literal('JIRA_API_TOKEN')]),
            required: z.literal(true),
            auth_style: z.literal('basic'),
            header_name: z.literal('authorization'),
          })
          .strict(),
      )
      .length(1),
    endpoints: z
      .array(
        z
          .object({
            host: z.literal('redhat.atlassian.net'),
            port: z.literal(443),
            protocol: z.literal('rest'),
            access: z.literal('read-only'),
            enforcement: z.literal('enforce'),
            tls: z.literal('terminate'),
          })
          .strict(),
      )
      .length(1),
    binaries: z
      .array(z.enum(['/usr/bin/python3', '/usr/bin/curl', '/usr/local/bin/curl']))
      .length(3)
      .refine((value) => new Set(value).size === 3, 'Jira profile binaries must be unique'),
  })
  .strict();
const ProfileList = z.array(z.object({ id: z.string().min(1) }).passthrough());

/** The profile is a security policy, so approximate matches are unsafe. */
export function validateJiraProfileYaml(value: string): void {
  try {
    JiraProfile.parse(load(value));
  } catch {
    throw new Error('Reviewed Jira profile differs from required policy');
  }
}
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
    input: { providerName: string; email: string; sandboxName?: string },
    signal: AbortSignal,
  ): Promise<{ identity: string }>;
  deleteSandbox(name: string, signal: AbortSignal): Promise<void>;
  sandbox(
    name: string,
    signal: AbortSignal,
  ): Promise<{ name: string; phase: string; labels: Record<string, string> } | undefined>;
  sandboxProviders(name: string, signal: AbortSignal): Promise<string[]>;
}
/** Pinned CLI 0.0.116-mitzo.2 table parser. Unknown output must fail closed. */
export function parseProviderAttachments(output: string, sandbox: string): string[] {
  const text = output.trim();
  if (text === `No providers attached to sandbox ${sandbox}.`) return [];
  const lines = text.split(/\r?\n/);
  if (
    lines[0].trim().split(/\s+/).join(' ') !== 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS' ||
    lines.length < 2
  )
    throw new Error('Gateway attachment output is invalid');
  const names = lines.slice(1).map((line) => {
    const cells = line.trim().split(/\s+/);
    if (
      cells.length !== 4 ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(cells[0]) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(cells[1]) ||
      !/^\d+$/.test(cells[2]) ||
      !/^\d+$/.test(cells[3])
    )
      throw new Error('Gateway attachment output is invalid');
    return cells[0];
  });
  if (new Set(names).size !== names.length) throw new Error('Gateway attachment output is invalid');
  return names;
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
    private readonly options: {
      workspace: string;
      providerType?: string;
      timeoutMs?: number;
      probeImage?: string;
      probePolicy?: string;
      profilePath?: string;
    } = {
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
    if (!this.options.profilePath) throw new Error('Reviewed Jira profile path is required');
    // Validate the exact reviewed source before asking the gateway to accept it.
    try {
      validateJiraProfileYaml(readFileSync(this.options.profilePath, 'utf8'));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Reviewed Jira profile differs from required policy'
      )
        throw error;
      throw new Error('Reviewed Jira profile cannot be read', { cause: error });
    }
    await this.run(
      [
        'provider',
        '--workspace',
        this.options.workspace,
        'profile',
        'lint',
        '--file',
        this.options.profilePath,
      ],
      signal,
    );
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
    const profileList = ProfileList.safeParse(
      JSON.parse(
        await this.run(
          ['provider', '--workspace', this.options.workspace, 'profile', 'list', '-o', 'json'],
          signal,
        ),
      ),
    );
    if (!profileList.success) throw new Error('Gateway returned invalid provider profile metadata');
    if (!profileList.data.some((profile) => profile.id === JIRA_TEMPLATE_ID)) {
      await this.run(
        [
          'provider',
          '--workspace',
          this.options.workspace,
          'profile',
          'import',
          '--file',
          this.options.profilePath,
        ],
        signal,
      );
    }
    // Import only follows a positive missing-profile result. Export failures are never a reason to import.
    const exported = await this.run(
      [
        'provider',
        '--workspace',
        this.options.workspace,
        'profile',
        'export',
        JIRA_TEMPLATE_ID,
        '-o',
        'yaml',
      ],
      signal,
    );
    validateJiraProfileYaml(exported);
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
  async sandbox(name: string, signal: AbortSignal) {
    const all: Array<{ name: string; phase: string; labels?: Record<string, string> }> = [];
    for (let offset = 0; ; offset += 100) {
      const page = z
        .array(
          z.object({
            name: z.string(),
            phase: z.string(),
            labels: z.record(z.string(), z.string()).optional(),
          }),
        )
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
      all.push(...page);
      if (page.length < 100) {
        const value = all.find((item) => item.name === name);
        return value
          ? { name: value.name, phase: value.phase, labels: value.labels ?? {} }
          : undefined;
      }
    }
  }
  async sandboxProviders(name: string, signal: AbortSignal) {
    return parseProviderAttachments(
      await this.run(
        ['sandbox', '--workspace', this.options.workspace, 'provider', 'list', name],
        signal,
        { NO_COLOR: '1' },
      ),
      name,
    );
  }
  async stopSandbox(name: string, signal: AbortSignal) {
    await this.run(['sandbox', '--workspace', this.options.workspace, 'stop', name], signal);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await this.sandboxStopped(name, signal)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Sandbox did not stop');
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
  async probe(
    input: { providerName: string; email: string; sandboxName?: string },
    signal: AbortSignal,
  ) {
    if (!this.options.probeImage || !this.options.probePolicy)
      throw new Error('Gateway identity probe is not configured');
    if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(input.email))
      throw new Error('Gateway identity probe is invalid');
    const name =
      input.sandboxName ??
      `mitzo-probe-${createHash('sha256').update(`${input.providerName}:${randomUUID()}`).digest('hex').slice(0, 16)}`;
    const probe =
      "import base64,json,os,ssl,urllib.request;u=os.environ['JIRA_URL']+'/rest/api/3/myself';a=base64.b64encode((os.environ['JIRA_EMAIL']+':'+os.environ['JIRA_API_TOKEN']).encode()).decode();H=type('H',(urllib.request.HTTPRedirectHandler,),{'redirect_request':lambda s,*x:(_ for _ in ()).throw(RuntimeError('redirect denied'))});o=urllib.request.build_opener(H());r=urllib.request.Request(u,headers={'Authorization':'Basic '+a});x=o.open(r,timeout=10);b=x.read(65537);assert len(b)<=65536;d=json.loads(b);print(json.dumps({'accountId':d['accountId']},separators=(',',':')))";
    try {
      const createOutput = await this.run(
        [
          'sandbox',
          '--workspace',
          this.options.workspace,
          'create',
          '--name',
          name,
          '--no-auto-providers',
          '--detach',
          '--no-tty',
          '--policy',
          this.options.probePolicy,
          '--from',
          this.options.probeImage,
          '--provider',
          safeName(input.providerName),
          '--label',
          'mitzo.connection_probe=1',
          '--env',
          `JIRA_URL=${JIRA_ENDPOINT}`,
          '--env',
          `JIRA_EMAIL=${input.email}`,
          '-o',
          'json',
        ],
        signal,
      );
      const created = z
        .object({ name: z.string().regex(/^mitzo-probe-[a-f0-9]{16}$/), phase: z.string() })
        .parse(JSON.parse(createOutput));
      if (created.name !== name) throw new Error('Probe sandbox identity mismatch');
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const sandbox = await this.sandbox(name, signal);
        if (sandbox?.phase === 'Ready') {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error('Probe sandbox is not Ready');
      const attached = await this.sandboxProviders(name, signal);
      if (attached.length !== 1 || attached[0] !== safeName(input.providerName))
        throw new Error('Probe sandbox provider attachment mismatch');
      const output = await this.run(
        [
          'sandbox',
          '--workspace',
          this.options.workspace,
          'exec',
          '--name',
          name,
          '--no-tty',
          '--timeout',
          '15',
          '--env',
          `JIRA_URL=${JIRA_ENDPOINT}`,
          '--env',
          `JIRA_EMAIL=${input.email}`,
          '--',
          '/usr/bin/python3',
          '-c',
          probe,
        ],
        signal,
      );
      const identity = z
        .object({ accountId: z.string().min(1).max(128) })
        .parse(JSON.parse(output));
      return {
        identity: identity.accountId,
      };
    } catch {
      throw new Error('Gateway identity probe failed');
    } finally {
      /* service owns durable cleanup using an independent signal */
    }
  }
  async deleteSandbox(name: string, signal: AbortSignal) {
    if (!/^mitzo-probe-[a-f0-9]{16}$/.test(name)) throw new Error('Invalid managed probe sandbox');
    await this.run(['sandbox', '--workspace', this.options.workspace, 'delete', name], signal);
    if (await this.sandbox(name, signal)) throw new Error('Probe sandbox remains present');
  }
}
