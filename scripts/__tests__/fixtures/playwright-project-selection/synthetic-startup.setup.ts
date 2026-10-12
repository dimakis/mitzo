import { test } from '@playwright/test';

test('synthetic browser startup', async ({}, testInfo) => {
  const engine = testInfo.project.use.browserName;
  console.log(`startup ${engine}`);
  if (engine === 'webkit') throw new Error('WebKit installation unavailable');
});
