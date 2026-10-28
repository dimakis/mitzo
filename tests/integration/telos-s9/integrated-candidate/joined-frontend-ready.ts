import type { DevEnvironment } from 'vite';

/** Compile the real client graph before browser navigation starts its unchanged
 * readiness deadline. No browser document, API call or application state runs. */
export async function prepareJoinedFrontend(
  client: Pick<DevEnvironment, 'transformRequest' | 'waitForRequestsIdle'>,
  entries: readonly string[] = [
    '/src/main.tsx',
    '/src/render-app.tsx',
    '/src/components/ResponsiveChatView.tsx',
    '/src/pages/TaskBoard.tsx',
  ],
) {
  // Start every dynamic entry before the idle observer settles its first crawl.
  const transformed = await Promise.all(entries.map((entry) => client.transformRequest(entry)));
  if (transformed.some((result) => !result)) throw Error('Joined frontend entry unavailable');
  await client.waitForRequestsIdle();
}
