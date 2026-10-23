import { request } from 'node:http';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { RelayTarget } from './secret-relay.js';
import { requestTarget } from './credential-connections.js';
/** Separate explicit cleartext LAN consent; never loosen HTTPS connection policy.
 * Numeric RFC1918 destinations avoid DNS rebinding. Controller interfaces and
 * loopback/metadata/CGNAT/public ranges are excluded. */
export function validateLanRelayEndpoint(value: string) {
  const url = new URL(value);
  const [a, b] = url.hostname.split('.').map(Number);
  if (
    url.protocol !== 'http:' ||
    value !== url.origin ||
    isIP(url.hostname) !== 4 ||
    !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) ||
    Object.values(networkInterfaces())
      .flat()
      .some((i) => i?.address === url.hostname)
  )
    throw new Error('LAN destination unavailable');
  return url.origin;
}
export async function sendLanRelayTarget(
  target: RelayTarget,
  body: string,
  encoding: 'json' | 'form',
  signal: AbortSignal,
  check: () => void,
  dispatched: () => void,
  assertRuntimeCurrent?: () => Promise<void>,
): Promise<{ status: number }> {
  if (Buffer.byteLength(body) > 32768) throw new Error('Request too large');
  if (!('lanEndpoint' in target)) throw new Error('LAN target required');
  const origin = validateLanRelayEndpoint(target.lanEndpoint);
  // Reuse the connection parser's relative-path/traversal checks with a dummy HTTPS origin.
  requestTarget({ endpoint: 'https://relay.invalid', paths: ['/'] }, target.path);
  await assertRuntimeCurrent?.();
  signal.throwIfAborted();
  check();
  validateLanRelayEndpoint(origin);
  return new Promise((resolve, reject) => {
    dispatched();
    const req = request(
      new URL(target.path, origin),
      {
        method: target.method,
        agent: false,
        signal,
        headers: {
          'Content-Type':
            encoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        // The complete response body is deliberately discarded, including echoes.
        response.destroy();
        if (status >= 300 && status < 400) reject(new Error('Redirect refused'));
        else resolve({ status });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
