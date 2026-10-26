import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  defaultMitzoProfileDefinition,
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
} from '../../packages/protocol/src/index';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/legacy-native-continuation.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-legacy-native-continuation.js',
  jsx: 'automatic',
  minify: true,
  external: [
    '/mitzo-wordmark.png',
    '/openshell-mark.svg',
    '/github-mark.svg',
    '/openai-mark.svg',
    '/claude-mark.svg',
  ],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});
const account = { accountId: 'work', provider: 'openai', profileRevision: 'r1' };
const profile = {
  kind: 'builtin',
  profileId: DEFAULT_MITZO_PROFILE_ID,
  revision: DEFAULT_MITZO_PROFILE_REVISION,
  definition: defaultMitzoProfileDefinition,
  contentHash: createHash('sha256')
    .update(JSON.stringify(defaultMitzoProfileDefinition))
    .digest('hex'),
};
const runtimeBinding = {
  version: 2,
  account,
  harness: { implementation: 'codex' },
  execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
};
for (const { theme, preclaim, accepted = false } of [
  { theme: 'dark', preclaim: false },
  { theme: 'light', preclaim: false },
  { theme: 'dark', preclaim: true },
  { theme: 'light', preclaim: false, accepted: true },
]) {
  test(`legacy native continuation ${accepted ? 'opens the admitted native conversation' : preclaim ? 'recovers an expired unclaimed review after reload' : 'keeps the source and exact uncertain attempt'} (${theme})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    const files = (await bundle).outputFiles!,
      requests: unknown[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let command: Record<string, unknown> | undefined;
    let workspaceId = '',
      reviewHash = '',
      discarded = false,
      catalogAvailable = false;
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = files.find(
        (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-ui)}.fixture-main{max-width:42rem;margin:auto;padding:var(--space-4)}.fixture-main>label,.fixture-main>output{display:block;margin-block:var(--space-4)}.fixture-main textarea{box-sizing:border-box;width:100%;min-height:var(--control-height);font:inherit}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      if (
        [
          '/openshell-mark.svg',
          '/github-mark.svg',
          '/openai-mark.svg',
          '/claude-mark.svg',
        ].includes(path)
      )
        return route.fulfill({
          body: await readFile(resolve('frontend/public' + path)),
          contentType: 'image/svg+xml',
        });
      if (path === '/api/chat/runtime/capabilities')
        return route.fulfill({
          json: {
            version: 1,
            authority: 'configuration-only',
            defaultLocation: 'openshell',
            capabilityRevision: 'cap-r1',
            accounts: [
              {
                account,
                label: 'Work API',
                models: [
                  { id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['low', 'high'] },
                ],
                modelDiscovery: { source: 'configured', stale: false },
              },
            ],
            targets: [{ ...runtimeBinding.execution, label: 'Local Mac', harness: 'codex' }],
            routes: [
              { account, targetId: 'mac', harness: 'codex', modes: ['ask', 'agent', 'auto'] },
            ],
            locations: [
              { location: 'local', status: 'configured' },
              { location: 'openshell', status: 'unavailable' },
            ],
            agentProfiles: [profile],
          },
        });
      if (path === '/api/repository-workspaces/catalog') {
        if (!catalogAvailable)
          return route.fulfill({ status: 503, json: { error: 'Fixture offline' } });
        return route.fulfill({
          json: {
            available: true,
            location: 'local',
            repositories: [
              {
                connectionId: 'local',
                label: 'Disposable fixture',
                repository: 'local/fixture',
                repositoryId: 'fixture',
              },
            ],
          },
        });
      }
      if (
        path === '/api/repository-workspaces/local' ||
        (workspaceId && path === `/api/repository-workspaces/${workspaceId}`)
      ) {
        if (route.request().method() === 'POST')
          workspaceId = route.request().postDataJSON().requestId;
        return route.fulfill({
          json: {
            id: workspaceId,
            repository: 'local/fixture',
            baseBranch: 'main',
            baseOid: 'a'.repeat(40),
            featureBranch: 'mitzo/fixture',
            state: 'ready',
            ordinaryRuntime: runtimeBinding,
          },
        });
      }
      if (path.endsWith('/native-continuation/preview')) {
        command = route.request().postDataJSON().command;
        reviewHash = createHash('sha256').update(String(command!.clientMsgId)).digest('hex');
        return route.fulfill({
          json: {
            reviewHash,
            sourceSessionId: 'legacy-source',
            nativeSessionId: 'native-child',
            commandId: command!.clientMsgId,
            sourceRevision: 'b'.repeat(64),
            account,
            sourceSelection: {
              model: 'luna-fixture',
              thinking: 'low',
              mode: 'agent',
              targetId: 'historical-target',
            },
            command,
            uncertainOutcomes: true,
            selectionChanged: true,
            retainedPendingCommands: 2,
            omittedNonTextBlocks: 3,
            omittedEarlierCharacters: 12,
            context:
              '[{"role":"assistant","text":"Review actual repository state before a new change."}]',
          },
        });
      }
      if (path.endsWith('/native-continuation/commit')) {
        expect(route.request().headers()['x-connection-id']).toBe('fixture-connection');
        requests.push(route.request().postDataJSON());
        if (preclaim)
          return route.fulfill({ status: 409, json: { error: 'Review expired before claim' } });
        return route.fulfill({
          status: 202,
          json: {
            ok: accepted,
            sessionId: 'native-child',
            clientMsgId: command!.clientMsgId,
            state: accepted ? 'consumed' : 'uncertain',
            dispatched: accepted,
          },
        });
      }
      if (path.endsWith('/native-continuation/discard')) {
        expect(route.request().postDataJSON()).toEqual({ reviewHash });
        discarded = true;
        return route.fulfill({
          json: {
            reviewHash,
            sourceSessionId: 'legacy-source',
            nativeSessionId: 'native-child',
            commandId: command!.clientMsgId,
            state: 'discarded',
          },
        });
      }
      if (path.endsWith('/native-continuation'))
        return route.fulfill({
          json: {
            links: [
              {
                reviewHash,
                sourceSessionId: 'legacy-source',
                nativeSessionId: 'native-child',
                commandId: command!.clientMsgId,
                state: discarded ? 'discarded' : 'reviewed',
                canReviewAgain: preclaim,
                createdAt: 1,
              },
            ],
          },
        });
      return route.abort();
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Continue with Codex' }).click();
    if (isMobile && theme === 'light')
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '20px';
      });
    const dialog = page.getByRole('dialog', { name: 'Review native continuation' });
    const request = page.getByRole('textbox', { name: /^New request/ });
    if (isMobile) {
      for (const control of [request, ...(await dialog.locator('select').all())]) {
        expect(
          await control.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
        ).toBeGreaterThanOrEqual(16);
      }
    }
    await dialog.screenshot({ path: testInfo.outputPath(`native-setup-top-${theme}.png`) });
    await request.scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
    await dialog.screenshot({ path: testInfo.outputPath(`native-setup-${theme}.png`) });
    await expect(page.getByRole('alert')).toContainText('Repository choices could not load');
    catalogAvailable = true;
    await page.getByRole('button', { name: 'Retry repository choices' }).click();
    await page.getByRole('button', { name: 'Add repository' }).click();
    await page.getByLabel('Local repository').selectOption('local:local/fixture');
    await page.getByRole('button', { name: 'Use repository' }).click();
    await page
      .getByRole('textbox', { name: /^New request/ })
      .fill('Inspect actual state before making a new change.');
    await page.getByRole('button', { name: 'Review native continuation', exact: true }).click();
    await expect(page.getByLabel('Exact historical context')).toContainText(
      'Review actual repository state',
    );
    const contentDoesNotOverlap = () =>
      dialog.locator('.native-continuation-form').evaluate((form) => {
        const rows = Array.from(form.children)
          .map((element) => element.getBoundingClientRect())
          .filter((rect) => rect.height > 0);
        return rows.every((rect, index) => index === 0 || rect.top >= rows[index - 1].bottom - 1);
      });
    expect(await contentDoesNotOverlap()).toBe(true);
    const start = page.getByRole('button', { name: 'Start reviewed native continuation' });
    await expect(start).toBeDisabled();
    await page.getByLabel(/I reviewed the exact context/).check();
    await page.getByLabel(/I understand earlier effects/).check();
    await page.getByLabel(/I approve the displayed model/).check();
    await start.click();
    if (accepted) {
      await expect(page.getByLabel('Current conversation')).toHaveText('/chat/native-child');
      await expect(page.getByLabel('Original conversation draft')).toHaveValue(
        'Keep this unsent draft in the original conversation.',
      );
      expect(requests).toHaveLength(1);
      expect(errors).toEqual([]);
      return;
    }
    if (preclaim) {
      await expect(
        page.getByRole('button', { name: 'Discard rejected attempt and review again' }),
      ).toBeVisible();
      const originalCommandId = command!.clientMsgId;
      await page.reload();
      await page.getByRole('button', { name: 'Continue with Codex' }).click();
      const discardButton = page.getByRole('button', {
        name: 'Discard rejected attempt and review again',
      });
      await expect(discardButton).toBeVisible();
      await discardButton.scrollIntoViewIfNeeded();
      expect((await discardButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({
        path: testInfo.outputPath('legacy-native-preclaim-recovery-button.png'),
        fullPage: true,
      });
      await discardButton.click();
      await expect(page.getByRole('textbox', { name: /^New request/ })).toHaveValue(
        'Inspect actual state before making a new change.',
      );
      expect(discarded).toBe(true);
      expect(requests).toHaveLength(1);
      await page.getByRole('button', { name: 'Review native continuation', exact: true }).click();
      await expect(page.getByLabel('Exact historical context')).toBeVisible();
      expect(command!.clientMsgId).not.toBe(originalCommandId);
      await expect(page.getByLabel(/I reviewed the exact context/)).not.toBeChecked();
      await expect(
        page.getByRole('button', { name: 'Start reviewed native continuation' }),
      ).toBeDisabled();
      expect(requests).toHaveLength(1);
    } else {
      await expect(page.getByRole('alert')).toContainText('Native admission is uncertain');
      await page.getByRole('button', { name: 'Check admission', exact: true }).click();
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual(requests[1]);
    }
    await expect(page.getByLabel('Current conversation')).toHaveText('/chat/legacy-source');
    await expect(page.getByLabel('Original conversation draft')).toHaveValue(
      'Keep this unsent draft in the original conversation.',
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    for (const label of [
      'I reviewed the exact context',
      'I understand earlier effects',
      'I approve the displayed model',
    ]) {
      const bounds = await page.getByLabel(new RegExp(label)).locator('..').boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await contentDoesNotOverlap()).toBe(true);
    await (
      preclaim
        ? page.getByRole('button', { name: 'Start reviewed native continuation' })
        : page.getByRole('alert')
    ).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`legacy-native-${preclaim ? 'preclaim-' : ''}${theme}.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}
