import { expect, it } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createJoinedOrdinaryApplication } from './joined-ordinary-application';

it('opens the exact original exchange and its item backlink while pinned material survives real revision editing and artifact-owner restart', async () => {
  const h = await createJoinedOrdinaryApplication({ viewport: { width: 320, height: 900 } });
  const { canonical, api, chat, page, front, f } = h;
  const facts: Array<Record<string, unknown>> = [];
  const save = async () => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'origin-material-observations.json'),
        JSON.stringify(
          {
            facts,
            nativeLaunches: h.nativeSessions.length,
            pageErrors: h.pageErrors,
            realModelProviderCalls: 0,
          },
          null,
          2,
        ),
      );
  };
  const record = async (stage: string, value: Record<string, unknown> = {}) => {
    facts.push({ stage, ...value });
    await save();
  };
  const capture = async (stage: string) => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.S9_JOINED_SCREENSHOT_DIR, stage + '.png'),
        fullPage: true,
      });
  };
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  try {
    await api.execute({
      operation: 'classify',
      itemId: 'studio',
      kind: 'outcome',
      requestId: randomUUID(),
      expectedRevision: (await api.read('studio')).revision,
    });
    // Canonical synthetic conversation events are fixture input. Actual adoption,
    // replay, source validation, navigation and artifact edit owners stay real.
    chat.eventStore.upsertSession({
      ...canonical.events.getSession('planning')!,
      accountBinding: f.binding,
    });
    const originalText =
      'Original decision: retain the acoustic plan revision one; execution is a separate decision.';
    const sequence = chat.eventStore.append('planning', 'user_message', {
      messageId: 'original-material-decision',
      text: originalText,
    });
    const material = {
      artifactId: canonical.material.id,
      revision: 1,
      sha256: canonical.material.sha256,
    };
    const selection = {
      requestId: randomUUID(),
      expectedMembershipRevision: 0,
      sourceConversationId: 'planning',
      mode: 'selected' as const,
      boundary: { sequence, messageId: 'original-material-decision' },
      messageIds: ['original-material-decision'],
      artifacts: [material],
      purpose: 'Original acoustic decision and exact material revision',
      joiningBrief: '',
    };
    const preview = await api.previewSource({ itemId: 'studio', selection });
    await api.adoptSource({
      itemId: 'studio',
      selection,
      requestId: randomUUID(),
      expectedRevision: preview.packet.workRevision,
      previewSha256: preview.sha256,
    });
    const workBefore = await api.read('studio'),
      sourceBefore = await api.readSource('studio', workBefore.sources[0].snapshotId);
    expect(workBefore.assignments).toEqual([]);
    expect(sourceBefore.available).toBe(true);
    expect(sourceBefore.snapshot.artifacts).toContainEqual(material);
    for (let i = 0; i < 16; i++)
      chat.eventStore.append('planning', 'user_message', {
        messageId: 'later-unadopted-' + i,
        text:
          'Later unadopted planning note ' +
          i +
          ': this newer discussion must not replace the original reviewed exchange or material revision.',
      });
    canonical.db
      .prepare(
        `INSERT INTO links (id,item_id,type,url,title,description,created_at) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        'pinned-original-material',
        'studio',
        'artifact',
        canonical.material.url,
        'Plan retained at adoption',
        'Exact original revision one',
        '2026-10-15T12:00:00Z',
      );
    canonical.db
      .prepare(
        `INSERT INTO links (id,item_id,type,url,title,description,created_at) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        'separate-external-reference',
        'studio',
        'reference',
        'https://example.test/room-notes',
        'External room notes',
        'External reference only',
        '2026-10-15T13:00:00Z',
      );
    const itemBefore = await api.readRecord('studio'),
      sessionCount = chat.eventStore.listSessions().length,
      first = canonical.artifacts.read(material.artifactId, 1);
    await record('actual-source-adoption-pinned-r1', {
      workBefore,
      sourceBefore,
      material,
      itemBefore,
      first: {
        id: first.id,
        revision: first.revision,
        sha256: first.sha256,
        sessionId: first.sessionId,
        createdAt: first.createdAt,
        sourceKind: first.sourceKind,
      },
      sessionCount,
    });
    await page.goto(front.origin + '/todos/studio');
    const workspace = page.locator('.telos-item-workspace');
    await workspace.getByRole('button', { name: 'Materials', exact: true }).click();
    const sources = workspace.getByRole('region', { name: 'Sources', exact: true });
    await browserExpect(sources).toContainText(sourceBefore.snapshot.author ?? 'Author unknown');
    await browserExpect(sources).toContainText(
      sourceBefore.snapshot.sourceCreatedAt ?? 'Source date unknown',
    );
    await browserExpect(sources).toContainText('Added ' + sourceBefore.snapshot.adoptedAt);
    const originalRead = page
      .waitForResponse(
        (r) =>
          r.url().includes('/sources/' + sourceBefore.snapshot.snapshotId) &&
          r.request().method() === 'GET',
      )
      .catch(() => null);
    await sources.getByRole('button', { name: 'Open original chat', exact: true }).click();
    await browserExpect(page).toHaveURL(front.origin + sourceBefore.sourceHref);
    const anchor = page.locator('[data-telos-source-anchor="true"]');
    await browserExpect(anchor).toContainText(originalText);
    await browserExpect(anchor).toBeInViewport();
    const sourceResponse = await originalRead;
    expect(sourceResponse?.status()).toBe(200);
    const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    await composer.fill('Keep this original planning draft.');
    await capture('exact-original-exchange-anchor');
    await page.getByRole('button', { name: 'View item: Home studio', exact: true }).click();
    await browserExpect(
      workspace.getByRole('heading', { name: 'Home studio', exact: true }),
    ).toBeVisible();
    // This backlink also exists in the ordinary originating chat without any
    // inspected-source URL selecting the item: it comes from recorded links.
    await page.goto(front.origin + '/chat/planning');
    await browserExpect(composer).toHaveValue('Keep this original planning draft.');
    await page.getByRole('button', { name: 'Open session tray', exact: true }).click();
    const resources = page.getByRole('dialog', { name: 'Resources', exact: true });
    await resources.getByRole('tab', { name: 'Sources', exact: true }).click();
    await browserExpect(
      resources.getByRole('heading', { name: 'Linked work', exact: true }),
    ).toBeVisible();
    const backlink = resources.getByRole('link', { name: 'Home studio', exact: true });
    await browserExpect(backlink).toHaveAttribute('href', '/todos/studio');
    await capture('ordinary-origin-recorded-item-backlink');
    await backlink.click();
    await browserExpect(page).toHaveURL(front.origin + '/todos/studio');
    await workspace.getByRole('button', { name: 'Materials', exact: true }).click();
    await browserExpect(
      workspace.getByRole('heading', { name: 'Saved document references', exact: true }),
    ).toBeVisible();
    await browserExpect(
      workspace.getByRole('link', { name: 'External room notes', exact: true }),
    ).toHaveAttribute('href', 'https://example.test/room-notes');
    await record('actual-origin-two-way-navigation', {
      sourceHref: sourceBefore.sourceHref,
      anchoredMessageId: 'original-material-decision',
      ordinaryBacklink: '/todos/studio',
      assignments: (await api.read('studio')).assignments,
    });
    await workspace.getByRole('link', { name: /Plan retained at adoption/ }).click();
    await browserExpect(page).toHaveURL(/\/files\?/);
    const originalViewerUrl = page.url();
    expect(new URL(originalViewerUrl).searchParams.get('path')).toBe(canonical.material.url);
    await browserExpect(page.locator('.viewer-content')).toContainText(first.bytes.toString());
    await page.locator('.viewer-header').getByRole('button', { name: 'Edit', exact: true }).click();
    const secondText =
      'Revision two adds new room measurements. The original retained plan remains a separate immutable version.\n';
    await page.getByRole('textbox', { name: 'Document source', exact: true }).fill(secondText);
    const [edited] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          new URL(r.url()).pathname === '/api/telos/artifacts/' + material.artifactId + '/document',
      ),
      page
        .locator('.viewer-header')
        .getByRole('button', { name: 'Save new revision', exact: true })
        .click(),
    ]);
    expect(edited.status()).toBe(200);
    expect(edited.request().postDataJSON()).toMatchObject({
      expectedRevision: 1,
      content: secondText,
    });
    const second = (await edited.json()).artifact;
    expect(second).toMatchObject({
      id: material.artifactId,
      revision: 2,
      sha256: hash(Buffer.from(secondText)),
      sourceKind: 'user_edit',
      sessionId: 'user-edit:' + f.auth.id,
    });
    expect(Date.parse(second.createdAt)).toBeGreaterThan(Date.parse(first.createdAt));
    await browserExpect(page.locator('.document-editor-status').first()).toContainText(
      'Revision 2',
    );
    await capture('actual-files-save-new-revision');
    expect(canonical.artifacts.read(material.artifactId, 1).bytes).toEqual(first.bytes);
    expect((await api.readSource('studio', sourceBefore.snapshot.snapshotId)).packet).toEqual(
      sourceBefore.packet,
    );
    await page.locator('.viewer-header').getByRole('button', { name: 'Back', exact: true }).click();
    await workspace.getByRole('button', { name: 'Materials', exact: true }).click();
    const outputs = workspace.getByRole('region', { name: 'Outputs', exact: true });
    const outputRow = outputs
      .locator('li')
      .filter({ has: page.getByRole('link', { name: 'Acoustic plan', exact: true }) });
    await browserExpect(outputRow).toContainText('Revision 2');
    await browserExpect(outputRow).toContainText('Edited by user');
    await outputRow.getByText('Provenance', { exact: true }).click();
    for (const value of [second.sha256, second.createdAt, second.sessionId, 'Author not recorded'])
      await browserExpect(outputRow).toContainText(value);
    await capture('latest-output-provenance-separate-from-origin');
    await outputs.getByRole('link', { name: 'Acoustic plan', exact: true }).click();
    const document = page.getByRole('dialog', { name: 'Acoustic plan', exact: true });
    const version = document.getByRole('combobox', { name: 'Version', exact: true });
    await browserExpect(version).toHaveValue('2');
    await browserExpect(document).toContainText(secondText.trim());
    await version.selectOption('1');
    await browserExpect(document).toContainText(first.bytes.toString());
    expect(new URL(page.url()).searchParams.get('savedRevision')).toBe('1');
    expect(new URL(page.url()).searchParams.get('savedHash')).toBe(first.sha256);
    await document.getByText('Provenance', { exact: true }).click();
    for (const value of [first.sha256, first.createdAt, first.sessionId])
      await browserExpect(document).toContainText(value);
    const pinnedDialogUrl = page.url();
    await capture('selected-original-version-hash-date-source');
    await record('real-version-edit-and-explicit-r1-selection', {
      first: {
        revision: first.revision,
        sha256: first.sha256,
        createdAt: first.createdAt,
        sessionId: first.sessionId,
        sourceKind: first.sourceKind,
      },
      second,
      originalViewerUrl,
      pinnedDialogUrl,
      saveRequest: edited.request().postDataJSON(),
      sourceStillPinned: (await api.readSource('studio', sourceBefore.snapshot.snapshotId)).snapshot
        .artifacts,
    });
    canonical.restartOwners();
    await page.reload();
    await browserExpect(version).toHaveValue('1');
    await browserExpect(document).toContainText(first.bytes.toString());
    await browserExpect(document).not.toContainText(secondText.trim());
    expect(page.url()).toBe(pinnedDialogUrl);
    const versionsResponse = await page.request.get(
      front.origin + '/api/telos/artifacts/' + material.artifactId + '/versions',
    );
    expect(versionsResponse.status()).toBe(200);
    const versions = await versionsResponse.json();
    expect(versions.artifacts.map((a: { revision: number }) => a.revision)).toEqual([2, 1]);
    for (const [revision, bytes, sha256] of [
      [1, first.bytes, first.sha256],
      [2, Buffer.from(secondText), second.sha256],
    ] as const) {
      const response = await page.request.get(
        front.origin + '/api/telos/artifacts/' + material.artifactId + '?revision=' + revision,
      );
      expect(response.status()).toBe(200);
      expect(await response.body()).toEqual(bytes);
      expect(response.headers()['x-artifact-sha256']).toBe(sha256);
    }
    expect((await api.readSource('studio', sourceBefore.snapshot.snapshotId)).packet).toEqual(
      sourceBefore.packet,
    );
    await capture('restart-retains-selected-original-version');
    await document.getByRole('button', { name: 'Done', exact: true }).click();
    await sources.getByRole('button', { name: 'Open original chat', exact: true }).click();
    await browserExpect(anchor).toContainText(originalText);
    await browserExpect(anchor).toBeInViewport();
    await browserExpect(composer).toHaveValue('Keep this original planning draft.');
    await page.getByRole('button', { name: 'View item: Home studio', exact: true }).click();
    await workspace.getByRole('button', { name: 'Materials', exact: true }).click();
    // The original explicit canonical document link still selects r1 after r2
    // and restart; opening it never silently follows latest bytes.
    await workspace.getByRole('link', { name: /Plan retained at adoption/ }).click();
    expect(new URL(page.url()).searchParams.get('path')).toBe(canonical.material.url);
    await browserExpect(page.locator('.viewer-content')).toContainText(first.bytes.toString());
    await browserExpect(page.locator('.viewer-content')).not.toContainText(secondText.trim());
    await page.locator('.viewer-header').getByRole('button', { name: 'Back', exact: true }).click();
    await outputs.getByRole('link', { name: 'Acoustic plan', exact: true }).click();
    const invalidPin = new URL(page.url());
    invalidPin.searchParams.set('savedRevision', '999');
    await page.goto(invalidPin.href);
    await browserExpect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    await capture('missing-version-real-refusal');
    expect((await api.read('studio')).sources).toEqual(workBefore.sources);
    expect((await api.read('studio')).assignments).toEqual([]);
    const itemAfter = await api.readRecord('studio');
    const latestAliasUrl = '/api/telos/artifacts/' + material.artifactId;
    const aliasBefore = itemBefore.links.find((link) => link.url === latestAliasUrl)!;
    const aliasAfter = itemAfter.links.find((link) => link.url === latestAliasUrl)!;
    // Preserve item fields and both explicit references byte-for-byte. The
    // latest alias may move in presentation order when the owner replaces its
    // row; its original Added date must still survive a document edit (UX19).
    const stableRecord = (value: typeof itemBefore) => ({
      ...value,
      links: value.links.filter((link) => link.url !== latestAliasUrl),
      legacyFields: {
        ...value.legacyFields,
        links: (value.legacyFields.links as Array<{ url: string }>).filter(
          (link) => link.url !== latestAliasUrl,
        ),
      },
    });
    expect(stableRecord(itemAfter)).toEqual(stableRecord(itemBefore));
    expect(aliasBefore).toBeDefined();
    expect(aliasAfter).toBeDefined();
    expect(itemAfter.links.filter((link) => link.url === latestAliasUrl)).toHaveLength(1);
    const { addedAt: originalAddedAt, ...aliasFieldsBefore } = aliasBefore;
    const { addedAt: observedAddedAt, ...aliasFieldsAfter } = aliasAfter;
    expect(aliasFieldsAfter).toEqual(aliasFieldsBefore);
    await record('document-link-original-added-date-contract', {
      aliasBefore,
      aliasAfter,
      itemAfter,
      expected:
        'Existing document-link Added date remains the original association date; revision creation records the edit date separately.',
      requirement: 'UX19',
      owner: 'S3 d4e0bf084cd61139; S7 57b0894e0379ab95 consumes Added metadata',
    });
    expect
      .soft(observedAddedAt, 'UX19: editing must retain the existing document link Added date')
      .toBe(originalAddedAt);
    expect(chat.eventStore.listSessions()).toHaveLength(sessionCount);
    expect(h.nativeSessions).toHaveLength(0);
    expect(h.pageErrors).toEqual([]);
    await record('completed-origin-and-material-version-journey', {
      versions,
      sourceAfter: await api.readSource('studio', sourceBefore.snapshot.snapshotId),
      itemAfter,
      sessionCount,
      nativeLaunches: 0,
      limitation:
        'Canonical artifact/work-owner restart plus full browser reload only; no server/nativeprocess restart, backup restore, publication/delivery or fullUX/device/main qualification.',
    });
  } finally {
    await save();
  }
}, 120_000);
