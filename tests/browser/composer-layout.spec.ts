import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

// Render the real composer without a backend, provider, or Vite preview.
async function composerAssets() {
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
            <ChatInput onSend={() => true} onStop={() => {}} running={false} voice={voice}
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
