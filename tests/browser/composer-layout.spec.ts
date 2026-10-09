import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

// Render the real composer without a backend, provider, or Vite preview.
async function composerAssets(running = false, model = 'new-model', voiceState = 'idle') {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ChatInput } from './frontend/src/components/ChatInput';
        import './frontend/src/styles/global.css';
        import './frontend/src/styles/workspace.css';
        import './frontend/src/styles/workspace-chat.css';
        const voice = { available: true, recording: ${voiceState === 'recording'}, transcribing: ${voiceState === 'transcribing'},
          partialTranscript: '', micBlocked: false, error: null,
          startRecording() {}, stopRecording: async () => '', cancelRecording() {} };
        createRoot(document.getElementById('root')).render(
          <div className="workspace-chat" style={{paddingTop: 200}}>
            <ChatInput onSend={() => true} onStop={() => {}} onInterrupt={() => true} running={${running}} voice={voice}
              tokenState={{agentContext: 50000, contextCeiling: 200000, sessionTotal: 90000,
                numTurns: 3, turnIndex: 1, numCompactions: 1,
                tokenLimits: {model: ${JSON.stringify(model)}, source: 'catalog', sourceName: 'Models.dev',
                  contextWindow: 200000, outputTokenLimit: 32000, checkedAt: Date.now(),
                  expiresAt: Date.now() + 3600000, stale: false}}} />
          </div>
        );`,
    },
    outfile: 'composer.js',
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'import.meta.env': '{}' },
    alias: {
      '@mitzo/client': `${process.cwd()}/packages/client/src/index.ts`,
      '@mitzo/protocol': `${process.cwd()}/packages/protocol/src/index.ts`,
    },
  });
  return {
    js: result.outputFiles.find((file) => file.path.endsWith('.js'))!.text,
    css: result.outputFiles.find((file) => file.path.endsWith('.css'))!.text,
  };
}

for (const width of [320, 390]) {
  test(`whole mobile composer stays compact at ${width}px with reachable details`, async ({
    page,
  }) => {
    const assets = await composerAssets();
    await page.setViewportSize({ width, height: 640 });
    await page.route('**/*', (route) => route.abort());
    await page.setContent(
      `<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${assets.css}</style><div id="root"></div>`,
    );
    await page.addScriptTag({ content: assets.js });
    const field = page.getByRole('textbox', { name: 'Message Mitzo' });
    await expect(field).toBeVisible();
    const composer = page.locator('.chat-input');
    expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(88);
    const wheel = page.getByRole('button', { name: 'Token usage', exact: true });
    expect((await wheel.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    await wheel.click();
    const details = page.locator('.token-bar-detail');
    await expect(details).toBeVisible();
    const bounds = (await details.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await field.focus();
    await field.press('Escape');
    await expect(details).toHaveCount(0);
    await field.fill('A long draft\n'.repeat(20));
    expect((await field.boundingBox())!.height).toBeLessThanOrEqual(160);
    expect(await composer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
}

test('running controls stay reachable with a draft at 320px', async ({ page }) => {
  const assets = await composerAssets(true);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('**/*', (route) => route.abort());
  await page.setContent(
    `<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${assets.css}</style><div id="root"></div>`,
  );
  await page.addScriptTag({ content: assets.js });
  const field = page.getByRole('textbox', { name: 'Message Mitzo' });
  await field.fill('Follow up while the agent is running');
  for (const name of ['Stop generation', 'Queue message', 'Interrupt and send now']) {
    const control = page.getByRole('button', { name, exact: true });
    await expect(control).toBeVisible();
    const bounds = (await control.boundingBox())!;
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  }
  expect(await page.locator('.chat-input').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
});

for (const width of [320, 390, 768, 1280]) {
  for (const theme of ['dark', 'light']) {
    for (const running of [false, true]) {
      test(`context wheel joins the actions at ${width}px in ${theme}, running=${running}`, async ({
        page,
      }) => {
        const assets = await composerAssets(running);
        await page.setViewportSize({ width, height: 640 });
        await page.route('**/*', (route) => route.abort());
        await page.setContent(
          `<html data-theme="${theme}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${assets.css}</style><div id="root"></div></html>`,
        );
        await page.addScriptTag({ content: assets.js });
        const wheel = page.getByRole('button', { name: 'Token usage', exact: true });
        const action = page.getByRole('button', {
          name: running ? 'Stop generation' : 'Send message',
          exact: true,
        });
        await expect(wheel).toBeVisible();
        const wheelBounds = (await wheel.boundingBox())!;
        const actionBounds = (await action.boundingBox())!;
        const micBounds = (await page
          .getByRole('button', { name: 'Record voice message' })
          .boundingBox())!;
        expect(micBounds.x - (wheelBounds.x + wheelBounds.width)).toBeGreaterThanOrEqual(0);
        expect(micBounds.x - (wheelBounds.x + wheelBounds.width)).toBeLessThanOrEqual(6);
        expect(actionBounds.x - (micBounds.x + micBounds.width)).toBeGreaterThanOrEqual(0);
        expect(actionBounds.x - (micBounds.x + micBounds.width)).toBeLessThanOrEqual(6);
        expect(
          Math.abs(
            wheelBounds.y + wheelBounds.height / 2 - (actionBounds.y + actionBounds.height / 2),
          ),
        ).toBeLessThanOrEqual(1);
        const palette = await wheel.evaluate((el) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--workspace-accent)';
          el.append(probe);
          const accent = getComputedStyle(probe).color;
          probe.remove();
          return { accent, wheel: getComputedStyle(el).color };
        });
        expect(palette.wheel).toBe(palette.accent);
        if (running) {
          await page.getByRole('textbox').fill('Follow up');
          const updatedWheel = (await wheel.boundingBox())!;
          const updatedAction = (await action.boundingBox())!;
          expect(updatedAction.x).toBeGreaterThan(updatedWheel.x + updatedWheel.width);
        }
        await wheel.click();
        const details = (await page.locator('.token-bar-detail').boundingBox())!;
        expect(details.x).toBeGreaterThanOrEqual(0);
        expect(details.x + details.width).toBeLessThanOrEqual(width);
        expect(
          await page.locator('.chat-input').evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
      });
    }
  }
}

