import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  use: { baseURL: 'http://127.0.0.1:4179', trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command:
      'npx tsc -b packages/protocol packages/client && npx vite frontend --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179',
    timeout: 120_000,
  },
});
