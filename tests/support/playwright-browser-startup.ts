import { chromium, firefox, webkit } from '@playwright/test';
import type { Browser, FullProject, PlaywrightTestConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

function startupSettings(use: FullProject['use'] = {}) {
  return {
    browserName: use.browserName ?? use.defaultBrowserType ?? 'chromium',
    launchOptions: {
      ...use.launchOptions,
      headless: use.headless ?? use.launchOptions?.headless ?? true,
      ...(use.channel ? { channel: use.channel } : {}),
    },
  };
}

// Let Playwright select setup dependencies with their projects, including CLI
// wildcards and variadic --project filters. Global setup receives every project.
export function withBrowserStartup(
  projects: NonNullable<PlaywrightTestConfig['projects']>,
): NonNullable<PlaywrightTestConfig['projects']> {
  const setups = new Map<string, NonNullable<PlaywrightTestConfig['projects']>[number]>();
  const dependentProjects = projects.map((project) => {
    const settings = startupSettings(project.use);
    const key = JSON.stringify(settings);
    let setup = setups.get(key);
    if (!setup) {
      const name = `browser-startup-${setups.size}`;
      if (projects.some((candidate) => candidate.name === name)) {
        throw new Error(`Reserved Playwright setup project name: ${name}`);
      }
      setup = {
        name,
        testDir: fileURLToPath(new URL('.', import.meta.url)),
        testMatch: '**/browser-startup.setup.ts',
        retries: 0,
        use: settings,
      };
      setups.set(key, setup);
    }
    return { ...project, dependencies: [...(project.dependencies ?? []), setup.name!] };
  });
  return [...setups.values(), ...dependentProjects];
}

// A broken installation or denied launch must fail once during setup, before
// Playwright starts replacing failed workers for every test in the suite.
export async function checkBrowserStartup(
  projects: Pick<FullProject, 'name' | 'use'>[],
): Promise<void> {
  const checked = new Set<string>();
  for (const project of projects) {
    const { browserName: name, launchOptions: options } = startupSettings(project.use);
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
        `Playwright startup failed for ${project.name} (${name}); dependent tests are blocked. ` +
          `Resolve the browser installation or host permissions before retrying.\n${detail}`,
        { cause },
      );
    }
  }
}
