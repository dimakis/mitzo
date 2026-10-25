import { z } from 'zod';

export const SecretVaultReferenceSchema = z
  .object({
    gateway: z.string().min(1),
    workspace: z.string().min(1),
    name: z.string().regex(/^mitzo-secret-[0-9a-f-]{36}$/),
    providerId: z.string().min(1),
    version: z.string().regex(/^[1-9][0-9]*$/),
    profileVersion: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
export type SecretVaultReference = z.infer<typeof SecretVaultReferenceSchema>;
export interface SecretVault {
  save(id: string, value: string, signal: AbortSignal): Promise<SecretVaultReference>;
  read(ref: SecretVaultReference, signal: AbortSignal): Promise<string>;
}
export type SecretOperatorRpc = (
  method: 'GetProviderProfile' | 'CreateProvider' | 'GetProvider' | 'GetProviderCredentials',
  request: object,
  signal: AbortSignal,
) => Promise<unknown>;
const key = 'MITZO_SECRET_VALUE';
const profileId = 'mitzo-secret-relay';
const valueSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= 16384);
const version = z.string().regex(/^[1-9][0-9]*$/);
/** Host-only operator boundary. Never attach these providers to agent sandboxes.
 * No tool exposes read(), raw Gateway responses, or operator authentication. */
export class OpenShellSecretVault implements SecretVault {
  constructor(
    private gateway: string,
    private workspace: string,
    private rpc: SecretOperatorRpc,
  ) {}
  private async profile(signal: AbortSignal) {
    const { profile } = z
      .object({
        profile: z.object({
          id: z.literal(profileId),
          resource_version: version,
          credentials: z.array(
            z.object({
              name: z.literal('value'),
              env_vars: z.tuple([z.literal(key)]),
              required: z.literal(true),
              auth_style: z.string().optional(),
              header_name: z.string().optional(),
              query_param: z.string().optional(),
              path_template: z.string().optional(),
              refresh: z.unknown().optional(),
              token_grant: z.unknown().optional(),
            }),
          ),
          endpoints: z.array(z.unknown()).optional(),
          binaries: z.array(z.unknown()).optional(),
          files: z.array(z.unknown()).optional(),
          discovery: z.unknown().optional(),
          inference_capable: z.boolean().optional(),
        }),
      })
      .parse(
        await this.rpc(
          'GetProviderProfile',
          { id: profileId, workspace_scope: { workspace: this.workspace } },
          signal,
        ),
      );
    const credential = profile.credentials[0];
    if (
      profile.credentials.length !== 1 ||
      !credential ||
      credential.refresh ||
      credential.token_grant ||
      credential.auth_style ||
      credential.header_name ||
      credential.query_param ||
      credential.path_template ||
      profile.endpoints?.length ||
      profile.binaries?.length ||
      profile.files?.length ||
      profile.discovery ||
      profile.inference_capable
    )
      throw new Error();
    return profile.resource_version;
  }
  private checked(value: unknown, name: string, expected?: SecretVaultReference) {
    const { provider } = z
      .object({
        provider: z.object({
          metadata: z.object({
            id: z.string().min(1),
            name: z.literal(name),
            workspace: z.literal(this.workspace),
            resource_version: version,
          }),
          type: z.literal(profileId),
          profile_workspace: z.literal(this.workspace),
          credentials: z.record(z.string(), z.string()),
          config: z.record(z.string(), z.string()).optional(),
        }),
      })
      .parse(value);
    if (
      Object.keys(provider.credentials).join(',') !== key ||
      Object.keys(provider.config ?? {}).length ||
      (expected &&
        (provider.metadata.id !== expected.providerId ||
          provider.metadata.resource_version !== expected.version))
    )
      throw new Error();
    return provider.metadata;
  }
  async save(id: string, value: string, signal: AbortSignal): Promise<SecretVaultReference> {
    try {
      z.string().uuid().parse(id);
      valueSchema.parse(value);
      signal.throwIfAborted();
      const profileVersion = await this.profile(signal);
      const name = `mitzo-secret-${id}`;
      const metadata = this.checked(
        await this.rpc(
          'CreateProvider',
          {
            workspace_scope: { workspace: this.workspace },
            request_id: id,
            provider: {
              metadata: { name, workspace: this.workspace },
              type: profileId,
              profile_workspace: this.workspace,
              credentials: { [key]: value },
            },
          },
          signal,
        ),
        name,
      );
      signal.throwIfAborted();
      return SecretVaultReferenceSchema.parse({
        gateway: this.gateway,
        workspace: this.workspace,
        name,
        providerId: metadata.id,
        version: metadata.resource_version,
        profileVersion,
      });
    } catch {
      throw new Error('Secret storage unavailable; check status before retrying');
    }
  }
  async read(reference: SecretVaultReference, signal: AbortSignal): Promise<string> {
    try {
      const ref = SecretVaultReferenceSchema.parse(reference);
      if (ref.gateway !== this.gateway || ref.workspace !== this.workspace) throw new Error();
      signal.throwIfAborted();
      if ((await this.profile(signal)) !== ref.profileVersion) throw new Error();
      const check = async () =>
        this.checked(
          await this.rpc(
            'GetProvider',
            { workspace_scope: { workspace: this.workspace }, name: ref.name },
            signal,
          ),
          ref.name,
          ref,
        );
      await check();
      const result = z
        .object({
          credentials: z.object({ MITZO_SECRET_VALUE: z.object({ value: valueSchema }) }).strict(),
        })
        .parse(
          await this.rpc(
            'GetProviderCredentials',
            {
              workspace_scope: { workspace: this.workspace },
              name: ref.name,
              credential_keys: [key],
            },
            signal,
          ),
        );
      await check();
      signal.throwIfAborted();
      return result.credentials.MITZO_SECRET_VALUE.value;
    } catch {
      throw new Error('Secret unavailable');
    }
  }
}
