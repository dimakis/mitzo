import { it, expect } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createAdvisorMaterialProcessFixture } from './advisor-material-process-fixture';
import { openChatSetting, chooseSetting, chooseAgent } from '../../../support/chat-settings';

it('refuses an actual UI-reviewed role material selection when retained r1 is paired with later r2 hash, without content release or work/session mutation', async () => {
  const h = await createAdvisorMaterialProcessFixture();
  const { page, api, front, retainedSourceBaseline: baseline } = h;
  const observations: Array<Record<string, unknown>> = [];
  const reviews: Array<Promise<Record<string, unknown>>> = [];
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const save = async () => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'material-refusal-observations.json'),
        JSON.stringify(
          { observations, pageErrors: h.pageErrors, realModelProviderCalls: 0 },
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
  page.on('response', (response) => {
    if (
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/telos/work/roles/review')
    )
      reviews.push(
        (async () => ({
          status: response.status(),
          request: response.request().postDataJSON(),
          body: await response.json(),
        }))(),
      );
  });
  const workspace = page.locator('.telos-item-workspace');
  try {
    await page.goto(front.origin + '/todos/studio');
    await workspace.getByRole('button', { name: 'Materials', exact: true }).click();
    await workspace.getByRole('link', { name: /^Acoustic plan ·/ }).click();
    await browserExpect(page.locator('.viewer-content')).toContainText(
      baseline.originalMaterialText,
    );
    await page.locator('.viewer-header').getByRole('button', { name: 'Edit', exact: true }).click();
    const secondText =
      'Revision two for the integrity refusal case. Its hash cannot authenticate retained revision one.\n';
    await page.getByRole('textbox', { name: 'Document source', exact: true }).fill(secondText);
    const [editResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          new URL(r.url()).pathname ===
            '/api/telos/artifacts/' + baseline.pin.artifactId + '/document',
      ),
      page
        .locator('.viewer-header')
        .getByRole('button', { name: 'Save new revision', exact: true })
        .click(),
    ]);
    expect(editResponse.status()).toBe(200);
    const second = (await editResponse.json()).artifact;
    expect(second).toMatchObject({
      id: baseline.pin.artifactId,
      revision: 2,
      sha256: hash(Buffer.from(secondText)),
      sourceKind: 'user_edit',
    });
    expect(second.sha256).not.toBe(baseline.pin.sha256);
    await record('actual-files-r2-established', {
      baseline,
      editRequest: editResponse.request().postDataJSON(),
      second,
      secondText,
    });
    await capture('actual-r2-before-role-material-refusal');

    await page.goto(front.origin + '/todos/recording-slice');
    await workspace.getByRole('button', { name: 'Refine item', exact: true }).click();
    const setup = page.getByRole('region', { name: 'Work conversation setup', exact: true });
    await browserExpect(setup).toBeVisible();
    await openChatSetting(page, 'execution');
    await page.getByRole('button', { name: 'Local Mac', exact: true }).click();
    await chooseSetting(page, 'Account', 'ordinary-personal');
    await chooseSetting(page, 'Model', 'fixture-model');
    await chooseSetting(page, 'Thinking level', 'low');
    await chooseAgent(page, JSON.stringify(['saved', 'ordinary-worker', 1]));
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await browserExpect(
      setup.getByRole('button', { name: 'Start chat', exact: true }),
    ).toBeEnabled();
    await setup.getByText('Linked work context', { exact: true }).click();
    await browserExpect(setup).toContainText('Preexisting reviewed sample plan');
    await browserExpect(setup).toContainText('Acoustic plan');
    await browserExpect(setup).toContainText('Revision 1');
    const captured = await Promise.all(reviews);
    const selected = captured
      .filter(
        (r) => r.status === 200 && (r.request as { itemId?: string }).itemId === 'recording-slice',
      )
      .at(-1);
    expect(selected).toBeTruthy();
    const input = selected!.request as Parameters<typeof api.reviewRoleContext>[0];
    const reviewed = selected!.body as Awaited<ReturnType<typeof api.reviewRoleContext>>;
    expect(input).toMatchObject({
      itemId: 'recording-slice',
      role: 'advisor',
      advisorPurpose: 'refine',
      sourceSnapshotIds: [baseline.source.snapshot.snapshotId],
      artifactRefs: baseline.pins,
    });
    expect(reviewed.selection.sources).toEqual([baseline.source.snapshot]);
    expect(reviewed.selection.artifacts).toEqual(baseline.pins);
    await capture('actual-ui-valid-nonempty-r1-role-context');

    const before = {
      work: await api.read('recording-slice'),
      record: await api.readRecord('recording-slice'),
      source: await api.readSource('recording-slice', baseline.source.snapshot.snapshotId),
      parent: await api.readRecord('studio'),
      quiet: await api.readRecord('quiet-job'),
      state: await h.snapshot(baseline.selection.sourceConversationId, 'not-yet-admitted'),
      effects: await h.effects(),
    };
    expect(before.state.session.sessionId).toBe(baseline.selection.sourceConversationId);
    expect(before.state.workspace).toBeNull();
    expect(before.state.preparation).toBeNull();
    expect(before.state.tasks).toEqual([]);
    // Origin inventory/source observation only: this ordinary source has no
    // owned runtime/workspace; do not infer a binding from absent fields.
    // This is an explicit API integrity negative using the ACTUAL UI request.
    // There is no UI picker or request interception/tampering in the browser.
    const mismatched = structuredClone(input);
    mismatched.artifactRefs = mismatched.artifactRefs.map((pin) =>
      pin.artifactId === baseline.pin.artifactId ? { ...pin, sha256: second.sha256 } : pin,
    );
    expect(mismatched.artifactRefs).toEqual([
      { ...baseline.pin, sha256: second.sha256 },
      baseline.sourceRecordPin,
    ]);
    let refusal: { status: unknown; code: unknown; message: string } | undefined;
    try {
      await api.reviewRoleContext(mismatched);
    } catch (error) {
      if (!(error instanceof Error) || !('status' in error) || !('code' in error)) throw error;
      refusal = { status: error.status, code: error.code, message: error.message };
    }
    // Existing role-review hash refusal maps the owner error to this generic
    // unavailable response. This does not qualify the error taxonomy/UI copy.
    expect(refusal).toEqual({
      status: 503,
      code: 'unavailable',
      message: 'Ordinary role setup unavailable',
    });
    expect(JSON.stringify(refusal)).not.toContain(baseline.originalMaterialText);
    expect(JSON.stringify(refusal)).not.toContain(baseline.originalText);
    const after = {
      work: await api.read('recording-slice'),
      record: await api.readRecord('recording-slice'),
      source: await api.readSource('recording-slice', baseline.source.snapshot.snapshotId),
      parent: await api.readRecord('studio'),
      quiet: await api.readRecord('quiet-job'),
      state: await h.snapshot(baseline.selection.sourceConversationId, 'not-yet-admitted'),
      effects: await h.effects(),
    };
    expect(after.work).toEqual(before.work);
    expect(after.record).toEqual(before.record);
    expect(after.source).toEqual(before.source);
    expect(after.parent).toEqual(before.parent);
    expect(after.quiet).toEqual(before.quiet);
    expect(after.state.allSessionIdentities).toEqual(before.state.allSessionIdentities);
    expect(after.state.executionBindings).toEqual(before.state.executionBindings);
    expect(after.state.tasks).toEqual(before.state.tasks);
    expect(after.state.preparation).toEqual(before.state.preparation);
    expect(after.state.events).toEqual(before.state.events);
    expect(after.state.activeSessionIds).toEqual(before.state.activeSessionIds);
    expect(after.state.workspace).toBeNull();
    expect(after.state.preparation).toBeNull();
    expect(after.effects).toEqual(before.effects);
    expect(
      after.effects.filter((e) =>
        ['native.launch', 'thread/start', 'turn/start', 'provider.notification.input'].includes(
          e.kind,
        ),
      ),
    ).toEqual([]);
    expect(after.work.assignments).toEqual([]);
    expect(after.work.attempts).toEqual([]);
    expect(
      after.work.links.filter((link) => ['advisor', 'worker', 'lead'].includes(link.role)),
    ).toEqual([]);
    const materialReadbacks = [];
    for (const [revision, text, sha256] of [
      [1, baseline.originalMaterialText, baseline.pin.sha256],
      [2, secondText, second.sha256],
    ] as const) {
      const response = await h.http(
        '/api/telos/artifacts/' + baseline.pin.artifactId + '?revision=' + revision,
      );
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.toString()).toBe(text);
      expect(hash(bytes)).toBe(sha256);
      materialReadbacks.push({ revision, sha256: hash(bytes), text: bytes.toString() });
    }
    await browserExpect(
      setup.getByRole('button', { name: 'Start chat', exact: true }),
    ).toBeEnabled();
    await browserExpect(setup).toContainText('Revision 1');
    expect(h.pageErrors).toEqual([]);
    await capture('valid-ui-role-context-preserved-after-api-hash-refusal');
    await record('complete-actual-role-review-mismatched-material-refusal', {
      baseline,
      runtimeBindingAndWorkspaceRecoveryNotQualified: true,
      second,
      secondText,
      capturedUiReviews: captured,
      selected,
      input,
      reviewed,
      mismatched,
      refusal,
      before,
      after,
      materialReadbacks,
      initialReady: h.initialReady,
      limits:
        'One App/typedclient material-integrity refusal using a real UI-produced valid role-review request. r1 with later r2 hash is rejected; exact canonical/source/session/task/origin-events/material/effects unchanged across the negative. Origin snapshot has no workspace/preparation and supplies no runtimebinding/recovery proof. No browser interception, invented picker, UI negative-state presentation, source adoption UI, advisor preview/save, Startchat submission, native turn/tool/terminal or model call. Synthetic preexisting source setup through real owners is not UIadoption proof. HTTP503 generic taxonomy remains existing behavior, not UX/error-message acceptance. No allocator invocation claimed solely from unchanged inventory; no new identity is observed and role-context reviewer has no allocation/provider port. Native selected content byte access remains open; full revocation/privacy/race/staleitem/recovery/currentmain/live matrix separate.',
    });
  } catch (error) {
    await capture('actual-material-refusal-failure-boundary').catch(() => {});
    throw error;
  } finally {
    await save();
    await h.close();
  }
}, 180_000);
