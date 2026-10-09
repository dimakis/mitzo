import { z } from 'zod';
import type { CredentialReference } from './credentials.js';
import { KeychainRotationCredentials } from './keychain-rotation-credentials.js';

export function openAIEnrollmentCredentialReference(operationId: string): CredentialReference {
  const id = z.uuid().parse(operationId);
  return { provider: 'keychain', service: 'mitzo.openai.enrollment.' + id, account: 'api-key' };
}
/** The same signed identity creates and verifies secret+receipt atomically; duplicates never overwrite. */
type Run = (stdin: string, signal: AbortSignal) => Promise<string>;
const nativeRun: Run = async (stdin, signal) => {
  const request = JSON.parse(stdin) as {
    service: string;
    account: string;
    value: string;
    version: string;
  };
  await new KeychainRotationCredentials().create(
    { provider: 'keychain', service: request.service, account: request.account },
    request.value,
    request.version,
    signal,
  );
  return JSON.stringify({ ok: true });
};
export class OpenAIEnrollmentKeychainCredentials {
  constructor(
    private readonly run: Run = nativeRun,
    private readonly reader = new KeychainRotationCredentials(),
  ) {}
  async create(operationId: string, value: string, signal: AbortSignal) {
    try {
      const reference = openAIEnrollmentCredentialReference(operationId);
      z.string().min(1).max(16384).parse(value);
      signal.throwIfAborted();
      z.object({ ok: z.literal(true) })
        .strict()
        .parse(
          JSON.parse(
            await this.run(
              JSON.stringify({
                service: reference.service,
                account: reference.account,
                value,
                version: operationId,
              }),
              signal,
            ),
          ),
        );
      return reference;
    } catch {
      throw new Error('OpenAI Keychain creation could not be confirmed');
    }
  }
  read(reference: CredentialReference, signal: AbortSignal) {
    return this.reader.read(reference, signal);
  }
}
