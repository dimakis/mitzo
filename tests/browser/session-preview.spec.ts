import { expect, test } from '@playwright/test';

test('session hold previews history and keeps actions reachable in small viewports', async ({
  page,
  isMobile,
}) => {
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/sessions')
      return route.fulfill({
        json: {
          sessions: [{ id: 'one', summary: 'Review UI', lastModified: Date.now() }],
          hasMore: false,
        },
      });
    if (path === '/api/sessions/one/messages')
      return route.fulfill({
        json: [
          {
            messageId: 'm1',
            role: 'assistant',
            blocks: [
              {
                blockId: 'b1',
                blockType: 'text',
                content:
                  '## Latest answer\n\nA saved response that can be previewed without entering the conversation.\n\n' +
                  'Additional details. '.repeat(300),
              },
            ],
          },
        ],
      });
    return route.fulfill({ json: {} });
  });
  await page.clock.install();
  await page.goto('/sessions');
  const row = page.getByRole('link', { name: 'Open Review UI' });
  // Wait for a stable row before dispatching synthetic touch input in Vite's
  // StrictMode build; its initial effect cleanup cancels pending holds.
  await row.scrollIntoViewIfNeeded();
  if (isMobile) {
    await row.dispatchEvent('touchstart', { touches: [{ clientX: 80, clientY: 200 }] });
    await page.clock.runFor(500);
  } else {
    await row.click({ button: 'right' });
  }
  const dialog = page.getByRole('dialog', { name: 'Preview Review UI' });
  await expect(dialog).toBeVisible();
  if (isMobile) await row.dispatchEvent('touchend', { touches: [] });
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(dialog.getByRole('heading', { name: 'Latest answer' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete conversation' })).toBeInViewport();
  // Native modal focus must stay inside the preview rather than entering the list.
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  if (isMobile) {
    await page.setViewportSize({ width: 390, height: 430 });
    await dialog.getByRole('button', { name: 'Delete conversation' }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: 'Delete conversation' })).toBeInViewport();
  }
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(row).toBeFocused();
  await row.press('Shift+F10');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.session-rename-input')).toBeFocused();
});
