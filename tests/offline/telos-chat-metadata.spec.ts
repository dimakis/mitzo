import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-chat-metadata.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-chat-metadata.js',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'])
  for (const known of [true, false])
    test(`chooser metadata hierarchy and exact provenance ${theme}, created known=${known}`, async ({
      page,
      isMobile,
    }, info) => {
      const files = (await bundle).outputFiles!;
      const writes: string[] = [];
      await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 1000 });
      await page.route('**/*', (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.startsWith('/api/')) {
          if (route.request().method() !== 'GET') writes.push(path);
          if (path === '/api/sessions')
            return route.fulfill({
              json: {
                sessions: ['former', 'additional', 'current'].map((id) => ({
                  id,
                  summary:
                    id === 'additional'
                      ? 'Independent acoustic discussion'
                      : `${id} lead discussion`,
                  lastModified: Date.parse('2026-10-20T00:00:00Z'),
                })),
                hasMore: false,
              },
            });
          if (path.endsWith('/meta'))
            return route.fulfill({
              json: {
                sessionId: path.split('/')[3],
                ...(known ? { createdAt: Date.parse('2026-10-16T10:00:00Z') } : {}),
                accountBinding: { accountLabel: 'Personal account', model: 'fixture-id' },
                modelSelection: {
                  model: 'fixture-id',
                  models: [{ id: 'fixture-id', label: 'Luna fixture' }],
                },
                agentProfile: { definition: { name: 'Independent reviewer' } },
                runtimeBinding: {
                  version: 2,
                  account: {
                    accountId: 'personal',
                    provider: 'openai-codex',
                    profileRevision: 'fixture',
                  },
                  harness: { implementation: 'codex' },
                  execution: { location: 'local', targetId: 'mac', targetRevision: 'fixture' },
                },
              },
            });
          return route.fulfill({ json: [] });
        }
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
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>main{padding:var(--page-gutter);max-width:52rem;margin:auto}${theme === 'light' ? 'html{font-size:125%}' : ''}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      });
      await page.goto('/');
      const additional = page.getByRole('button', {
        name: 'Open Additional lead conversation: Independent acoustic discussion',
        exact: true,
      });
      await expect(additional.locator('.telos-chat-role-settings')).toHaveText(
        'Additional lead conversation · Personal account · Luna fixture',
      );
      // The unchanged S9 label observer reads the first small independently.
      await expect(additional.locator('.telos-chat-copy small').first()).toHaveText(
        'Additional lead conversation',
      );
      await expect(additional.getByText(/Independent reviewer · Local Mac/)).toBeVisible();
      if (known)
        await expect(additional.locator('time')).toHaveAttribute(
          'datetime',
          '2026-10-16T10:00:00.000Z',
        );
      else {
        await expect(additional.getByText(/Created date unavailable/)).toBeVisible();
        await expect(additional.locator('time')).toHaveCount(0);
      }
      expect(await additional.textContent()).not.toContain('2026-10-20');
      expect(await additional.textContent()).not.toContain('operator:');
      expect(
        await additional.locator('.telos-chat-copy > small, .telos-chat-role-settings').count(),
      ).toBe(2);
      await expect(
        page.getByRole('button', {
          name: 'Open Previous conversation: former lead discussion',
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', {
          name: 'Open Assigned lead: current lead discussion',
          exact: true,
        }),
      ).toBeVisible();
      const provenance = additional.locator('..').locator('details');
      const summary = provenance.locator('summary');
      expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(provenance).not.toHaveAttribute('open', '');
      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(provenance).toHaveAttribute('open', '');
      await expect(
        provenance.getByText(
          /Linked 2026-10-20T01:13:23.803Z · operator:dce4a056-4350-43f7-bc7a-2592150ca7ee/,
        ),
      ).toBeVisible();
      await expect(page.getByLabel('Opened chat')).toBeEmpty();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`metadata-${theme}-${known ? 'created' : 'unknown'}.png`),
        fullPage: true,
      });
      await page.keyboard.press('Enter');
      await expect(provenance).not.toHaveAttribute('open', '');
      await additional.click();
      await expect(page.getByLabel('Opened chat')).toHaveText('additional');
      expect(writes).toEqual([]);
    });
