import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

test.use({ baseURL: 'https://mitzo-ui.test' });

const providers = ['openai', 'openai-codex', 'google-vertex', 'anthropic-vertex'] as const;
type Send = { type: string; prompt: string; images: { data: string; mediaType: string }[] };

async function fixtureImages(page: Page, provider: (typeof providers)[number]) {
  const sessionId = 'image-fixture';
  const sent: Send[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('mitzo:transport', 'ws');
    localStorage.setItem('mitzo-theme', 'dark');
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.overflow = 'hidden';
      document.body.style.cssText = 'height:100dvh;overflow:hidden';
    });
  });
  await page.routeWebSocket('**/*', (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello')
        socket.send(
          JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'offline-images' }),
        );
      if (message.type === 'switch_session')
        socket.send(JSON.stringify({ type: 'session_switched', sessionId, mode: 'agent' }));
      if (message.type === 'send') {
        sent.push(message);
        socket.send(
          JSON.stringify({
            type: 'user_message',
            sessionId,
            messageId: message.clientMsgId,
            text: message.prompt,
          }),
        );
      }
    });
  });
  const accountBinding = {
    accountId: 'fixture-account',
    accountLabel: `Fixture ${provider}`,
    provider,
    model: 'fixture-model',
    profileRevision: 'offline-fixture',
  };
  const fixtures: Record<string, unknown> = {
    '/api/auth/check': { authenticated: true },
    '/api/config': { quickActions: [] },
    '/api/skills': [],
    '/api/sessions': [
      { id: sessionId, summary: 'Image annotation example', totalTokens: 0, isActive: false },
    ],
    '/api/accounts': [
      {
        id: accountBinding.accountId,
        label: accountBinding.accountLabel,
        provider,
        models: [{ id: 'fixture-model', label: 'Fixture model' }],
      },
    ],
    '/api/home/briefing-chats': [],
    '/api/service-health': { services: [], checkedAt: Date.now() },
    '/api/tasks': [],
    [`/api/sessions/${sessionId}/messages`]: [],
    [`/api/sessions/${sessionId}/outputs`]: { outputs: [], candidates: [] },
    [`/api/sessions/${sessionId}/meta`]: {
      sessionType: 'chat',
      accountBinding,
      modelSelection: {
        model: 'fixture-model',
        models: [{ id: 'fixture-model', label: 'Fixture model' }],
      },
    },
    [`/api/sessions/${sessionId}/symposium/status`]: { sessionId, config: null, seats: [] },
  };
  const types: Record<string, string> = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      if (route.request().method() !== 'GET')
        return route.fulfill({ status: 405, json: { error: 'Offline fixture forbids writes' } });
      return route.fulfill({ json: fixtures[url.pathname] ?? {} });
    }
    const root = resolve('frontend/dist');
    const file =
      url.pathname.startsWith('/assets/') || extname(url.pathname)
        ? url.pathname.slice(1)
        : 'index.html';
    const path = resolve(root, file);
    if (!path.startsWith(root + '/')) return route.abort();
    try {
      await route.fulfill({
        body: await readFile(path),
        contentType: types[extname(path)] ?? 'application/octet-stream',
      });
    } catch {
      await route.fulfill({ status: 404, body: 'Missing offline asset' });
    }
  });
  await page.goto(`/chat/${sessionId}`);
  await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toBeVisible();
  return sent;
}

async function pasteSyntheticImage(page: Page) {
  await page
    .getByRole('textbox', { name: 'Message Mitzo', exact: true })
    .evaluate(async (input) => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'white';
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = '#eeeeee';
      context.fillRect(24, 24, 272, 132);
      context.fillStyle = '#222222';
      context.font = '18px sans-serif';
      context.fillText('Synthetic screenshot', 40, 60);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((value) => resolve(value!), 'image/png'),
      );
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([blob], 'synthetic.png', { type: 'image/png' }));
      input.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
      );
    });
}

async function stroke(page: Page, surface: Locator, touch: boolean) {
  const bounds = (await surface.boundingBox())!;
  const x = bounds.x + bounds.width * 0.2;
  const y = bounds.y + bounds.height * 0.65;
  if (touch) {
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y, id: 9 }],
    });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + bounds.width * 0.55, y, id: 9 }],
    });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await client.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + bounds.width * 0.55, y, { steps: 10 });
    await page.mouse.up();
  }
}

async function expectTarget(control: Locator) {
  const bounds = (await control.boundingBox())!;
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
}

