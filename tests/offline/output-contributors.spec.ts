import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

// Contributor storage remains available to the API, but ordinary chat does not
// enroll a conversation in an output workflow or fetch its contributor state.
test('ordinary chat has no output workflow on mobile or desktop', async ({ page }) => {
  const sessionId = 'ordinary-chat';
  const workflowRequests: string[] = [];
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    const path = url.pathname;
    if (path.startsWith('/api/')) {
      if (/\/(outputs|contributors)(\/|$)/.test(path)) workflowRequests.push(path);
      if (route.request().method() !== 'GET') return route.abort();
      const fixtures: Record<string, unknown> = {
        '/api/auth/check': { authenticated: true },
        '/api/config': { quickActions: [], models: [], mcpServers: [] },
        '/api/accounts': [],
        '/api/sessions': [],
        '/api/home/briefing-chats': [],
        '/api/notifications': { items: [], needsYou: 0, unread: 0, total: 0, hasMore: false },
        '/api/service-health': { services: [], checkedAt: 1 },
        [`/api/sessions/${sessionId}/messages`]: [
          {
            messageId: 'reply',
            role: 'assistant',
            blocks: [
              {
                blockId: 'text',
                blockType: 'text',
                content: 'The conversation stays readable.',
              },
            ],
          },
        ],
        [`/api/sessions/${sessionId}/meta`]: { sessionType: 'chat' },
        [`/api/sessions/${sessionId}/symposium/status`]: { sessionId, config: null, seats: [] },
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
  await page.goto(`/chat/${sessionId}`);
  await expect(page.getByText('The conversation stays readable.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Outputs', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Keep as output', exact: true })).toHaveCount(0);
  expect(workflowRequests).toEqual([]);
});
