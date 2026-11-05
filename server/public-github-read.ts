import { fetchPublicPage } from './public-web-fetch.js';
import { isTrustedGitHubEndpoint } from './trusted-native-operation.js';

/** The public route never invokes gh or reads host credentials. A failed public
 * request stays public; authenticated access is a separate, reviewed invocation. */
export async function executePublicGitHubRead(
  endpoint: string,
  signal: AbortSignal,
  timeoutMs = 30_000,
  maxOutputBytes = 64 * 1024,
  view?: 'summary' | 'full',
  assertCurrent?: () => void,
): Promise<string> {
  if (!endpoint.startsWith('/repos/') || !isTrustedGitHubEndpoint(endpoint))
    throw Error('Public GitHub reads require a valid /repos/OWNER/REPO/... endpoint');
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const current = () => {
    bounded.throwIfAborted();
    assertCurrent?.();
  };
  current();
  const content = await fetchPublicPage(
    `https://api.github.com${endpoint}`,
    bounded,
    undefined,
    async () => current(),
    view,
  );
  current();
  if (Buffer.byteLength(content) > maxOutputBytes)
    throw Error('Public GitHub response exceeds the output limit. Request a narrower read.');
  return content;
}
