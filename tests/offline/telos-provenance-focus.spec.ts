import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve, basename } from 'node:path';

const entry = resolve('tests/fixtures/telos-provenance-focus.tsx');
const routePages = [
  'SandboxesView',
  'TerminalView',
  'SettingsView',
  'DraftsView',
  'UpdatesView',
  'BackupsView',
  'NotificationsView',
  'SymposiumSavedReviewRecordPage',
  'Login',
  'Today',
  'QuoteView',
  'BriefingView',
  'MockupsView',
  'MoreView',
  'ConnectionSetupView',
  'ConnectionsRoute',
  'ConnectionsAccessView',
  'SessionList',
  'ResponsiveChatView',
  'KnowledgeLibrary',
  'AgentLibrary',
  'FileViewer',
  'UnifiedInboxView',
  'InboxRedirect',
  'CalendarView',
  'TodoWorkspace',
  'TaskBoard',
];
const bundle = build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-provenance-focus.js',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
  plugins: [
    {
      name: 'isolate-unrelated-app-owners',
      setup(build) {
        build.onLoad({ filter: /frontend\/src\/route-pages\.tsx?$/ }, () => ({
          contents: `import {FocusPage} from ${JSON.stringify(entry)};${routePages.map((name) => `export const ${name}=${name === 'Today' ? 'FocusPage' : '()=>null'};`).join('')}`,
          loader: 'tsx',
        }));
        build.onLoad(
          {
            filter:
              /components\/(NotificationProvider|MobileShell|DesktopShell|ProtectedRoute)\.tsx$/,
          },
          ({ path }) => {
            const name = basename(path, '.tsx');
            return {
              contents: `export function ${name}({children,center}) {return ${name === 'DesktopShell' ? 'center' : 'children'};}`,
              loader: 'tsx',
            };
          },
        );
      },
    },
  ],
});
for (const theme of ['dark', 'light'])
  test(`real App capture preserves native provenance keyboard focus (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const files = (await bundle).outputFiles!;
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 850 });
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = files.find(
        (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/');
    const summary = page.locator('summary');
    const details = summary.locator('..');
    const action = page.getByRole('button', { name: 'Next ordinary action' });
    await action.focus();
    await page.keyboard.press('Enter');
    await expect(action).toBeFocused();
    await summary.focus();
    for (const key of ['Enter', 'Space']) {
      await page.keyboard.press(key);
      await expect(details).toHaveAttribute('open', '');
      await expect(summary).toBeFocused();
      await expect(details.getByText(/operator:fixture/)).toBeVisible();
      await page.keyboard.press(key);
      await expect(details).not.toHaveAttribute('open', '');
      await expect(summary).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(page.getByRole('textbox', { name: 'Next keyboard field' })).toBeFocused();
    const input = page.getByRole('textbox', { name: 'Retained draft' });
    await input.focus();
    await page.getByText('Conversation background', { exact: true }).click();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await expect(input).toHaveValue('Keep this draft');
    await page.screenshot({
      path: info.outputPath(`provenance-focus-${theme}.png`),
      fullPage: true,
    });
  });
