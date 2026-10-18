import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { deployedSecurityHeaders } from '../support/response-security';
const bundle = build({
  entryPoints: [resolve('tests/fixtures/tool-builder.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/tool-builder.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
const id = '11111111-1111-4111-8111-111111111111';
test.use({ baseURL: 'https://mitzo-ui.test' });
for (const theme of ['dark', 'light'] as const) {
  test(`Tool Builder: exact review, feedback, publication and keyboard (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const compiled = await bundle;
    let version = 1;
    let status = 'submitted';
    let feedback = '';
    let published = false;
    let publishAttempts = 0;
    let linkedReads = 0;
    const requests: Array<{ path: string; body: unknown }> = [];
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    const draft = () => ({
      status,
      sessionId: 'builder-fixture',
      ...(status === 'rejected' || status === 'accepted'
        ? {
            review: {
              decision: status,
              feedback,
              reviewer: 'user',
              contractDigest: 'a'.repeat(64),
            },
          }
        : {}),
      draft: {
        id,
        version,
        name: 'Text length',
        description: 'Count input characters',
        contractDigest: 'a'.repeat(64),
        sourceDigest: 'b'.repeat(64),
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { length: { type: 'integer' } },
          required: ['length'],
          additionalProperties: false,
        },
        examples: [{ input: { text: 'abc' }, expected: { length: 3 } }],
        permissions: { behavior: 'read', requiredConnections: [] },
        compatibility: { routes: ['local-api'] },
        testProfile: 'unit',
        files: [
          {
            path: 'src/index.mts',
            content: 'export const runTool = ({text}: {text:string}) => ({length: text.length});',
          },
          {
            path: 'test/qualify.mts',
            content: '// Independent installed checks\n' + 'assert.ok(true);\n'.repeat(1800),
          },
        ],
        tests: {
          summary: 'Unit checks and examples passed',
          passed: true,
          complete: true,
          evidenceKind: 'candidate-report',
        },
      },
    });
    const history = new Map<number, ReturnType<typeof draft>>();
    const entry = {
      id: `custom:${id}`,
      version: 2,
      revision: '22222222-2222-4222-8222-222222222222',
      name: 'Text length',
      description: 'Count input characters',
      source: 'Reviewed custom implementation',
      required: false,
      behavior: 'read',
      routes: ['local-api'],
      requirement: 'Accepted installed source; assignment separate.',
    };
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://mitzo-ui.test') return route.abort();
      if (route.request().method() === 'POST')
        requests.push({ path: url.pathname, body: route.request().postDataJSON() });
      if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css')
        return route.fulfill({
          body: compiled.outputFiles!.find((file) =>
            file.path.endsWith(url.pathname.endsWith('.js') ? '.js' : '.css'),
          )!.text,
          contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
        });
      if (url.pathname === '/api/agent-library')
        return route.fulfill({ json: { drafts: [], versions: [] } });
      if (url.pathname === '/api/agent-library/tools')
        return route.fulfill({ json: { tools: published ? [entry] : [] } });
      if (url.pathname === '/api/agent-library/tool-builder')
        return route.fulfill({
          json: { drafts: [{ id, version, name: 'Text length', status }], nextOffset: null },
        });
      if (url.pathname.startsWith('/api/agent-library/tool-builder/drafts/')) {
        if (route.request().method() === 'GET') {
          const requested = Number(url.pathname.split('/').at(-1));
          if (requested === 1 && ++linkedReads === 1)
            return route.fulfill({
              status: 503,
              json: { error: 'Exact draft read temporarily unavailable' },
            });
          const value = requested === version ? draft() : history.get(requested);
          return route.fulfill({
            status: value ? 200 : 404,
            json: value ?? { error: 'Draft version not found' },
          });
        }
        const body = route.request().postDataJSON();
        if (url.pathname.endsWith('/review')) {
          expect(body).toEqual({
            decision: body.decision,
            feedback: body.feedback,
            contractDigest: 'a'.repeat(64),
          });
          status = body.decision;
          feedback = body.feedback;
          history.set(version, structuredClone(draft()));
          return route.fulfill({ json: draft() });
        }
        if (url.pathname.endsWith('/publish')) {
          expect(status).toBe('accepted');
          publishAttempts++;
          if (publishAttempts === 1)
            return route.fulfill({
              status: 400,
              json: {
                error:
                  'Exact reviewed implementation is not installed. Install reviewed source before retrying.',
              },
            });
          published = true;
          return route.fulfill({
            json: { reference: { id: entry.id, version: entry.version, revision: entry.revision } },
          });
        }
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: [] });
      return route.fulfill({
        contentType: 'text/html',
        headers: deployedSecurityHeaders(),
        body: `<html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      });
    });
    await page.goto(`/agent-library?library=tools&toolDraft=${id}&draftVersion=1`);
    await expect(page.getByRole('alert')).toContainText('Exact draft read temporarily unavailable');
    await page.getByRole('button', { name: 'Reload tool drafts' }).click();
    await expect(page.getByRole('heading', { name: 'Text length · v1' })).toBeVisible();
    expect(linkedReads).toBe(2);
    const builder = page.getByRole('link', { name: 'Build a tool' });
    await expect(builder).toHaveAttribute('href', /agentProfile=mitzo-tool-builder/);
    expect((await builder.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(requests).toEqual([]);
    await expect(page.getByRole('button', { name: 'Publish accepted tool' })).toBeDisabled();
    await page.getByLabel('Review feedback').fill('Cover Unicode edge cases');
    await page.getByRole('button', { name: 'Request changes' }).click();
    await expect(
      page.getByText(
        'Changes requested. Return to the Builder conversation to prepare a new version.',
      ),
    ).toBeVisible();
    expect(requests.some((request) => request.path.endsWith('/publish'))).toBe(false);
    // Synthetic independent Builder revision; the real immutable flow is covered in server tests.
    version = 2;
    status = 'submitted';
    await page.getByRole('button', { name: 'Reload tool drafts' }).click();
    await page.getByLabel('Saved tool draft').selectOption(`${id}:2`);
    await expect(page.getByRole('heading', { name: 'Text length · v2' })).toBeVisible();
    await page.getByLabel('Source file').selectOption('test/qualify.mts');
    await page.getByRole('button', { name: 'Next source page' }).click();
    await page.getByLabel('Draft source').focus();
    await page.keyboard.press('PageDown');
    await expect
      .poll(() => page.getByLabel('Draft source').evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Previous source page' })).toBeEnabled();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download review bundle' }).click();
    const savedBundle = await download;
    expect(savedBundle.suggestedFilename()).toBe(`tool-draft-${id}-v2.json`);
    const savedPath = await savedBundle.path();
    expect(savedPath).not.toBeNull();
    expect(JSON.parse(await readFile(savedPath!, 'utf8'))).toMatchObject({
      format: 'mitzo-tool-draft-review-v1',
      status: 'submitted',
      draft: { id, version: 2, tests: { passed: true, complete: true } },
    });
    await page.getByRole('button', { name: 'Accept review' }).click();
    await expect(
      page.getByText(
        'Review accepted. Publication still requires the exact reviewed implementation installed and qualified.',
      ),
    ).toBeVisible();
    expect(publishAttempts).toBe(0);
    await page.getByRole('button', { name: 'Publish accepted tool' }).click();
    await expect(page.getByRole('alert')).toContainText('not installed');
    await expect(page.getByText('Status: accepted')).toBeVisible();
    await page.getByRole('button', { name: 'Publish accepted tool' }).click();
    await expect(
      page.getByText('Published. Assign the tool to an agent separately and start a new chat.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish accepted tool' })).toBeDisabled();
    await page.getByRole('button', { name: 'Done reviewing' }).focus();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Review tool drafts' })).toBeFocused();
    await page.getByRole('button', { name: 'Review tool drafts' }).click();
    await expect(page.getByRole('heading', { name: 'Text length · v2' })).toBeVisible();
    for (const button of [
      'Accept review',
      'Request changes',
      'Publish accepted tool',
      'Cancel draft',
      'Done reviewing',
    ])
      expect(
        (await page.getByRole('button', { name: button, exact: true }).boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('heading', { name: 'Text length · v2' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`tool-builder-${theme}.png`), fullPage: true });
    expect(requests).toHaveLength(4);
    expect(
      requests.every((request) =>
        /\/tool-builder\/drafts\/.+\/(review|publish)$/.test(request.path),
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
}
