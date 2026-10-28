import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  CollaborationPolicyUpdateSchema,
  CollaborationViewSchema,
} from '../../packages/protocol/src/index';
import { sharedConversationView } from '../fixtures/symposium-shared-conversation-data';

// Actual protocol/parser/projection/components with synthetic schema-valid retained outcomes.
// No installed application owners or provider calls: this establishes UI behavior only.
const bundle = build({
  entryPoints: [resolve('tests/fixtures/symposium-shared-conversation.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-shared-conversation.js',
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
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});

for (const theme of ['dark', 'light'])
  test(`shared conversation retains partial outcomes, Defaults/@ and drafts (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const errors: string[] = [],
      mutations: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundle).outputFiles!;
    let view = sharedConversationView();
    let refuseNextPolicy = false;
    let failNextView = false;
    let releasePolicy!: () => void;
    const policyBarrier = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    let holdFirstPolicy = true;
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET') mutations.push(path);
      if (path === `/api/session-collaborations/${view.collaborationId}/conversation`) {
        if (failNextView) {
          failNextView = false;
          return route.fulfill({
            status: 503,
            json: { code: 'unavailable', error: 'Confirmation read unavailable' },
          });
        }
        return route.fulfill({ json: view });
      }
      if (path === `/api/session-collaborations/${view.collaborationId}/policy`) {
        const input = CollaborationPolicyUpdateSchema.parse(route.request().postDataJSON());
        if (refuseNextPolicy) {
          refuseNextPolicy = false;
          return route.fulfill({
            status: 409,
            json: { code: 'conflict', error: 'Membership changed. Refresh discussion sharing.' },
          });
        }
        if (holdFirstPolicy) {
          holdFirstPolicy = false;
          await policyBarrier;
          failNextView = true;
        }
        const current = view.policies.find((policy) => policy.sessionId === input.sessionId)!;
        expect(input.expectedMembershipRevision).toBe(view.membershipRevision);
        expect(input.expectedRevision).toBe(current.revision);
        const policy = {
          ...current,
          revision: current.revision + 1,
          effectiveFromSequence: view.cursor + 2,
          readsFutureDiscussion: input.readsFutureDiscussion,
          repliesByDefault: input.repliesByDefault,
        };
        view = CollaborationViewSchema.parse({
          ...view,
          cursor: view.cursor + 1,
          policySequence: view.cursor + 1,
          policies: view.policies.map((row) => (row.sessionId === input.sessionId ? policy : row)),
        });
        return route.fulfill({ json: policy });
      }
      if (path === `/api/session-collaborations/${view.collaborationId}/events`)
        return route.fulfill({
          json: { events: [], cursor: 99, highWatermark: 99, hasMore: false },
        });
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'light' ? 'georgia' : 'system'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const header = page.getByRole('button', {
      name: 'Agents, Architect, Reviewer, Reader',
      exact: true,
    });
    // The frozen reference uses the conversation container, not the device viewport.
    for (const width of [320, 360, 361, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(header.locator('.conversation-participant-additional-name'))[
        width <= 360 ? 'toBeHidden' : 'toBeVisible'
      ]();
      await expect(header.locator('.conversation-participant-count'))[
        width <= 360 ? 'toBeVisible' : 'toBeHidden'
      ]();
      await expect(header.locator('.conversation-participant-wide-count'))[
        width <= 360 ? 'toBeHidden' : 'toBeVisible'
      ]();
      await expect(header.locator('.conversation-participant-wide-count')).toHaveText('+1');
      await expect(header.locator('.conversation-participant-count')).toHaveText('+2');
      await expect(header).toHaveAccessibleName('Agents, Architect, Reviewer, Reader');
      if (width === 390)
        await header.screenshot({ path: info.outputPath(`header-390-${theme}.png`) });
    }
    if (!isMobile) {
      await page.setViewportSize({ width: 1280, height: 844 });
      await page.locator('main').evaluate((el) => {
        el.style.width = '320px';
      });
      await expect(header.locator('.conversation-participant-additional-name')).toBeHidden();
      await expect(header.locator('.conversation-participant-count')).toBeVisible();
      await header.screenshot({ path: info.outputPath(`header-desktop-column-320-${theme}.png`) });
      await page.locator('main').evaluate((el) => {
        el.style.removeProperty('width');
      });
    }
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    // CI's serif fallback has different glyph metrics from macOS Georgia.
    // Keep the protected readable name track with the count adjacent.
    await header.evaluate((el) => {
      el.style.fontFamily = '"Times New Roman", serif';
    });
    const serifMetrics = [];
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const serifNames = header.locator('.conversation-participant-names');
      const serifBounds = (await serifNames.boundingBox())!;
      expect(serifBounds.width).toBeGreaterThanOrEqual(64);
      const count = header.locator(
        width <= 360 ? '.conversation-participant-count' : '.conversation-participant-wide-count',
      );
      await expect(count).toBeVisible();
      const countBounds = (await count.boundingBox())!;
      const headerBounds = (await header.boundingBox())!;
      expect(countBounds.x).toBeGreaterThanOrEqual(serifBounds.x + serifBounds.width);
      expect(countBounds.x - (serifBounds.x + serifBounds.width)).toBeLessThanOrEqual(8);
      expect(countBounds.x + countBounds.width).toBeLessThanOrEqual(
        headerBounds.x + headerBounds.width,
      );
      const typography = await serifNames.evaluate((el) => {
        const style = getComputedStyle(el);
        const range = document.createRange();
        range.selectNodeContents(el.firstElementChild!);
        return {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          glyphWidth: range.getBoundingClientRect().width,
        };
      });
      serifMetrics.push({
        width,
        nameTrackWidth: serifBounds.width,
        countGap: countBounds.x - (serifBounds.x + serifBounds.width),
        ...typography,
      });
      await header.screenshot({ path: info.outputPath(`header-serif-${width}-${theme}.png`) });
    }
    await writeFile(
      info.outputPath(`header-serif-metrics-${theme}.json`),
      JSON.stringify(serifMetrics, null, 2),
    );
    await header.evaluate((el) => {
      el.style.removeProperty('font-family');
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    const trigger = page.getByRole('button', { name: 'Choose who replies' });
    await input.fill('Keep this shared draft');
    await trigger.click();
    await expect(trigger).toContainText('Defaults');
    await page.getByRole('checkbox', { name: 'Reviewer', exact: true }).check();
    await expect(trigger).toContainText('Architect, Reviewer');
    const picker = page.getByRole('group', { name: 'Who replies to this prompt' });
    const box = (await picker.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(isMobile ? 320 : 1280);
    await page.getByRole('button', { name: 'Defaults', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(picker).toHaveCount(0);
    await input.fill('Keep this shared draft @rev');
    await expect(picker).toBeVisible();
    await input.press('ArrowDown');
    await expect(page.getByRole('checkbox', { name: 'Reviewer', exact: true })).toBeFocused();
    await input.focus();
    await input.press('Escape');
    await expect(input).toHaveValue('Keep this shared draft @rev');
    await input.fill('Keep this shared draft');
    const agents = page.getByRole('button', { name: /^Agents,/ });
    await agents.click();
    const dialog = page.getByRole('dialog', { name: 'Agents', exact: true });
    await dialog.getByRole('checkbox', { name: 'Reads future discussion' }).first().click();
    try {
      await expect(dialog.getByRole('status')).toHaveText('Saving discussion sharing choices…');
      await expect(
        dialog.getByRole('checkbox', { name: 'Reads future discussion' }).first(),
      ).not.toBeChecked();
      await expect(
        dialog.getByRole('checkbox', { name: 'Reads future discussion' }).first(),
      ).toBeDisabled();
      await page.screenshot({
        path: info.outputPath(`policy-pending-${theme}.png`),
        style: '[data-fixture-control]{visibility:hidden}',
      });
    } finally {
      releasePolicy();
    }
    await expect(dialog.getByRole('status')).toHaveText(
      'Discussion sharing was saved. Refresh to confirm its current choices.',
    );
    await expect(dialog.getByRole('alert')).toHaveText('Confirmation read unavailable');
    await expect(
      dialog.getByRole('checkbox', { name: 'Reads future discussion' }).first(),
    ).not.toBeChecked();
    await expect(
      dialog.getByRole('checkbox', { name: 'Reads future discussion' }).first(),
    ).toBeDisabled();
    await page.screenshot({
      path: info.outputPath(`policy-refresh-needed-${theme}.png`),
      style: '[data-fixture-control]{visibility:hidden}',
    });
    await dialog.getByRole('button', { name: 'Refresh sharing', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveCount(0);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(
      dialog.getByRole('checkbox', { name: 'Reads future discussion' }).first(),
    ).toBeChecked();
    await dialog.getByRole('button', { name: 'Close Agents' }).click();
    await expect(input).toHaveValue('Keep this shared draft');
    await expect(trigger).toContainText('Architect, Reviewer');
    await expect(page.getByLabel('Send attempts')).toHaveText('0');
    refuseNextPolicy = true;
    await agents.click();
    await dialog.getByRole('checkbox', { name: 'Reads future discussion' }).first().click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'Membership changed. Refresh discussion sharing.',
    );
    await page.screenshot({
      path: info.outputPath(`policy-refusal-${theme}.png`),
      style: '[data-fixture-control]{visibility:hidden}',
    });
    await expect(
      dialog.getByRole('checkbox', { name: 'Reads future discussion' }).first(),
    ).toBeChecked();
    await dialog.getByRole('button', { name: 'Refresh sharing' }).click();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(
      dialog.getByRole('checkbox', { name: 'Reads future discussion' }).first(),
    ).toBeEnabled();
    await dialog.getByRole('button', { name: 'Close Agents' }).click();
    await expect(agents).toBeFocused();
    await page.getByText('To Architect, Reviewer · Context for Reader', { exact: true }).click();
    await expect(page.getByText('Prompt accepted', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Outcome uncertain · do not resend', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Context pending · no response requested', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Architect answer is retained even while Reviewer is uncertain.', {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`shared-${theme}.png`),
      style: '[data-fixture-control]{visibility:hidden}',
    });
    await page.getByRole('button', { name: 'Fixture replay gap' }).click();
    await expect(
      page.getByText(
        'Refresh this conversation to check its latest state. Retained replies stay here.',
      ),
    ).toBeVisible();
    await expect(
      page.getByText('Architect answer is retained even while Reviewer is uncertain.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await input.focus();
    await input.press('Enter');
    await expect(page.getByLabel('Send attempts')).toHaveText('0');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(await page.locator('main').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await page.reload();
    await expect(input).toHaveValue('Keep this shared draft');
    await expect(trigger).toContainText('Architect, Reviewer');
    expect(mutations).toEqual(
      Array(2).fill(`/api/session-collaborations/${view.collaborationId}/policy`),
    );
    expect(errors).toEqual([]);
  });
