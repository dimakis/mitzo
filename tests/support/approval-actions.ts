import type { Locator, Page } from '@playwright/test';

/** Secondary decisions use the same keyboard-accessible menu in every consumer. */
export async function approvalSecondary(page: Page, card: Locator, name: string) {
  const trigger = card.getByRole('button', { name: 'More approval actions', exact: true });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  return page
    .getByRole('menu', { name: 'More approval actions' })
    .getByRole('menuitem', { name, exact: true });
}
