import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { SessionOutputReference } from '@mitzo/protocol';

test.use({ baseURL: 'https://mitzo-ui.test' });
test('registered draft and ordinary contributor setup preserve revision, account and source chat', async ({
  page,
  isMobile,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const sessionId = 'output-chat';
  const output: SessionOutputReference = {
    outputId: '6f84c6cb-3ec4-4f45-bb2e-761119e02231',
    sessionId,
    title: 'A decision draft with a long title for the product direction',
    revision: 1,
    kind: 'inline_draft',
    durability: 'reference_registered',
    label: 'In conversation',
    sourceAvailability: 'available',
    source: {
      sessionId,
      messageId: 'draft-message',
      blockId: 'draft-text',
      messageEndSeq: 4,
      sha256: 'a'.repeat(64),
    },
    provenance: null,
    createdAt: 1,
  };
  const content =
    '## Product direction\n\nKeep artifacts central. Contributions stay attributed to independent conversations.\n\n```ts\nconst revision = 1;\n```';
  let eligible = true;
  let showContributor = false;
  let stopRequests = 0;
  let selectedReadFailed = false;
  let failedReads = 0;
  const contributor = {
    id: 'joe',
    label: 'Joe',
    accountLabel: 'Personal ChatGPT',
    model: 'luna-fixture',
    sessionId: 'child-chat',
    status: 'stopping',
    outputId: output.outputId,
    outputRevision: 1,
    messages: [],
  };
  const writes: { path: string; body: unknown }[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    const path = url.pathname;
    if (path.startsWith('/api/')) {
      if (route.request().method() !== 'GET') {
        writes.push({ path, body: route.request().postDataJSON() });
        if (path === `/api/sessions/${sessionId}/contributors/joe/stop`) {
          stopRequests++;
          if (stopRequests === 1)
            return route.fulfill({
              status: 503,
              json: { error: 'Cleanup is not confirmed. Retry Stop.' },
            });
          contributor.status = 'idle';
          return route.fulfill({ json: { contributor } });
        }
        return route.fulfill({
          status: 503,
          json: { error: 'Offline fixture: execution is unavailable' },
        });
      }
      if (path.endsWith('/events'))
        return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
      if (path === `/api/sessions/${sessionId}/outputs`)
        return route.fulfill({ json: { outputs: [output], candidates: [] } });
      if (path === `/api/sessions/${sessionId}/outputs/${output.outputId}`) {
        if (selectedReadFailed) {
          failedReads++;
          return route.fulfill({
            status: 503,
            json: { error: 'Selected draft temporarily unavailable' },
          });
        }
        return route.fulfill({ json: { output, content, contextPackageDigest: 'b'.repeat(64) } });
      }
      if (path === `/api/sessions/${sessionId}/contributors`)
        return route.fulfill({
          json: {
            contributors: showContributor ? [contributor] : [],
            eligibility: {
              available: eligible,
              reason: eligible
                ? 'Personal ChatGPT uses the existing ordinary session route.'
                : 'Cancellation proof is unavailable',
              accountIds: ['personal'],
            },
          },
        });
      const fixtures: Record<string, unknown> = {
        '/api/auth/check': { authenticated: true },
        '/api/config': { quickActions: [], models: [], mcpServers: [] },
        '/api/sessions': [],
        '/api/home/briefing-chats': [],
        '/api/notifications': { items: [], needsYou: 0, unread: 0, total: 0, hasMore: false },
        '/api/service-health': { services: [], checkedAt: 1 },
        '/api/accounts': [
          {
            id: 'unsupported',
            label: 'Another account route',
            models: [{ id: 'other-fixture', label: 'Other model' }],
          },
          {
            id: 'personal',
            label: 'Personal ChatGPT',
            models: [{ id: 'luna-fixture', label: 'Luna fixture' }],
          },
        ],
        '/api/agent-library': {
          drafts: [],
          versions: [
            {
              profileId: 'bob',
              revision: 3,
              contentHash: 'c'.repeat(64),
              definition: {
                name: 'Bob',
                descriptor: 'The architect',
                role: 'coder',
                instructions: 'Challenge assumptions',
                expectedOutput: 'Decision brief',
                acceptanceCriteria: ['Evidence'],
                modelPolicyRole: 'agent',
              },
            },
          ],
        },
        [`/api/sessions/${sessionId}/messages`]: [],
        [`/api/sessions/${sessionId}/meta`]: {
          sessionType: 'chat',
          accountBinding: {
            accountId: 'personal',
            accountLabel: 'Personal ChatGPT',
            model: 'luna-fixture',
          },
          modelSelection: {
            model: 'luna-fixture',
            models: [{ id: 'luna-fixture', label: 'Luna fixture' }],
          },
        },
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
  const panel = page.getByRole('region', { name: 'Outputs', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Product direction', { exact: true })).toBeVisible();
  await expect(panel.getByText(/depends on this conversation/)).toBeVisible();
  expect(writes).toEqual([]);
  for (const [theme, accent, font] of [
    ['dark', 'lavender', 'system'],
    ['light', 'teal', 'georgia'],
  ]) {
    await page.evaluate(
      ({ theme, accent, font }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.accent = accent;
        document.documentElement.dataset.font = font;
      },
      { theme, accent, font },
    );
    // Shared buttons animate backgrounds during appearance changes.
    // Assert settled semantic roles before capturing visual evidence.
    await expect
      .poll(async () =>
        panel.getByRole('button', { name: 'Add contributor', exact: true }).evaluate((control) => {
          const reference = document.createElement('span');
          reference.style.backgroundColor = 'var(--color-bg)';
          reference.style.color = 'var(--color-text)';
          control.parentElement!.append(reference);
          const actual = getComputedStyle(control);
          const expected = getComputedStyle(reference);
          const matches = {
            background: actual.backgroundColor === expected.backgroundColor,
            text: actual.color === expected.color,
          };
          reference.remove();
          return matches;
        }),
      )
      .toEqual({ background: true, text: true });
    await page.screenshot({
      path: testInfo.outputPath(`output-${theme}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await panel.getByRole('button', { name: 'Add contributor', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add contributor', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Contributor name').fill('Joe');
    await expect(dialog.getByRole('option', { name: 'Another account route' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Use Personal ChatGPT · Luna fixture' }).click();
    for (const control of await dialog.getByRole('button').all()) {
      if (await control.isVisible())
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await dialog.getByLabel('Agent profile').selectOption('bob:3');
    await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
    await dialog
      .getByLabel('Additional guidance')
      .fill('Challenge the assumptions in this exact draft.');
    await expect(dialog.getByText(/separate filesystem boundary/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Add to this output' }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: 'Add to this output' })).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath(`contributor-${theme}.png`),
      fullPage: true,
    });
    if (theme === 'light') {
      await dialog.getByRole('button', { name: 'Add to this output' }).click();
      await expect(dialog.getByRole('alert')).toContainText('execution is unavailable');
      await expect(dialog.getByLabel('Contributor name')).toHaveValue('Joe');
      expect(writes[0].path).toBe(`/api/sessions/${sessionId}/contributors`);
      expect(writes[0].body).toMatchObject({
        outputId: output.outputId,
        outputRevision: 1,
        contextPackageDigest: 'b'.repeat(64),
        accountId: 'personal',
        model: 'luna-fixture',
        profileSelection: { profileId: 'bob', revision: 3 },
      });
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Add contributor' })).toBeFocused();
  }
  eligible = false;
  await panel.getByRole('button', { name: 'Refresh access' }).click();
  await expect(panel.getByText('Cancellation proof is unavailable')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Add contributor' })).toBeDisabled();
  eligible = true;
  showContributor = true;
  await panel.getByRole('button', { name: 'Refresh access' }).click();
  await expect(panel.getByRole('button', { name: 'Stop Joe', exact: true })).toBeEnabled();
  await panel.getByLabel('Message to Joe').fill('Retain this follow-up through refresh failure.');
  await panel.getByRole('button', { name: 'Stop Joe', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Cleanup is not confirmed');
  await expect(panel.getByRole('button', { name: 'Stop Joe', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Stop Joe', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Stop Joe', exact: true })).toHaveCount(0);
  const stopWrites = writes.filter((item) => item.path.endsWith('/joe/stop'));
  expect(stopWrites).toHaveLength(2);
  expect(stopWrites[0].body).toEqual(stopWrites[1].body);
  await expect(panel.getByLabel('Message to Joe')).toHaveValue(
    'Retain this follow-up through refresh failure.',
  );
  await panel.getByRole('button', { name: 'Add contributor', exact: true }).click();
  const pendingDialog = page.getByRole('dialog', { name: 'Add contributor', exact: true });
  await pendingDialog.getByLabel('Contributor name').fill('Retained name');
  await pendingDialog.getByRole('button', { name: 'Use Personal ChatGPT · Luna fixture' }).click();
  await pendingDialog
    .getByLabel('Additional guidance')
    .fill('Retain these exact draft assumptions.');
  const writesBeforeFailure = writes.length;
  selectedReadFailed = true;
  await expect.poll(() => failedReads, { timeout: 10000 }).toBeGreaterThan(0);
  await expect(pendingDialog.getByRole('button', { name: 'Add to this output' })).toBeDisabled();
  await expect(pendingDialog.getByLabel('Contributor name')).toHaveValue('Retained name');
  await expect(pendingDialog.getByLabel('Additional guidance')).toHaveValue(
    'Retain these exact draft assumptions.',
  );
  await expect(pendingDialog.getByLabel('Additional guidance')).toBeFocused();
  await expect(pendingDialog.getByRole('status')).toContainText(
    'Selected draft temporarily unavailable',
  );
  await expect(panel.getByLabel('Message to Joe')).toHaveValue(
    'Retain this follow-up through refresh failure.',
  );
  expect(writes).toHaveLength(writesBeforeFailure);
  await pendingDialog.getByLabel('Additional guidance').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('contributor-draft-read-failure.png'),
    fullPage: true,
    animations: 'disabled',
  });
  selectedReadFailed = false;
  await expect(pendingDialog.getByRole('button', { name: 'Add to this output' })).toBeEnabled({
    timeout: 10000,
  });
  await expect(pendingDialog.getByLabel('Additional guidance')).toHaveValue(
    'Retain these exact draft assumptions.',
  );
  await pendingDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel.getByLabel('Message to Joe')).toHaveValue(
    'Retain this follow-up through refresh failure.',
  );
  await expect(panel.getByRole('button', { name: 'Send to Joe', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
