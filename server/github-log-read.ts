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
  | { reason: 'github_http'; status: number; message?: string }
  | { reason: 'redirect_refused'; host: string; detail: string }
  | { reason: 'network'; host?: string; detail: string }
  | { reason: 'unknown' };

const BLOB_HOST = /^[a-z0-9-]+\.blob\.core\.windows\.net$/i;

/** Classify a GitHub CLI log-download failure from its stderr without echoing it.
 * The job-log endpoint redirects to a signed Azure Blob URL, and the CLI prints
 * that URL (including its `sig` token) when the redirect leg fails. The result
 * keeps only the HTTP status, GitHub's short API message or the target host and
 * a fixed network category. URLs, query strings and log content never pass. */
export function classifyGithubLogTransportFailure(stderr: string): GithubLogTransportFailure {
  const text = stderr.slice(0, 4096);
  const http = text.match(/(?:^|\n)(?:gh: )?([^\n]{0,300}?)\s*\(HTTP (\d{3})\)/);
  if (http) {
    const message = http[1]
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[^\w .,:'()-]/g, '')
      .trim()
      .slice(0, 160);
    return { reason: 'github_http', status: Number(http[2]), ...(message ? { message } : {}) };
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
    case 'github_http':
      return `GitHub API returned HTTP ${failure.status}${failure.message ? ` (${failure.message})` : ''}`;
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
