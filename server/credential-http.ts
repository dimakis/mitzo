import { canonicalPublicDnsAddress } from './connections/iana-address-policy.js';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import type { AuthenticatedRequest, ConnectionSender } from './credential-connections.js';

/** Enrollment may permit LAN services, but never local controller or metadata endpoints. */
export function isAllowedConnectionAddress(address: string, allowPrivate: boolean): boolean {
  if (canonicalPublicDnsAddress(address)) return true;
  if (!allowPrivate) return false;
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return isIP(address) === 6 && /^(fc|fd)/i.test(address);
}
const httpsSend: ConnectionSender = (input, signal) =>
  new Promise((resolve, reject) => {
    const hostname = input.url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname) && !isAllowedConnectionAddress(hostname, input.allowPrivateNetwork))
      return reject(new Error('Destination is unavailable'));
    const request = httpsRequest(
      input.url,
      {
        method: input.method,
        agent: false,
        rejectUnauthorized: true,
        signal,
        headers: {
          Accept: 'application/json, text/plain',
          'Accept-Encoding': 'identity',
          ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...input.headers,
        },
        // Resolve and validate every address, then connect to that checked result. No DNS TOCTOU lookup.
        lookup: (host, options, callback) => {
          lookup(host, { all: true }, (error, addresses) => {
            if (
              error ||
              !addresses?.length ||
              addresses.length > 16 ||
              addresses.some(
                (a) =>
                  isIP(a.address) !== a.family ||
                  !isAllowedConnectionAddress(a.address, input.allowPrivateNetwork),
              )
            )
              return callback(error ?? new Error('Destination is unavailable'), [], undefined);
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          });
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        // Refuse redirects before reading their body; never resend authentication to another URL.
        if (status >= 300 && status < 400) {
          response.destroy();
          reject(new Error('Redirects are unavailable'));
          return;
        }
        const parts: Buffer[] = [];
        let size = 0;
        response.on('data', (part: Buffer) => {
          size += part.length;
          if (size > 64 * 1024) {
            const error = new Error('Connection response is too large');
            reject(error);
            response.destroy(error);
            return;
          }
          parts.push(part);
        });
        response.on('error', reject);
        response.on('end', () => resolve({ status, body: Buffer.concat(parts).toString('utf8') }));
      },
    );
    request.on('error', reject);
    request.end(input.body);
  });
export async function sendConnectionRequest(
  input: AuthenticatedRequest,
  signal: AbortSignal,
  send: ConnectionSender = httpsSend,
) {
  signal.throwIfAborted();
  const response = await send(input, signal);
  signal.throwIfAborted();
  if (response.status >= 300 && response.status < 400) throw new Error('Redirects are unavailable');
  return response;
}
