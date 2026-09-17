import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { z } from 'zod';
import { isValidEmailAddress } from './connections/email.js';
import type { ProviderPolicy } from './connections/types.js';

export const JIRA_ENDPOINT = 'https://redhat.atlassian.net';
export const JIRA_API_ENDPOINT =
  'https://api.atlassian.com/ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432';
export const JIRA_TEMPLATE_ID = 'jira-readonly';
export const GITHUB_TEMPLATE_ID = 'github-readonly';
export type ConnectionProbeErrorCode =
  | 'JIRA_AUTH_REJECTED'
  | 'JIRA_PERMISSION_DENIED'
  | 'JIRA_HTTP_ERROR'
  | 'JIRA_NETWORK_FAILED'
  | 'GITHUB_AUTH_REJECTED'
  | 'GITHUB_PERMISSION_DENIED'
  | 'GITHUB_HTTP_ERROR'
  | 'GITHUB_NETWORK_FAILED';
export class ConnectionProbeError extends Error {
  constructor(readonly code: ConnectionProbeErrorCode) {
    super(code);
  }
}
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
    // Gateway import may advance the durable resource version; policy semantics do not change.
    resource_version: z.number().int().positive(),
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
            // OpenShell serializes its default rather than skipping this field.
            query_param: z.literal('').optional(),
          })
          .strict(),
      )
      .length(1),
    endpoints: z
      .array(
        z
          .object({
            host: z.literal('api.atlassian.com'),
            port: z.literal(443),
            protocol: z.literal('rest'),
            enforcement: z.literal('enforce'),
            tls: z.literal('terminate'),
            rules: z.tuple([
              z
                .object({
                  allow: z
                    .object({
                      method: z.literal('GET'),
                      path: z.literal(
                        '/ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432/rest/api/2/**',
                      ),
                    })
                    .strict(),
                })
                .strict(),
              z
                .object({
                  allow: z
                    .object({
                      method: z.literal('HEAD'),
                      path: z.literal(
                        '/ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432/rest/api/2/**',
                      ),
                    })
                    .strict(),
                })
                .strict(),
              z
                .object({
                  allow: z
                    .object({
                      method: z.literal('GET'),
                      path: z.literal(
                        '/ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432/rest/api/3/**',
                      ),
                    })
                    .strict(),
                })
                .strict(),
              z
                .object({
                  allow: z
                    .object({
                      method: z.literal('HEAD'),
                      path: z.literal(
                        '/ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432/rest/api/3/**',
                      ),
                    })
                    .strict(),
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .length(1),
    binaries: z
      .array(z.enum(['/usr/bin/python3', '/usr/bin/curl', '/usr/local/bin/curl']))
      .length(3)
      .refine((value) => new Set(value).size === 3, 'Jira profile binaries must be unique'),
    // Gateway metadata is not policy input, but must remain a bounded scalar projection.
    source: z.string().max(256).optional(),
    scope: z.string().max(256).optional(),
  })
  .strict();
const ProfileList = z.array(z.object({ id: z.string().min(1) }).passthrough());
const ProbeSandboxName = /^mzp-[a-f0-9]{15}$/;
const CleanupProbeSandboxName = /^(?:mzp-[a-f0-9]{15}|mitzo-probe-[a-f0-9]{16})$/;

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
export interface GatewayProviderOperation {
  name: string;
  templateId: string;
  templateVersion: number;
  policy: ProviderPolicy;
  /** One-shot secrets: gateway methods must not retain this object. */
  credentials: Record<string, string>;
}
export interface GatewayCompatibilityInput {
  templateId: string;
  templateVersion: number;
  policy: ProviderPolicy;
}
export interface ConnectionGateway {
  /** A registered template may be visible before its gateway adapter ships. */
  supportsTemplate(templateId: string, templateVersion: number): boolean;
  /** Adapter-owned binding checks include credential injection invariants. */
  validateBinding(input: {
    templateId: string;
    templateVersion: number;
    provider: GatewayProvider;
  }): void;
  verifyCompatibility(input: GatewayCompatibilityInput, signal: AbortSignal): Promise<void>;
  provision(input: GatewayProviderOperation, signal: AbortSignal): Promise<GatewayProvider>;
  rotate(input: GatewayProviderOperation, signal: AbortSignal): Promise<void>;
  get(name: string, signal: AbortSignal): Promise<GatewayProvider | undefined>;
  list(signal: AbortSignal): Promise<GatewayProvider[]>;
  delete(name: string, signal: AbortSignal): Promise<void>;
  attachments(providerName: string, signal: AbortSignal): Promise<string[]>;
  stopSandbox(name: string, signal: AbortSignal): Promise<void>;
  sandboxStopped(name: string, signal: AbortSignal): Promise<boolean>;
  detach(sandbox: string, providerName: string, signal: AbortSignal): Promise<void>;
  probe(
    input: {
      providerName: string;
      templateId: string;
      templateVersion: number;
      publicConfig: Record<string, string | string[]>;
      sandboxName?: string;
    },
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
  // The pinned CLI may decorate table headings when stdout is a terminal. Strip
  // only ANSI control sequences, then retain the exact fail-closed table shape.
  const ansiControlSequence = new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'g');
  const text = output.replace(ansiControlSequence, '').trim();
  if (text === `No providers attached to sandbox ${sandbox}.`) return [];
  const lines = text.split(/\r?\n/);
  // Pinned CLI formats table headings with SGR bold even when NO_COLOR=1.
  // Strip SGR only from the header; data rows remain strict plain identifiers/counts.
  const header = lines[0].replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  if (
    header.trim().split(/\s+/).join(' ') !== 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS' ||
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
type LegacyGatewayProviderOperation = { name: string; token: string };
type LegacyProbeInput = { providerName: string; email: string; sandboxName?: string };
function jiraOperation(input: GatewayProviderOperation | LegacyGatewayProviderOperation) {
  if ('token' in input) return { name: safeName(input.name), token: input.token };
  assertPinnedDnsSupported(input.policy);
  if (
    input.templateId !== JIRA_TEMPLATE_ID ||
    input.templateVersion !== 1 ||
    input.policy.templateId !== input.templateId ||
    input.policy.templateVersion !== input.templateVersion ||
    Object.keys(input.credentials).length !== 1 ||
    typeof input.credentials.token !== 'string' ||
    input.credentials.token.length === 0
  )
    throw new Error('Unsupported or invalid reviewed provider template');
  return { name: safeName(input.name), token: input.credentials.token };
}
function githubOperation(input: GatewayProviderOperation) {
  assertPinnedDnsSupported(input.policy);
  if (
    input.templateId !== GITHUB_TEMPLATE_ID ||
    input.templateVersion !== 1 ||
    input.policy.templateId !== input.templateId ||
    input.policy.templateVersion !== input.templateVersion ||
    Object.keys(input.credentials).length !== 1 ||
    typeof input.credentials.token !== 'string' ||
    input.credentials.token.length === 0
  )
    throw new Error('Unsupported or invalid reviewed provider template');
  return { name: safeName(input.name), token: input.credentials.token };
}
function assertPinnedDnsSupported(policy: ProviderPolicy) {
  for (const endpoint of policy.endpoints) {
    if (!endpoint.dns) continue;
    const requirement = endpoint.dns;
    if (
      requirement.mode !== 'pinned-public-only' ||
      !requirement.hostname ||
      requirement.verifyAt !== 'provision-and-every-use' ||
      requirement.rejectRebinding !== true
    )
      throw new Error('Invalid pinned public DNS policy');
    // This Jira-only adapter cannot resolve and pin a custom endpoint, so it
    // must never provision it under a weaker hostname-only boundary.
    throw new Error('Pinned public DNS is unsupported by this gateway');
  }
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
      githubProbePolicy?: string;
      profilePath?: string;
    } = {
      workspace: 'default',
    },
  ) {}
  supportsTemplate(templateId: string, templateVersion: number) {
    return (
      (templateId === JIRA_TEMPLATE_ID || templateId === GITHUB_TEMPLATE_ID) &&
      templateVersion === 1
    );
  }
  validateBinding(input: {
    templateId: string;
    templateVersion: number;
    provider: GatewayProvider;
  }) {
    const { provider } = input;
    const jira =
      input.templateId === JIRA_TEMPLATE_ID &&
      input.templateVersion === 1 &&
      provider.type === JIRA_TEMPLATE_ID &&
      provider.credentialKeys.length === 1 &&
      provider.credentialKeys[0] === 'JIRA_API_TOKEN';
    // OpenShell's built-in GitHub profile remains read-only. This connection
    // only supplies its token to that provider; all writes route through the
    // controller capability and never through this credential binding.
    const github =
      input.templateId === GITHUB_TEMPLATE_ID &&
      input.templateVersion === 1 &&
      provider.type === 'github' &&
      provider.credentialKeys.length === 1 &&
      provider.credentialKeys[0] === 'GITHUB_TOKEN';
    if (!jira && !github) throw new Error('Managed provider credential binding changed');
  }
  private async run(args: string[], signal: AbortSignal, env: Record<string, string> = {}) {
    try {
      // The pinned Podman driver allows 45 seconds to stop a container before removal.
      const teardown = args[0] === 'sandbox' && ['stop', 'delete'].includes(args[3]);
      return await this.runner(args, {
        env,
        signal,
        timeoutMs: this.options.timeoutMs ?? (teardown ? 90_000 : 15_000),
      });
    } catch {
      // CLI output can include credential material; never forward it across this boundary.
      throw new Error('Gateway command failed');
    }
  }
  async verifyCompatibility(input: GatewayCompatibilityInput | AbortSignal, signal?: AbortSignal) {
    const actualSignal = signal ?? (input as AbortSignal);
    if (signal) {
      const compatibility = input as GatewayCompatibilityInput;
      assertPinnedDnsSupported(compatibility.policy);
      if (
        compatibility.templateId === GITHUB_TEMPLATE_ID &&
        compatibility.templateVersion === 1 &&
        compatibility.policy.templateId === compatibility.templateId &&
        compatibility.policy.templateVersion === compatibility.templateVersion
      )
        return;
      if (
        compatibility.templateId !== JIRA_TEMPLATE_ID ||
        compatibility.templateVersion !== 1 ||
        compatibility.policy.templateId !== compatibility.templateId ||
        compatibility.policy.templateVersion !== compatibility.templateVersion
      )
        throw new Error('Unsupported reviewed provider template');
    }
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
    const profileList = ProfileList.safeParse(
      JSON.parse(
        await this.run(
          ['provider', '--workspace', this.options.workspace, 'list-profiles', '-o', 'json'],
          actualSignal,
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
          'lint',
          '--file',
          this.options.profilePath,
        ],
        actualSignal,
      );
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
        actualSignal,
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
      actualSignal,
    );
    validateJiraProfileYaml(exported);
  }
  async provision(
    input: GatewayProviderOperation | LegacyGatewayProviderOperation,
    signal: AbortSignal,
  ) {
    const github = !('token' in input) && input.templateId === GITHUB_TEMPLATE_ID;
    const { name, token } = github
      ? githubOperation(input as GatewayProviderOperation)
      : jiraOperation(input);
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
        github ? 'github' : (this.options.providerType ?? JIRA_TEMPLATE_ID),
        '--credential',
        github ? 'GITHUB_TOKEN' : 'JIRA_API_TOKEN',
      ],
      signal,
      github ? { GITHUB_TOKEN: token } : { JIRA_API_TOKEN: token },
    );
    const provider = await this.get(name, signal);
    if (!provider) throw new Error('Gateway did not create managed provider');
    return provider;
  }
  async rotate(
    input: GatewayProviderOperation | LegacyGatewayProviderOperation,
    signal: AbortSignal,
  ) {
    const github = !('token' in input) && input.templateId === GITHUB_TEMPLATE_ID;
    const { name, token } = github
      ? githubOperation(input as GatewayProviderOperation)
      : jiraOperation(input);
    await this.run(
      [
        'provider',
        '--workspace',
        this.options.workspace,
        'update',
        name,
        '--credential',
        github ? 'GITHUB_TOKEN' : 'JIRA_API_TOKEN',
      ],
      signal,
      github ? { GITHUB_TOKEN: token } : { JIRA_API_TOKEN: token },
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
    const managedName = safeName(name);
    await this.run(
      ['provider', '--workspace', this.options.workspace, 'delete', managedName],
      signal,
    );
    if (await this.get(managedName, signal)) throw new Error('Managed provider remains present');
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
    input:
      | {
          providerName: string;
          templateId: string;
          templateVersion: number;
          publicConfig: Record<string, string | string[]>;
          sandboxName?: string;
        }
      | LegacyProbeInput,
    signal: AbortSignal,
  ) {
    if (!this.options.probeImage || !this.options.probePolicy)
      throw new Error('Gateway identity probe is not configured');
    const normalized =
      'email' in input
        ? {
            ...input,
            templateId: JIRA_TEMPLATE_ID,
            templateVersion: 1,
            publicConfig: { email: input.email },
          }
        : input;
    if (normalized.templateId === GITHUB_TEMPLATE_ID && normalized.templateVersion === 1)
      return this.probeGithubReadonly(normalized, signal);
    const email = normalized.publicConfig.email;
    if (
      normalized.templateId !== JIRA_TEMPLATE_ID ||
      normalized.templateVersion !== 1 ||
      typeof email !== 'string' ||
      !isValidEmailAddress(email)
    )
      throw new Error('Gateway identity probe is invalid');
    const name =
      normalized.sandboxName ??
      `mzp-${createHash('sha256').update(`${normalized.providerName}:${randomUUID()}`).digest('hex').slice(0, 15)}`;
    if (!ProbeSandboxName.test(name)) throw new Error('Invalid managed probe sandbox');
    const probe = `import base64,json,os,urllib.error,urllib.request
u=os.environ['JIRA_URL']+'/rest/api/3/myself';a=base64.b64encode((os.environ['JIRA_EMAIL']+':'+os.environ['JIRA_API_TOKEN']).encode()).decode()
H=type('H',(urllib.request.HTTPRedirectHandler,),{'redirect_request':lambda s,*x:(_ for _ in ()).throw(RuntimeError('redirect denied'))});o=urllib.request.build_opener(H());r=urllib.request.Request(u,headers={'Authorization':'Basic '+a})
try:
 x=o.open(r,timeout=10);b=x.read(65537);assert len(b)<=65536;d=json.loads(b);print(json.dumps({'accountId':d['accountId']},separators=(',',':')))
except urllib.error.HTTPError as e:
 print(json.dumps({'error': 'JIRA_AUTH_REJECTED' if e.code==401 else 'JIRA_PERMISSION_DENIED' if e.code==403 else 'JIRA_HTTP_ERROR'},separators=(',',':')))
except Exception:
 print(json.dumps({'error':'JIRA_NETWORK_FAILED'},separators=(',',':')))`;
    try {
      let createOutput: string | undefined;
      try {
        createOutput = await this.run(
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
            safeName(normalized.providerName),
            '--label',
            'mitzo.connection_probe=1',
            '--env',
            `JIRA_URL=${JIRA_API_ENDPOINT}`,
            '--env',
            `JIRA_EMAIL=${email}`,
            '-o',
            'json',
          ],
          signal,
        );
      } catch {
        if (signal.aborted)
          // Upstream failures may contain credential material; retain only the safe code.

          throw new Error('Gateway identity probe failed');
        const recovered = await this.sandbox(name, signal);
        if (
          recovered?.name !== name ||
          recovered.phase !== 'Ready' ||
          recovered.labels['mitzo.connection_probe'] !== '1'
        )
          throw new Error('Probe sandbox create failed');
      }
      if (createOutput !== undefined) {
        const created = z
          .object({ name: z.string().regex(ProbeSandboxName), phase: z.string() })
          .parse(JSON.parse(createOutput));
        if (created.name !== name) throw new Error('Probe sandbox identity mismatch');
      }
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const sandbox = await this.sandbox(name, signal);
        if (sandbox?.phase === 'Ready' && sandbox.labels['mitzo.connection_probe'] === '1') {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error('Probe sandbox is not Ready');
      const attached = await this.sandboxProviders(name, signal);
      if (attached.length !== 1 || attached[0] !== safeName(normalized.providerName))
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
          `JIRA_URL=${JIRA_API_ENDPOINT}`,
          '--env',
          `JIRA_EMAIL=${email}`,
          '--',
          '/usr/bin/python3',
          '-c',
          probe,
        ],
        signal,
      );
      const identity = z
        .union([
          z.object({ accountId: z.string().min(1).max(128) }).strict(),
          z
            .object({
              error: z.enum([
                'JIRA_AUTH_REJECTED',
                'JIRA_PERMISSION_DENIED',
                'JIRA_HTTP_ERROR',
                'JIRA_NETWORK_FAILED',
              ]),
            })
            .strict(),
        ])
        .parse(JSON.parse(output));
      if ('error' in identity) throw new ConnectionProbeError(identity.error);
      return {
        identity: identity.accountId,
      };
    } catch (error) {
      if (error instanceof ConnectionProbeError) throw error;
      // Upstream failures may contain credential material; retain only the safe code.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Gateway identity probe failed');
    } finally {
      /* service owns durable cleanup using an independent signal */
    }
  }
  /** Probe only GitHub's read identity endpoint through the built-in read-only provider. */
  private async probeGithubReadonly(
    input: {
      providerName: string;
      templateId: string;
      templateVersion: number;
      publicConfig: Record<string, string | string[]>;
      sandboxName?: string;
    },
    signal: AbortSignal,
  ): Promise<{ identity: string }> {
    if (!this.options.probeImage || !this.options.githubProbePolicy)
      throw new Error('Gateway GitHub identity probe is not configured');
    const name =
      input.sandboxName ??
      `mzp-${createHash('sha256').update(`${input.providerName}:${randomUUID()}`).digest('hex').slice(0, 15)}`;
    if (!ProbeSandboxName.test(name)) throw new Error('Invalid managed probe sandbox');
    // The script is code-owned and keeps the response compact. It neither
    // reads nor prints a token; OpenShell injects it only into its provider.
    const probe = `import json,urllib.error,urllib.request
try:
 r=urllib.request.Request('https://api.github.com/user',headers={'Accept':'application/vnd.github+json'});x=urllib.request.urlopen(r,timeout=10);b=x.read(65537);assert len(b)<=65536;d=json.loads(b);print(json.dumps({'login':d['login']},separators=(',',':')))
except urllib.error.HTTPError as e: print(json.dumps({'error':'GITHUB_AUTH_REJECTED' if e.code==401 else 'GITHUB_PERMISSION_DENIED' if e.code==403 else 'GITHUB_HTTP_ERROR'},separators=(',',':')))
except Exception: print(json.dumps({'error':'GITHUB_NETWORK_FAILED'},separators=(',',':')))`;
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
          this.options.githubProbePolicy,
          '--from',
          this.options.probeImage,
          '--provider',
          safeName(input.providerName),
          '--label',
          'mitzo.connection_probe=1',
          '-o',
          'json',
        ],
        signal,
      );
      const created = z
        .object({ name: z.string().regex(ProbeSandboxName), phase: z.string() })
        .parse(JSON.parse(createOutput));
      if (created.name !== name) throw new Error('Probe sandbox identity mismatch');
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const sandbox = await this.sandbox(name, signal);
        if (sandbox?.phase === 'Ready' && sandbox.labels['mitzo.connection_probe'] === '1') {
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
          '--',
          '/usr/bin/python3',
          '-c',
          probe,
        ],
        signal,
      );
      const identity = z
        .union([
          z
            .object({
              login: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[A-Za-z0-9-]+$/),
            })
            .strict(),
          z
            .object({
              error: z.enum([
                'GITHUB_AUTH_REJECTED',
                'GITHUB_PERMISSION_DENIED',
                'GITHUB_HTTP_ERROR',
                'GITHUB_NETWORK_FAILED',
              ]),
            })
            .strict(),
        ])
        .parse(JSON.parse(output));
      if ('error' in identity) throw new ConnectionProbeError(identity.error);
      return { identity: identity.login };
    } catch (error) {
      if (error instanceof ConnectionProbeError) throw error;
      // The OpenShell CLI can include provider response details; do not retain
      // that cause across the controller credential boundary.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Gateway GitHub identity probe failed');
    }
  }
  async deleteSandbox(name: string, signal: AbortSignal) {
    if (!CleanupProbeSandboxName.test(name)) throw new Error('Invalid managed probe sandbox');
    const sandbox = await this.sandbox(name, signal);
    // A successful authoritative lookup proving absence means a failed create or prior cleanup
    // has already reached the desired durable state. Lookup errors still propagate fail-closed.
    if (!sandbox) return;
    if (sandbox.labels['mitzo.connection_probe'] !== '1')
      throw new Error('Probe sandbox ownership cannot be verified');
    const deadline = Date.now() + (this.options.timeoutMs ?? 90_000);
    await this.run(['sandbox', '--workspace', this.options.workspace, 'delete', name], signal);
    do {
      signal.throwIfAborted();
      if (!(await this.sandbox(name, signal))) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    throw new Error('Probe sandbox remains present');
  }
}
