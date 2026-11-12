import { expect, type Page } from '@playwright/test';

export async function reviewQueuedDrafts(page: Page) {
  const queue = page.getByRole('region', { name: 'Up next' });
  await expect(queue).toBeVisible();
}

export async function closeComposerStatus(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Conversation status' });
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
}
