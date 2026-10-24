import { it, expect } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { createLegacyBackupProcessFixture } from './legacy-backup-process-fixture';

it('preserves complete and unknown legacy provenance through repeated real schema enrollment and actual backup-group App readback', async () => {
  const h = await createLegacyBackupProcessFixture();
  const { page, front, api, seedFacts } = h;
  const observations: Array<Record<string, unknown>> = [];
  const save = async () => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'legacy-backup-observations.json'),
        JSON.stringify(
          { observations, pageErrors: h.pageErrors, realProviderModelCalls: 0 },
          null,
          2,
        ),
      );
  };
  const record = async (stage: string, detail: Record<string, unknown>) => {
    observations.push({ stage, ...detail });
    await save();
  };
  const capture = async (name: string) => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.S9_JOINED_SCREENSHOT_DIR, name + '.png'),
        fullPage: true,
      });
  };
  const rawCanonical = () => {
    const db = new Database(h.initialReady.statePaths.canonicalDb, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return Object.fromEntries(
        ['items', 'sources', 'links', 'history'].map((table) => [
          table,
          db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
        ]),
      );
    } finally {
      db.close();
    }
  };
  const readAll = async () => {
    const values = [];
    for (const id of ['legacy-parent', 'legacy-known', 'legacy-unknown'])
      values.push({ work: await api.read(id), record: await api.readRecord(id) });
    return values;
  };
  try {
    const before = await readAll();
    expect(before).toEqual(seedFacts.firstRead);
    expect(seedFacts.afterRepeatedEnrollment).toEqual(seedFacts.before);
    expect(rawCanonical()).toEqual(seedFacts.before);
    for (const { work, record: row } of before) {
      expect(work.assignments).toEqual([]);
      expect(work.links).toEqual([]);
      expect(work.attempts).toEqual([]);
      expect(work.sources).toEqual([]);
      expect(row.kind).toBeNull();
      expect(row.itemId).toBe(work.itemId);
    }
    const known = before[1].record,
      unknown = before[2].record;
    expect(known).toMatchObject({
      itemId: 'legacy-known',
      parentId: 'legacy-parent',
      profile: 'work',
      status: 'snoozed',
      priority: 9,
      contextHints: {
        sessionIds: ['legacy-hint-is-not-lead'],
        taskHint: 'Retain the exact older intent.',
      },
    });
    expect(known.sources[0].rawSnippet).toBe(seedFacts.snippet);
    expect(known.sources[0].author).toBe('Original Person');
    expect(unknown.sources[0]).toMatchObject({
      author: '',
      createdAt: null,
      addedAt: null,
      updatedAt: null,
    });
    await record('real-app-legacy-read-after-twice-enrollment', {
      before,
      seedFacts,
      canonical: rawCanonical(),
    });
    const workspace = page.locator('.telos-item-workspace');
    await page.goto(front.origin + '/todos/legacy-known');
    await browserExpect(
      workspace.getByRole('heading', { name: 'Known legacy provenance', exact: true }),
    ).toBeVisible();
    const brief = workspace.getByRole('complementary', { name: 'Original brief' });
    await browserExpect(brief).toContainText('Keep original intent — Καλημέρα');
    await browserExpect(brief).toContainText('Original rationale');
    await browserExpect(brief).toContainText('Exact old fields');
    await browserExpect(brief).toContainText('Original Person');
    await browserExpect(brief).toContainText('EXACT END OF LEGACY SOURCE');
    await brief.getByText('Context', { exact: true }).click();
    await browserExpect(brief).toContainText('legacy-hint-is-not-lead');
    await capture('known-legacy-original-fields-and-context');
    await page.goto(front.origin + '/todos/legacy-unknown');
    await browserExpect(
      workspace.getByRole('heading', { name: 'Unknown legacy provenance', exact: true }),
    ).toBeVisible();
    await browserExpect(brief).toContainText('Unknown author and source date must remain unknown.');
    await browserExpect(brief).toContainText('Unknown');
    await workspace.getByRole('button', { name: 'Chat', exact: true }).click();
    await browserExpect(workspace).toContainText('No linked conversations yet.');
    await browserExpect(
      workspace.getByRole('heading', { name: 'Chats · 0', exact: true }),
    ).toBeVisible();
    await capture('unknown-legacy-no-inferred-assignment');
    const artifactReads = [];
    for (const item of seedFacts.artifacts) {
      const response = await h.http(item.url);
      expect(response.status).toBe(200);
      const content = await response.text();
      expect(content).toBe(seedFacts.artifactBytes[item.revision - 1]);
      expect(createHash('sha256').update(content).digest('hex')).toBe(item.sha256);
      artifactReads.push({
        revision: item.revision,
        sha256: item.sha256,
        content,
        status: response.status,
      });
    }
    const destination = join(h.f.root, 'actual-core-backup');
    const coverage = await h.captureBackup(destination);
    const capturedCoverage = JSON.parse(await readFile(join(destination, 'coverage.json'), 'utf8'));
    expect(coverage).toEqual(capturedCoverage);
    expect(capturedCoverage.required).toEqual(['mitzo-events', 'mitzo-tasks', 'telos']);
    expect(capturedCoverage.stores.map((s: { id: string }) => s.id)).toEqual(
      capturedCoverage.required,
    );
    const capturedFiles = [];
    if (process.env.S9_JOINED_SCREENSHOT_DIR) {
      for (const relative of [
        'coverage.json',
        ...capturedCoverage.required.map((id: string) => id + '/store.db'),
      ]) {
        const target = join(process.env.S9_JOINED_SCREENSHOT_DIR, 'captured-core-group', relative);
        await mkdir(join(target, '..'), { recursive: true });
        const source = join(destination, relative);
        const bytes = await readFile(source);
        await copyFile(source, target);
        expect(await readFile(target)).toEqual(bytes);
        capturedFiles.push({
          path: target,
          relative,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
        });
      }
    }

    await record('actual-owner-backup-group-captured', {
      coverage,
      destination,
      capturedFiles,
      artifactReads,
      canonical: rawCanonical(),
      lifecycle: h.lifecycle,
    });
    await h.crash();
    const restoredFiles = await h.restoreBackupFiles(destination);
    const cold = await h.restart();
    expect(cold.pid).not.toBe(h.initialReady.pid);
    expect(cold.statePaths).toEqual(h.initialReady.statePaths);
    expect(cold.authId).toBe(h.initialReady.authId);
    const after = await readAll();
    expect(after).toEqual(before);
    expect(rawCanonical()).toEqual(seedFacts.before);
    const restoredArtifactReads = [];
    for (const item of seedFacts.artifacts) {
      const response = await h.http(item.url);
      expect(response.status).toBe(200);
      const content = await response.text();
      expect(content).toBe(seedFacts.artifactBytes[item.revision - 1]);
      expect(createHash('sha256').update(content).digest('hex')).toBe(item.sha256);
      restoredArtifactReads.push({
        revision: item.revision,
        sha256: item.sha256,
        content,
        status: response.status,
      });
    }
    expect(restoredArtifactReads).toEqual(artifactReads);
    await page.goto(front.origin + '/todos/legacy-known?view=Materials');
    await browserExpect(
      workspace.getByRole('heading', { name: 'Known legacy provenance', exact: true }),
    ).toBeVisible();
    await workspace.getByRole('link', { name: /Explicit historical revision one/ }).click();
    expect(new URL(page.url()).searchParams.get('path')).toBe(seedFacts.artifacts[0].url);
    await browserExpect(page.locator('.viewer-content')).toContainText(
      'Keep these exact older bytes.',
    );
    await browserExpect(page.locator('.viewer-content')).not.toContainText(
      'Later bytes must not replace',
    );
    await capture('restored-explicit-original-revision-through-actual-files');
    await page.locator('.viewer-header').getByRole('button', { name: 'Back', exact: true }).click();
    await page.goto(front.origin + '/todos/legacy-unknown?view=Chat');
    await browserExpect(workspace).toContainText('No linked conversations yet.');
    await browserExpect(
      workspace.getByRole('heading', { name: 'Chats · 0', exact: true }),
    ).toBeVisible();
    await capture('restored-unknown-provenance-still-unassigned');
    expect(await readAll()).toEqual(before);
    expect(rawCanonical()).toEqual(seedFacts.before);
    const effects = await h.effects();
    expect(effects.map((effect) => effect.kind)).toEqual(['preflight.close', 'preflight.close']);
    expect(
      effects.filter((effect) =>
        ['native.launch', 'thread/start', 'turn/start', 'thread/resume', 'turn/interrupt'].includes(
          effect.kind,
        ),
      ),
    ).toEqual([]);
    expect(h.pageErrors).toEqual([]);
    await record('complete-legacy-enrollment-backup-app-readback', {
      before,
      after,
      seedFacts,
      coverage,
      restoredFiles,
      capturedFiles,
      artifactReads,
      restoredArtifactReads,
      canonicalAfter: rawCanonical(),
      initialReady: h.initialReady,
      cold,
      lifecycle: h.lifecycle,
      effects: await h.effects(),
      limitations:
        'Actual Telos enrollment over3077 exported upgradedDDL and actual backup-group snapshot restore/readback only. Does not execute historical Python migration or Restic/cloud/full host recovery. No guessed provenance, role, coordinator, provider turn, approval, canonical completion or terminal. No current accepted-main/fullUX/live acceptance.',
    });
  } catch (error) {
    await capture('actual-failure-boundary').catch(() => {});
    throw error;
  } finally {
    await save();
    await h.close();
  }
}, 180_000);
