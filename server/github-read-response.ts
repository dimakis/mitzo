export interface GitHubReadResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
  retryAfterMs?: number;
}
/** Bounded gh --include envelope; only quota/pagination metadata escapes. */
export function parseGitHubReadResponse(raw: string): GitHubReadResponse {
  if (Buffer.byteLength(raw) > 1048576) throw Error('github_response_invalid');
  const split = /\r?\n\r?\n/.exec(raw);
  if (!split || split.index > 16384) throw Error('github_response_invalid');
  const lines = raw.slice(0, split.index).split(/\r?\n/),
    status = /^HTTP\/\d(?:\.\d)? (\d{3})(?: |$)/.exec(lines.shift() ?? '');
  if (!status) throw Error('github_response_invalid');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 1) throw Error('github_response_invalid');
    const key = line.slice(0, colon).toLowerCase(),
      value = line.slice(colon + 1).trim();
    if (
      [
        'retry-after',
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
        'x-ratelimit-reset',
        'x-ratelimit-resource',
        'link',
      ].includes(key)
    ) {
      if (headers[key] !== undefined || value.length > 4096) throw Error('github_response_invalid');
      headers[key] = value;
    }
  }
  const body = raw.slice(split.index + split[0].length);
  const retry = headers['retry-after'];
  return {
    status: Number(status[1]),
    headers,
    data: body ? JSON.parse(body) : null,
    ...(retry && /^\d+$/.test(retry)
      ? { retryAfterMs: Math.min(Number(retry) * 1000, 86400000) }
      : {}),
  };
}