for (const provider of providers) {
  test(`image attachments: preview, edit and send annotated bytes (${provider})`, async ({
    page,
    isMobile,
    browserName,
  }, testInfo) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: isMobile ? 640 : 800 });
    if (provider === 'openai-codex') await page.emulateMedia({ reducedMotion: 'reduce' });
    const sent = await fixtureImages(page, provider);
    const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    await input.fill('Please inspect the highlighted area');
    await pasteSyntheticImage(page);
    const preview = page.getByRole('button', { name: 'Preview attachment 1', exact: true });
    await expect(preview).toBeVisible();
    const original = await preview.locator('img').getAttribute('src');
    await expectTarget(preview);
    await expectTarget(page.getByRole('button', { name: 'Remove attachment 1', exact: true }));
    expect((await preview.locator('img').boundingBox())!.width).toBeGreaterThanOrEqual(64);
    await page.screenshot({
      path: testInfo.outputPath(`image-composer-${provider}-dark.png`),
      animations: 'disabled',
    });
    await preview.click();
    const dialog = page.getByRole('dialog', { name: 'Image preview', exact: true });
    await expect(dialog).toBeVisible();
    await expectTarget(dialog.getByRole('button', { name: 'Close', exact: true }));
    await expect(dialog.getByRole('button', { name: 'Save image', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(dialog.getByRole('button', { name: 'Save image', exact: true })).toBeFocused();
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
    await page.screenshot({
      path: testInfo.outputPath(`image-preview-${provider}-dark.png`),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Draw', exact: true }).click();
    await dialog.getByRole('button', { name: 'Red pen', exact: true }).click();
    await stroke(
      page,
      dialog.getByLabel('Image drawing surface', { exact: true }),
      isMobile && browserName === 'chromium',
    );
    if (isMobile && browserName === 'webkit') {
      const bounds = (await dialog
        .getByLabel('Image drawing surface', { exact: true })
        .boundingBox())!;
      await page.touchscreen.tap(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
    }
    await expect(dialog.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(preview.locator('img')).toHaveAttribute('src', original!);
    await expect(input).toHaveValue('Please inspect the highlighted area');
    await expect(preview).toBeFocused();
    await preview.click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(preview).toBeFocused();
    await page.getByRole('button', { name: 'Open session tray', exact: true }).click();
    await page.getByRole('button', { name: 'Sources 1', exact: true }).click();
    const source = page.getByRole('button', { name: 'Preview pasted image 1', exact: true });
    await source.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`image-sources-${provider}-dark.png`),
      animations: 'disabled',
    });
    await source.click();
    await expect(dialog).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
      document.documentElement.dataset.accent = 'teal';
      document.documentElement.dataset.font = 'georgia';
      document.documentElement.style.fontSize = '20px';
    });
    const draw = dialog.getByRole('button', { name: 'Draw', exact: true });
    await draw.click();
    await expect(draw).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Red pen', exact: true }).click();
    const surface = dialog.getByLabel('Image drawing surface', { exact: true });
    await stroke(page, surface, isMobile && browserName === 'chromium');
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await stroke(page, surface, isMobile && browserName === 'chromium');
    await dialog.getByRole('button', { name: 'Clear drawing', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await stroke(page, surface, isMobile && browserName === 'chromium');
    for (const name of ['Draw', 'Undo', 'Clear drawing', 'Red pen', 'Save image', 'Cancel']) {
      const button = dialog.getByRole('button', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
      await expectTarget(button);
    }
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`image-drawing-${provider}-light-larger-text.png`),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Save image', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(source).toBeFocused();
    await expect(source.locator('img')).not.toHaveAttribute('src', original!);
    await page.getByRole('button', { name: 'Close session tray', exact: true }).click();
    const annotated = await preview.locator('img').getAttribute('src');
    expect(annotated).toMatch(/^data:image\/png;base64,/);
    await expect(input).toHaveValue('Please inspect the highlighted area');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].prompt).toBe('Please inspect the highlighted area');
    expect(sent[0].images).toHaveLength(1);
    expect(sent[0].images[0].mediaType).toBe('image/png');
    expect(`data:image/png;base64,${sent[0].images[0].data}`).toBe(annotated);
    const pixels = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0;
      for (let index = 0; index < rgba.length; index += 4)
        if (
          rgba[index] > rgba[index + 1] * 1.3 &&
          rgba[index] > rgba[index + 2] * 1.3 &&
          rgba[index + 3] > 0
        )
          red++;
      return { width: canvas.width, height: canvas.height, red };
    }, sent[0].images[0].data);
    expect(pixels).toMatchObject({ width: 320, height: 180 });
    expect(pixels.red).toBeGreaterThan(100);
    await input.fill('Keep this next draft');
    await pasteSyntheticImage(page);
    await expect(preview).toBeVisible();
    await page.getByRole('button', { name: 'Open session tray', exact: true }).click();
    const removeSource = page.getByRole('button', { name: 'Remove pasted image 1', exact: true });
    await removeSource.scrollIntoViewIfNeeded();
    await expectTarget(removeSource);
    await removeSource.click();
    await expect(preview).toHaveCount(0);
    await page.getByRole('button', { name: 'Close session tray', exact: true }).click();
    await pasteSyntheticImage(page);
    await page.getByRole('button', { name: 'Remove attachment 1', exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(input).toHaveValue('Keep this next draft');
    expect(sent).toHaveLength(1);
  });
}
