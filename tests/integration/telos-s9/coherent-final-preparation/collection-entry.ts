import { expect } from 'vitest';
import { expect as browserExpect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TelosWorkItemSchema } from '@mitzo/protocol';

/** Called once at the coherent journey's natural entry. It does not retry,
 * replace a failing list response or infer a cause for a Protected command failure. */
export async function observeActualAllOutcomesEntry(
  page: Page,
  origin: string,
  record: (stage: string, facts: Record<string, unknown>) => Promise<void>,
) {
  const [response] = await Promise.all([
    page.waitForResponse((value) => {
      const url = new URL(value.url());
      return (
        url.origin === origin &&
        url.pathname === '/api/telos/work/collection' &&
        value.request().method() === 'GET'
      );
    }),
    page.goto(origin + '/todos'),
  ]);
  let body: string | undefined;
  let bodyReadError: string | undefined;
  try {
    body = await response.text();
  } catch (error) {
    bodyReadError = String(error);
  }
  await record('actual-collection-at-natural-coherent-journey-entry-before-oracles', {
    url: response.url(),
    status: response.status(),
    body,
    bodyReadError,
    sha256: body === undefined ? null : createHash('sha256').update(body).digest('hex'),
  });
  expect(response.status()).toBe(200);
  expect(bodyReadError).toBeUndefined();
  expect(body).toBeDefined();
  const collection = z
    .object({
      records: z.array(TelosWorkItemSchema),
      profiles: z.array(z.string()),
      failures: z.array(z.object({ itemId: z.string(), code: z.string() })),
    })
    .parse(JSON.parse(body!));
  const all = page.getByRole('button', { name: 'All outcomes', exact: true });
  await browserExpect(all).toBeVisible();
  await all.click();
  await browserExpect(all).toHaveAttribute('aria-pressed', 'true');
  const tree = page.getByRole('region', { name: 'Outcomes tree', exact: true });
  await browserExpect(tree).toBeVisible();
  await record('actual-all-outcomes-selected-at-natural-journey-entry', {
    collection,
    ax: await tree.ariaSnapshot(),
  });
  return collection;
}
