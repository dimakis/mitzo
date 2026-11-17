import {
  reviewQueuedDrafts as reviewQueue,
  closeComposerStatus as closeStatus,
} from '../support/composer-status';
import { readChatStorage } from '../support/persisted-chat-storage';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { expect, test, type Page } from '@playwright/test';
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
async function correct(page: Page) {
  await page.getByRole('button', { name: 'Steer current turn' }).click();
}
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
    await page
      .locator('[data-reply-source="first"]')
      .getByText('Review Akram’s accomplishments and current priorities.', { exact: true })
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Reply', exact: true }).click();
    await input.fill('Please also check the previous quarter.');
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await reviewQueue(page);
    const inlineQueue = page.getByRole('region', { name: 'Up next' });
    await expect(inlineQueue.locator('xpath=ancestor::dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Minimize queue' }).click();
    await expect(page.getByRole('button', { name: 'Expand queue' })).toContainText(
      'Please also check the previous quarter.',
    );
    await expect(page.getByRole('button', { name: 'Pause queue' })).toBeVisible();
    await page.getByRole('button', { name: 'Expand queue' }).click();
    await expect(page.getByRole('region', { name: 'Up next' })).toContainText(
      'Please also check the previous quarter.',
    );
    expect(queued).toHaveLength(0);
    await closeStatus(page);
    await page.evaluate(() =>
      (
        window as unknown as { queueFixture: { answerEarlier(): void } }
      ).queueFixture.answerEarlier(),
    );
    const reply = page.getByRole('button', {
      name: 'Replying to: Review Akram’s accomplishments and current priorities.',
    });
    await expect(reply).toBeVisible();
    await reply.click();
    await expect(page.locator('[data-command-request="first"]')).toBeFocused();
    // Desktop context menu and mobile swipe select the same exact source.
    const source = page
      .locator('[data-reply-source="first"]')
      .getByText('Review Akram’s accomplishments and current priorities.', { exact: true });
    await source.click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Message actions' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Copy text' })).toBeVisible();
    await expect(page.locator('.message-actions-date')).toContainText(/20\d\d/);
    await page.getByRole('menuitem', { name: 'Reply', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cancel reply' })).toBeVisible();
    await input.fill('A draft kept while resizing');
    const more = page.getByRole('button', { name: 'More composer actions' });
    if (await more.isVisible()) await more.click();
    await page.getByRole('button', { name: 'Expand input' }).click();
    await expect(input).toHaveCSS('height', /\d+px/);
    await expect(page.locator('.chat-input--expanded')).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('A draft kept while resizing');
    if (await more.isVisible()) await more.click();
    await page.getByRole('button', { name: 'Shrink input' }).click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('A draft kept while resizing');
    if (await more.isVisible()) await expect(page.locator('.composer-tools')).toBeHidden();
    await input.fill('The current priorities are fine.');
    await expect(page.getByRole('button', { name: 'Send options' })).toHaveCount(0);
    for (const name of ['Steer current turn', 'Queue message', 'Stop generation']) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      expect((await button.innerText()).trim()).toBe('');
      const box = await button.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const alignment = await page
      .locator('.msg-bubble-group--user')
      .first()
      .evaluate((user) => {
        const chat = user.closest('.chat-messages')!;
        return Math.abs(
          user.getBoundingClientRect().right -
            (chat.getBoundingClientRect().left +
              chat.clientLeft +
              chat.clientWidth -
              parseFloat(getComputedStyle(chat).paddingRight)),
        );
      });
    expect(alignment).toBeLessThan(2);
    await expect(page.locator('.message-actions-menu')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`chat-queue-${theme}.png`), fullPage: true });
    await correct(page);
    await expect.poll(() => steered.length).toBe(1);
    await expect(input).toHaveValue('');
    expect(steered[0]).toMatchObject({
      targetCommandId: 'first',
      text: 'The current priorities are fine.',
      replyToMessageId: 'first',
    });
    expect(stopped).toHaveLength(0);
    const savedQueue = JSON.parse(
      (await readChatStorage(page, (storage) => storage.getItem('mitzo-queue-queue-fixture')))!,
    );
    await reviewQueue(page);
    await page.getByRole('button', { name: 'Steer with queued prompt 1' }).click();
    await expect.poll(() => steered.length).toBe(2);
    expect(steered[1]).toMatchObject({
      requestId: savedQueue[0].queueEntryId,
      targetCommandId: 'first',
      replyToMessageId: 'first',
      text: 'Please also check the previous quarter.',
    });
    await expect(page.getByRole('region', { name: 'Up next' })).not.toBeVisible();
    await closeStatus(page);
    // Images use the same native correction path; no Stop or queue dispatch.
    await input.fill('Use this screenshot');
    await page.locator('input[type=file]').setInputFiles({
      name: 'correction.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    await expect(page.getByAltText('Attachment 1')).toBeVisible();
    const screenshotData = await page.getByAltText('Attachment 1').getAttribute('src');
    await expect(page.getByRole('button', { name: 'Steer current turn' })).toBeEnabled();
    await page.screenshot({
      path: info.outputPath(`chat-queue-interrupt-image-${theme}.png`),
      fullPage: true,
    });
    await correct(page);
    await expect.poll(() => steered.length).toBe(3);
    expect(steered[2]).toMatchObject({
      targetCommandId: 'first',
      text: 'Use this screenshot',
      images: [{ mediaType: 'image/png' }],
    });
    const screenshot = (steered[2].images as { mediaType: string; data: string }[])[0];
    expect(`data:${screenshot.mediaType};base64,${screenshot.data}`).toBe(screenshotData);
    await expect(page.getByAltText('Attachment 1')).toHaveCount(0);
    await expect(input).toBeFocused();
    expect(stopped).toHaveLength(0);
    expect(queued).toHaveLength(0);
    await input.fill('Check dates next.');
    await input.press('Enter');
    await expect(input).toHaveValue('');
    status = 'stale_target';
    await input.fill('A later correction');
    await correct(page);
    await expect(page.getByRole('alert')).toContainText('That turn has finished');
    await expect(input).toHaveValue('A later correction');
    status = 'uncertain';
    await input.fill('An unconfirmed correction');
    await correct(page);
    await expect(page.getByRole('alert')).toContainText('delivery not confirmed');
    await expect(input).toHaveValue('An unconfirmed correction');
    await input.fill('A separate queued task');
    await input.press('Enter');
    await expect(input).toHaveValue('');
    expect(queued).toHaveLength(0);
    await reviewQueue(page);
    await expect(page.getByRole('region', { name: 'Up next' })).toContainText(
      'A separate queued task',
    );
    await page.getByRole('button', { name: 'Reorder dispatch order' }).click();
    await page.getByRole('button', { name: 'Move queued prompt 2 earlier' }).click();
    await expect(page.locator('.queued-draft-row').first()).toContainText('A separate queued task');
    await expect(
      page.getByRole('button', { name: 'Edit, reorder or remove queued prompt 1' }),
    ).toBeFocused();
    expect(queued).toHaveLength(0);
    await page.getByRole('button', { name: 'Move queued prompt 1 later' }).click();
    await page.getByRole('button', { name: 'Done reordering' }).click();
    const listBounds = (await page.locator('.queued-draft-list').boundingBox())!;
    expect(listBounds.height).toBeLessThanOrEqual(110);
    await page.getByRole('button', { name: 'Edit, reorder or remove queued prompt 2' }).click();
    const editor = page.getByRole('region', { name: 'Queued prompt' });
    await expect(editor).toBeVisible();
    await editor.getByRole('textbox', { name: 'Prompt' }).fill('Edited next task');
    await editor.getByRole('button', { name: 'Move prompt earlier' }).click();
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await expect(editor).not.toBeVisible();
    await expect(page.locator('.queued-draft-row').first()).toContainText('Edited next task');

    await closeStatus(page);
    await page.getByRole('button', { name: 'Stop generation', exact: true }).click();
    await expect.poll(() => stopped.length).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await reviewQueue(page);
    await expect(page.getByRole('button', { name: 'Resume queue' })).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { queueFixture: { emit(event: unknown): void } }).queueFixture.emit({
        type: 'session_state_changed',
        state: 'idle',
      }),
    );
    expect(queued).toHaveLength(0);
    await page.getByRole('button', { name: 'Resume queue' }).click();
    await expect.poll(() => queued.length).toBe(1);
    expect(queued[0]).toMatchObject({ text: 'Edited next task' });
    expect(errors).toEqual([]);
  });

