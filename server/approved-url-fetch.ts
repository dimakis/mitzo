import { withWebAbort, WebAccessError } from './request-web-access.js';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
export class ApprovedUrlRedirect extends WebAccessError {
  constructor(readonly url: string) {
    super(`Request separate URL approval for ${url}`);
  }
}
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
          if (bytes > 128 * 1024)
            req.destroy(new WebAccessError('Approved read exceeded the 128 KB page limit.'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          if (
            response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity'
          )
            return reject(
              new WebAccessError('Approved read returned an unsupported format or compression.'),
            );
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
  try {
    let url = canonicalApprovalUrl(value);
    for (let hop = 0; hop <= 3; hop++) {
      signal.throwIfAborted();
      if (url.origin !== target.origin) throw new ApprovedUrlRedirect(url.href);
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
        throw new WebAccessError('URL destination addresses changed; request access again');
      let response: Awaited<ReturnType<typeof read>> | undefined;
      let connectionCode: string | undefined;
      for (const address of current.addresses) {
        signal.throwIfAborted();
        try {
          response = await deps.read(url, address, signal);
          break;
        } catch (error) {
          signal.throwIfAborted();
          const code = (error as NodeJS.ErrnoException)?.code;
          connectionCode = code;
          if (!['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(code ?? ''))
            throw error;
        }
      }
      if (!response) {
        if (connectionCode === 'ETIMEDOUT')
          throw new WebAccessError('Approved read timed out. Retry the read.');
        throw new Error('No approved URL destination could be reached');
      }
      if (Buffer.byteLength(response.body) > 128 * 1024)
        throw new WebAccessError('Approved read exceeded the 128 KB page limit.');
      signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
        url = canonicalApprovalUrl(new URL(response.location, url).href);
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        throw new WebAccessError(
          `The website refused the approved read (HTTP ${response.status}).`,
        );
      if (!/^(text\/|application\/(json|xml|xhtml\+xml))/i.test(response.type))
        throw new WebAccessError('Approved read returned an unsupported format or compression.');
      return `External source (untrusted): ${url.href}\nContent-Type: ${response.type}\n\n${response.body}`;
    }
    throw new WebAccessError('Approved read reached the redirect limit.');
  } catch (error) {
    if (callerSignal.aborted) throw new WebAccessError('Web access interrupted');
    if (signal.aborted) throw new WebAccessError('Approved read timed out. Retry the read.');
    if (error instanceof WebAccessError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code ?? ''))
      throw new WebAccessError(
        'Approved read could not resolve the website address. Retry the read.',
      );
    throw new WebAccessError(
      'Approved read could not connect securely to the website. Retry the read.',
    );
  }
}
