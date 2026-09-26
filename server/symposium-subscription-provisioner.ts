import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AccountBinding } from '@mitzo/protocol';
import type { VerifySymposiumSubscriptionAuth } from './symposium-subscription-native.js';

const issuer = 'https://auth.openai.com';
const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
const redirect = 'http://localhost:1455/auth/callback';
const random = () => randomBytes(32).toString('base64url');
export interface SubscriptionTokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  account_id?: string;
}
export interface SubscriptionIdentity {
  subject: string;
  accountId: string;
  email: string;
  planType: string;
}
/** Host-only dependencies, never supplied by an HTTP request or account profile. */
export interface SubscriptionProvisioningHost {
  readonly workspace: string;
  /** Must prove exclusive management custody of the same live, freshly created gateway. */
  verifyCustody(): void;
  run(args: string[], secretEnvironment?: Record<string, string>): Promise<unknown>;
  installProfile(
    input: SubscriptionIdentity & { provider: string; providerId: string },
  ): Promise<AccountBinding>;
}
interface OAuthDependencies {
  fetch: typeof fetch;
  verifyIdToken(token: string, nonce?: string): Promise<JWTPayload>;
}
const oauth: OAuthDependencies = {
  fetch: (...args) => fetch(...args),
  async verifyIdToken(token, nonce) {
    const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('OAuth identity discovery failed');
    const metadata = (await response.json()) as { issuer?: string; jwks_uri?: string };
    if (metadata.issuer !== issuer || !metadata.jwks_uri) throw new Error('OAuth issuer changed');
    const jwks = new URL(metadata.jwks_uri);
    if (jwks.origin !== issuer || jwks.username || jwks.password || jwks.hash)
      throw new Error('OAuth signing-key origin changed');
    const { payload } = await jwtVerify(token, createRemoteJWKSet(jwks), {
      issuer,
      audience: clientId,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', ...(nonce ? ['nonce'] : [])],
      maxTokenAge: '10m',
    });
    if (nonce && payload.nonce !== nonce) throw new Error('OAuth identity nonce changed');
    return payload;
  },
};
function identity(payload: JWTPayload): SubscriptionIdentity {
  const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  const accountId = auth?.chatgpt_account_id;
  const planType = auth?.chatgpt_plan_type;
  const email =
    payload.email ??
    (payload['https://api.openai.com/profile'] as Record<string, unknown> | undefined)?.email;
  if (
    !payload.sub ||
    typeof email !== 'string' ||
    !email ||
    typeof accountId !== 'string' ||
    !accountId ||
    typeof planType !== 'string' ||
    !['free', 'plus', 'pro'].includes(planType.toLowerCase())
  )
    throw new Error('OAuth identity is not a supported personal ChatGPT account');
  return { subject: payload.sub, accountId, email, planType };
}

/** No disk receipts: losing this instance loses authorization. Every explicit
 * grant mutation first revokes its receipt, including failed replacements.
 * Automatic upstream refresh is trusted only while sole host custody holds. */
export class SymposiumSubscriptionProvisioner {
  private receipt?: {
    identity: SubscriptionIdentity;
    provider: string;
    providerId: string;
    binding: AccountBinding;
  };
  private pending?: { state: string; nonce: string; verifier: string; expires: number };
  private busy = false;
  private resources = new Set<string>();
  private generation = 0;
  constructor(
    private readonly host: SubscriptionProvisioningHost,
    private readonly auth: OAuthDependencies = oauth,
  ) {}

  private verifyCustody(): void {
    try {
      this.host.verifyCustody();
    } catch {
      this.invalidate();
      throw new Error('Subscription gateway custody was lost');
    }
  }