for (const theme of ['dark', 'light'])
  test(`combined status stays above the original composer and preserves message controls (${theme})`, async ({
    page,
  }, info) => {
    const files = (await output).outputFiles!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            (window as unknown as { copiedText: string }).copiedText = text;
          },
        },
      });
    });
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/api/') || path.startsWith('/fixture/'))
        return route.fulfill({ json: [] });
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: file.text,
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/status.css"><div id="root"></div><script type="module" src="/status.js"></script></html>`,
      });
    });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.goto('/');
    const rail = page.getByRole('region', { name: 'Conversation status' });
    await expect(rail).toBeVisible();
    const thread = page.locator('.chat-messages');
    const original = await thread.boundingBox();
    const originalRail = await rail.boundingBox();
    for (const status of [
      'Working',
      'Connecting',
      'Preparing a workspace with a very long explanation that must never wrap and push the conversation upwards',
    ]) {
      await page.evaluate(
        (status) =>
          (
            window as unknown as { queueFixture: { feedback(value: { status: string }): void } }
          ).queueFixture.feedback({ status }),
        status,
      );
      await expect(rail.getByRole('status')).toHaveText(status);
      const next = await thread.boundingBox();
      expect(next?.y).toBe(original?.y);
      expect(next?.height).toBe(original?.height);
      expect((await rail.boundingBox())?.height).toBe(originalRail?.height);
      expect(await rail.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    await page.evaluate(() =>
      (
        window as unknown as { queueFixture: { feedback(value: { error: string }): void } }
      ).queueFixture.feedback({ error: 'Draft could not be saved on this device.' }),
    );
    await expect(rail.getByRole('alert')).toHaveText('Draft could not be saved on this device.');
    expect((await thread.boundingBox())?.height).toBe(original?.height);
    await page.getByRole('button', { name: 'Conversation status details' }).click();
    await expect(page.getByRole('dialog', { name: 'Conversation status' })).toContainText(
      'Draft could not be saved',
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Conversation status details' })).toBeFocused();
    await page.evaluate(() =>
      (
        window as unknown as { queueFixture: { feedback(value: object): void } }
      ).queueFixture.feedback({}),
    );
    await expect(page.locator('.msg-timestamp').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy to clipboard' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Read aloud' }).first().click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { queueFixture: { spoken: string[] } }).queueFixture.spoken
              .length,
        ),
      )
      .toBe(1);
    await page.getByRole('button', { name: 'Copy to clipboard' }).first().click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { copiedText?: string }).copiedText))
      .toContain('Review Akram');
    const more = page.getByRole('button', { name: 'More composer actions' });
    if (await more.isVisible()) await more.click();
    for (const name of [
      'Commands',
      'Attach images or PDF',
      'Terminal',
      'Expand input',
      'Open session tray',
      'Symposium collaboration',
      'Record voice message',
      'Token usage',
    ])
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          queueFixture: { holdDelivery(value: boolean): void; emit(event: object): void };
        }
      ).queueFixture;
      fixture.holdDelivery(true);
      fixture.emit({ type: 'session_state_changed', state: 'idle' });
    });
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await input.fill('Review this screenshot');
    await page.locator('input[type=file]').setInputFiles({
      name: 'status.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    await expect(page.locator('.chat-input-previews img')).toHaveCount(1);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(input).toHaveValue('');
    await expect(page.locator('.chat-input-previews img')).toHaveCount(0);
    await input.fill('My next independent draft');
    await page.evaluate(() =>
      (
        window as unknown as { queueFixture: { acceptDelivery(): void } }
      ).queueFixture.acceptDelivery(),
    );
    await expect(input).toHaveValue('My next independent draft');
    await expect(page.locator('.chat-input-previews img')).toHaveCount(0);
    await expect(
      page.getByText(/Draft saved on this device|Saving draft on this device/),
    ).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`chat-status-${theme}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
