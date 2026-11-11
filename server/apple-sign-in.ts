import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppleSignInConfig, AppleIdentityRequest } from './apple-sign-in-provider.js';
import type { AppleOwnerStore } from './apple-owner-store.js';

export class AppleSignInError extends Error {
  constructor(
    readonly code: string,
    cause?: unknown,
  ) {
    super(code, { cause });
    this.name = 'AppleSignInError';
  }
}
type Client = 'web' | 'native';
interface Transaction {
  client: Client;
  nonce: string;
  verifierHash: Buffer;
  expiresAt: number;
  enrolling: boolean;
}
const secret = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest();
export const APPLE_TRANSACTION_TTL_MS = 5 * 60_000;

/** One primary operator, with an explicitly linked Apple identity. This does not
 * create users or widen the existing single-operator authorization model. */
export function createAppleSignIn(options: {
  config: AppleSignInConfig;
  store: Pick<AppleOwnerStore, 'read' | 'enroll'>;
  verify: (request: AppleIdentityRequest) => Promise<{ subject: string }>;
  issueSession: () => Promise<string>;
  verifyPassphrase: (value: string) => boolean;
  now?: () => number;
}) {
  const { config, store } = options;
  const now = options.now ?? Date.now;
  const pending = new Map<string, Transaction>();
  function clientId(client: Client) {
    const id = client === 'web' ? config.clientId : config.nativeClientId;
    if (!id) throw new AppleSignInError('native_unavailable');
    return id;
  }
  return {
    status: () => ({
      enabled: true,
      enrolled: store.read() !== null,
      native: !!config.nativeClientId,
    }),
    start(client: Client, enrollPassphrase?: string) {
      const id = clientId(client);
      const owner = store.read();
      const enrolling = enrollPassphrase !== undefined;
      if (enrolling && owner) throw new AppleSignInError('already_enrolled');
      if (enrolling && !options.verifyPassphrase(enrollPassphrase!))
        throw new AppleSignInError('enrollment_denied');
      if (!owner && !enrolling) throw new AppleSignInError('enrollment_required');
      for (const [state, transaction] of pending)
        if (transaction.expiresAt <= now()) pending.delete(state);
      if (pending.size >= 128) throw new AppleSignInError('capacity_exceeded');
      const state = secret(),
        nonce = secret(),
        verifier = secret();
      pending.set(state, {
        client,
        nonce,
        verifierHash: digest(verifier),
        expiresAt: now() + APPLE_TRANSACTION_TTL_MS,
        enrolling,
      });
      const url = new URL('https://appleid.apple.com/auth/authorize');
      url.search = new URLSearchParams({
        client_id: id,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        response_mode: 'query',
        state,
        nonce,
      }).toString();
      // No profile/email scope: Apple supports a code-only GET callback and the
      // Lax browser binding cookie survives the top-level cross-site return.
      return { state, nonce, verifier, authorizationUrl: client === 'web' ? url.href : undefined };
    },
    async finish(input: {
      client: Client;
      state: string;
      verifier: string;
      code?: string;
      error?: string;
    }) {
      const transaction = pending.get(input.state);
      if (
        !transaction ||
        transaction.client !== input.client ||
        transaction.expiresAt <= now() ||
        !timingSafeEqual(transaction.verifierHash, digest(input.verifier))
      )
        throw new AppleSignInError('invalid_transaction');
      // Consume before awaiting Apple: callbacks and concurrent exchanges cannot replay.
      pending.delete(input.state);
      if (input.error)
        throw new AppleSignInError(
          ['user_cancelled_authorize', 'access_denied'].includes(input.error)
            ? 'cancelled'
            : 'provider_rejected',
        );
      if (!input.code) throw new AppleSignInError('invalid_transaction');
      const identity = await options.verify({
        code: input.code,
        nonce: transaction.nonce,
        clientId: clientId(input.client),
        redirectUri: input.client === 'web' ? config.redirectUri : undefined,
      });
      if (transaction.expiresAt <= now()) throw new AppleSignInError('invalid_transaction');
      if (transaction.enrolling) store.enroll(identity.subject);
      if (store.read() !== identity.subject) throw new AppleSignInError('owner_mismatch');
      const token = await options.issueSession();
      if (transaction.expiresAt <= now() || store.read() !== identity.subject)
        throw new AppleSignInError('invalid_transaction');
      return token;
    },
  };
}
export type AppleSignIn = ReturnType<typeof createAppleSignIn>;
