import { z } from 'zod';
import type { CommandRunner } from './connections-gateway.js';
import { attestEffectiveRuntimePolicy } from './openshell-runtime-policy.js';

const profileType = 'mitzo-openai-keychain-spike';
const OperationId = z.uuid();
const Provider = z.object({
  name: z.string(),
  id: z.uuid(),
  workspace: z.string(),
  type: z.literal(profileType),
  resource_version: z
    .union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]*$/)])
    .transform(String),
  credential_keys: z.tuple([z.literal('OPENAI_API_KEY')]),
  // The pinned CLI omits config_keys for an empty map.
  config_keys: z.array(z.string()).max(0).default([]),
});
export interface OpenAIEnrollmentProvider {
  name: string;
  id: string;
  workspace: string;
  type: typeof profileType;
  version: string;
}
/** A durable pending operation must survive this error; never retry create automatically. */
export class OpenAIProviderCreationUnconfirmedError extends Error {
  constructor() {
    super('OpenAI provider creation could not be confirmed; inspect the pending enrollment');
    this.name = 'OpenAIProviderCreationUnconfirmedError';
  }
}

/** Create-only enrollment uses the accepted CLI, without unconditional credential updates. */
export class OpenShellOpenAIEnrollmentGateway {
  constructor(
    private readonly run: CommandRunner,
    private readonly workspace: string,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(workspace))
      throw new Error('Invalid OpenAI enrollment workspace');
  }
  providerName(operationId: string): string {
    return `mitzo-openai-${OperationId.parse(operationId)}`;
  }
  private command(args: string[], signal: AbortSignal, env: Record<string, string> = {}) {
    return this.run(args, { signal, env, timeoutMs: 30000 });
  }
  private async verifyProfile(signal: AbortSignal) {
    const profile: unknown = JSON.parse(
      await this.command(
        ['provider', 'profile', 'export', profileType, '--workspace', this.workspace, '-o', 'json'],
        signal,
      ),
    );
    const materialization = z
      .object({ endpoints: z.array(z.unknown()), binaries: z.array(z.string()) })
      .passthrough()
      .parse(profile);
    // Reuse the exact reviewed profile/provenance checker. This synthetic empty
    // base validates only the profile; it is not evidence of a sandbox's policy.
    attestEffectiveRuntimePolicy(
      { network_policies: {} },
      {
        network_policies: {
          _provider_profile_check: {
            name: '_provider_profile_check',
            ...(materialization.endpoints.length ? { endpoints: materialization.endpoints } : {}),
            ...(materialization.binaries.length
              ? { binaries: materialization.binaries.map((path) => ({ path })) }
              : {}),
          },
        },
      },
      [{ name: 'profile-check', id: 'profile-only-observation', type: profileType, profile }],
    );
  }
  /** Secret-free metadata observation; absence requires a successful complete inventory. */
  async inspect(
    operationId: string,
    signal: AbortSignal,
  ): Promise<OpenAIEnrollmentProvider | undefined> {
    const name = this.providerName(operationId);
    try {
      await this.verifyProfile(signal);
      const inventory: { name: string; [key: string]: unknown }[] = [];
      for (let offset = 0; ; offset += 100) {
        signal.throwIfAborted();
        const page = z
          .array(z.object({ name: z.string() }).passthrough())
          .max(100)
          .parse(
            JSON.parse(
              await this.command(
                [
                  'provider',
                  'list',
                  '--workspace',
                  this.workspace,
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
        inventory.push(...page);
        if (new Set(inventory.map((item) => item.name)).size !== inventory.length)
          throw new Error();
        if (page.length < 100) break;
        // A full final page cannot prove completeness. Fail closed instead of
        // confusing a provider beyond the bounded inventory with absence.
        if (inventory.length >= 1000) throw new Error();
      }
      const matches = inventory.filter((item) => item.name === name);
      if (matches.length === 0) return undefined;
      if (matches.length !== 1) throw new Error();
      const provider = Provider.parse(matches[0]);
      // Fresh enrollment never updates a provider. Any later version could
      // contain another credential and cannot acknowledge this operation.
      if (provider.workspace !== this.workspace || provider.resource_version !== '1')
        throw new Error();
      return {
        name,
        id: provider.id,
        type: provider.type,
        workspace: provider.workspace,
        version: provider.resource_version,
      };
    } catch {
      throw new Error('OpenAI enrollment provider could not be verified');
    }
  }
  /** Call only after persisting fresh durable intent under the admission/mutation fence. */
  async create(
    operationId: string,
    value: string,
    signal: AbortSignal,
  ): Promise<OpenAIEnrollmentProvider> {
    const name = this.providerName(operationId);
    if (!value.trim() || value.length > 16384)
      throw new Error('Invalid OpenAI enrollment credential');
    if (await this.inspect(operationId, signal))
      throw new Error('OpenAI enrollment provider already exists');
    try {
      await this.command(
        [
          'provider',
          'create',
          '--name',
          name,
          '--type',
          profileType,
          '--workspace',
          this.workspace,
          '--credential',
          'OPENAI_API_KEY',
        ],
        signal,
        { OPENAI_API_KEY: value },
      );
      const provider = await this.inspect(operationId, signal);
      if (!provider) throw new Error();
      return provider;
    } catch {
      // CLI output can contain the one-shot key. Preserve neither output nor cause.
      throw new OpenAIProviderCreationUnconfirmedError();
    }
  }
}
