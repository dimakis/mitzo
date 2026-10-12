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
                  content: `Saved revision 2: [Telos artifact](${artifact}?revision=2). Also [PDF report](/workspace/report.pdf), [binary file](/workspace/packet.bin) and [section](#details). [Filtered file](sandbox:/mnt/data/%E0%A4%A.pdf).`,
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
    await link.focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { shared: unknown }).shared))
      .toEqual({
        name: 'Résumé.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: Array.from(bytes),
      });
    expect(requests).toEqual(['?revision=2']);
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
