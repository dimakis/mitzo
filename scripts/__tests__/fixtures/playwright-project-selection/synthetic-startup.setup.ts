import { test } from '@playwright/test';

// eslint-disable-next-line no-empty-pattern -- Match the no-browser Playwright startup fixture signature.
test('synthetic browser startup', async ({}, testInfo) => {
  const engine = testInfo.project.use.browserName;
  console.log(`startup ${engine}`);
  if (engine === 'webkit') throw new Error('WebKit installation unavailable');
});
