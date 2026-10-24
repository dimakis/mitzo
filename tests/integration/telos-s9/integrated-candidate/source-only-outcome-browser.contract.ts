import { expect, it } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createSourceOnlyProcessFixture } from './source-only-process-fixture';
import { tabToTaskControl as tabToControl } from './task-chat-tree-geometry';

it('opens a preexisting source-only unassigned studio directly and from actual Home without assigning or allocating, retaining origin draft and navigation', async () => {
  const h = await createSourceOnlyProcessFixture();
  const { page, front, api } = h;
  const observations: Array<Record<string, unknown>> = [];
  const requests: Array<{
    path: string;
    method: string;
    body: unknown;
    readOnlyWorkOperation: boolean;
  }> = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/') || request.method() === 'GET') return;
    const body = request.postData() ? request.postDataJSON() : null;
    const readOnlyWorkOperation =
      request.method() === 'POST' &&
      ((path === '/api/telos/work/links' &&
        body?.namespace === 'mitzo' &&
        typeof body.conversationId === 'string') ||
        (path === '/api/telos/work/controls' && ['inbox', 'read'].includes(body?.operation)));
    requests.push({ path, method: request.method(), body, readOnlyWorkOperation });
  });
  const save = async () => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'source-only-observations.json'),
        JSON.stringify(
          {
            observations,
            requests,
            pageErrors: h.pageErrors,
            realModelProviderCalls: 0,
            simulatedProviderInputs: 0,
          },
          null,
          2,
        ),
      );
  };
  const record = async (stage: string, data: Record<string, unknown>) => {
    observations.push({ stage, ...data });
    await save();
  };
  const capture = async (name: string) => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.S9_JOINED_SCREENSHOT_DIR, name + '.png'),
        fullPage: true,
      });
  };
  const focus = () =>
    page.evaluate(() => {
      const e = document.activeElement;
      return {
        tag: e?.tagName,
        name: e?.getAttribute('aria-label') || e?.textContent?.slice(0, 100),
        connected: !!e?.isConnected,
        insideHiddenOrInert: !!e?.closest('[inert],[aria-hidden="true"]'),
      };
    });
  const activate = async (target: ReturnType<typeof page.getByRole>) => {
    const trace = await tabToControl(page, target);
    await browserExpect(target).toBeFocused();
    await page.keyboard.press('Enter');
    return trace;
  };
  try {
    const workBefore = await api.read('studio');
    const recordBefore = await api.readRecord('studio');
    const peerBefore = await api.read('quiet-job');
    const childBefore = await api.read('recording-slice');
    const sourceBefore = await api.readSource('studio', workBefore.sources[0].snapshotId);
    const snapshotBefore = await h.snapshot('planning', 'source-only-no-command');
    const effectsBefore = await h.effects();
    const prefsResponse = await h.http('/api/home/preferences');
    const prefsBefore = await prefsResponse.json();
    const tasksResponse = await h.http('/api/tasks');
    const tasksBefore = await tasksResponse.json();
    expect(prefsResponse.status).toBe(200);
    expect(tasksResponse.status).toBe(200);
    expect(workBefore.kind).toBe('outcome');
    expect(workBefore.assignments).toEqual([]);
    expect(workBefore.attempts).toEqual([]);
    expect(childBefore.assignments).toEqual([]);
    expect(workBefore.sources).toHaveLength(1);
    expect(workBefore.links.every((link) => link.role === 'origin')).toBe(true);
    expect(sourceBefore.available).toBe(true);
    const uniqueConversations = [
      ...new Set([
        ...workBefore.links.map((link) =>
          JSON.stringify([link.conversation.namespace, link.conversation.conversationId]),
        ),
        ...workBefore.sources.flatMap((source) =>
          source.source
            ? [JSON.stringify([source.source.namespace, source.source.conversationId])]
            : [],
        ),
      ]),
    ];
    expect(uniqueConversations).toHaveLength(1);
    expect(prefsBefore.pins).toEqual([{ kind: 'telos', id: 'studio', title: 'Home studio' }]);
    await record('clearly-labeled-preexisting-source-only-baseline', {
      seed: h.retainedSourceBaseline,
      workBefore,
      recordBefore,
      peerBefore,
      childBefore,
      sourceBefore,
      snapshotBefore,
      effectsBefore,
      prefsBefore,
      tasksBefore,
      uniqueConversations,
      limitation:
        'Synthetic PRE-APP source capture/adoption and Home pin via real owners; not native CreateOutcome/AdoptSource or user creation/pinning proof. No lead/worker assigned. Origin session runtime/profile is not qualified by viewing.',
    });
    const workspace = page.locator('.telos-item-workspace');
    const list = page.getByRole('region', { name: 'Chats for Home studio', exact: true });
    const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    const sourceDraft = 'Keep this unsent source-only planning draft; no lead is assigned.';
    const inspectSourceOnly = async (stage: string) => {
      await browserExpect(page).toHaveURL(/\/todos\/studio(?:\?|$)/);
      await browserExpect(
        workspace.getByRole('heading', { name: 'Home studio', exact: true }),
      ).toBeVisible();
      await browserExpect(
        list.getByRole('heading', { name: 'Chats · 1', exact: true }),
      ).toBeVisible();
      await browserExpect(
        list.getByRole('button', { name: 'Choose lead collaborator', exact: true }),
      ).toBeVisible();
      await browserExpect(
        list.getByRole('button', { name: /^Open Originating conversation/ }),
      ).toHaveCount(1);
      await browserExpect(list.locator('.telos-chat-row')).toHaveCount(1);
      await browserExpect(list).not.toContainText('Assigned lead');
      await browserExpect(list).not.toContainText('Assigned worker');
      await browserExpect(composer).not.toBeVisible();
      const current = await api.read('studio');
      expect(current).toEqual(workBefore);
      const fact = {
        stage,
        actualRoute: page.url(),
        actualText: await list.innerText(),
        actualRows: await list.locator('.telos-chat-row').allTextContents(),
        actualWork: current,
        focus: await focus(),
        uniqueConversationCount: uniqueConversations.length,
      };
      await record('source-only-empty-lead-state-' + stage, fact);
      await capture('source-only-' + stage);
    };
    // No chooseChat override: an origin-only item must not auto-enter its chat.
    await page.goto(front.origin + '/todos/studio?view=Chat');
    await inspectSourceOnly('direct-no-forced-chooser');
    const originTrace = await activate(
      list.getByRole('button', { name: /^Open Originating conversation/ }),
    );
    await browserExpect(page).toHaveURL(/\/chat\/planning\?/);
    await browserExpect(page.locator('[data-telos-source-anchor="true"]')).toContainText(
      h.retainedSourceBaseline.originalText,
    );
    await composer.fill(sourceDraft);
    await record('actual-original-exchange-and-unsent-draft', {
      actualRoute: page.url(),
      originalText: h.retainedSourceBaseline.originalText,
      sourceHref: sourceBefore.sourceHref,
      originTrace,
      focus: await focus(),
    });
    await capture('source-only-exact-origin-and-draft');
    const sourceBack = page.getByRole('link', { name: 'Back', exact: true });
    await browserExpect(sourceBack).toHaveAttribute('href', '/todos/studio?view=Chat&chooseChat=1');
    const backTrace = await activate(sourceBack);
    await inspectSourceOnly('origin-back-retains-unassigned');
    const chooseTrace = await tabToControl(
      page,
      list.getByRole('button', { name: 'Choose lead collaborator', exact: true }),
    );
    await record('source-back-keyboard-focus', {
      backTrace,
      chooseTrace,
      actualFocus: await focus(),
      qualification:
        'Natural keyboard reaches the existing assignment affordance; it is not activated. No claim of automatic route-focus restoration.',
    });
    // Actual Home/Today route with a preexisting real HomeStore pin; no mock Home.
    await activate(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'Today', exact: true }),
    );
    await browserExpect(page).toHaveURL(front.origin + '/');
    await browserExpect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    const pin = page.getByRole('link', { name: /^Home studio Work · Pinned to Today$/ });
    await browserExpect(pin).toHaveAttribute('href', '/todos/studio');
    await record('actual-Home-preexisting-outcome-pin', {
      actualRoute: page.url(),
      pinHref: await pin.getAttribute('href'),
      focus: await focus(),
    });
    await capture('source-only-actual-home');
    const pinTrace = await activate(pin);
    // Home pin has no view query: preserve its normal Overview entry.
    await browserExpect(
      workspace.getByRole('heading', { name: 'Home studio', exact: true }),
    ).toBeVisible();
    await browserExpect(
      workspace.getByRole('button', { name: 'Overview', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    const lead = workspace.getByRole('region', { name: 'Lead collaborator', exact: true });
    await browserExpect(lead).toContainText('The originating conversation is linked.');
    await browserExpect(
      lead.getByRole('button', { name: 'Choose lead collaborator', exact: true }),
    ).toBeVisible();
    await browserExpect(
      lead.getByRole('button', { name: 'Open lead chat', exact: true }),
    ).toHaveCount(0);
    await record('unassigned-studio-overview-from-Home', {
      actualRoute: page.url(),
      leadText: await lead.innerText(),
      pinTrace,
      focus: await focus(),
    });
    await capture('source-only-unassigned-studio-overview');
    await activate(workspace.getByRole('button', { name: 'Chat', exact: true }));
    await inspectSourceOnly('from-actual-home-explicit-chat-tab');
    await activate(workspace.getByRole('button', { name: 'Back', exact: true }));
    await browserExpect(workspace).not.toBeVisible();
    const backFromHome = {
      expectedPath: '/',
      actualPath: new URL(page.url()).pathname,
      actualRoute: page.url(),
      focus: await focus(),
    };
    await record('actual-workspace-back-after-Home-entry', backFromHome);
    await capture('source-only-workspace-back-after-home');
    expect
      .soft(
        backFromHome.actualPath,
        'Back preserves the actual Home entry context for this preexisting pinned outcome',
      )
      .toBe('/');
    // Explicit navigation continues observation without altering the returned state.
    await activate(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'Today', exact: true }),
    );
    await browserExpect(page).toHaveURL(front.origin + '/');
    await page.goto(front.origin + '/todos/studio?view=Chat');
    await inspectSourceOnly('direct-after-home-roundtrip');
    await activate(list.getByRole('button', { name: /^Open Originating conversation/ }));
    await browserExpect(composer).toHaveValue(sourceDraft);
    await capture('source-only-origin-draft-retained-after-home');
    await activate(page.getByRole('link', { name: 'Back', exact: true }));
    await inspectSourceOnly('final-origin-return');
    const workAfter = await api.read('studio');
    const sourceAfter = await api.readSource('studio', workBefore.sources[0].snapshotId);
    const snapshotAfter = await h.snapshot('planning', 'source-only-no-command');
    const tasksAfterResponse = await h.http('/api/tasks');
    const tasksAfter = await tasksAfterResponse.json();
    const prefsAfterResponse = await h.http('/api/home/preferences');
    const prefsAfter = await prefsAfterResponse.json();
    const effectsAfter = await h.effects();
    expect(workAfter).toEqual(workBefore);
    expect(await api.readRecord('studio')).toEqual(recordBefore);
    expect(sourceAfter).toEqual(sourceBefore);
    expect(await api.read('quiet-job')).toEqual(peerBefore);
    expect(await api.read('recording-slice')).toEqual(childBefore);
    expect(tasksAfterResponse.status).toBe(200);
    expect(tasksAfter).toEqual(tasksBefore);
    expect(prefsAfterResponse.status).toBe(200);
    expect(prefsAfter).toEqual(prefsBefore);
    expect(snapshotAfter.allSessionIdentities).toEqual(snapshotBefore.allSessionIdentities);
    expect(snapshotAfter.executionBindings).toEqual(snapshotBefore.executionBindings);
    expect(snapshotAfter.tasks).toEqual(snapshotBefore.tasks);
    expect(snapshotAfter.session.accountBinding).toEqual(snapshotBefore.session.accountBinding);
    expect(snapshotAfter.events).toEqual(snapshotBefore.events);
    expect(snapshotAfter.activeSessionIds).toEqual(snapshotBefore.activeSessionIds);
    expect(effectsAfter).toEqual(effectsBefore);
    expect(
      effectsAfter.filter((e) =>
        [
          'native.launch',
          'thread/start',
          'turn/start',
          'provider.tool.request',
          'provider.notification.input',
        ].includes(e.kind),
      ),
    ).toEqual([]);
    const authorityCalls = requests.filter(
      (request) =>
        (request.path.startsWith('/api/telos/work/') && !request.readOnlyWorkOperation) ||
        request.path.startsWith('/api/ordinary/') ||
        request.path.startsWith('/api/tasks') ||
        request.path === '/api/sessions',
    );
    expect(authorityCalls).toEqual([]);
    expect(h.pageErrors).toEqual([]);
    await record('complete-source-only-unassigned-outcome-journey', {
      workBefore,
      workAfter,
      sourceBefore,
      sourceAfter,
      recordBefore,
      recordAfter: await api.readRecord('studio'),
      peerBefore,
      peerAfter: await api.read('quiet-job'),
      childBefore,
      childAfter: await api.read('recording-slice'),
      snapshotBefore,
      snapshotAfter,
      tasksBefore,
      tasksAfter,
      prefsBefore,
      prefsAfter,
      effectsBefore,
      effectsAfter,
      requests,
      authorityCalls,
      backFromHome,
      sourceDraft,
      lifecycle: h.lifecycle,
      limitation:
        'ONE390px Chromium journey; pre-App synthetic source/outcome/Home pin notcreation/nativeCapture proof. Existing source-only list/origin/assignment separation and unique count only; no complete UX06/13/count matrix, assigned single-nonorigin behavior, source revocation/error matrix, runtime/profile/native/model/main/live qualification. NaturalTab reachability/focus observations, no automatic route-focus restoration claim.',
    });
  } catch (error) {
    await record('hard-failure-actual-route-and-DOM', {
      error: String(error),
      actualRoute: page.url(),
      actualBodyText: await page.locator('body').innerText(),
      focus: await focus(),
    });
    await capture('source-only-hard-failure-actual-state');
    throw error;
  } finally {
    await save();
    await h.close();
  }
}, 180_000);
