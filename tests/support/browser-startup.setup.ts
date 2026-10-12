import { test } from '@playwright/test';
import { checkBrowserStartup } from './playwright-browser-startup';

test('browser startup', async ({}, testInfo) => {
  await checkBrowserStartup([testInfo.project]);
});
