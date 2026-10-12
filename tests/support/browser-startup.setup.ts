import { test } from '@playwright/test';
import { checkBrowserStartup } from './playwright-browser-startup';

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures; preflight requests no browser.
test('browser startup', async ({}, testInfo) => {
  await checkBrowserStartup([testInfo.project]);
});
