import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { SaveAgentTaskSchema } from '../../packages/protocol/src/agent-tasks';

// CI-only browser execution. Do not import/--list this spec locally: like the
// existing builder fixture, its bundle is prepared when the module is loaded.
const bundle = build({
  entryPoints: [resolve('tests/fixtures/agent-settings-bounded.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/agent-settings-bounded.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});
const account = { accountId: 'task-account', provider: 'openai', profileRevision: 'r1' };
const inventory = {
  version: 1,
  authority: 'configuration-only',
  defaultLocation: 'openshell',
  capabilityRevision: 'task-capabilities',
  accounts: [
    {
      account,
      label: 'Task account',
      models: [{ id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['low', 'high'] }],
      modelDiscovery: { source: 'configured', stale: false },
    },
  ],
  targets: [
    {
      targetId: 'task-shell',
      targetRevision: 't1',
      label: 'OpenShell',
      location: 'openshell',
      harness: 'responses',
    },
    {
      targetId: 'task-mac',
      targetRevision: 't1',
      label: 'Local Mac',
      location: 'local',
      harness: 'responses',
    },
  ],
  routes: ['task-shell', 'task-mac'].map((targetId) => ({
    account,
    targetId,
    harness: 'responses',
    modes: ['agent'],
  })),
  locations: [
    { location: 'openshell', status: 'configured' },
    { location: 'local', status: 'configured' },
  ],
  agentProfiles: [],
};
type HeldWindow = typeof window & {
  boundedAnimations: Animation[];
  localClicks: number;
  localNode?: Element;
};

for (const appearance of [
  { theme: 'light', accent: 'teal', font: 'georgia' },
  { theme: 'dark', accent: 'lavender', font: 'system' },
] as const) {
  test(`bounded task settings retain geometry and the first target write · ${appearance.theme}/${appearance.accent}/${appearance.font}`, async ({
    page,
  }, testInfo) => {
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: viewport.width, height: 600 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const files = (await bundle).outputFiles;
    const writes: ReturnType<typeof SaveAgentTaskSchema.parse>[] = [];
    const unexpected: string[] = [];
    const errors: string[] = [];
    let releaseInventory!: () => void;
    const inventoryGate = new Promise<void>((resolve) => (releaseInventory = resolve));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const host = window as HeldWindow;
      host.boundedAnimations = [];
      host.localClicks = 0;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        const animation = animate.call(this, frames, options);
        if (this.classList.contains('agent-settings-panel')) {
          animation.pause();
          animation.currentTime = 0;
          host.boundedAnimations.push(animation);
        }
        return animation;
      };
      document.addEventListener(
        'click',
        (event) => {
          if (event.target instanceof Element && event.target.closest('button') === host.localNode)
            host.localClicks++;
        },
        true,
      );
    });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test') {
        unexpected.push(url.href);
        return route.abort();
      }
      if (url.pathname === '/openai-mark.svg' || url.pathname === '/claude-mark.svg')
        return route.fulfill({
          body: await readFile(resolve('frontend/public', url.pathname.slice(1))),
          contentType: 'image/svg+xml',
        });
      if (url.pathname === '/api/chat/runtime/capabilities') {
        await inventoryGate;
        return route.fulfill({ json: inventory });
      }
      if (url.pathname === '/api/agent-tasks') {
        if (route.request().method() === 'GET') return route.fulfill({ json: [] });
        const request = SaveAgentTaskSchema.parse(route.request().postDataJSON());
        writes.push(request);
        return route.fulfill({
          json: {
            taskId: request.taskId,
            revision: 1,
            definition: request.definition,
            configuration: { state: 'draft' },
            deleted: false,
            createdAt: '2026-10-15T00:00:00.000Z',
            updatedAt: '2026-10-15T00:00:00.000Z',
          },
        });
      }
      const file = files.find(
        (file) =>
          url.pathname === `/fixture.${file.path.endsWith('.css') ? 'css' : 'js'}` &&
          file.path.endsWith(url.pathname.slice(-3)),
      );
      if (file)
        return route.fulfill({
          body: Buffer.from(file.contents),
          contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${appearance.theme}" data-accent="${appearance.accent}" data-font="${appearance.font}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
        });
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
      unexpected.push(`${route.request().method()} ${url.pathname}`);
      return route.abort();
    });
    await page.goto('/');
    const trigger = page.getByRole('button', { name: /^Agent settings/ });
    await trigger.click();
    const panel = page.getByRole('region', { name: 'Agent settings', exact: true });
    await expect(panel).toHaveAttribute('data-motion-active', 'true');
    await panel.evaluate((element) => {
      const animation = (window as HeldWindow).boundedAnimations[0];
      animation.currentTime = Number(animation.effect!.getTiming().duration) * 0.4;
      element.querySelector('.agent-settings-scroll')!.scrollTop = 20;
    });
    const heldHeight = (await panel.boundingBox())!.height;
    releaseInventory();
    await expect(panel.getByRole('option', { name: 'Task account', exact: true })).toBeAttached();
    await panel.getByLabel('Account', { exact: true }).selectOption('task-account');
    await panel.getByLabel('Thinking level', { exact: true }).selectOption('high');
    expect(Math.abs((await panel.boundingBox())!.height - heldHeight)).toBeLessThan(2);
    const samples = await panel.evaluate(async (element) => {
      const animation = (window as HeldWindow).boundedAnimations[0];
      const duration = Number(animation.effect!.getTiming().duration);
      const frames = (animation.effect as KeyframeEffect).getKeyframes();
      const start = Number.parseFloat(String(frames[0].height));
      const end = Number.parseFloat(String(frames.at(-1)!.height));
      const samples = [];
      for (const fraction of [0, 0.25, 0.5, 0.75, 0.95]) {
        animation.currentTime = duration * fraction;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push({ fraction, height: element.getBoundingClientRect().height });
      }
      return { start, end, samples, animations: (window as HeldWindow).boundedAnimations.length };
    });
    expect(samples.animations).toBe(1);
    expect(samples.end).toBeGreaterThan(samples.start);
    for (let index = 1; index < samples.samples.length; index++)
      expect(samples.samples[index].height).toBeGreaterThan(samples.samples[index - 1].height);
    const scroll = panel.locator('.agent-settings-scroll');
    expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    const local = panel.getByRole('button', { name: 'Local Mac', exact: true });
    await local.scrollIntoViewIfNeeded();
    await local.evaluate((element) => ((window as HeldWindow).localNode = element));
    await local.click();
    await expect(local).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => (window as HeldWindow).localClicks)).toBe(1);
    const release = await panel.evaluate(async (element) => {
      const host = window as HeldWindow;
      const animation = host.boundedAnimations[0];
      animation.currentTime = Number(animation.effect!.getTiming().duration);
      const before = element.getBoundingClientRect().height;
      const scroll = element.querySelector('.agent-settings-scroll')!;
      const scrollBefore = scroll.scrollTop;
      const topBefore = host.localNode!.getBoundingClientRect().top;
      animation.finish();
      await animation.finished;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return {
        before,
        after: element.getBoundingClientRect().height,
        scrollBefore,
        scrollAfter: scroll.scrollTop,
        topBefore,
        topAfter: host.localNode!.getBoundingClientRect().top,
        connected: host.localNode!.isConnected,
      };
    });
    expect(Math.abs(release.after - release.before)).toBeLessThan(2);
    expect(Math.abs(release.scrollAfter - release.scrollBefore)).toBeLessThan(2);
    expect(Math.abs(release.topAfter - release.topBefore)).toBeLessThan(2);
    expect(release.connected).toBe(true);
    await expect(panel).not.toHaveAttribute('data-motion-active', 'true');
    await testInfo.attach('bounded-picker-geometry', {
      body: JSON.stringify({ samples, release }, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('bounded-picker-selected', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await local.focus();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(panel).toHaveAttribute('inert', '');
    await panel.evaluate(async () => {
      const animation = (window as HeldWindow).boundedAnimations.at(-1)!;
      animation.finish();
      await animation.finished;
    });
    await page.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].definition.execution).toMatchObject({
      account,
      model: 'luna-fixture',
      reasoningEffort: 'high',
      targetId: 'task-mac',
      harness: 'responses',
    });
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
