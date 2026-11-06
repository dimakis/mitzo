import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
// One local signing key and the existing physical-login fixture exercise the real
// cryptographic/file/RPC boundary without OAuth, a native process or a model.
export const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
export function refreshedAuth(
  epoch: number,
  changes: Record<string, unknown> = {},
  signer: { privateKey: KeyObject } = signingKey,
  kid = 'fixture-key',
) {
  const access = `synthetic-access-${epoch}`;
  const payload = {
    iss: 'https://auth.openai.com',
    aud: ['app_EMoamEEZ73f0CkXaXp7hrann'],
    sub: 'same-user',
    sid: 'same-login',
    auth_time: 100,
    email: 'person@example.test',
    email_verified: true,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'fixture-account',
      chatgpt_plan_type: 'plus',
    },
    iat: epoch,
    exp: epoch + 3600,
    at_hash: createHash('sha256').update(access).digest().subarray(0, 16).toString('base64url'),
    ...changes,
  };
  const input = [
    Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
  ].join('.');
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: `${input}.${sign('RSA-SHA256', Buffer.from(input), signer.privateKey).toString('base64url')}`,
      access_token: access,
      refresh_token: `synthetic-refresh-${epoch}`,
      account_id: 'fixture-account',
    },
    last_refresh: new Date(epoch * 1000).toISOString(),
  });
}
