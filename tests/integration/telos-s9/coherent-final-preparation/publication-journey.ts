import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CollaborationSettings } from '@mitzo/protocol';
import type { createActualApp } from './actual-app.js';

type App = Awaited<ReturnType<typeof createActualApp>>;
/** Actual publication has its own explicitly reviewed tool profile. The legacy
 * report lead remains the original canonical-progress actor; an operator review
 * installs a new current publication lead through the real role owner. No
 * retired lead, fixture pins/adapter, direct runtime request or fake permit is used. */
export async function publicationJourney(
  app: App,
  settings: CollaborationSettings,
  sourceHead: string,
  sourceTree: string,
  start: (sessionId: string, selected: App['selection']) => Promise<unknown>,
) {
  const selected = {
    ...app.selection,
    agent: { profileId: app.publisherProfile.profileId, revision: app.publisherProfile.revision },
  };
  const work = await app.api.read('studio');
  const previous = work.assignments.find((assignment) => assignment.role === 'lead')!;
  const review = await app.api.reviewRoleContext({
    itemId: 'studio',
    role: 'lead',
    sourceSnapshotIds: work.sources.map((source) => source.snapshotId),
    artifactRefs: [],
  });
  const setup = {
    version: 1 as const,
    input: {
      requestId: randomUUID(),
      itemId: 'studio',
      role: 'lead' as const,
      expectedRevision: review.selection.brief.revision,
      expectedAssignmentRevision: previous.revision,
      settings: { ...settings, selection: selected },
      contextSelection: review.selection,
    },
    presentationRef: review.presentationRef,
  };
  const receipt = await app.api.setupReviewedRole(setup);
  expect(await app.api.setupReviewedRole(setup)).toEqual(receipt);
  const current = receipt.work.assignments.find((assignment) => assignment.role === 'lead')!;
  expect(current.revision).toBe(previous.revision + 1);
  expect(current.conversation.conversationId).not.toBe(previous.conversation.conversationId);
  const publisherId = current.conversation.conversationId;
  await start(publisherId, selected);
  const external = app.publicationExternal;
  external.state.sourceHead = sourceHead;
  external.state.currentMain = app.sourceOid!;
  external.state.base = app.sourceOid!;
  external.state.sourceTree = sourceTree;
  external.state.mergeTree = sourceTree;
  external.state.reportBody = `<!-- centaur:sha:${sourceHead} -->\n## Centaur Review\nLGTM — no issues found.\n\n### Convergence\n**Recommendation:** \`merge\`\n- New blocking findings: 0\n- Unresolved blocking findings: 0\n`;
  const call = async (
    input: unknown,
    approval: 'once' | 'publication-receipt',
    beforeOnce?: () => Promise<void>,
  ) => {
    const observed = await app.nativeCall(
      publisherId,
      'RequestGithubMainPublication',
      input,
      approval,
      beforeOnce,
    );
    return {
      observed,
      body: JSON.parse(observed.result.contentItems.map((part) => part.text ?? '').join('\n')) as {
        state: string;
        mergeCommit?: string;
        inspectedMainHead?: string;
        admittedMainHead?: string;
      },
    };
  };
  const intent = () => ({
    requestId: randomUUID(),
    itemId: 'studio',
    pullRequest: 7,
    sourceHead,
    workRevision: receipt.work.revision,
  });
  let holdInstalled = false;
  external.state.prepareDispatch = async () => {
    if (holdInstalled) return;
    holdInstalled = true;
    const lifecycle = await app.api.readLifecycle('studio');
    const held = await app.api.executeLifecycle({
      operation: 'pause',
      requestId: randomUUID(),
      itemId: 'studio',
      expectedRevision: lifecycle.revision,
    });
    await app.record('actual-publication-hold-introduced-after-once-before-external-admit', {
      held,
    });
  };
  const held = await call(intent(), 'once');
  expect(holdInstalled).toBe(true);
  expect(held.body.state).toBe('denied');
  expect(external.state.mutations).toBe(0);
  expect(app.publicationReceipts.at(-1)?.approvalReceiptId).toBeUndefined();
  const paused = await app.api.readLifecycle('studio');
  const released = await app.api.executeLifecycle({
    operation: 'resume',
    requestId: randomUUID(),
    itemId: 'studio',
    expectedRevision: paused.revision,
  });
  expect(released.lifecycle?.pause.stage).toBe('running');
  external.state.prepareDispatch = async () => {};
  external.state.loseReply = true;
  const input = { ...intent(), workRevision: (await app.api.read('studio')).revision };
  const advancedMain = 'd'.repeat(40);
  const uncertain = await call(input, 'once', async () => {
    // External remote main changes while the real Once is pending. The real
    // adapter must inspect again and admit the newly observed normal-rules main.
    external.state.currentMain = advancedMain;
    external.state.base = advancedMain;
    await app.record('fake-external-main-advanced-during-actual-publication-once', {
      advancedMain,
    });
  });
  expect(uncertain.observed.result.success).toBe(false);
  expect(uncertain.body.state).toBe('uncertain');
  expect(external.state.mutations).toBe(1);
  const original = app.publicationReceipts.at(-1)!;
  expect(original.state).toBe('uncertain');
  expect(original.approvalReceiptId).toEqual(expect.any(String));
  expect(original.inspectedMainHead).toBe(app.sourceOid);
  expect(original.admittedMainHead).toBe(advancedMain);
  const permissionCalls = () =>
    app.records.filter(
      (record) =>
        record.stage === 'actual-app-http' && record.facts.path === '/api/chat/permission',
    ).length;
  const beforeRecovery = permissionCalls();
  const recovered = await call(input, 'publication-receipt');
  expect(recovered.observed.result.success).toBe(true);
  expect(recovered.body.state).toBe('accepted');
  expect(external.state.mutations).toBe(1);
  expect(permissionCalls()).toBe(beforeRecovery);
  const exact = await call(input, 'publication-receipt');
  expect(exact.body).toEqual(recovered.body);
  expect(external.state.mutations).toBe(1);
  expect(permissionCalls()).toBe(beforeRecovery);
  const durable = app.publicationReceipts.at(-1)!;
  expect(durable.pins.authority.conversationId).toBe(publisherId);
  expect(durable.pins.authority.assignmentRevision).toBe(current.revision);
  expect(durable.pins.authority.accountBinding.accountId).toBe(app.binding.accountId);
  expect(durable.pins.authority.capabilityId).toBe('s9-main-capability');
  expect(durable.approvalReceiptId).toBe(original.approvalReceiptId);
  expect(durable.admittedMainHead).toBe(advancedMain);
  const inbox = await app.api.control({ operation: 'inbox', itemId: 'studio' });
  expect(Array.isArray(inbox)).toBe(true);
  const control = Array.isArray(inbox)
    ? inbox.find((control) => control.scope === 'publication' && control.stage === 'released')
    : undefined;
  expect(control).toBeDefined();
  expect(control!.publicationRevalidation).toBe('required');
  await app.record(
    'actual-native-publication-hold-release-current-main-uncertainty-recovery-exact-receipt',
    {
      publisherId,
      previousLeadId: previous.conversation.conversationId,
      input,
      held: held.body,
      uncertain: uncertain.body,
      recovered: recovered.body,
      exact: exact.body,
      durable,
      control,
      externalMutationCount: external.state.mutations,
    },
  );
  return { input, durable, publisherId };
}
