import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

/** Non-secret lookup coordinates. Never put credential values in an account profile. */
export const CredentialReferenceSchema = z
  .object({
    provider: z.string().regex(/^[a-z][a-z0-9-]*$/),
    service: z.string().min(1).max(256),
    account: z.string().min(1).max(256),
  })
  .strict();
export type CredentialReference = z.infer<typeof CredentialReferenceSchema>;
export interface CredentialProvider {
  resolve(reference: CredentialReference): Promise<string>;
}

/** Provider registration is server-owned. A failed lookup never selects another account. */
export class CredentialResolver {
  constructor(private providers: Record<string, CredentialProvider>) {}
  async resolve(reference: CredentialReference): Promise<string> {
    const parsed = CredentialReferenceSchema.safeParse(reference);
    if (!parsed.success) throw new Error('Invalid credential reference');
    const provider = Object.hasOwn(this.providers, parsed.data.provider)
      ? this.providers[parsed.data.provider]
      : undefined;
    if (!provider) throw new Error('Credential provider is unavailable');
    try {
      const secret = await provider.resolve(parsed.data);
      if (!secret.trim()) throw new Error('Empty credential');
      return secret;
    } catch {
      // Secret stores can include credential values in errors. Do not retain their cause.
      throw new Error('Credential unavailable. Check the configured secret store.');
    }
  }
}

const execute = promisify(execFile);
type Run = (file: string, args: string[]) => Promise<string>;
const runKeychain: Run = async (file, args) => {
  const { stdout } = await execute(file, args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    env: { PATH: '/usr/bin:/bin' },
  });
  return stdout;
};
export class KeychainCredentialProvider implements CredentialProvider {
  constructor(private run: Run = runKeychain) {}
  async resolve(reference: CredentialReference): Promise<string> {
    const output = await this.run('/usr/bin/security', [
      'find-generic-password',
      '-s',
      reference.service,
      '-a',
      reference.account,
      '-w',
    ]);
    return output.replace(/\r?\n$/, '');
  }
}
export const credentials = new CredentialResolver({ keychain: new KeychainCredentialProvider() });
