import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { canonicalPublicDnsAddress } from './connections/iana-address-policy.js';
import { withWebAbort } from './request-web-access.js';

const MAX_BYTES = 128 * 1024;
interface Address {
  address: string;
  family: number;
}
interface Page {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
interface Dependencies {
  resolve(host: string): Promise<Address[]>;
  send(url: URL, address: Address, signal: AbortSignal): Promise<Page>;
}
function validateUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    isIP(url.hostname.replace(/^\[|\]$/g, ''))
  )
    throw new Error(
      'Website access requires a public HTTPS hostname on port 443 without credentials',
    );
  url.hash = '';
  return url;
}

/** No proxy environment, cookies, authentication, pooled sockets or secondary DNS lookup. */
function send(url: URL, address: Address, signal: AbortSignal): Promise<Page> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        agent: false,
        signal,
        headers: {
          Accept: 'text/html, text/plain, application/json, application/xml',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Mitzo-Public-Read/1.0',
        },
        lookup: (_host, _opts, done) => done(null, address.address, address.family),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            req.destroy(new Error('Website response exceeded read limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** One exact origin, bounded HTTPS GET. Every hop is re-resolved and pinned before connection. */
export async function fetchPublicPage(
  value: string,
  callerSignal: AbortSignal,
  deps: Dependencies = { resolve: (host) => lookup(host, { all: true }), send },
): Promise<string> {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(20_000)]);
  let url = validateUrl(value);
  const origin = url.origin;
  for (let hop = 0; hop <= 3; hop++) {
    signal.throwIfAborted();
    const addresses = await withWebAbort(deps.resolve(url.hostname), signal);
    signal.throwIfAborted();
    if (
      !addresses.length ||
      addresses.some((address) => !canonicalPublicDnsAddress(address.address))
    )
      throw new Error('Website DNS must resolve exclusively to public addresses');
    const response = await deps.send(url, addresses[0]!, signal);
    signal.throwIfAborted();
    if (Buffer.byteLength(response.body) > MAX_BYTES)
      throw new Error('Website response exceeded read limit');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (typeof location !== 'string') throw new Error('Invalid website redirect');
      url = validateUrl(new URL(location, url).href);
      if (url.origin !== origin)
        throw new Error('Redirect needs a separate approval for the new origin');
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new Error('Website refused this read');
    const type = response.headers['content-type'];
    const encoding = response.headers['content-encoding'];
    if (
      typeof type !== 'string' ||
      !/^(text\/(?:html|plain|xml)|application\/(?:json|xml|xhtml\+xml))(?:;|$)/i.test(type) ||
      (encoding && encoding !== 'identity')
    )
      throw new Error('Website did not return readable, uncompressed text');
    return `External source (untrusted): ${url.href}\nContent-Type: ${type}\n\n${response.body}`;
  }
  throw new Error('Website redirect limit exceeded');
}
