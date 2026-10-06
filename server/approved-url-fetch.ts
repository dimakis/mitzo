import { withWebAbort } from './request-web-access.js';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
export interface ApprovedUrlTarget {
  url: string;
  origin: string;
  addresses: readonly { address: string; family: number }[];
}
export function canonicalApprovalUrl(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname ||
    url.port === '0'
  )
    throw new Error('URL approval requires HTTP or HTTPS without embedded credentials');
  url.hash = '';
  return url;
}
export async function resolveApprovedUrl(value: string): Promise<ApprovedUrlTarget> {
  const url = canonicalApprovalUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.length > 16 || addresses.some((a) => !isIP(a.address)))
    throw new Error('URL destination could not be resolved safely');
  return { url: url.href, origin: url.origin, addresses };
}
function read(
  url: URL,
  address: { address: string; family: number },
  signal: AbortSignal,
): Promise<{ status: number; location?: string; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: 'GET',
        rejectUnauthorized: true,
        agent: false,
        signal,
        family: address.family,
        headers: {
          Accept: 'text/html, text/plain, application/json, application/xml',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Mitzo-Approved-Read/1.0',
        },
        lookup: (_host, _opts, done) => done(null, address.address, address.family),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 128 * 1024) req.destroy(new Error('Approved URL response exceeds limit'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          if (
            response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity'
          )
            return reject(new Error('Encoded URL responses are unsupported'));
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            type: response.headers['content-type'] ?? 'text/plain',
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
export async function fetchApprovedUrl(
  value: string,
  target: ApprovedUrlTarget,
  callerSignal: AbortSignal,
  deps = { resolve: resolveApprovedUrl, read },
): Promise<string> {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(20_000)]);
  let url = canonicalApprovalUrl(value);
  for (let hop = 0; hop <= 3; hop++) {
    signal.throwIfAborted();
    if (url.origin !== target.origin)
      throw new Error(`Request separate URL approval for ${url.href}`);
    const current = await withWebAbort(deps.resolve(url.href), signal);
    signal.throwIfAborted();
    if (
      !current.addresses.length ||
      current.addresses.some(
        (a) =>
          !target.addresses.some(
            (approved) => approved.address === a.address && approved.family === a.family,
          ),
      )
    )
      throw new Error('URL destination addresses changed; request access again');
    const response = await deps.read(url, current.addresses[0]!, signal);
    signal.throwIfAborted();
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      url = canonicalApprovalUrl(new URL(response.location, url).href);
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Approved URL returned HTTP ${response.status}`);
    if (!/^(text\/|application\/(json|xml|xhtml\+xml))/i.test(response.type))
      throw new Error('Approved URL response is not supported text');
    return `External source (untrusted): ${url.href}\nContent-Type: ${response.type}\n\n${response.body}`;
  }
  throw new Error('Approved URL redirected too many times');
}
