import { expect, type Locator, type Page } from '@playwright/test';

type Field = 'Account' | 'Model' | 'Thinking level' | 'Thinking';
const key = (field: Field) =>
  field === 'Account' ? 'account' : field === 'Model' ? 'model' : 'thinking';
export const settingRow = (scope: Page | Locator, field: Field) =>
  scope.locator(`[data-quick-setting="${key(field)}"]`);

export async function settingsHome(page: Page) {
  const trigger = page.getByRole('button', { name: /^Workspace controls/ });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  const panel = page.getByRole('region', { name: 'Agent settings', exact: true });
  while (await panel.getByRole('button', { name: 'Back to chat settings' }).count())
    await panel.getByRole('button', { name: 'Back to chat settings' }).click();
  return panel;
}

export async function openChatSetting(page: Page, field: string) {
  const panel = await settingsHome(page);
  await panel.locator(`[data-quick-setting="${field}"]`).click();
  return panel;
}

export async function chooseSetting(page: Page, field: Field, value: string) {
  const row = settingRow(page, field);
  if (!(await row.count())) {
    await page.getByRole('combobox', { name: field, exact: true }).selectOption(value);
    return;
  }
  const previous = await page
    .locator('.workspace-controls-settings')
    .getAttribute('data-settings-page');
  const panel = await openChatSetting(page, key(field));
  await panel.locator(`[data-setting-value=${JSON.stringify(value)}]`).click();
  await settingsHome(page);
  if (previous && previous !== 'main' && previous !== key(field))
    await openChatSetting(page, previous);
}

export async function expectSettingValue(page: Page, field: Field, value: string) {
  await expect(settingRow(page, field)).toHaveAttribute('data-value', value);
}

export const settingChoices = (page: Page, field: Field) =>
  page.locator(
    `[aria-label="${field === 'Thinking level' ? 'Thinking' : field} options"] .quick-settings-choices`,
  );

export async function chooseAgent(page: Page, value: string) {
  const previous = await page
    .locator('.workspace-controls-settings')
    .getAttribute('data-settings-page');
  const panel = await openChatSetting(page, 'agent');
  await panel.getByRole('combobox', { name: 'Agent', exact: true }).selectOption(value);
  await settingsHome(page);
  if (previous && previous !== 'main' && previous !== 'agent')
    await openChatSetting(page, previous);
}
