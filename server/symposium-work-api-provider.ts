import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AccountProfiles } from './account-profiles.js';
import { credentials, CredentialReferenceSchema, type CredentialResolver } from './credentials.js';
import { CatalogModel } from './model-catalog.js';
import { validateOpenShellCliEnvironment } from './openshell-cli-environment.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import { StagingApiBillingScopeSchema } from './staging-api-billing-scope.js';

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

export interface SymposiumWorkApiCreationCapability {
  readonly identity: Readonly<{
    accountId: string;
    provider: 'openai';
    providerName: string;
    providerId: string;
    workspace: string;
  }>;
  assertCurrent(): void;
}
const originalCreations = new WeakMap<
  OwnedSymposiumGateway,
  Map<string, SymposiumWorkApiCreationCapability>
>();
export interface SymposiumWorkApiCatalogCapability {
  readonly observation: Readonly<{
    version: 1;
    providerId: string;
    providerName: string;
    workspace: string;
    organizationId: string;
    projectId: string;
    selectedModel: string;
    credentialSha256: string;
    catalogSha256: string;
    /** Distinct source-minted epoch of an accepted authenticated observation. */
    observationRevision: string;
    listedModels: readonly string[];
    observedAt: number;
    expiresAt: number;
    requestId: string | null;
    /** Billing-scope proof from accepted exact headers, not principal identity. */
    accountHeaders: Readonly<{ 'OpenAI-Organization': string; 'OpenAI-Project': string }>;
  }>;
  assertCurrent(): void;
}
const originalCatalogs = new WeakMap<
  OwnedSymposiumGateway,
  Map<string, SymposiumWorkApiCatalogCapability>
>();
const originalCatalogRefreshers = new WeakMap<
  OwnedSymposiumGateway,
  Map<string, () => Promise<SymposiumWorkApiCatalogCapability>>
>();
/** Read-only operation on the same retained creation and credential reference.
 * No new provider, runtime or inferred principal is created by a refresh. */