  begin(): string {
    this.verifyCustody();
    if (this.busy) throw new Error('Subscription provisioning is already running');
    this.receipt = undefined;
    this.generation += 1;
    const state = random(),
      nonce = random(),
      verifier = random();
    this.pending = { state, nonce, verifier, expires: Date.now() + 10 * 60_000 };
    const url = new URL(`${issuer}/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      scope: 'openid profile email offline_access',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state,
      nonce,
      originator: 'codex_cli_rs',
    }).toString();
    return url.toString();
  }

  async complete(callback: URL): Promise<SubscriptionIdentity & { binding: AccountBinding }> {
    const pending = this.pending;
    if (
      !pending ||
      this.busy ||
      pending.expires <= Date.now() ||
      callback.origin !== 'http://localhost:1455' ||
      callback.pathname !== '/auth/callback' ||
      callback.searchParams.getAll('state').length !== 1 ||
      callback.searchParams.get('state') !== pending.state ||
      callback.searchParams.has('error') ||
      callback.searchParams.getAll('code').length !== 1 ||
      !callback.searchParams.get('code')
    )
      throw new Error('Invalid or expired OAuth callback');
    this.pending = undefined;
    this.receipt = undefined;
    this.busy = true;
    const generation = this.generation;
    const assertCurrent = () => {
      this.verifyCustody();
      if (this.generation !== generation)
        throw new Error('Subscription authorization was cancelled');
    };
    try {
      assertCurrent();
      const response = await this.auth.fetch(`${issuer}/oauth/token`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code')!,
          redirect_uri: redirect,
          client_id: clientId,
          code_verifier: pending.verifier,
        }),
      });
      if (!response.ok) throw new Error('OAuth token exchange failed');
      const tokens = (await response.json()) as SubscriptionTokens;
      return await this.installTokens(tokens, pending.nonce, assertCurrent);
    } catch {
      // Neither OAuth bodies, gateway output, nor credential-bearing errors escape.
      throw new Error('Personal subscription provisioning failed; authorization remains closed');
    } finally {
      this.busy = false;
    }
  }

  /** Host-only import from a fresh isolated upstream device login, never an HTTP token body. */
  beginDevice(): (
    tokens: SubscriptionTokens,
  ) => Promise<SubscriptionIdentity & { binding: AccountBinding }> {
    this.verifyCustody();
    if (this.busy) throw new Error('Subscription provisioning is already running');
    this.invalidate();
    const generation = this.generation;
    const expires = Date.now() + 10 * 60_000;
    let consumed = false;
    return async (tokens) => {
      const assertCurrent = () => {
        this.verifyCustody();
        if (this.generation !== generation || Date.now() >= expires)
          throw new Error('Subscription authorization was cancelled or expired');
      };
      if (consumed || this.busy) throw new Error('Device authorization is no longer available');
      consumed = true;
      this.busy = true;
      try {
        assertCurrent();
        return await this.installTokens(tokens, undefined, assertCurrent);
      } catch {
        throw new Error('Personal subscription provisioning failed; authorization remains closed');
      } finally {
        this.busy = false;
      }
    };
  }

  /** Fence first; only verified physical removal permits reuse of this slot. */
  async disconnect(): Promise<void> {
    this.invalidate();
    if (this.busy) throw new Error('Subscription cleanup awaits provisioning completion');
    const pages = async (args: string[], key: string): Promise<Record<string, unknown>[]> => {
      const rows: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      let token = '';
      do {
        this.verifyCustody();
        const page = (await this.host.run([
          ...args,
          '--output',
          'json',
          '--page-size',
          '100',
          ...(token ? ['--page-token', token] : []),
        ])) as Record<string, unknown>;
        this.verifyCustody();
        if (
          !page ||
          !Array.isArray(page[key]) ||
          typeof page.next_page_token !== 'string' ||
          !(page[key] as unknown[]).every((r) => r && typeof r === 'object')
        )
          throw new Error('Invalid cleanup inventory');
        rows.push(...(page[key] as Record<string, unknown>[]));
        token = page.next_page_token;
        if (token && (seen.has(token) || seen.size >= 100))
          throw new Error('Invalid cleanup pagination');
        if (token) seen.add(token);
      } while (token);
      return rows;
    };
    try {
      if (!this.resources.size) return;
      // Attachment absence cannot prove a formerly projected credential cache
      // was erased. Without durable projection/deletion lineage, require the
      // entire owned workspace to have no surviving or starting sandboxes.
      if ((await pages(['sandbox', 'list'], 'sandboxes')).length)
        throw new Error('Owned workspace sandbox cleanup is required');
      for (const provider of this.resources) {
        await this.host.run([
          'provider',
          'refresh',
          'delete',
          provider,
          '--credential-key',
          'CODEX_AUTH_ACCESS_TOKEN',
        ]);
        this.verifyCustody();
        await this.host.run(['provider', 'delete', provider]);
        this.verifyCustody();
        const remaining = await pages(['provider', 'list'], 'providers');
        if (remaining.some((row) => typeof row.name !== 'string' || row.name === provider))
          throw new Error('Provider absence is unconfirmed');
        // An in-flight create may become visible after the first inventory.
        if ((await pages(['sandbox', 'list'], 'sandboxes')).length)
          throw new Error('Owned workspace sandbox cleanup is unconfirmed');
        this.resources.delete(provider);
      }
    } catch {
      throw new Error('Subscription credential cleanup is unconfirmed');
    }
  }

  private async installTokens(
    tokens: SubscriptionTokens,
    nonce: string | undefined,
    assertCurrent: () => void,
  ) {
    if (
      ['access_token', 'refresh_token', 'id_token'].some(
        (key) =>
          typeof tokens[key as keyof SubscriptionTokens] !== 'string' ||
          !tokens[key as keyof SubscriptionTokens],
      )
    )
      throw new Error('OAuth token response is incomplete');
    const verified = identity(await this.auth.verifyIdToken(tokens.id_token, nonce));
    if (tokens.account_id !== undefined && tokens.account_id !== verified.accountId)
      throw new Error('Subscription cached account identity changed');
    assertCurrent();
    const provider = `symposium-personal-${randomBytes(12).toString('hex')}`;
    this.resources.add(provider); // Track before creation: even a failed command may have created credentials.
    await this.host.run(
      [
        'provider',
        'create',
        '--name',
        provider,
        '--type',
        'codex',
        '--credential',
        'CODEX_AUTH_ACCESS_TOKEN',
        '--credential',
        'CODEX_AUTH_ACCOUNT_ID',
      ],
      { CODEX_AUTH_ACCESS_TOKEN: tokens.access_token, CODEX_AUTH_ACCOUNT_ID: verified.accountId },
    );
    assertCurrent();
    const matches: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let pageToken = '';
    do {
      const page = (await this.host.run([
        'provider',
        'list',
        '--output',
        'json',
        '--page-size',
        '100',
        ...(pageToken ? ['--page-token', pageToken] : []),
      ])) as { providers?: Array<Record<string, unknown>>; next_page_token?: string };
      assertCurrent();
      if (!Array.isArray(page.providers) || typeof page.next_page_token !== 'string')
        throw new Error('Invalid provider inventory');
      matches.push(...page.providers.filter((row) => row.name === provider));
      pageToken = page.next_page_token;
      if (pageToken && seen.has(pageToken)) throw new Error('Repeated inventory page');
      seen.add(pageToken);
      if (seen.size > 1000) throw new Error('Provider inventory exceeded bound');
    } while (pageToken);
    const providerId = matches[0]?.id;
    if (
      matches.length !== 1 ||
      typeof providerId !== 'string' ||
      !providerId ||
      matches[0].type !== 'codex' ||
      matches[0].workspace !== this.host.workspace
    )
      throw new Error('Created provider identity is missing');
    assertCurrent();
    await this.host.run(
      [
        'provider',
        'refresh',
        'configure',
        provider,
        '--credential-key',
        'CODEX_AUTH_ACCESS_TOKEN',
        '--strategy',
        'oauth2-refresh-token',
        '--material',
        `client_id=${clientId}`,
        '--secret-material-env',
        'refresh_token=CODEX_AUTH_REFRESH_TOKEN',
      ],
      { CODEX_AUTH_REFRESH_TOKEN: tokens.refresh_token },
    );
    // Re-check custody after each awaited external boundary; no partial receipt.
    assertCurrent();
    const binding = await this.host.installProfile({ ...verified, provider, providerId });
    if (binding.provider !== 'openai-codex' || !binding.profileRevision)
      throw new Error('Installed subscription binding is invalid');
    assertCurrent();
    this.receipt = { identity: verified, provider, providerId, binding: { ...binding } };
    return { ...verified, binding };
  }

  invalidate(): void {
    this.generation += 1;
    this.receipt = undefined;
    this.pending = undefined;
  }

  readonly assertPrivateAuth = (input: Parameters<VerifySymposiumSubscriptionAuth>[0]): void => {
    this.verifyCustody();
    const receipt = this.receipt;
    const binding = input.execution.seat.accountBinding;
    const route = input.route;
    if (
      !receipt ||
      route.kind !== 'chatgpt-subscription-native' ||
      !binding ||
      receipt.binding.accountId !== binding.accountId ||
      receipt.binding.profileRevision !== binding.profileRevision ||
      receipt.binding.provider !== binding.provider ||
      route.model !== binding.model ||
      route.profile.model !== binding.model ||
      route.provider !== receipt.provider ||
      route.providerId !== receipt.providerId ||
      route.profile.email !== receipt.identity.email ||
      route.profile.planType !== receipt.identity.planType
    )
      throw new Error('Subscription authorization receipt is missing or changed');
  };
  readonly verifyPrivateAuth: VerifySymposiumSubscriptionAuth = async (input) => {
    this.assertPrivateAuth(input);
  };
}

/** Attended local login. No token or authorization code is rendered in responses. */
export async function attendSubscriptionLogin(service: SymposiumSubscriptionProvisioner): Promise<{
  authorizationUrl: string;
  completed: Promise<SubscriptionIdentity & { binding: AccountBinding }>;
  cancel(): void;
}> {
  let resolve!: (value: SubscriptionIdentity & { binding: AccountBinding }) => void;
  let reject!: (reason: Error) => void;
  const completed = new Promise<SubscriptionIdentity & { binding: AccountBinding }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let expectedState: string | null = null;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain');
    if (request.method !== 'GET' || request.headers.host !== 'localhost:1455') {
      response.writeHead(400).end('Invalid callback');
      return;
    }
    const callback = new URL(request.url ?? '/', redirect);
    if (
      !expectedState ||
      callback.pathname !== '/auth/callback' ||
      callback.searchParams.get('state') !== expectedState
    ) {
      response.writeHead(400).end('Invalid callback');
      return;
    }
    void service.complete(callback).then(
      (result) => {
        response.end('Personal subscription connected. You may close this window.');
        resolve(result);
        close();
      },
      () => {
        response.writeHead(400).end('Login failed. Start a new login from Symposium.');
        service.invalidate();
        close();
        reject(new Error('Subscription login failed; start a new login'));
      },
    );
  });
  const close = () => {
    clearTimeout(timer);
    server.close();
  };
  const timer = setTimeout(() => {
    service.invalidate();
    close();
    reject(new Error('Subscription login timed out'));
  }, 10 * 60_000);
  await new Promise<void>((yes, no) => {
    server.once('error', no);
    server.listen(1455, '127.0.0.1', yes);
  }).catch((error) => {
    clearTimeout(timer);
    throw error;
  });
  let authorizationUrl: string;
  try {
    authorizationUrl = service.begin();
    expectedState = new URL(authorizationUrl).searchParams.get('state');
  } catch (error) {
    close();
    throw error;
  }

  return {
    authorizationUrl,
    completed,
    cancel() {
      service.invalidate();
      close();
      reject(new Error('Subscription login cancelled'));
    },
  };
}
