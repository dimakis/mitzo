import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AccountBinding } from '@mitzo/protocol';
import type { VerifySymposiumSubscriptionAuth } from './symposium-subscription-native.js';

const issuer = 'https://auth.openai.com';
const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
const redirect = 'http://localhost:1455/auth/callback';
const random = () => randomBytes(32).toString('base64url');
interface Tokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
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
  verifyIdToken(token: string, nonce: string): Promise<JWTPayload>;
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
      requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
      maxTokenAge: '10m',
    });
    if (payload.nonce !== nonce) throw new Error('OAuth identity nonce changed');
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
      const tokens = (await response.json()) as Tokens;
      if (
        ['access_token', 'refresh_token', 'id_token'].some(
          (key) => typeof tokens[key as keyof Tokens] !== 'string' || !tokens[key as keyof Tokens],
        )
      )
        throw new Error('OAuth token response is incomplete');
      const verified = identity(await this.auth.verifyIdToken(tokens.id_token, pending.nonce));
      assertCurrent();
      const provider = `symposium-personal-${randomBytes(12).toString('hex')}`;
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
    } catch {
      // Neither OAuth bodies, gateway output, nor credential-bearing errors escape.
      throw new Error('Personal subscription provisioning failed; authorization remains closed');
    } finally {
      this.busy = false;
    }
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
