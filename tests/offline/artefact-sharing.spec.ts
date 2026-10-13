import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const artifact = '/api/telos/artifacts/' + 'a'.repeat(32);
const bytes = Buffer.from([0, 255, 128, 65]);

for (const appearance of ['dark', 'light'] as const) {
  test(`artefact sharing preserves files inside chat in ${appearance}`, async ({
    page,
    context,
  }, testInfo) => {
    const requests: string[] = [];
    await page.addInitScript((theme) => {
      localStorage.setItem('mitzo-theme', theme);
      localStorage.setItem('mitzo-accent', 'teal');
      localStorage.setItem('mitzo-font', 'georgia');
      localStorage.setItem('mitzo_auth_token', 'offline-fixture');
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async ({ files }: { files: File[] }) => {
          const file = files[0];
          (window as unknown as { shared: unknown }).shared = {
            name: file.name,
            type: file.type,
            bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
          };
        },
      });
    }, appearance);
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test') return route.abort();
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        if (path === artifact) {
          requests.push(url.search);
          expect(route.request().headers().authorization).toBe('Bearer offline-fixture');
          return route.fulfill({
            body: bytes,
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': "attachment; filename*=UTF-8''R%C3%A9sum%C3%A9.docx",
            },
          });
        }
        const fixtures: Record<string, unknown> = {
          '/api/auth/check': { authenticated: true },
          '/api/config': { quickActions: [], models: [], mcpServers: [] },
          '/api/accounts': [],
          '/api/sessions': [],
          '/api/home/briefing-chats': [],
          '/api/notifications': { items: [], needsYou: 0, unread: 0, total: 0, hasMore: false },
          '/api/service-health': { services: [], checkedAt: 1 },
          '/api/sessions/sharing/messages': [
            {
              messageId: 'reply',
              role: 'assistant',
              blocks: [
                {
                  blockId: 'text',
                  blockType: 'text',
                  content: `Saved revision 2: [Telos artifact](${artifact}?revision=2). Bare revision 1: ${artifact}?revision=1. Also [PDF report](/workspace/report.pdf), [binary file](/workspace/packet.bin) and [section](#details). [Filtered file](sandbox:/mnt/data/%E0%A4%A.pdf).`,
                },
              ],
            },
          ],
          '/api/sessions/sharing/meta': { sessionType: 'chat' },
          '/api/sessions/sharing/symposium/status': {
            sessionId: 'sharing',
            config: null,
            seats: [],
          },
        };
        return route.fulfill({ json: fixtures[path] ?? {} });
      }
      const root = resolve('frontend/dist');
      const asset = path.startsWith('/assets/') || extname(path) ? path.slice(1) : 'index.html';
      const file = resolve(root, asset);
      if (!file.startsWith(root + '/')) return route.abort();
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.woff2': 'font/woff2',
      };
      try {
        return route.fulfill({
          body: await readFile(file),
          contentType: mime[extname(file)] ?? 'application/octet-stream',
        });
      } catch {
        return route.fulfill({ status: 404, body: 'Missing offline asset' });
      }
    });
    await page.goto('/chat/sharing');
    const link = page.getByRole('link', { name: 'Telos artifact', exact: true });
    await expect(link).toBeVisible();
    await expect(link).not.toHaveAttribute('target', '_blank');
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('button', { name: 'Share file' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download file' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'File options', exact: true })).toHaveCount(4);
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/files\?/);
    await expect(page.getByText('Résumé.docx', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    expect(requests).toEqual(['?revision=2']);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page).toHaveURL(/\/chat\/sharing$/);
    const telosOptions = link
      .locator('..')
      .getByRole('button', { name: 'File options', exact: true });
    await telosOptions.focus();
    await page.keyboard.press('Enter');
    const options = page.getByRole('dialog', { name: 'File options' });
    await expect(options).toBeVisible();
    expect((await options.boundingBox())!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    for (const name of ['Open', 'Download file', 'Share file', 'Close']) {
      expect(
        (await options.getByRole('button', { name }).boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
    }
    await expect(options.getByRole('button', { name: 'Download file' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('file-options.png') });
    await options.getByRole('button', { name: 'Share file' }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { shared: unknown }).shared))
      .toEqual({
        name: 'Résumé.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: Array.from(bytes),
      });
    expect(requests).toEqual(['?revision=2', '?revision=2']);
    await expect(options).not.toBeVisible();
    await expect(telosOptions).toBeFocused();
    const bareLink = page.getByRole('link', { name: `${artifact}?revision=1`, exact: true });
    await expect(bareLink).not.toHaveAttribute('target', '_blank');
    await bareLink.locator('..').getByRole('button', { name: 'File options', exact: true }).click();
    await options.getByRole('button', { name: 'Share file' }).click();
    await expect.poll(() => requests).toEqual(['?revision=2', '?revision=2', '?revision=1']);
    await expect(options).not.toBeVisible();
    const pdfOptions = page
      .getByRole('link', { name: 'PDF report', exact: true })
      .locator('..')
      .getByRole('button', { name: 'File options', exact: true });
    await pdfOptions.click();
    await expect(options.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
    await expect(options.getByRole('button', { name: 'Download file' })).toBeVisible();
    await expect(options.getByRole('button', { name: 'Share file' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(options).not.toBeVisible();
    await expect(pdfOptions).toBeFocused();
    expect(context.pages()).toHaveLength(1);
    await expect(page).toHaveURL(/\/chat\/sharing$/);
    await expect(page.getByRole('link', { name: 'PDF report', exact: true })).not.toHaveAttribute(
      'target',
      '_blank',
    );
    await expect(page.getByRole('link', { name: 'binary file', exact: true })).not.toHaveAttribute(
      'target',
      '_blank',
    );
    await expect(page.getByRole('link', { name: 'section', exact: true })).not.toHaveAttribute(
      'target',
      '_blank',
    );
    await expect(page.getByText('Filtered file', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Filtered file', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('artefact-sharing.png') });
  });
}
