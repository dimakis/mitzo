import { z } from 'zod';

/** Plain job logs only: run-log endpoints return archives, not text. */
export const GithubLogReadSchema = z.strictObject({
  offset: z
    .number()
    .int()
    .min(0)
    .max(8 * 1024 * 1024)
    .optional(),
  limit: z.number().int().min(1).max(16000).optional(),
  query: z.string().min(1).max(500).optional(),
});
export type GithubLogRead = z.infer<typeof GithubLogReadSchema>;
export const GITHUB_LOG_SOURCE_LIMIT = 8 * 1024 * 1024;

export function validateGithubLogRead(endpoint: string, options: unknown): GithubLogRead {
  if (!/^\/repos\/[\w.-]+\/[\w.-]+\/actions\/jobs\/[1-9]\d*\/logs$/.test(endpoint))
    throw Error('Log controls require /repos/OWNER/REPO/actions/jobs/JOB_ID/logs');
  return GithubLogReadSchema.parse(options);
}

export type GithubLogTransportFailure =
  | { reason: 'http_status'; status: number; meaning?: string }
  | { reason: 'redirect_refused'; host: string; detail: string }
  | { reason: 'network'; host?: string; detail: string }
  | { reason: 'unknown' };

const BLOB_HOST = /^[a-z0-9-]+\.blob\.core\.windows\.net$/i;
// `gh` prints `gh: MESSAGE (HTTP 403)` for JSON API errors and a bare
// `gh: HTTP 403` for other bodies, such as blob-storage XML or proxy HTML.
const HTTP_STATUS_LINE = /^(?:gh: )?(?:HTTP (\d{3})|.*\(HTTP (\d{3})\))\s*$/m;

/** Fixed wording per status. The API or blob message is free-form text that can
 * name hosts or carry signed parameters, so it is never reported. */
function httpStatusMeaning(status: number) {
  if (status === 401) return 'authentication failed';
  if (status === 403) return 'access denied or rate limited';
  if (status === 404) return 'not found or not visible to this credential';
  if (status === 410) return 'log no longer available';
  if (status === 429) return 'rate limited';
  if (status >= 500) return 'server error';
  return undefined;
}

/** Classify a GitHub CLI log-download failure from its stderr without echoing it.
 * The job-log endpoint redirects to a signed Azure Blob URL, and the CLI prints
 * that URL (including its `sig` token) when the redirect leg fails. The result
 * keeps only the HTTP status with fixed wording, or an allowlisted target host
 * and a fixed network category. Messages, URLs and log content never pass. */
export function classifyGithubLogTransportFailure(stderr: string): GithubLogTransportFailure {
  // The CLI reports its final failure last; bound the scan to the tail.
  const text = stderr.slice(-65536);
  const http = text.match(HTTP_STATUS_LINE);
  const status = Number(http?.[1] ?? http?.[2]);
  if (status >= 100 && status <= 599) {
    const meaning = httpStatusMeaning(status);
    return { reason: 'http_status', status, ...(meaning ? { meaning } : {}) };
  }
  const target = text.match(/"https:\/\/([a-z0-9.-]+)(?:[/?][^"]*)?":\s*([^\n]*)/i);
  // Report only expected hosts by name; anything else stays anonymous.
  const rawHost = target?.[1].toLowerCase();
  const host =
    rawHost === undefined
      ? undefined
      : BLOB_HOST.test(rawHost) || /^(?:api\.)?github\.com$/.test(rawHost)
        ? rawHost
        : 'other-host';
  const failure = (target?.[2] ?? text).toLowerCase();
  const detail = /no such host|server misbehaving/.test(failure)
    ? 'dns_failure'
    : /connection refused/.test(failure)
      ? 'connection_refused'
      : /i\/o timeout|deadline exceeded|timed out/.test(failure)
        ? 'timeout'
        : /x509|tls|certificate/.test(failure)
          ? 'tls_failure'
          : /proxyconnect|proxy/.test(failure)
            ? 'proxy_failure'
            : /^forbidden\b|^bad gateway\b|^service unavailable\b/.test(failure.trim())
              ? 'egress_proxy_refused'
              : undefined;
  if (target && detail === 'egress_proxy_refused')
    return { reason: 'redirect_refused', host: host ?? 'other-host', detail };
  if (detail) return { reason: 'network', ...(host ? { host } : {}), detail };
  return { reason: 'unknown' };
}

export function describeGithubLogTransportFailure(failure: GithubLogTransportFailure): string {
  switch (failure.reason) {
    case 'http_status':
      return `the log request returned HTTP ${failure.status}${failure.meaning ? ` (${failure.meaning})` : ''}`;
    case 'redirect_refused':
      return `the log download redirect to ${failure.host} was refused by a network proxy`;
    case 'network':
      return `network failure${failure.host ? ` reaching ${failure.host}` : ''} (${failure.detail})`;
    default:
      return 'unclassified GitHub CLI failure';
  }
}

/** Offsets count UTF-16 characters in the optionally filtered text. Returning
 * the continuation explicitly prevents a bounded excerpt looking complete. */
export function githubLogPage(body: string, options: GithubLogRead) {
  const text = options.query
    ? body
        .split(/\r?\n/)
        .filter((line) => line.includes(options.query!))
        .join('\n')
    : body;
  const offset = Math.min(options.offset ?? 0, text.length);
  const end = Math.min(text.length, offset + (options.limit ?? 16000));
  return {
    content: text.slice(offset, end),
    offset,
    nextOffset: end < text.length ? end : null,
    totalCharacters: text.length,
    sourceBytes: Buffer.byteLength(body),
    ...(options.query ? { query: options.query } : {}),
  };
}
