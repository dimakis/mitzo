import { Capacitor, registerPlugin } from '@capacitor/core';
import { getApiBaseUrl } from './api-fetch';

interface AppleBridge {
  authorize(options: { state: string; nonce: string }): Promise<{ state: string; code: string }>;
}
export type AppleSignInStatus =
  { enabled: false } | { enabled: true; enrolled: boolean; native: boolean };
const failure = 'Apple sign-in could not complete. Try again or use your passphrase.';

export class AppleSignInClientError extends Error {
  constructor(
    readonly code: string,
    cause?: unknown,
  ) {
    super(appleSignInMessage(code), { cause });
    this.name = 'AppleSignInClientError';
  }
}
export function appleSignInMessage(code: unknown): string {
  switch (code) {
    case 'owner_mismatch':
      return 'This Apple account is not connected to Mitzo. Use the connected account or your passphrase.';
    case 'enrollment_denied':
      return 'The Mitzo passphrase was not accepted. Check it and try again.';
    case 'already_enrolled':
      return 'An Apple account is already connected. Reload this page to sign in.';
    case 'cancelled':
    case 'APPLE_CANCELLED':
      return 'Apple sign-in was cancelled.';
    case 'native_unavailable':
      return 'Update the Mitzo iPhone app and enable native Apple sign-in on the server, or use your passphrase.';
    default:
      return failure;
  }
}

async function request(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
    credentials: Capacitor.isNativePlatform() ? 'omit' : 'include',
    signal: AbortSignal.timeout(15_000),
  });
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(failure);
  if (!response.ok) {
    const code = 'code' in data && typeof data.code === 'string' ? data.code : 'request_failed';
    throw new AppleSignInClientError(code);
  }
  return data as Record<string, unknown>;
}

export async function readAppleSignInStatus(): Promise<AppleSignInStatus> {
  const data = await request('/api/auth/apple/status');
  if (data.enabled === false) return { enabled: false };
  if (
    data.enabled !== true ||
    typeof data.enrolled !== 'boolean' ||
    typeof data.native !== 'boolean'
  )
    throw new Error(failure);
  return { enabled: true, enrolled: data.enrolled, native: data.native };
}

export async function verifyAppleBrowserSession(): Promise<void> {
  // A URL parameter is not authentication. Check the HttpOnly cookie without a stale bearer token.
  const data = await request('/api/auth/check');
  if (data.ok !== true || typeof data.authSessionId !== 'string' || !data.authSessionId)
    throw new Error(failure);
}

export async function beginAppleSignIn(
  enrollPassphrase?: string,
  isCurrent: () => boolean = () => true,
): Promise<{ kind: 'redirect'; url: string } | { kind: 'session'; token: string }> {
  const native = Capacitor.isNativePlatform();
  if (
    native &&
    (Capacitor.getPlatform() !== 'ios' || !Capacitor.isPluginAvailable('AppleSignInBridge'))
  ) {
    throw new AppleSignInClientError('native_unavailable');
  }
  const data = await request('/api/auth/apple/start', {
    client: native ? 'native' : 'web',
    ...(enrollPassphrase ? { enrollPassphrase } : {}),
  });
  if (!isCurrent()) throw new AppleSignInClientError('cancelled');
  if (!native) {
    if (typeof data.authorizationUrl !== 'string') throw new Error(failure);
    const url = new URL(data.authorizationUrl);
    if (
      url.origin !== 'https://appleid.apple.com' ||
      url.pathname !== '/auth/authorize' ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error(failure);
    return { kind: 'redirect', url: url.href };
  }
  const { state, nonce, verifier } = data;
  if (
    typeof state !== 'string' ||
    !state ||
    typeof nonce !== 'string' ||
    !nonce ||
    typeof verifier !== 'string' ||
    !verifier
  )
    throw new Error(failure);
  let result: { state: string; code: string };
  try {
    result = await registerPlugin<AppleBridge>('AppleSignInBridge').authorize({ state, nonce });
  } catch (cause) {
    const code =
      cause && typeof cause === 'object' && 'code' in cause && cause.code === 'APPLE_CANCELLED'
        ? 'cancelled'
        : 'native_failed';
    throw new AppleSignInClientError(code, cause);
  }
  if (!isCurrent()) throw new AppleSignInClientError('cancelled');
  if (result.state !== state || typeof result.code !== 'string' || !result.code)
    throw new Error(failure);
  const session = await request('/api/auth/apple/native', { state, verifier, code: result.code });
  if (typeof session.token !== 'string' || !session.token) throw new Error(failure);
  return { kind: 'session', token: session.token };
}
