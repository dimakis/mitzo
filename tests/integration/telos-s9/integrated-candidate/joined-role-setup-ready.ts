import { expect as browserExpect, type Page } from '@playwright/test';
import { TelosWorkRoleContextReviewSchema } from '@mitzo/protocol';
import { expect } from 'vitest';

/** Observe the real startup review before checking the business control. The
 * async response predicate keeps headers, body completion and schema validation
 * inside Playwright's same ten-second response deadline.
 */
export async function navigateToReviewedRoleSetup(page: Page, destination: string) {
  const url = new URL(destination);
  const reviewed = page.waitForResponse(
    async (response) => {
      const responseUrl = new URL(response.url());
      const request = response.request();
      if (
        responseUrl.origin !== url.origin ||
        responseUrl.pathname !== '/api/telos/work/roles/review' ||
        request.method() !== 'POST'
      )
        return false;
      const input = request.postDataJSON() as { itemId?: string; role?: string };
      if (
        input.itemId !== url.searchParams.get('telosRoleItem') ||
        input.role !== url.searchParams.get('telosRole')
      )
        return false;
      expect(response.status()).toBe(200);
      expect(await response.finished()).toBeNull();
      TelosWorkRoleContextReviewSchema.parse(await response.json());
      return true;
    },
    { timeout: 10_000 },
  );
  // Navigation can fail before the already-armed observer settles.
  void reviewed.catch(() => {});
  await page.goto(destination);
  await reviewed;
  await browserExpect(
    page.getByRole('region', { name: 'Work conversation setup', exact: true }),
  ).toBeVisible();
}
