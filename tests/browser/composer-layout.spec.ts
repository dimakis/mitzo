import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

// Render the real composer without a backend, provider, or Vite preview.
async function composerAssets(running = false, model = 'new-model') {
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
    expect(u.x).toBeGreaterThan(s.x + s.width);
    expect(Math.abs(u.y - s.y)).toBeLessThanOrEqual(1);
    expect(u.height).toBe(s.height);
    expect(u.width).toBe(s.width);
    expect(Math.abs(u.x + u.width - toolbar.x - toolbar.width)).toBeLessThanOrEqual(1);
    await usage.click();
    const details = (await page.locator('.token-bar-detail').boundingBox())!;
    expect(Math.abs(details.x + details.width - u.x - u.width)).toBeLessThanOrEqual(1);
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
