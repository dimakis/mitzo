import type { ToolBlock } from './tool-status';

/** Uses server-authored outcomes; unknown failures never imply approval succeeded. */
export function webAccessOutcome(block: ToolBlock): string | undefined {
  if (
    !['RequestWebAccess', 'mcp__mitzo-web-access__RequestWebAccess'].includes(block.toolName ?? '')
  )
    return undefined;
  if (block.toolResult === undefined) return 'Request in progress…';
  if (!block.toolError) return 'Completed';
  const result = block.toolResult;
  if (result.startsWith('The website redirected to ')) return 'Approved · Redirect needs approval';
  if (result.startsWith('The website refused the approved read'))
    return 'Approved · Website blocked access';
  if (result.startsWith('Approved read exceeded')) return 'Approved · Page too large';
  if (result.startsWith('Approved read timed out')) return 'Approved · Read timed out';
  if (result.startsWith('Approved read returned')) return 'Approved · Unsupported format';
  if (result.startsWith('Approved read could not resolve'))
    return 'Approved · Address lookup failed';
  if (result.startsWith('Approved read could not connect')) return 'Approved · Connection failed';
  if (result.startsWith('Approved read reached')) return 'Approved · Too many redirects';
  if (result.startsWith('Approved web access failed')) return 'Approved · Request failed';
  if (/declined|denied/i.test(result)) return 'Access declined';
  if (/interrupt/i.test(result)) return 'Interrupted';
  if (/expired/i.test(result)) return 'Approval expired';
  if (/changed|unavailable/i.test(result)) return 'Access needs renewal';
  return 'Access failed';
}

export function webAccessSummary(input: string) {
  const fallback = { name: 'Website read', target: input };
  try {
    const request = JSON.parse(input);
    if (request?.operation === 'search')
      return {
        name: 'Web search',
        target: typeof request.query === 'string' ? request.query : input,
      };
    if (typeof request?.url !== 'string') return fallback;
    const url = new URL(request.url);
    const name =
      request.operation === 'request_access'
        ? 'Website access'
        : request.operation === 'revoke_access'
          ? 'Revoke website access'
          : 'Website read';
    return { name, target: url.host + (url.pathname === '/' ? '' : url.pathname) };
  } catch {
    return fallback;
  }
}
