import { SessionRuntimeError, findSessionRuntimeError } from './session-runtime-error.js';
import { observeLocalCodexPhase } from './local-codex-observation.js';
import { createHash, createPublicKey, verify, type KeyObject, type JsonWebKey } from 'node:crypto';
import { z } from 'zod';

const issuer = 'https://auth.openai.com';
const audience = 'app_EMoamEEZ73f0CkXaXp7hrann';
const unavailable = () => new SessionRuntimeError('login_refresh_invalid');
const unavailableKeys = () => new SessionRuntimeError('login_verification_unavailable');
const Claims = z.object({
  iss: z.literal(issuer),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1),
  sid: z.string().min(1),
  auth_time: z.number().int().nonnegative(),
  email: z.string().min(1),
  email_verified: z.literal(true),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  nbf: z.number().int().nonnegative().optional(),
  at_hash: z.string().min(1),
  'https://api.openai.com/auth': z.object({
    chatgpt_account_id: z.string().min(1),
    chatgpt_plan_type: z.string().min(1),
  }),
});
const Document = z.object({
  auth_mode: z.literal('chatgpt').optional(),
  OPENAI_API_KEY: z.null().optional(),
  tokens: z.object({
    id_token: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});
export const LoginRefreshAnchorSchema = z.strictObject({
  identitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative(),
});
export type LoginRefreshAnchor = z.infer<typeof LoginRefreshAnchorSchema>;
export interface LoginRefreshVersion {
  sha256: string;
  issuedAt: number;
  tokenPairs: string[];
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function inspect(bytes: Buffer, profile: { email: string; planType: string }) {
  try {
    const document = Document.parse(JSON.parse(bytes.toString('utf8')));
    const parts = document.tokens.id_token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
      throw unavailable();
    const header = z
      .object({ alg: z.literal('RS256'), kid: z.string().min(1).max(200) })
      .parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
    const claims = Claims.parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
    const account = claims['https://api.openai.com/auth'];
    if (
      !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience) ||
      account.chatgpt_account_id !== document.tokens.account_id ||
      claims.email !== profile.email ||
      account.chatgpt_plan_type !== profile.planType ||
      claims.at_hash !==
        createHash('sha256')
          .update(document.tokens.access_token)
          .digest()
          .subarray(0, 16)
          .toString('base64url')
    )
      throw unavailable();
    const identitySha256 = hash(
      JSON.stringify([
        issuer,
        audience,
        claims.sub,
        claims.sid,
        claims.auth_time,
        claims.email,
        account.chatgpt_account_id,
        account.chatgpt_plan_type,
      ]),
    );
    return {
      parts,
      header,
      claims,
      anchor: { identitySha256, issuedAt: claims.iat },
      tokenPair: hash(JSON.stringify([document.tokens.id_token, document.tokens.access_token])),
    };
  } catch (error) {
    throw (
      findSessionRuntimeError(error) ??
      new SessionRuntimeError('login_refresh_invalid', { cause: error })
    );
  }
}
/** The original operator-selected bytes establish a login identity, not a new
 * account. Legacy/opaque tokens retain exact-hash custody and gain no new proof. */
export function captureLoginRefreshAnchor(
  bytes: Buffer,
  profile: { email: string; planType: string },
): LoginRefreshAnchor | undefined {
  try {
    return inspect(bytes, profile).anchor;
  } catch {
    return undefined;
  }
}

export function captureLoginRefreshVersion(
  bytes: Buffer,
  profile: { email: string; planType: string },
): LoginRefreshVersion {
  const observed = inspect(bytes, profile);
  return { sha256: hash(bytes), issuedAt: observed.claims.iat, tokenPairs: [observed.tokenPair] };
}

async function publicJson(
  transport: typeof fetch,
  url: URL,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await transport(url, { redirect: 'error', signal, credentials: 'omit' });
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if ((size += part.value.byteLength) > 128 * 1024) throw unavailable();
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
type SigningKeys = ReadonlyMap<string, KeyObject>;
// Public verification material only. Each waiter owns its cancellation; one
// cancelled login cannot cancel another login's issuer discovery.
const keyCache = new WeakMap<
  typeof fetch,
  { expires: number; pending: Promise<SigningKeys>; keys?: SigningKeys }
>();
async function signingKeys(
  signal?: AbortSignal,
  requiredKids: string[] = [],
): Promise<SigningKeys> {
  signal?.throwIfAborted();
  const transport = fetch;
  let cached = keyCache.get(transport);
  const cachedKeys = cached?.keys;
  if (
    !cached ||
    cached.expires <= Date.now() ||
    (cachedKeys && requiredKids.some((kid) => !cachedKeys.has(kid)))
  ) {
    const pending = observeLocalCodexPhase('login_verification_keys', async () => {
      const deadline = AbortSignal.timeout(15_000);
      const metadata = z
        .object({ issuer: z.literal(issuer), jwks_uri: z.string().url() })
        .parse(
          await publicJson(
            transport,
            new URL(`${issuer}/.well-known/openid-configuration`),
            deadline,
          ),
        );
      const url = new URL(metadata.jwks_uri);
      if (url.origin !== issuer || url.username || url.password || url.hash) throw unavailable();
      const document = z
        .object({ keys: z.array(z.record(z.string(), z.unknown())).max(32) })
        .parse(await publicJson(transport, url, deadline));
      const keys = new Map<string, KeyObject>();
      for (const key of document.keys) {
        if (
          key.kty !== 'RSA' ||
          typeof key.kid !== 'string' ||
          (key.alg && key.alg !== 'RS256') ||
          (key.use && key.use !== 'sig')
        )
          continue;
        if (keys.has(key.kid) || 'd' in key) throw unavailable();
        keys.set(key.kid, createPublicKey({ key: key as JsonWebKey, format: 'jwk' }));
      }
      if (!keys.size) throw unavailable();
      return keys;
    }).catch((error: unknown) => {
      throw new SessionRuntimeError('login_verification_unavailable', { cause: error });
    });
    cached = { expires: Date.now() + 5 * 60_000, pending };
    keyCache.set(transport, cached);
    const entry = cached;
    void pending.then(
      (keys) => {
        entry.keys = keys;
      },
      () => {},
    );
    void pending.catch(() => {
      if (keyCache.get(transport) === cached) keyCache.delete(transport);
    });
  }
  // Do not keep the caller waiting after operator revocation. The shared,
  // unauthenticated public-key acquisition retains its own bounded lifetime.
  if (!signal) return cached.pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    cached!.pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export class HostCodexLoginRefreshVerifier {
  #keys?: SigningKeys;
  constructor(
    readonly anchor: LoginRefreshAnchor,
    private readonly profile: { email: string; planType: string },
  ) {}
  async prepare(signal?: AbortSignal): Promise<void> {
    this.#keys = await signingKeys(signal);
    signal?.throwIfAborted();
  }
  qualifyUnknownSigningKey(bytes: Buffer[], signal?: AbortSignal): void | Promise<void> {
    const candidates = bytes.map((value) => inspect(value, this.profile));
    if (
      candidates.some((candidate) => candidate.anchor.identitySha256 !== this.anchor.identitySha256)
    )
      throw unavailable();
    if (candidates.every((candidate) => this.#keys?.has(candidate.header.kid))) return;
    return signingKeys(
      signal,
      candidates.map((candidate) => candidate.header.kid),
    ).then((keys) => {
      signal?.throwIfAborted();
      this.#keys = keys;
      if (candidates.some((candidate) => !keys.has(candidate.header.kid))) throw unavailableKeys();
    });
  }
  /** Called only after physical custody checks. Never grants account, operator,
   * workspace or execution authority; these remain with their existing owners. */
  verify(
    bytes: Buffer,
    previous: LoginRefreshVersion,
    mode: 'refresh' | 'reauthorize-current' | 'reauthorize-history' = 'refresh',
  ): LoginRefreshVersion {
    const observed = inspect(bytes, this.profile);
    const key = this.#keys?.get(observed.header.kid);
    const now = Math.floor(Date.now() / 1000);
    let currentAccess = false;
    if (mode === 'reauthorize-current') {
      // An ID assertion can expire before its paired access token. Its verified
      // signature and at_hash authenticate these exact access claims as well.
      const document = Document.parse(JSON.parse(bytes.toString('utf8')));
      const part = document.tokens.access_token.split('.')[1];
      if (part) {
        const access = z
          .object({
            iss: z.literal(issuer),
            exp: z.number(),
            nbf: z.number().optional(),
            aud: z.array(z.string()),
            client_id: z.literal(audience),
            'https://api.openai.com/auth': z.object({
              chatgpt_account_id: z.literal(document.tokens.account_id),
            }),
          })
          .safeParse(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
        currentAccess =
          access.success &&
          access.data.exp > now &&
          (access.data.nbf === undefined || access.data.nbf <= now) &&
          access.data.aud.includes('https://api.openai.com/v1');
      }
    }
    if (
      !key ||
      observed.anchor.identitySha256 !== this.anchor.identitySha256 ||
      observed.claims.iat < previous.issuedAt ||
      (observed.claims.iat === previous.issuedAt &&
        previous.tokenPairs.includes(observed.tokenPair)) ||
      (observed.claims.iat === previous.issuedAt && previous.tokenPairs.length >= 32) ||
      observed.claims.iat > now + 30 ||
      (observed.claims.exp <= now && !currentAccess && mode !== 'reauthorize-history') ||
      (observed.claims.nbf !== undefined && observed.claims.nbf > now) ||
      observed.claims.exp <= observed.claims.iat ||
      !verify(
        'RSA-SHA256',
        Buffer.from(observed.parts.slice(0, 2).join('.')),
        key,
        Buffer.from(observed.parts[2], 'base64url'),
      )
    )
      throw unavailable();
    return {
      sha256: hash(bytes),
      issuedAt: observed.claims.iat,
      tokenPairs:
        observed.claims.iat === previous.issuedAt
          ? [...previous.tokenPairs, observed.tokenPair]
          : [observed.tokenPair],
    };
  }
}

/** Public read-only work; the bootstrap invokes it before claiming a command. */
export async function prepareLoginRefreshKeys(
  signal?: AbortSignal,
  requiredKids: string[] = [],
): Promise<void> {
  const keys = await signingKeys(signal, requiredKids);
  if (requiredKids.some((kid) => !keys.has(kid))) throw unavailableKeys();
  signal?.throwIfAborted();
}

export function loginRefreshSigningKey(
  bytes: Buffer,
  profile: { email: string; planType: string },
): string {
  return inspect(bytes, profile).header.kid;
}
