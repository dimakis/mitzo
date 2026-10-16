import type { Page } from '@playwright/test';

/** Complete the reads started by an action before unloading its fixture document. */
export async function waitForNewFixtureReads(
  page: Page,
  paths: readonly string[],
  action: () => Promise<unknown>,
): Promise<void> {
  // Observe new requests, rather than responses that could belong to an older
  // mount. Arm every witness before the action can start its passive effects.
  const reads = paths.map(async (path) => {
    const request = await page.waitForRequest(
      (request) => request.method() === 'GET' && new URL(request.url()).pathname === path,
    );
    const response = await request.response();
    if (!response) throw new Error(`Fixture read did not receive a response: ${path}`);
    const failure = await response.finished();
    if (failure) throw failure;
    if (!response.ok()) throw new Error(`Fixture read failed (${response.status()}): ${path}`);
  });
  await Promise.all([action(), ...reads]);
}
