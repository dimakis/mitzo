/* eslint-disable preserve-caught-error -- Native Keychain diagnostics may contain credentials; never retain their causes. */
import { isAbsolute } from 'node:path';
import { KeychainController } from './keychain-controller.js';
import { MacKeychainVault, KeychainUnavailableError } from './keychain-vault.js';
import { z } from 'zod';
import { CredentialReferenceSchema, type CredentialReference } from './credentials.js';
import {
  OpenAIKeychainAuthorizationRequired,
  type VersionedKeychain,
} from './openai-key-management.js';

/** Use the existing authenticated, signed Mitzo helper. There is no interpreter fallback. */
type Run = (stdin: string, signal: AbortSignal) => Promise<string>;
const nativeRun: Run = async (stdin, signal) => {
  signal.throwIfAborted();
  const file = process.env.MITZO_KEYCHAIN_HELPER;
  const team = process.env.MITZO_KEYCHAIN_TEAM_ID;
  const namespace = process.env.MITZO_KEYCHAIN_CONNECTIONS_NAMESPACE ?? 'default';
  if (
    process.platform !== 'darwin' ||
    !file ||
    !isAbsolute(file) ||
    !team ||
    !/^[A-Z0-9]{10}$/.test(team)
  )
    throw new Error('Keychain unavailable');
  const request = JSON.parse(stdin) as {
    action: string;
    service: string;
    account: string;
    value?: string;
    version?: string;
    expectedVersion?: string | null;
  };
  const vault = new MacKeychainVault(
    file,
    `identifier "com.mitzo.keychain-helper" and anchor apple generic and certificate leaf[subject.OU] = "${team}"`,
    undefined,
    undefined,
    new KeychainController(undefined, namespace),
  );
  try {
    const result = await vault.rotateOpenAI(
      { service: request.service, account: request.account },
      request.action === 'create'
        ? 'rotation-create'
        : request.action === 'read'
          ? 'rotation-read'
          : request.action === 'authorize'
            ? 'rotation-authorize'
            : 'rotation-write',
      request.action === 'create'
        ? { secret: request.value, version: request.version }
        : request.action === 'write'
          ? {
              secret: request.value,
              version: request.version,
              expectedVersion: request.expectedVersion,
            }
          : {},
      signal,
    );
    signal.throwIfAborted();
    return JSON.stringify(
      request.action === 'read'
        ? { value: result.value, version: result.version, managed: result.managed }
        : { ok: result.ok },
    );
  } catch (error) {
    if (error instanceof KeychainUnavailableError && error.code === 'unlock_on_mac')
      throw new OpenAIKeychainAuthorizationRequired();
    throw new Error('Keychain unavailable');
  }
};
const SecretValue = z
  .object({ value: z.string().min(1).max(16384), version: z.uuid().nullable() })
  .strict();
const Secret = SecretValue.extend({ managed: z.boolean() }).refine(
  (value) => value.version === null || value.managed,
);
export class KeychainRotationCredentials implements VersionedKeychain {
  constructor(private readonly run: Run = nativeRun) {}
  private async request(
    reference: CredentialReference,
    action: 'read' | 'write' | 'authorize' | 'create',
    signal: AbortSignal,
    extra: Record<string, string | null> = {},
  ) {
    try {
      const ref = CredentialReferenceSchema.parse(reference);
      if (ref.provider !== 'keychain') throw new Error();
      return JSON.parse(
        await this.run(
          JSON.stringify({ action, service: ref.service, account: ref.account, ...extra }),
          signal,
        ),
      ) as unknown;
    } catch (error) {
      if (error instanceof OpenAIKeychainAuthorizationRequired) throw error;
      throw new Error('Keychain unavailable');
    }
  }
  async create(
    reference: CredentialReference,
    value: string,
    version: string,
    signal: AbortSignal,
  ) {
    SecretValue.parse({ value, version });
    z.object({ ok: z.literal(true) })
      .strict()
      .parse(await this.request(reference, 'create', signal, { value, version }));
  }
  async authorize(reference: CredentialReference, signal: AbortSignal) {
    z.object({ ok: z.literal(true) })
      .strict()
      .parse(await this.request(reference, 'authorize', signal));
  }
  async read(reference: CredentialReference, signal: AbortSignal) {
    try {
      return Secret.parse(await this.request(reference, 'read', signal));
    } catch (error) {
      if (error instanceof OpenAIKeychainAuthorizationRequired) throw error;
      throw new Error('Keychain unavailable');
    }
  }
  async write(
    reference: CredentialReference,
    value: string,
    version: string,
    signal: AbortSignal,
    expectedVersion: string | null = null,
  ) {
    try {
      SecretValue.parse({ value, version });
      z.object({ ok: z.literal(true) })
        .strict()
        .parse(await this.request(reference, 'write', signal, { value, version, expectedVersion }));
    } catch (error) {
      if (error instanceof OpenAIKeychainAuthorizationRequired) throw error;
      throw new Error('Keychain unavailable');
    }
  }
}
