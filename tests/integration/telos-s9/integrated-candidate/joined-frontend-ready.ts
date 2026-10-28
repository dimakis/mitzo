import type { DevEnvironment } from 'vite';

/** Compile the real client graph before browser navigation starts its unchanged
 * readiness deadline. No browser document, API call or application state runs. */
export async function prepareJoinedFrontend(
  client: Pick<DevEnvironment, 'transformRequest' | 'waitForRequestsIdle'>,
  entry = '/src/main.tsx',
) {
  if (!(await client.transformRequest(entry))) throw Error('Joined frontend entry unavailable');
  await client.waitForRequestsIdle();
}
