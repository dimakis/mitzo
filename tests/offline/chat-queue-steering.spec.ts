import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const output = build({
  entryPoints: [resolve('tests/fixtures/chat-queue-steering.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-chat-steering.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'])
  test(`queue and steer remain distinct with an icon-only composer (${theme})`, async ({
    page,
  }, info) => {
    const files = (await output).outputFiles!;
    const queued: unknown[] = [],
      steered: Record<string, unknown>[] = [],
      stopped: unknown[] = [];
    let status: 'accepted' | 'stale_target' | 'uncertain' = 'accepted';
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/fixture/queue') {
        queued.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      }
      if (path === '/fixture/stop') {
        stopped.push({});
        return route.fulfill({ json: { ok: true } });
      }
      if (path.endsWith('/codex-queue/steer')) {
        const body = route.request().postDataJSON();
        steered.push(body);
        return route.fulfill({
          status: status === 'stale_target' ? 409 : 200,
          json: { requestId: body.requestId, status },
        });
      }
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: file.text,
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.goto('/');
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await input.fill('Please also check the previous quarter.');
    await input.press('Enter');
    await expect.poll(() => queued.length).toBe(1);
    await expect(page.getByText('Queued — waiting for the current turn')).toBeVisible();
    await page.evaluate(() =>
      (
        window as unknown as { queueFixture: { answerEarlier(): void } }
      ).queueFixture.answerEarlier(),
    );
    const reply = page.getByRole('button', {
      name: 'Answering: Review Akram’s accomplishments and current priorities.',
    });
    await expect(reply).toBeVisible();
    await reply.click();
    await expect(page.locator('[data-command-request="first"]')).toBeFocused();
    await input.fill('The current priorities are fine.');
    for (const name of ['Steer current turn', 'Queue message', 'Stop generation']) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      expect((await button.innerText()).trim()).toBe('');
      const box = await button.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: info.outputPath(`chat-queue-${theme}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Steer current turn', exact: true }).click();
    await expect.poll(() => steered.length).toBe(1);
    await expect(input).toHaveValue('');
    expect(steered[0]).toMatchObject({
      targetCommandId: 'first',
      text: 'The current priorities are fine.',
    });
    expect(stopped).toHaveLength(0);
    status = 'stale_target';
    await input.fill('A later correction');
    await page.getByRole('button', { name: 'Steer current turn', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('That turn has finished');
    await expect(input).toHaveValue('A later correction');
    status = 'uncertain';
    await input.fill('An unconfirmed correction');
    await page.getByRole('button', { name: 'Steer current turn', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('delivery not confirmed');
    await expect(input).toHaveValue('An unconfirmed correction');
    await input.fill('A separate queued task');
    await input.press('Enter');
    await expect.poll(() => queued.length).toBe(2);
    await expect(input).toHaveValue('');

    await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
    await expect.poll(() => stopped.length).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });
