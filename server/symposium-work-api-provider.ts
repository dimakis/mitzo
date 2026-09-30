import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AccountProfiles } from './account-profiles.js';
import { credentials, CredentialReferenceSchema, type CredentialResolver } from './credentials.js';
import { CatalogModel } from './model-catalog.js';
import { validateOpenShellCliEnvironment } from './openshell-cli-environment.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';

const WorkProfile = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    label: z.string().min(1),
    provider: z.literal('openai'),
    credentialRef: CredentialReferenceSchema,
    models: z.array(CatalogModel.strict()).min(1),
    // Existing bindings are accepted as source metadata only and always replaced.
    sandboxProvider: z.string().optional(),
    sandboxProviderId: z.string().optional(),
  })
  .strict();
export type SymposiumWorkApiProfile = z.infer<typeof WorkProfile>;

/** Explicit host operation. Only this call resolves the named secret reference;
 * importing this module never touches the keychain, gateway or active profile file.
 * The returned profile binds a freshly created provider on the owned gateway. */
export async function createSymposiumWorkApiProvider(
  gateway: OwnedSymposiumGateway,
  input: SymposiumWorkApiProfile,
  dependencies: { resolver?: Pick<CredentialResolver, 'resolve'>; run?: typeof spawnSync } = {},
): Promise<SymposiumWorkApiProfile & { sandboxProvider: string; sandboxProviderId: string }> {
  const profile = WorkProfile.parse(input);
  new AccountProfiles([profile]);
  const environment = validateOpenShellCliEnvironment(gateway.managementEnvironment);
  const run = dependencies.run ?? spawnSync;
  const provider = `symposium-work-${randomBytes(12).toString('hex')}`;
  const invoke = (args: string[], secret?: string): unknown => {
    gateway.verifyCustody();
    const result = run(
      gateway.cli,
      ['provider', '--gateway', gateway.gateway, '--workspace', gateway.workspace, ...args],
      {
        env: { ...environment, ...(secret ? { OPENAI_API_KEY: secret } : {}) },
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1_000_000,
      },
    );
    gateway.verifyCustody();
    if (result.error || result.status !== 0) throw new Error('Work API provider operation failed');
    if (args[0] !== 'list') return undefined;
    return JSON.parse(String(result.stdout));
  };
  try {
    gateway.verifyCustody();
    const secret = await (dependencies.resolver ?? credentials).resolve(profile.credentialRef);
    gateway.verifyCustody();
    if (!secret.trim()) throw new Error('Work credential unavailable');
    invoke(
      ['create', '--name', provider, '--type', 'openai', '--credential', 'OPENAI_API_KEY'],
      secret,
    );
    const matches: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let token = '';
    do {
      const page = invoke([
        'list',
        '--output',
        'json',
        '--page-size',
        '100',
        ...(token ? ['--page-token', token] : []),
      ]) as {
        providers?: Array<Record<string, unknown>>;
        next_page_token?: string;
      };
      if (!Array.isArray(page.providers) || typeof page.next_page_token !== 'string')
        throw new Error('Invalid provider inventory');
      matches.push(...page.providers.filter((row) => row.name === provider));
      token = page.next_page_token;
      if (token && seen.has(token)) throw new Error('Repeated inventory page');
      seen.add(token);
      if (seen.size > 1000) throw new Error('Provider inventory exceeded bound');
    } while (token);
    const found = matches[0];
    if (
      matches.length !== 1 ||
      typeof found.id !== 'string' ||
      !found.id ||
      found.type !== 'openai' ||
      found.workspace !== gateway.workspace
    )
      throw new Error('Created work API provider identity is unavailable');
    gateway.verifyCustody();
    return { ...profile, sandboxProvider: provider, sandboxProviderId: found.id };
  } catch {
    // Secret-store and process errors may contain credentials; do not retain causes.
    throw new Error('Work API provisioning failed; no new account profile was published');
  }
}
