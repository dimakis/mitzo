import { expect, type Page } from '@playwright/test';

export async function openToolLibrary(page: Page) {
  const options = page.getByText('Library options', { exact: true });
  if (!(await options.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
    await options.click();
  await page.getByRole('button', { name: 'Tool library', exact: true }).click();
}

export async function editProfile(page: Page) {
  const tools = page.getByRole('tab', { name: 'Tools', exact: true });
  const edit = page.getByText('Edit profile', { exact: true });
  await expect(tools.or(edit).first()).toBeVisible();
  if (!(await tools.isVisible())) await edit.click();
}

export async function openProfileTools(page: Page) {
  await editProfile(page);
  await page.getByRole('tab', { name: 'Tools', exact: true }).click();
}
