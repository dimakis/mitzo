import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { withBrowserStartup } from '../../../../tests/support/playwright-browser-startup';

const testDir = fileURLToPath(new URL('.', import.meta.url));
const projects = withBrowserStartup([
  {
    name: 'mobile-webkit',
    testDir,
    testMatch: '**/selected.pw.ts',
    use: { defaultBrowserType: 'webkit' },
  },
  {
    name: 'mobile-chromium',
    testDir,
    testMatch: '**/selected.pw.ts',
    use: { browserName: 'chromium' },
  },
  {
    name: 'desktop-chromium',
    testDir,
    testMatch: '**/selected.pw.ts',
    use: { browserName: 'chromium' },
  },
]);

export default defineConfig({
  projects: projects.map((project) =>
    project.name?.startsWith('browser-startup-')
      ? { ...project, testDir, testMatch: '**/synthetic-startup.setup.ts' }
      : project,
  ),
  outputDir: fileURLToPath(new URL('../../../../test-results/project-selection', import.meta.url)),
});
