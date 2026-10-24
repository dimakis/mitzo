import { it, expect } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { TelosWorkLifecycleCommandSchema, TelosWorkLifecycleReceiptSchema } from '@mitzo/protocol';
import { createPurgeApplication } from './purge-application.js';

it('positive eligible-leaf purge preserves unrelated work and recovers the committed404 receipt after real lost delivery and cold App', async () => {
  const evidence = process.env.S9_COHERENT_EVIDENCE_DIR;
  if (!evidence) throw Error('Explicit private evidence directory required');
  await mkdir(evidence, { recursive: true });
  const facts: Array<{ stage: string; facts: Record<string, unknown> }> = [];
  const record = async (stage: string, data: Record<string, unknown>) => {
    facts.push({ stage, facts: data });
    await writeFile(join(evidence, 'positive-purge.json'), JSON.stringify(facts, null, 2));
  };
  const h = await createPurgeApplication(record);
  const { page } = h;
  let original: ReturnType<typeof TelosWorkLifecycleCommandSchema.parse> | undefined,
    receipt: unknown,
    lost = false;
  const posted: unknown[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/telos/work/lifecycle'
    )
      posted.push(request.postDataJSON());
  });
  const capture = async (name: string) => {
    await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true });
    await writeFile(join(evidence, name + '.ax.txt'), await page.locator('body').ariaSnapshot());
  };
  const journal = () =>
    page.evaluate(() =>
      Object.entries(sessionStorage).filter(
        ([key]) => key.startsWith('telos.lifecycle.pending.') && key.endsWith('.purge-leaf'),
      ),
    );
  const observePrivateReceipt = () => {
    // Forensic observation ONLY after real commit, before owner shutdown. This
    // read-only private connection never supplies host/quiescence authority.
    const db = new Database(h.canonical, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          'SELECT actor_id,request_id,fingerprint,receipt FROM telos_work_lifecycle_commands WHERE request_id=?',
        )
        .all(original!.requestId);
      expect(rows).toHaveLength(1);
      return rows[0] as {
        actor_id: string;
        request_id: string;
        fingerprint: string;
        receipt: string;
      };
    } finally {
      db.close();
    }
  };
  let failure: unknown, cleanupFailure: unknown;
  try {
    const witnessResponse = await h.http('/api/telos/work/items/retained-witness/record');
    expect(witnessResponse.status).toBe(200);
    const witness = witnessResponse.body;
    const assertWitness = async () => {
      const response = await h.http('/api/telos/work/items/retained-witness/record');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(witness);
    };
    await page.goto(h.origin + '/todos/purge-leaf');
    const lifecycle = page.getByRole('region', { name: 'Item lifecycle', exact: true });
    await browserExpect(
      lifecycle.getByRole('button', { name: 'Item actions', exact: true }),
    ).toBeEnabled();
    await lifecycle.getByRole('button', { name: 'Item actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move to Trash', exact: true }).click();
    const trash = page.getByRole('dialog', { name: 'Move item to Trash?', exact: true });
    await trash.getByRole('button', { name: 'Move to Trash', exact: true }).click();
    await browserExpect(lifecycle.getByText('In Trash', { exact: true })).toBeVisible();
    await page.route('**/api/telos/work/lifecycle', async (route) => {
      const input = TelosWorkLifecycleCommandSchema.parse(route.request().postDataJSON());
      if (!lost && input.operation === 'delete_permanently') {
        original = input;
        const response = await route.fetch();
        await record('actual-purge-commit-header-before-deliberate-response-loss', {
          status: response.status(),
          input,
        });
        expect(response.status()).toBe(200);
        lost = true;
        // Do not read/fulfill the receipt body. The actual browser sees uncertainty.
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await lifecycle.getByRole('button', { name: 'Item actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete permanently', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete item permanently?', exact: true });
    await confirm.getByRole('textbox').fill('DELETE PERMANENTLY');
    await confirm.getByRole('button', { name: 'Delete permanently', exact: true }).click();
    await expect.poll(() => lost).toBe(true);
    await browserExpect(
      lifecycle.getByRole('button', { name: 'Retry original request', exact: true }),
    ).toBeVisible();
    expect((await h.http('/api/telos/work/items/purge-leaf')).status).toBe(404);
    await assertWitness();
    const actual = observePrivateReceipt();
    receipt = TelosWorkLifecycleReceiptSchema.parse(JSON.parse(actual.receipt));
    await record('actual-private-committed-purge-receipt-observed-before-cold', { actual });
    const retained = await journal();
    expect(retained).toHaveLength(1);
    await capture('purge-uncertain-before-cold');
    await page.unroute('**/api/telos/work/lifecycle');
    await h.restart();
    const beforeMountPosts = posted.length;
    await page.goto(h.origin + '/todos/purge-leaf');
    const cold = page.getByRole('region', { name: 'Item lifecycle', exact: true }),
      review = cold.getByRole('button', { name: 'Review current state', exact: true });
    await browserExpect(review).toBeEnabled();
    expect(posted).toHaveLength(beforeMountPosts);
    expect(await journal()).toEqual(retained);
    expect((await h.http('/api/telos/work/items/purge-leaf')).status).toBe(404);
    await review.click();
    expect(posted).toHaveLength(beforeMountPosts);
    expect(await journal()).toEqual(retained);
    await cold.getByRole('button', { name: 'Retry original request', exact: true }).click();
    const retry = page.getByRole('dialog', { name: 'Delete item permanently?', exact: true });
    await browserExpect(retry.getByRole('textbox')).toHaveValue('');
    await retry.getByRole('textbox').fill('DELETE PERMANENTLY');
    const [recovered] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/telos/work/lifecycle',
      ),
      retry.getByRole('button', { name: 'Delete permanently', exact: true }).click(),
    ]);
    expect(recovered.status()).toBe(200);
    expect(await recovered.json()).toEqual(receipt);
    expect(posted.at(-1)).toEqual(original);
    expect(posted).toHaveLength(beforeMountPosts + 1);
    expect(observePrivateReceipt()).toEqual(actual);
    expect((await h.http('/api/telos/work/items/purge-leaf')).status).toBe(404);
    await assertWitness();
    await capture('purge-cold-exact-receipt-recovered');
    await record('positive-purge-cold404-explicit-review-fresh-confirmation-exact-recovery', {
      original,
      receipt,
      posted,
      unrelatedWitnessExact: true,
      readOnlyObserversClosed: true,
      modelCalls: 0,
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await h.close();
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (cleanupFailure)
    throw new AggregateError(
      [...(failure ? [failure] : []), cleanupFailure],
      'Purge acceptance and cleanup failed',
      { cause: failure ?? cleanupFailure },
    );
  if (failure) throw failure;
}, 120_000);
