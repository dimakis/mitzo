import { chromium, firefox, webkit } from '@playwright/test';
import type { Browser, FullConfig, FullProject } from '@playwright/test';
import { assertPlaywrightHost } from './playwright-host';

// A broken installation or denied launch must fail once during setup, before
// Playwright starts replacing failed workers for every test in the suite.
export async function checkBrowserStartup(
  projects: Pick<FullProject, 'name' | 'use'>[],
): Promise<void> {
  const checked = new Set<string>();
  for (const project of projects) {
    const name = project.use.browserName ?? 'chromium';
    const options = {
      ...project.use.launchOptions,
      headless: project.use.headless ?? project.use.launchOptions?.headless ?? true,
      ...(project.use.channel ? { channel: project.use.channel } : {}),
    };
    const key = JSON.stringify({ name, options });
    if (checked.has(key)) continue;
    checked.add(key);
    let browser: Browser | undefined;
    try {
      browser = await { chromium, firefox, webkit }[name].launch(options);
      await browser.newPage();
      await browser.close();
      browser = undefined;
    } catch (cause) {
      await browser?.close().catch(() => {});
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Playwright startup failed for ${project.name} (${name}); no tests were run. ` +
          `Resolve the browser installation or host permissions before retrying.\n${detail}`,
        { cause },
      );
    }
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  assertPlaywrightHost();
  await checkBrowserStartup(config.projects);
}
