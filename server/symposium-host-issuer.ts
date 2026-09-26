import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Worker } from 'node:worker_threads';

/** Private management issuer: network callers can retrieve discovery/JWKS only.
 * A worker serves HTTPS so synchronous upstream CLI probes cannot deadlock their
 * own discovery request. Token signing remains exclusively in the host process.
 */
export class SymposiumHostIssuer {
  private active = true;
  private closed?: () => void;
  private constructor(
    private readonly worker: Worker,
    private readonly key: ReturnType<typeof generateKeyPairSync>,
    private readonly kid: string,
    readonly url: string,
  ) {
    worker.once('exit', () => {
      this.active = false;
      this.closed?.();
    });
    worker.once('error', () => {
      this.active = false;
      this.closed?.();
    });
  }

  static async start(cert: Buffer, tlsKey: Buffer): Promise<SymposiumHostIssuer> {
    const key = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const kid = randomUUID();
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { createServer } = require('node:https');
      let issuer;
      const server = createServer({ cert: workerData.cert, key: workerData.key }, (req, res) => {
        const document = req.method !== 'GET' ? undefined
          : req.url === '/.well-known/openid-configuration'
            ? { issuer, jwks_uri: issuer + '/jwks', id_token_signing_alg_values_supported: ['RS256'] }
            : req.url === '/jwks' ? { keys: [workerData.jwk] } : undefined;
        if (!document) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(document));
      });
      server.on('error', err => { throw err; });
      server.listen(0, '127.0.0.1', () => {
        issuer = 'https://127.0.0.1:' + server.address().port;
        parentPort.postMessage(issuer);
      });
    `,
      {
        eval: true,
        workerData: {
          cert: cert.toString(),
          key: tlsKey.toString(),
          jwk: { ...key.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
        },
      },
    );
    try {
      const url = await new Promise<string>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', () => reject(new Error('Host issuer stopped during startup')));
      });
      return new SymposiumHostIssuer(worker, key, kid, url);
    } catch (error) {
      await worker.terminate();
      throw error;
    }
  }

  assertLive(): void {
    if (!this.active || this.worker.threadId === -1)
      throw new Error('Host management issuer is no longer live');
  }
  onLoss(callback: () => void): void {
    this.closed = callback;
  }
  tokenBundle(): { access_token: string; expires_at: number; issuer: string; client_id: string } {
    this.assertLive();
    const now = Math.floor(Date.now() / 1000);
    const expires_at = now + 300;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: this.kid })}.${encode({
      iss: this.url,
      aud: 'symposium-host',
      sub: 'symposium-host-owner',
      iat: now,
      nbf: now - 5,
      exp: expires_at,
      jti: randomUUID(),
      realm_access: { roles: ['openshell-admin'] },
    })}`;
    return {
      access_token: `${input}.${sign('RSA-SHA256', Buffer.from(input), this.key.privateKey).toString('base64url')}`,
      expires_at,
      issuer: this.url,
      client_id: 'symposium-host',
    };
  }
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.closed?.();
    void this.worker.terminate();
  }
}
