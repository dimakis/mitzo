import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

// Render the real composer without a backend, provider, or Vite preview.
async function composerAssets(running = false) {
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
        const voice = { available: true, recording: false, transcribing: false,
          partialTranscript: '', micBlocked: false, error: null,
          startRecording() {}, stopRecording: async () => '', cancelRecording() {} };
        createRoot(document.getElementById('root')).render(
          <div className="workspace-chat" style={{paddingTop: 200}}>
            <ChatInput onSend={() => true} onStop={() => {}} onInterrupt={() => true} running={${running}} voice={voice}
              tokenState={{agentContext: 50000, contextCeiling: 200000, sessionTotal: 90000,
                numTurns: 3, turnIndex: 1, numCompactions: 1}} />
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
        const mic = page.getByRole('button', { name: 'Record voice message', exact: true });
        await expect(wheel).toBeVisible();
        const wheelBounds = (await wheel.boundingBox())!;
        const micBounds = (await mic.boundingBox())!;
        expect(micBounds.x - (wheelBounds.x + wheelBounds.width)).toBeGreaterThanOrEqual(0);
        expect(micBounds.x - (wheelBounds.x + wheelBounds.width)).toBeLessThanOrEqual(6);
        expect(
          Math.abs(wheelBounds.y + wheelBounds.height / 2 - (micBounds.y + micBounds.height / 2)),
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
          const updatedMic = (await mic.boundingBox())!;
          expect(updatedMic.x - (updatedWheel.x + updatedWheel.width)).toBeLessThanOrEqual(6);
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
