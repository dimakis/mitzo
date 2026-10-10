import { z } from 'zod';
import type { CommandRunner, ConnectionGateway } from './connections-gateway.js';
import type { ManagedOpenAIAccount, OpenAIKeyGateway } from './openai-key-management.js';

const Profile = z
  .object({
    id: z.literal('mitzo-openai-keychain-spike'),
    resource_version: z.number().int().positive(),
    display_name: z.string(),
    description: z.string(),
    category: z.literal('inference'),
    inference_capable: z.literal(true),
    credentials: z.tuple([
      z
        .object({
          name: z.literal('api_key'),
          description: z.string(),
          env_vars: z.tuple([z.literal('OPENAI_API_KEY')]),
          required: z.literal(true),
          auth_style: z.literal('bearer'),
          header_name: z.literal('authorization'),
          query_param: z.literal('').optional(),
        })
        .strict(),
    ]),
    endpoints: z.tuple([
      z
        .object({
          host: z.literal('api.openai.com'),
          port: z.literal(443),
          protocol: z.literal('rest'),
          access: z.literal('read-write'),
          enforcement: z.literal('enforce'),
          // OpenShell exports omit default false booleans (serde skip_serializing_if=is_false).
          // Normalize that canonical wire form; any explicit true/nonboolean remains rejected.
          request_body_credential_rewrite: z.literal(false).default(false),
          allow_uninspected_credentials: z.literal(false).default(false),
        })
        .strict(),
    ]),
    binaries: z
      .array(
        z.enum([
          '/usr/bin/curl',
          '/usr/bin/codex',
          '/usr/bin/node',
          '/usr/lib/node_modules/@openai/**',
        ]),
      )
      .length(4)
      .refine((values) => new Set(values).size === 4),
    source: z.string().optional(),
    scope: z.string().optional(),
  })
  .strict();
const Provider = z.object({
  id: z.string(),
  name: z.string(),
  workspace: z.string(),
  type: z.literal('mitzo-openai-keychain-spike'),
  resource_version: z
    .union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)])
    .transform(String),
  credential_keys: z.tuple([z.literal('OPENAI_API_KEY')]),
  config_keys: z.array(z.string()).max(0).default([]),
});
/** Restricted to the existing reviewed OpenAI route. Browser input never chooses destinations. */
export class OpenShellOpenAIKeyGateway implements OpenAIKeyGateway {
  constructor(
    private readonly run: CommandRunner,
    private readonly workspace: string,
    private readonly sandboxes: Pick<
      ConnectionGateway,
      'attachments' | 'stopSandbox' | 'sandboxStopped'
    >,
    private readonly api: Pick<OpenAIKeyGateway, 'inspect' | 'replace'>,
  ) {}
  private command(args: string[], signal: AbortSignal, env: Record<string, string> = {}) {
    return this.run(args, { signal, env, timeoutMs: 30000 });
  }
  async inspect(account: ManagedOpenAIAccount, signal: AbortSignal) {
    try {
      const inventory = z
        .array(z.object({ name: z.string() }).passthrough())
        .parse(
          JSON.parse(
            await this.command(
              ['provider', 'list', '--workspace', this.workspace, '-o', 'json'],
              signal,
            ),
          ),
        );
      const matches = inventory.filter((item) => item.name === account.providerName);
      if (matches.length !== 1) throw new Error();
      const provider = Provider.parse(matches[0]);
      if (
        provider.id !== account.providerId ||
        provider.name !== account.providerName ||
        provider.workspace !== this.workspace
      )
        throw new Error();
      Profile.parse(
        JSON.parse(
          await this.command(
            [
              'provider',
              'profile',
              'export',
              provider.type,
              '--workspace',
              this.workspace,
              '-o',
              'json',
            ],
            signal,
          ),
        ),
      );
      const api = await this.api.inspect(account, signal);
      if (api.version !== provider.resource_version) throw new Error();
      return { version: provider.resource_version };
    } catch {
      throw new Error('OpenAI provider binding changed');
    }
  }
  async pause(account: ManagedOpenAIAccount, signal: AbortSignal) {
    await this.inspect(account, signal);
    try {
      const attached = await this.sandboxes.attachments(account.providerName, signal);
      // Retained histories can contain many workspaces. Bound concurrent control
      // requests, and settle the entire batch before releasing the custody gate.
      for (let offset = 0; offset < attached.length; offset += 4) {
        signal.throwIfAborted();
        const outcomes = await Promise.allSettled(
          attached.slice(offset, offset + 4).map(async (sandbox) => {
            if (await this.sandboxes.sandboxStopped(sandbox, signal)) return;
            await this.sandboxes.stopSandbox(sandbox, signal);
            if (!(await this.sandboxes.sandboxStopped(sandbox, signal))) throw new Error();
          }),
        );
        if (outcomes.some((outcome) => outcome.status === 'rejected')) throw new Error();
      }
    } catch {
      throw new Error('OpenAI chats could not be paused');
    }
  }
  async replace(
    account: ManagedOpenAIAccount,
    value: string,
    expectedVersion: string,
    signal: AbortSignal,
  ) {
    const before = await this.inspect(account, signal);
    if (before.version !== expectedVersion) throw new Error('OpenAI provider binding changed');
    let acknowledged: { version: string };
    try {
      acknowledged = await this.api.replace(account, value, expectedVersion, signal);
    } catch {
      throw new Error('OpenAI gateway update could not be confirmed');
    }
    const after = await this.inspect(account, signal);
    if (
      after.version !== acknowledged.version ||
      BigInt(after.version) !== BigInt(before.version) + 1n
    )
      throw new Error('OpenAI gateway update could not be confirmed');
    return after;
  }
}

/** The attended save flow discloses this bounded Luna 6 low check and its billing account. */
export async function validateOpenAIKey(
  value: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  try {
    const response = await request('https://api.openai.com/v1/models/gpt-6-luna', {
      method: 'GET',
      headers: { Authorization: `Bearer ${value}` },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw new Error();
    z.object({ id: z.literal('gpt-6-luna') }).parse(await response.json());
    const probe = await request('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${value}`, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      body: JSON.stringify({
        model: 'gpt-6-luna',
        reasoning: { effort: 'low' },
        store: false,
        max_output_tokens: 256,
        instructions: 'Reply with exactly MITZO_KEY_OK. Do not add any other text.',
        input: 'Verify this API credential.',
      }),
    });
    if (!probe.ok) throw new Error();
    const result = z
      .object({
        status: z.literal('completed'),
        output: z.array(
          z.object({
            type: z.string(),
            content: z
              .array(z.object({ type: z.string(), text: z.string().optional() }))
              .optional(),
          }),
        ),
      })
      .parse(await probe.json());
    const text = result.output
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text ?? '')
      .join('')
      .trim();
    if (text !== 'MITZO_KEY_OK') throw new Error();
  } catch {
    throw new Error('OpenAI key validation failed');
  }
}
