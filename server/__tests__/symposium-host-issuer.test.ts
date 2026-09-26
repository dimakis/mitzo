import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumHostIssuer } from '../symposium-host-issuer.js';

let root: string;
let cert: Buffer;
let key: Buffer;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'symposium-issuer-test-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(root, 'key.pem'),
      '-out',
      join(root, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  cert = readFileSync(join(root, 'cert.pem'));
  key = readFileSync(join(root, 'key.pem'));
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
function get(url: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { ca: cert, method }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (part) => {
        body += part;
      });
      response.on('end', () => resolve({ status: response.statusCode!, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('private HTTPS management issuer', () => {
  it('serves only public discovery and JWKS and signs a fixed short-lived host principal', async () => {
    const issuer = await SymposiumHostIssuer.start(cert, key);
    try {
      const discovery = await get(`${issuer.url}/.well-known/openid-configuration`);
      expect(discovery.status).toBe(200);
      expect(JSON.parse(discovery.body)).toEqual({
        issuer: issuer.url,
        jwks_uri: `${issuer.url}/jwks`,
        id_token_signing_alg_values_supported: ['RS256'],
      });
      const keys = JSON.parse((await get(`${issuer.url}/jwks`)).body).keys;
      expect(keys).toHaveLength(1);
      expect(Object.keys(keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
      expect((await get(`${issuer.url}/token`)).status).toBe(404);
      expect((await get(`${issuer.url}/jwks`, 'POST')).status).toBe(404);
      const bundle = issuer.tokenBundle();
      const [header, payload, signature] = bundle.access_token.split('.');
      expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({
        alg: 'RS256',
        kid: keys[0].kid,
      });
      expect(
        verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${payload}`),
          createPublicKey({ key: keys[0], format: 'jwk' }),
          Buffer.from(signature, 'base64url'),
        ),
      ).toBe(true);
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      expect(claims).toMatchObject({
        iss: issuer.url,
        aud: 'symposium-host',
        sub: 'symposium-host-owner',
        realm_access: { roles: ['openshell-admin'] },
        exp: bundle.expires_at,
      });
      expect(claims.exp - claims.iat).toBe(300);
      expect(bundle).not.toHaveProperty('refresh_token');
    } finally {
      issuer.stop();
    }
  });

  it('invalidates custody and minting immediately on stop and uses new keys after restart', async () => {
    const first = await SymposiumHostIssuer.start(cert, key);
    const firstHeader = first.tokenBundle().access_token.split('.')[0];
    const lost = vi.fn();
    first.onLoss(lost);
    first.stop();
    expect(lost).toHaveBeenCalled();
    expect(() => first.assertLive()).toThrow(/no longer live/);
    expect(() => first.tokenBundle()).toThrow(/no longer live/);
    const second = await SymposiumHostIssuer.start(cert, key);
    try {
      expect(second.tokenBundle().access_token.split('.')[0]).not.toBe(firstHeader);
    } finally {
      second.stop();
    }
  });
});