for (const width of [768, 1280]) {
  test(`desktop usage is flush with the trailing controls at ${width}px`, async ({ page }) => {
    const assets = await composerAssets();
    await page.setViewportSize({ width, height: 800 });
    await page.route('**/*', (route) => route.abort());
    await page.setContent(
      `<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${assets.css}</style><div id="root"></div>`,
    );
    await page.addScriptTag({ content: assets.js });
    const usage = page.getByRole('button', { name: 'Token usage', exact: true });
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    await expect(page.locator('.token-bar-label')).toHaveCount(0);
    await expect(page.locator('.token-bar-detail')).toHaveCount(0);
    const u = (await usage.boundingBox())!;
    const s = (await send.boundingBox())!;
    const toolbar = (await page.locator('.composer-toolbar').boundingBox())!;
    expect(s.x).toBeGreaterThan(u.x + u.width);
    expect(Math.abs(u.y - s.y)).toBeLessThanOrEqual(1);
    expect(u.height).toBe(s.height);
    expect(u.width).toBe(s.width);
    expect(Math.abs(s.x + s.width - toolbar.x - toolbar.width)).toBeLessThanOrEqual(1);
    await usage.click();
    const details = (await page.locator('.token-bar-detail').boundingBox())!;
    expect(Math.abs(details.x + details.width - toolbar.x - toolbar.width)).toBeLessThanOrEqual(1);
    expect(details.y + details.height).toBeLessThanOrEqual(u.y);
  });
}

test('pressed model-limit details fit a narrow viewport even for a long model ID', async ({
  page,
}) => {
  const assets = await composerAssets(false, 'preview-' + 'model'.repeat(25));
  await page.setViewportSize({ width: 320, height: 640 });
  await page.route('**/*', (route) => route.abort());
  await page.setContent(
    `<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${assets.css}</style><div id="root"></div>`,
  );
  await page.addScriptTag({ content: assets.js });
  await expect(page.getByText('Limit source', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Token usage', exact: true }).click();
  const details = page.locator('.token-bar-detail');
  await expect(details.getByText('Models.dev', { exact: true })).toBeVisible();
  await expect(details.getByText('Maximum output', { exact: true })).toBeVisible();
  expect(await details.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const rect = (await details.boundingBox())!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(320);
});

for (const width of [320, 390, 1280]) {
  for (const theme of ['dark', 'light']) {
    test(`unboxed composer utilities and circular send at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      const assets = await composerAssets();
      await page.setViewportSize({ width, height: 640 });
      await page.route('**/*', (route) => route.abort());
      await page.setContent(
        `<html data-theme="${theme}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${assets.css}</style><div id="root"></div></html>`,
      );
      await page.addScriptTag({ content: assets.js });
      for (const button of await page.locator('.composer-toolbar button:visible').all()) {
        const rect = (await button.boundingBox())!;
        expect(rect.width).toBeGreaterThanOrEqual(44);
        expect(rect.height).toBeGreaterThanOrEqual(44);
        if ((await button.getAttribute('aria-label')) === 'Send message') continue;
        const style = await button.evaluate((el) => ({
          border: getComputedStyle(el).borderTopWidth,
          background: getComputedStyle(el).backgroundColor,
        }));
        expect(style.border).toBe('0px');
        expect(style.background).toBe('rgba(0, 0, 0, 0)');
      }
      const send = page.getByRole('button', { name: 'Send message', exact: true });
      await expect(send).toBeDisabled();
      await page.getByRole('textbox').fill('Ready to send');
      await expect(send).toBeEnabled();
      expect(await send.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('50%');
      const mic = page.getByRole('button', { name: 'Record voice message' });
      const usage = page.getByRole('button', { name: 'Token usage', exact: true });
      expect((await usage.boundingBox())!.x).toBeLessThan((await mic.boundingBox())!.x);
      expect((await mic.boundingBox())!.x).toBeLessThan((await send.boundingBox())!.x);
      await mic.focus();
      expect(await mic.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
      await mic.blur();
      if (width === 390)
        await page
          .locator('.chat-input')
          .screenshot({ path: testInfo.outputPath(`composer-${theme}.png`) });
    });
  }
}

test('voice feedback remains distinct in the unboxed composer', async ({ page }) => {
  await page.route('**/*', (route) => route.abort());
  for (const state of ['recording', 'transcribing']) {
    const assets = await composerAssets(false, 'new-model', state);
    await page.setContent(`<style>${assets.css}</style><div id="root"></div>`);
    await page.addScriptTag({ content: assets.js });
    const mic = page.getByRole('button', {
      name: state === 'recording' ? 'Stop recording' : 'Transcribing audio',
    });
    if (state === 'recording') {
      await expect(mic).toHaveAttribute('aria-pressed', 'true');
      expect(await mic.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
        'rgba(0, 0, 0, 0)',
      );
    } else {
      await expect(mic).toBeDisabled();
      expect(await mic.locator('svg').evaluate((el) => getComputedStyle(el).animationName)).toBe(
        'mic-spin',
      );
    }
  }
});
