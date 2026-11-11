import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { AppleSignInError } from './apple-sign-in.js';
import { withAppleFile } from './apple-private-file.js';

export interface AppleSignInConfig {
  clientId: string;
  nativeClientId?: string;
  teamId: string;
  keyId: string;
  privateKeyPath: string;
  redirectUri: string;
}
export interface AppleIdentityRequest {
  clientId: string;
  code: string;
  nonce: string;
  redirectUri?: string;
}
export function loadAppleSignInConfig(env: NodeJS.ProcessEnv): AppleSignInConfig | null {
  if (!Object.entries(env).some(([key, value]) => key.startsWith('MITZO_APPLE_') && value))
    return null;
  const {
    MITZO_APPLE_CLIENT_ID: clientId,
    MITZO_APPLE_NATIVE_CLIENT_ID: nativeClientId,
    MITZO_APPLE_TEAM_ID: teamId,
    MITZO_APPLE_KEY_ID: keyId,
    MITZO_APPLE_PRIVATE_KEY_PATH: privateKeyPath,
    MITZO_APPLE_REDIRECT_URI: redirectUri,
  } = env;
  if (
    !clientId ||
    !teamId ||
    !keyId ||
    !privateKeyPath ||
    !redirectUri ||
    !/^[A-Za-z0-9.-]{1,255}$/.test(clientId) ||
    !/^[A-Z0-9]{10}$/.test(teamId) ||
    !/^[A-Z0-9]{10}$/.test(keyId) ||
    !isAbsolute(privateKeyPath) ||
    (nativeClientId &&
      (!/^[A-Za-z0-9.-]{1,255}$/.test(nativeClientId) || nativeClientId === clientId))
  )
    throw new Error('Apple sign-in configuration is incomplete or invalid');
  const url = new URL(redirectUri);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.localhost') ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/api/auth/apple/callback'
  )
    throw new Error(
      'Apple sign-in requires an exact HTTPS domain callback at /api/auth/apple/callback',
    );
  return { clientId, nativeClientId, teamId, keyId, privateKeyPath, redirectUri };
}

function readPrivateKey(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  return withAppleFile(fd, () => {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0)
      throw new Error('Apple signing key must be a private regular file');
    return readFileSync(fd, 'utf8');
  });
}

/** All upstream destinations are fixed. Dependencies are injectable only by the
 * trusted caller for offline tests, never supplied through HTTP/configuration. */
export function createAppleVerifier(
  config: AppleSignInConfig,
  dependencies: {
    fetch?: typeof fetch;
    key?: JWTVerifyGetKey;
    privateKey?: () => Promise<string>;
  } = {},
) {
  const fetcher = dependencies.fetch ?? fetch;
  const key =
    dependencies.key ??
    createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
  return async (input: AppleIdentityRequest): Promise<{ subject: string }> => {
    try {
      if (![config.clientId, config.nativeClientId].includes(input.clientId))
        throw new AppleSignInError('invalid_identity');
      const signingKey = await importPKCS8(
        await (dependencies.privateKey?.() ??
          Promise.resolve(readPrivateKey(config.privateKeyPath))),
        'ES256',
      );
      const clientSecret = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: config.keyId })
        .setIssuer(config.teamId)
        .setSubject(input.clientId)
        .setAudience('https://appleid.apple.com')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signingKey);
      const body = new URLSearchParams({
        client_id: input.clientId,
        client_secret: clientSecret,
        code: input.code,
        grant_type: 'authorization_code',
        ...(input.redirectUri ? { redirect_uri: input.redirectUri } : {}),
      });
      const response = await fetcher('https://appleid.apple.com/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new AppleSignInError('provider_rejected');
      // Bound a compromised/unexpected upstream before parsing any credential-bearing body.
      const reader = response.body?.getReader();
      if (!reader) throw new AppleSignInError('provider_unavailable');
      const chunks: Uint8Array[] = [];
      let length = 0;
      let readFailure: { cause: unknown } | undefined;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 65_536) throw new AppleSignInError('provider_unavailable');
          chunks.push(value);
        }
      } catch (cause) {
        readFailure = { cause };
      }
      try {
        await reader.cancel();
      } catch (cause) {
        throw new AppleSignInError(
          'provider_unavailable',
          new AggregateError(
            readFailure ? [readFailure.cause, cause] : [cause],
            'Apple response cleanup failed',
          ),
        );
      }
      if (readFailure) throw readFailure.cause;
      const tokens = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof tokens.id_token !== 'string') throw new AppleSignInError('invalid_identity');
      const { payload } = await jwtVerify(tokens.id_token, key, {
        issuer: 'https://appleid.apple.com',
        audience: input.clientId,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
        maxTokenAge: '10m',
      });
      if (
        payload.aud !== input.clientId ||
        payload.nonce !== input.nonce ||
        !payload.sub ||
        payload.sub.length > 255
      )
        throw new AppleSignInError('invalid_identity');
      // Apple access/refresh tokens and optional profile fields are not retained.
      return { subject: payload.sub };
    } catch (cause) {
      if (cause instanceof AppleSignInError) throw cause;
      throw new AppleSignInError('identity_verification_failed', cause);
    }
  };
}
