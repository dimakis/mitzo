import { afterEach, expect, it } from 'vitest';
import { createS9Fixture, cleanupS9Fixtures } from './fixture.js';
import { resolveTelosWorkRoleContext } from '../../../server/telos-work-role-context.js';

afterEach(cleanupS9Fixtures);

it('CT17 partial: canonical source -> mounted HTTP -> typed client -> silent independent lead and immutable restart receipt', async () => {
  const f = await createS9Fixture();
  const reviewed = await f.captureSource();
  const canonical = await f.api.readRecord('outcome');
  expect(canonical).toMatchObject({
    itemId: 'outcome',
    parentId: 'goal',
    profile: 'manual',
    status: 'active',
    intent: 'Keep the reviewed plan',
  });
  expect((await f.api.read('outcome')).links).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'origin',
        conversation: { namespace: 'mitzo', conversationId: 'source' },
      }),
    ]),
  );
  const contextSelection = await f.api.roleContext({
    itemId: 'outcome',
    role: 'lead',
    sourceSnapshotIds: [reviewed.snapshotId],
    artifactRefs: [f.materialPin],
  });
  expect(contextSelection.overallGoal).toMatchObject({
    itemId: 'goal',
    text: 'Deliver the reviewed outcome',
  });
  expect(contextSelection.parentCriteria).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ itemId: 'goal', criteria: ['Independent review recorded'] }),
    ]),
  );
  expect(contextSelection.sources).toHaveLength(1);
  expect(contextSelection.sources[0].snapshotId).toBe(reviewed.snapshotId);
  const input = {
    itemId: 'outcome',
    role: 'lead' as const,
    requestId: 'lead-operation',
    expectedRevision: contextSelection.brief.revision,
    expectedAssignmentRevision: 0,
    settings: f.ordinary.input.settings,
    contextSelection,
  };
  const receipt = await f.api.setupRole(input);
  const leadId = receipt.work.assignments[0].conversation.conversationId;
  expect(leadId).not.toBe('source');
  expect(receipt.work.attempts).toEqual([]);
  expect(f.events.getOrdinaryInitialCommandId(leadId)).toBeUndefined();
  expect(f.events.getSession(leadId)?.cwd).not.toBe(f.events.getSession('source')?.cwd);
  const retained = resolveTelosWorkRoleContext(
    f.events,
    leadId,
    f.events.getSession(leadId)!.accountBinding!,
  );
  expect(retained).toEqual(contextSelection);
  const sourceBefore = await f.api.readSource('outcome', reviewed.snapshotId);
  expect(sourceBefore.snapshot.source).toEqual({ namespace: 'mitzo', conversationId: 'source' });
  expect(JSON.stringify(sourceBefore.packet.context)).toContain('Keep exactly this reviewed plan.');
  f.events.append('source', 'user_message', {
    messageId: 'later',
    text: 'Later discussion is not adopted',
  });
  f.replaceMaterial();
  f.changeBrief();
  f.restart();
  f.ordinary.resolvePreparation.mockClear();
  expect(await f.api.setupRole(input)).toEqual(receipt);
  expect(f.ordinary.resolvePreparation).not.toHaveBeenCalled();
  expect(f.events.listSessions()).toHaveLength(2);
  expect(await f.api.readSource('outcome', reviewed.snapshotId)).toEqual(sourceBefore);
  expect(f.readMaterial()).toBe('Original retained plan');
  expect((await f.api.read('outcome')).attempts).toEqual([]);
  expect((await f.api.read('child')).attempts).toEqual([]);
  expect((await f.api.read('sibling')).attempts).toEqual([]);
  expect(f.canonicalStatus('outcome')).toBe('active');
});

it('CT17 partial: definite stale context is rejected by actual HTTP/client before ordinary allocation', async () => {
  const f = await createS9Fixture();
  const contextSelection = await f.api.roleContext({
    itemId: 'outcome',
    role: 'lead',
    sourceSnapshotIds: [],
    artifactRefs: [],
  });
  f.changeBrief();
  await expect(
    f.api.setupRole({
      itemId: 'outcome',
      role: 'lead',
      requestId: 'stale',
      expectedRevision: contextSelection.brief.revision,
      expectedAssignmentRevision: 0,
      settings: f.ordinary.input.settings,
      contextSelection,
    }),
  ).rejects.toMatchObject({ status: 409, code: 'conflict' });
  expect(f.ordinary.resolvePreparation).not.toHaveBeenCalled();
  expect(f.events.listSessions()).toHaveLength(1);
});

it('CT17 partial: lost committed HTTP response replays exactly after restart; changed input conflicts without allocation', async () => {
  const f = await createS9Fixture();
  const contextSelection = await f.api.roleContext({
    itemId: 'outcome',
    role: 'lead',
    sourceSnapshotIds: [],
    artifactRefs: [],
  });
  const input = {
    itemId: 'outcome',
    role: 'lead' as const,
    requestId: 'lost-response',
    expectedRevision: contextSelection.brief.revision,
    expectedAssignmentRevision: 0,
    settings: f.ordinary.input.settings,
    contextSelection,
  };
  f.loseNextSetupResponse();
  await expect(f.api.setupRole(input)).rejects.toThrow('synthetic response loss after commit');
  const first = await f.api.read('outcome');
  f.restart();
  const replay = await f.api.setupRole(input);
  expect(replay.work).toEqual(first);
  await expect(
    f.api.setupRole({
      ...input,
      settings: { ...input.settings, selection: { ...input.settings.selection, thinking: 'high' } },
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(f.events.listSessions()).toHaveLength(2);
  expect((await f.api.read('outcome')).assignments).toHaveLength(1);
});

it('CT18 partial: fresh Symposium allocation and Telos role setup share owners but retain separate workspaces, contexts and receipts', async () => {
  const f = await createS9Fixture();
  const contextSelection = await f.api.roleContext({
    itemId: 'outcome',
    role: 'lead',
    sourceSnapshotIds: [],
    artifactRefs: [],
  });
  const lead = await f.api.setupRole({
    itemId: 'outcome',
    role: 'lead',
    requestId: 'lead',
    expectedRevision: contextSelection.brief.revision,
    expectedAssignmentRevision: 0,
    settings: f.ordinary.input.settings,
    contextSelection,
  });
  const leadId = lead.work.assignments[0].conversation.conversationId;
  const joiningInput = f.joiningInput(await f.independentSettings());
  const joined = await f.ordinary
    .owner()
    .confirm('s9-offline-operator', f.ordinary.group, joiningInput, f.ordinary.signal);
  const memberId = joined.sessionId!;
  expect(memberId).not.toBe(leadId);
  expect(f.events.getSession(memberId)?.cwd).not.toBe(f.events.getSession(leadId)?.cwd);
  expect(
    resolveTelosWorkRoleContext(f.events, memberId, f.events.getSession(memberId)!.accountBinding!),
  ).toBeUndefined();
  expect(await f.api.links({ namespace: 'mitzo', conversationId: memberId })).toEqual([]);
  expect(f.events.getOrdinaryInitialCommandId(memberId)).toBeUndefined();
  f.restart();
  expect(
    await f.ordinary
      .owner()
      .confirm('s9-offline-operator', f.ordinary.group, joiningInput, f.ordinary.signal),
  ).toEqual(joined);
  expect((await f.api.read('outcome')).assignments[0].conversation.conversationId).toBe(leadId);
  expect(f.events.listSessions()).toHaveLength(3);
});
