import { z } from 'zod';
import type { ManagedOpenAIAccount, OpenAIKeyGateway } from './openai-key-management.js';
import { openShellKeyApiService } from './openshell-key-api-protocol.js';
import { OpenShellOperatorTransport } from './openshell-operator-transport.js';
const Version = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
const Response = z.object({
  provider: z.object({
    metadata: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      workspace: z.string().min(1),
      resource_version: Version,
    }),
    type: z.literal('mitzo-openai-keychain-spike'),
    credentials: z.record(z.string(), z.unknown()),
    config: z.record(z.string(), z.unknown()).optional(),
    profile_workspace: z.string().optional(),
  }),
});
export class OpenShellProviderKeyApi implements Pick<OpenAIKeyGateway, 'inspect' | 'replace'> {
  private transport: OpenShellOperatorTransport;
  constructor(
    private readonly options: {
      home: string;
      gateway: string;
      endpoint?: string;
      workspace: string;
      protocol?: string;
    },
  ) {
    this.transport = new OpenShellOperatorTransport(options);
  }
  private checked(value: unknown, account: ManagedOpenAIAccount) {
    const provider = Response.parse(value).provider;
    const metadata = provider.metadata;
    if (
      metadata.id !== account.providerId ||
      metadata.name !== account.providerName ||
      metadata.workspace !== this.options.workspace ||
      Object.keys(provider.credentials).join(',') !== 'OPENAI_API_KEY' ||
      Object.keys(provider.config ?? {}).length ||
      (provider.profile_workspace && provider.profile_workspace !== this.options.workspace)
    )
      throw new Error();
    return {
      version: metadata.resource_version,
      profileWorkspace: provider.profile_workspace ?? '',
    };
  }
  private async read(account: ManagedOpenAIAccount, signal: AbortSignal) {
    return this.checked(
      await this.transport.request(
        openShellKeyApiService.GetProvider,
        { name: account.providerName, workspace: this.options.workspace },
        signal,
      ),
      account,
    );
  }
  async inspect(account: ManagedOpenAIAccount, signal: AbortSignal) {
    try {
      const value = await this.read(account, signal);
      return { version: value.version };
    } catch {
      throw new Error('OpenAI gateway API is unavailable');
    }
  }
  async replace(
    account: ManagedOpenAIAccount,
    value: string,
    expectedVersion: string,
    signal: AbortSignal,
  ) {
    try {
      Version.parse(expectedVersion);
      if (!value || Buffer.byteLength(value) > 16384) throw new Error();
      const before = await this.read(account, signal);
      if (before.version !== expectedVersion) throw new Error();
      // Preserve the caller's durable version. Never replace it with a new read's version or retry a conflict.
      const result = this.checked(
        await this.transport.request(
          openShellKeyApiService.UpdateProvider,
          {
            workspace: this.options.workspace,
            provider: {
              metadata: {
                id: account.providerId,
                name: account.providerName,
                workspace: this.options.workspace,
                resource_version: expectedVersion,
              },
              type: 'mitzo-openai-keychain-spike',
              profile_workspace: before.profileWorkspace,
              credentials: { OPENAI_API_KEY: value },
            },
          },
          signal,
        ),
        account,
      );
      if (BigInt(result.version) !== BigInt(expectedVersion) + 1n) throw new Error();
      return { version: result.version };
    } catch {
      throw new Error('OpenAI gateway API update could not be confirmed');
    }
  }
}