export async function refreshSymposiumWorkApiCatalog(
  gateway: OwnedSymposiumGateway,
  providerId: string,
): Promise<SymposiumWorkApiCatalogCapability> {
  const refresh = originalCatalogRefreshers.get(gateway)?.get(providerId);
  if (!refresh) throw Error('Original authenticated API catalog refresh unavailable');
  return refresh();
}
function publishCatalog(
  gateway: OwnedSymposiumGateway,
  receipt: SymposiumWorkApiCreationCapability,
  catalog: Awaited<ReturnType<typeof authenticatedCatalog>>,
): SymposiumWorkApiCatalogCapability {
  receipt.assertCurrent();
  const identity = receipt.identity;
  const catalogs = originalCatalogs.get(gateway) ?? new Map();
  const capability: SymposiumWorkApiCatalogCapability = Object.freeze({
    observation: Object.freeze({
      version: 1 as const,
      providerId: identity.providerId,
      providerName: identity.providerName,
      workspace: identity.workspace,
      ...catalog,
    }),
    assertCurrent() {
      try {
        receipt.assertCurrent();
        if (
          Date.now() >= catalog.expiresAt ||
          originalCatalogs.get(gateway)?.get(identity.providerId) !== capability
        )
          throw Error();
      } catch {
        // An expired/replaced capability cannot invalidate its fresh successor.
        if (originalCatalogs.get(gateway)?.get(identity.providerId) === capability)
          originalCatalogs.get(gateway)?.delete(identity.providerId);
        throw Error('Original authenticated API catalog capability unavailable');
      }
    },
  });
  catalogs.set(identity.providerId, capability);
  originalCatalogs.set(gateway, catalogs);
  return capability;
}
export function captureSymposiumWorkApiCatalog(
  gateway: OwnedSymposiumGateway,
  providerId: string,
): SymposiumWorkApiCatalogCapability {
  const capability = originalCatalogs.get(gateway)?.get(providerId);
  if (!capability) throw Error('Original authenticated API catalog capability unavailable');
  capability.assertCurrent();
  return capability;
}
async function authenticatedCatalog(
  gateway: OwnedSymposiumGateway,
  profile: SymposiumWorkApiProfile,
  secret: string,
  rawScope: z.infer<typeof StagingApiBillingScopeSchema>,
  request: typeof fetch,
) {
  const scope = StagingApiBillingScopeSchema.parse(rawScope);
  const selectedModel = profile.models.find((model) =>
    /^gpt-\d+(?:\.\d+)?-luna$/.test(model.id),
  )?.id;
  if (!selectedModel || !/^[^\s]{1,16384}$/.test(secret))
    throw Error('Explicit staging Luna and fresh credential required');
  const accountHeaders = Object.freeze({
    'OpenAI-Organization': scope.organizationId,
    'OpenAI-Project': scope.projectId,
  });
  gateway.verifyCustody();
  const response = await request('https://api.openai.com/v1/models', {
    method: 'GET',
    headers: { authorization: `Bearer ${secret}`, ...accountHeaders },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  gateway.verifyCustody();
  if (
    response.status !== 200 ||
    response.redirected ||
    (response.url && response.url !== 'https://api.openai.com/v1/models') ||
    !response.body ||
    Number(response.headers.get('content-length')) > 131072
  )
    throw Error('Authenticated bounded API catalog unavailable');
  const returnedOrg = response.headers.get('openai-organization');
  if (returnedOrg !== null && returnedOrg !== scope.organizationId)
    throw Error('Authenticated API organization differs');
  // Organization is a documented common response header, not guaranteed;
  // no returned-project header is documented. The accepted authenticated
  // request's exact fixed headers establish billing scope, never a principal.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      gateway.verifyCustody();
      if (next.done) break;
      size += next.value.length;
      if (size > 131072) {
        await reader.cancel();
        throw Error('Authenticated API catalog exceeded bound');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks);
  const parsed = z
    .object({
      object: z.literal('list'),
      data: z
        .array(
          z.object({
            id: z.string().min(1).max(200),
            object: z.literal('model'),
            created: z.number().int().nonnegative(),
            owned_by: z.string().min(1).max(200),
          }),
        )
        .max(1000),
    })
    .parse(JSON.parse(body.toString('utf8')));
  const listedModels = parsed.data.map((model) => model.id).sort();
  if (new Set(listedModels).size !== listedModels.length || !listedModels.includes(selectedModel))
    throw Error('Exact staging Luna is unavailable');
  const requestId = response.headers.get('x-request-id');
  if (requestId !== null && !/^[A-Za-z0-9_-]{1,200}$/.test(requestId))
    throw Error('Bounded API request identity required');
  const observedAt = Date.now();
  return {
    ...scope,
    selectedModel,
    accountHeaders,
    credentialSha256: createHash('sha256').update(secret).digest('hex'),
    catalogSha256: createHash('sha256').update(body).digest('hex'),
    observationRevision: randomBytes(32).toString('hex'),
    listedModels: Object.freeze(listedModels),
    observedAt,
    expiresAt: observedAt + 300000,
    requestId,
  };
}
/** Fresh creation in this exact gateway owner. Inventory JSON and reopened
 * configurations cannot recreate the original enrollment capability. */
export function captureSymposiumWorkApiProvider(
  gateway: OwnedSymposiumGateway,
  providerId: string,
): SymposiumWorkApiCreationCapability {
  const receipt = originalCreations.get(gateway)?.get(providerId);
  if (!receipt) throw Error('Original fresh work API creation capability unavailable');
  receipt.assertCurrent();
  return receipt;
}

/** Explicit host operation. Only this call resolves the named secret reference;
 * importing this module never touches the keychain, gateway or active profile file.
 * The returned profile binds a freshly created provider on the owned gateway. */
export async function createSymposiumWorkApiProvider(
  gateway: OwnedSymposiumGateway,
  input: SymposiumWorkApiProfile,
  dependencies: {
    resolver?: Pick<CredentialResolver, 'resolve'>;
    run?: typeof spawnSync;
    /** Source-owned reviewed stage scope; no ambient env/profile label fallback. */
    stagingCatalogScope?: z.infer<typeof StagingApiBillingScopeSchema>;
    request?: typeof fetch;
  } = {},
): Promise<SymposiumWorkApiProfile & { sandboxProvider: string; sandboxProviderId: string }> {
  const profile = WorkProfile.parse(input);
  const catalogProfile = WorkProfile.parse(profile);
  new AccountProfiles([profile]);
  const environment = validateOpenShellCliEnvironment(gateway.managementEnvironment);
  const run = dependencies.run ?? spawnSync;
  const resolver = dependencies.resolver ?? credentials;
  const resolveCredential = resolver.resolve.bind(resolver);
  const request = dependencies.request ?? fetch;
  const scope = dependencies.stagingCatalogScope
    ? Object.freeze(StagingApiBillingScopeSchema.parse(dependencies.stagingCatalogScope))
    : undefined;
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
    const secret = await resolveCredential(profile.credentialRef);
    gateway.verifyCustody();
    if (!secret.trim()) throw new Error('Work credential unavailable');
    const catalog = scope
      ? await authenticatedCatalog(gateway, catalogProfile, secret, scope, request)
      : undefined;
    gateway.verifyCustody();
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
    const retained = originalCreations.get(gateway) ?? new Map();
    const identity = Object.freeze({
      accountId: profile.id,
      provider: 'openai' as const,
      providerName: provider,
      providerId: found.id,
      workspace: gateway.workspace,
    });
    const receipt: SymposiumWorkApiCreationCapability = Object.freeze({
      identity,
      assertCurrent() {
        try {
          gateway.verifyCustody();
          if (
            originalCreations.get(gateway)?.get(identity.providerId) !== receipt ||
            gateway.workspace !== identity.workspace
          )
            throw Error();
        } catch {
          originalCreations.delete(gateway);
          throw Error('Original fresh work API creation capability unavailable');
        }
      },
    });
    retained.set(found.id, receipt);
    originalCreations.set(gateway, retained);
    if (catalog) {
      publishCatalog(gateway, receipt, catalog);
      const refreshers = originalCatalogRefreshers.get(gateway) ?? new Map();
      let refreshing = false;
      const originalCredentialSha256 = catalog.credentialSha256;
      refreshers.set(identity.providerId, async () => {
        if (refreshing) throw Error('Original authenticated API catalog refresh unavailable');
        refreshing = true;
        originalCatalogs.get(gateway)?.delete(identity.providerId);
        try {
          receipt.assertCurrent();
          const freshSecret = await resolveCredential(catalogProfile.credentialRef);
          receipt.assertCurrent();
          if (createHash('sha256').update(freshSecret).digest('hex') !== originalCredentialSha256)
            throw Error();
          // Read metadata from the actual original gateway. Inventory is only an
          // identity observation; the native issuer must still verify its actual
          // current credential identity/revision/hash before any inference.
          const page = invoke(['list', '--output', 'json', '--page-size', '100']) as {
            providers?: Array<Record<string, unknown>>;
            next_page_token?: string;
          };
          if (!Array.isArray(page.providers) || page.next_page_token !== '') throw Error();
          const matches = page.providers.filter((row) => row.id === identity.providerId);
          if (
            matches.length !== 1 ||
            matches[0].name !== identity.providerName ||
            matches[0].workspace !== identity.workspace ||
            matches[0].type !== identity.provider
          )
            throw Error();
          const fresh = await authenticatedCatalog(
            gateway,
            catalogProfile,
            freshSecret,
            scope!,
            request,
          );
          receipt.assertCurrent();
          return publishCatalog(gateway, receipt, fresh);
        } catch {
          originalCatalogs.get(gateway)?.delete(identity.providerId);
          throw Error('Original authenticated API catalog refresh unavailable');
        } finally {
          refreshing = false;
        }
      });
      originalCatalogRefreshers.set(gateway, refreshers);
    }
    return { ...profile, sandboxProvider: provider, sandboxProviderId: found.id };
  } catch {
    // Secret-store and process errors may contain credentials; do not retain causes.
    throw new Error('Work API provisioning failed; no new account profile was published');
  }
}
