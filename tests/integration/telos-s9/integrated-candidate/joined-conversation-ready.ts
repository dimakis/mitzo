import { expect as browserExpect, type Page } from '@playwright/test';
import { expect, vi } from 'vitest';
import { LAST_SESSION_KEY } from '../../../../frontend/src/lib/constants';

/** The route URL can change before the destination composer owns its draft.
 * Reads are captured by the journey's response observer before setup/navigation.
 * Await the real destination, rather than typing into the departing composer.
 */
export async function waitForPreparedConversation(
  page: Page,
  capturedReads: readonly unknown[],
  sessionId: string,
) {
  const read = (suffix: string) =>
    capturedReads.flatMap((value) => {
      const response = value as { path?: string; status?: number; body?: string };
      if (
        response.path !== `/api/sessions/${sessionId}/${suffix}` ||
        response.status !== 200 ||
        typeof response.body !== 'string'
      )
        return [];
      return [JSON.parse(response.body)];
    });
  await vi.waitFor(
    () => {
      expect(read('meta')).toContainEqual(
        expect.objectContaining({ sessionId, runtimeCommandScope: 'prepared-first-command' }),
      );
      expect(read('messages').some((body) => Array.isArray(body.messages))).toBe(true);
    },
    { timeout: 10_000 },
  );
  // This actual session-selection effect follows the composer's layout commit.
  await browserExpect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), LAST_SESSION_KEY))
    .toBe(sessionId);
  await browserExpect(
    page.getByText('Loading conversation settings…', { exact: true }),
  ).toBeHidden();
}

/** Install before a process-hosted journey navigates to its first conversation. */
export function observePreparedConversations(page: Page) {
  const capturedReads: unknown[] = [];
  page.on('response', async (response) => {
    const path = new URL(response.url()).pathname;
    if (!/^\/api\/sessions\/[^/]+\/(meta|messages)$/.test(path)) return;
    capturedReads.push({
      path,
      status: response.status(),
      body: await response.text().catch(() => '<unavailable>'),
    });
  });
  return (sessionId: string) => waitForPreparedConversation(page, capturedReads, sessionId);
}
