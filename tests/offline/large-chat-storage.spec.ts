import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const bundle = build({
  entryPoints: [resolve('tests/fixtures/large-chat-storage.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  minify: true,
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});

test.beforeEach(async ({ context }) => {
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).hostname !== 'mitzo-ui.test') return route.abort();
    if (route.request().url().endsWith('/fixture.js'))
      return route.fulfill({
        body: (await bundle).outputFiles[0].text,
        contentType: 'application/javascript',
      });
    return route.fulfill({
      body: '<html><body><script type="module" src="/fixture.js"></script></body></html>',
      contentType: 'text/html',
    });
  });
});

test('a saved screenshot and its smaller outgoing copy survive real Web Storage exhaustion', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => 'storageFixture' in window);
  const saved = await page.evaluate(() =>
    (
      window as unknown as {
        storageFixture: {
          saveNearQuota(): Promise<{
            quotaName: string;
            rawLength: number;
            referenceRejected: boolean;
            preserved: string;
          }>;
        };
      }
    ).storageFixture.saveNearQuota(),
  );
  expect(saved.quotaName).toBe('QuotaExceededError');
  expect(saved.referenceRejected).toBe(true);
  expect(saved.preserved).toBe('Keep my existing draft');
  expect(saved.rawLength).toBeLessThan(256 * 1024);
  await page.reload();
  await page.waitForFunction(() => 'storageFixture' in window);
  const restored = await page.evaluate(() =>
    (
      window as unknown as {
        storageFixture: {
          readNearQuota(): Promise<unknown>;
        };
      }
    ).storageFixture.readNearQuota(),
  );
  expect(restored).toEqual({
    draftText: 'Inspect this screenshot',
    prompt: 'Inspect this screenshot',
    sameImage: true,
    imageLength: 140000,
  });
});

test('large draft and outgoing screenshots survive real IndexedDB reload beyond Web Storage quota', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => 'storageFixture' in window);
  const saved = await page.evaluate(() =>
    (
      window as unknown as {
        storageFixture: { save(): Promise<{ length: number; diskBytes: number }> };
      }
    ).storageFixture.save(),
  );
  expect(saved.length).toBeGreaterThan(12 * 1024 * 1024);
  expect(saved.diskBytes).toBeLessThan(100);
  await page.reload();
  await page.waitForFunction(() => 'storageFixture' in window);
  const restored = await page.evaluate(() =>
    (
      window as unknown as {
        storageFixture: { read(): Promise<{ text: number; image: number; queuedImage: number }> };
      }
    ).storageFixture.read(),
  );
  expect(restored).toEqual({
    text: 1300000,
    image: 12 * 1024 * 1024,
    queuedImage: 12 * 1024 * 1024,
  });
  const kept = await page.evaluate(() =>
    (
      window as unknown as { storageFixture: { failedMigration(): Promise<boolean> } }
    ).storageFixture.failedMigration(),
  );
  expect(kept).toBe(true);
  await page.reload();
  await page.waitForFunction(() => 'storageFixture' in window);
  const legacy = await page.evaluate(() =>
    (
      window as unknown as { storageFixture: { readLegacy(): Promise<number> } }
    ).storageFixture.readLegacy(),
  );
  expect(legacy).toBe(700000);
});

test('IndexedDB transactions refuse a stale writer and retain both edits', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => 'storageFixture' in window);
  const result = await page.evaluate(() =>
    (
      window as unknown as { storageFixture: { crossTabConflict(): Promise<unknown> } }
    ).storageFixture.crossTabConflict(),
  );
  expect(result).toEqual({ rejected: true, durable: 'committed A', unsaved: 'unsaved B' });
});

test('other tabs observe IndexedDB saves and tombstones without localStorage signals', async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  for (const tab of [page, other]) {
    await tab.goto('/');
    await tab.waitForFunction(() => 'storageFixture' in window);
    await tab.evaluate(
      () =>
        (window as unknown as { storageFixture: { ready: Promise<void> } }).storageFixture.ready,
    );
  }
  for (const value of ['shared text', null]) {
    await page.evaluate(
      (value) =>
        (
          window as unknown as {
            storageFixture: { saveShared(value: string | null): Promise<void> };
          }
        ).storageFixture.saveShared(value),
      value,
    );
    await expect
      .poll(() =>
        other.evaluate(() =>
          (
            window as unknown as { storageFixture: { readShared(): Promise<string | null> } }
          ).storageFixture.readShared(),
        ),
      )
      .toBe(value);
  }
  await other.reload();
  await other.waitForFunction(() => 'storageFixture' in window);
  expect(
    await other.evaluate(() =>
      (
        window as unknown as { storageFixture: { readShared(): Promise<string | null> } }
      ).storageFixture.readShared(),
    ),
  ).toBeNull();
});

test('upgrades a real legacy payload pointer and fences later edits from an older frontend', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => 'storageFixture' in window);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { storageFixture: { upgradeLegacyPointer(): Promise<string> } }
      ).storageFixture.upgradeLegacyPointer(),
    ),
  ).toBe('old pointer draft');
  await page.reload();
  await page.waitForFunction(() => 'storageFixture' in window);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { storageFixture: { readUpgrade(): Promise<unknown> } }
      ).storageFixture.readUpgrade(),
    ),
  ).toEqual({ value: 'upgraded draft', legacy: 'mitzo-large-chat:v1:legacy-payload' });
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { storageFixture: { rejectOldFrontendEdit(): Promise<boolean> } }
      ).storageFixture.rejectOldFrontendEdit(),
    ),
  ).toBe(true);
});

test('a failed revision replacement cannot restore revoked acceptance authority after reload', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => 'storageFixture' in window);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { storageFixture: { revokedRevision(): Promise<boolean> } }
      ).storageFixture.revokedRevision(),
    ),
  ).toBe(true);
  await page.reload();
  await page.waitForFunction(() => 'storageFixture' in window);
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { storageFixture: { readRevokedRevision(): Promise<string | null> } }
      ).storageFixture.readRevokedRevision(),
    ),
  ).toBeNull();
});
