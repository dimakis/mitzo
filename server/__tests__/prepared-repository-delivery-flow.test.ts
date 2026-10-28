import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { preparedRepositoryDeliveryFlow } from './fixtures/prepared-repository-delivery-flow.js';

it('recovers exact original delivery after adoption, then accepts repeated explicit prompts and a lost-response continuation without replay', async () => {
  const f = await preparedRepositoryDeliveryFlow();
  const nativeBefore = f.f.native.commands(f.sessionId, f.binding);
  f.store.getState().selectLocalCommandSession(f.sessionId);
  await vi.waitFor(() =>
    expect(f.requests.some((request) => request.path.endsWith('/receipt'))).toBe(true),
  );
  expect(f.requests[0], JSON.stringify(f.requests)).toMatchObject({
    path: '/api/chat/local-codex/send/receipt',
    body: f.originalBody,
    status: 202,
  });
  await vi.waitFor(() => expect(f.store.getState().localCommand?.state).toBe('consumed'));
  expect(f.saved()).toEqual([]);
  expect(f.f.native.commands(f.sessionId, f.binding)).toEqual(nativeBefore);
  expect(
    f.f.events.observePreparedRepositoryCommandRouting(f.originalBody.clientMsgId, true)
      ?.originalAdmission,
  ).toEqual(f.originalReceipt);
  expect(f.store.getState().localCommand?.composerDraft).toEqual({
    storageKey: 'original-composer',
    revisionToken: 'submitted-revision',
  });
  for (const id of ['later-prompt', 'lost-response-prompt', 'another-later-prompt']) {
    const delivered = vi.fn();
    if (id === 'lost-response-prompt') f.loseNextResponse();
    expect(
      f.store.getState().sendLocalFirstCommand(
        {
          ...f.originalBody,
          sessionId: f.sessionId,
          repositoryWorkspaceId: f.adopted.id,
          clientMsgId: id,
          payload: { text: id },
        },
        { onDelivery: delivered },
      ),
    ).toBe(true);
    await f.complete(id);
    if (id === 'lost-response-prompt') {
      await vi.waitFor(() => expect(f.store.getState().localCommand?.state).toBe('uncertain'));
      f.reconnect();
    }
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith('accepted'));
    expect(f.saved()).toEqual([]);
    expect(
      f.requests.filter(
        (request) => request.body.clientMsgId === id && !request.path.endsWith('/receipt'),
      ),
    ).toHaveLength(1);
  }
}, 420000);

it.each([false, true])(
  'admits a deliberately retried never-admitted stale-workspace prompt through canonical adoption after capability deployment=%s without rewriting its frozen browser body',
  async (changedCatalog) => {
    const f = await preparedRepositoryDeliveryFlow({ unadmittedStaleWorkspace: true });
    const { capturePostAdoptionWire } = await import('../post-adoption-wire-admission.js');
    const captured = capturePostAdoptionWire(f.f.events, f.pendingBody, f.f.auth.id);
    expect(captured.target.executionWorkspace.workspaceId).toBe(f.adopted.id);
    expect(captured.knownCapability).toBe(true);
    if (changedCatalog) {
      const { OrdinaryLocalCodexCapabilityCatalog } =
        await import('../ordinary-local-codex-capabilities.js');
      const read = OrdinaryLocalCodexCapabilityCatalog.prototype.inventory;
      vi.spyOn(OrdinaryLocalCodexCapabilityCatalog.prototype, 'inventory').mockImplementation(
        function (this: InstanceType<typeof OrdinaryLocalCodexCapabilityCatalog>) {
          return { ...read.call(this), capabilityRevision: 'new-deployment-capability-revision' };
        },
      );
      const nativeBeforeRefusals = f.f.native.commands(f.sessionId, f.binding);
      const launchesBeforeRefusals = f.launch.mock.calls.length;
      for (const [index, changes] of [
        { capabilityRevision: 'unproven-historical-capability' },
        { repositoryWorkspaceId: randomUUID() },
        { sessionId: 'foreign-conversation' },
        { runtime: { ...f.pendingBody.runtime, targetId: 'foreign-target' } },
        {
          runtime: {
            ...f.pendingBody.runtime,
            account: { ...f.pendingBody.runtime.account, profileRevision: 'foreign-profile' },
          },
        },
        {
          selection: {
            ...f.pendingBody.selection,
            agent: { ...f.pendingBody.selection.agent, revision: 999 },
          },
        },
        {
          selection: {
            ...f.pendingBody.selection,
            context: { source: 'workspace', revision: 'foreign' },
          },
        },
        {
          runtime: { ...f.pendingBody.runtime, mode: 'auto' },
          selection: {
            ...f.pendingBody.selection,
            permission: { ...f.pendingBody.selection.permission, mode: 'auto' },
          },
        },
        { selection: { ...f.pendingBody.selection, model: 'unavailable-current-model' } },
        { selection: { ...f.pendingBody.selection, thinking: 'unavailable-current-effort' } },
      ].entries()) {
        const body = { ...f.pendingBody, ...changes, clientMsgId: `refused-stale-wire-${index}` };
        const response = await f.post('/api/chat/local-codex/continue', body);
        expect(response.status, `refusal ${index}: ${JSON.stringify(response.body)}`).toBe(409);
        expect(f.f.events.getSendCommand(body.clientMsgId)).toBeUndefined();
        expect(f.f.native.commands(f.sessionId, f.binding)).toEqual(nativeBeforeRefusals);
        expect(f.launch).toHaveBeenCalledTimes(launchesBeforeRefusals);
      }
    }
    const wire = structuredClone(f.pendingBody);
    const nativeBefore = f.f.native.commands(f.sessionId, f.binding);
    expect(f.f.events.getSendCommand(f.pendingBody.clientMsgId)).toBeUndefined();
    f.store.getState().selectLocalCommandSession(f.sessionId);
    await vi.waitFor(() =>
      expect(f.requests.some((request) => request.path.endsWith('/receipt'))).toBe(true),
    );
    expect(f.requests[0]).toMatchObject({
      path: '/api/chat/local-codex/continue/receipt',
      status: 409,
    });
    expect(f.f.native.commands(f.sessionId, f.binding)).toEqual(nativeBefore);
    expect(f.store.getState().localCommand?.state).toBe('uncertain');
    if (changedCatalog) f.loseNextResponse();
    expect(f.store.getState().recoverLocalCommand()).toBe(true);
    await vi.waitFor(
      () => expect(f.requests.some((request) => !request.path.endsWith('/receipt'))).toBe(true),
      { timeout: 30000 },
    );
    expect(
      f.requests.find((request) => !request.path.endsWith('/receipt')),
      JSON.stringify(f.requests),
    ).toMatchObject({ path: '/api/chat/local-codex/continue', status: 202 });
    for (const request of f.requests) expect(request.body).toEqual(wire);
    expect(
      f.f.events.observePostAdoptionWireAdmission(
        f.pendingBody.clientMsgId,
        (await import('../post-adoption-wire-admission.js')).ordinaryWireFingerprint(wire),
      ),
    ).toMatchObject({ bridge: { executionWorkspace: { workspaceId: f.adopted.id } } });
    await f.complete(f.pendingBody.clientMsgId);
    if (changedCatalog) {
      await vi.waitFor(() => expect(f.store.getState().localCommand?.state).toBe('uncertain'));
      f.reconnect();
    }
    await vi.waitFor(() => expect(f.store.getState().localCommand?.state).toBe('consumed'));
    expect(f.f.events.getSendCommand(f.pendingBody.clientMsgId)?.sessionId).toBe(f.sessionId);
    expect(f.saved()).toEqual([]);
    const nativeAfter = f.f.native.commands(f.sessionId, f.binding);
    expect((await f.post('/api/chat/local-codex/continue', f.pendingBody)).status).toBe(202);
    expect(
      (
        await f.post('/api/chat/local-codex/continue/receipt', {
          ...f.pendingBody,
          payload: { text: 'changed wire' },
        })
      ).status,
    ).toBe(409);
    expect(f.f.native.commands(f.sessionId, f.binding)).toEqual(nativeAfter);
  },
  420000,
);

it('recovers an exact already bridged command only while its earlier attempt never crossed the native dispatch boundary', async () => {
  const f = await preparedRepositoryDeliveryFlow({ unadmittedStaleWorkspace: true });
  const { OrdinaryLocalCodexOwnedRuntime } =
    await import('../ordinary-local-codex-owned-runtime.js');
  const { cleanups } = await import('./fixtures/prepared-repository-native-consumer.js');
  const { capturePostAdoptionWire, ordinaryWireFingerprint } =
    await import('../post-adoption-wire-admission.js');
  const events = f.chat.eventStore;
  const captured = capturePostAdoptionWire(events, f.pendingBody, f.f.auth.id);
  const request = {
    clientMsgId: f.pendingBody.clientMsgId,
    capabilityRevision: f.pendingBody.capabilityRevision,
    runtime: f.pendingBody.runtime,
    selection: f.pendingBody.selection,
    payload: f.pendingBody.payload,
  };
  const dispatch = vi.fn(async () => {
    throw Error('Offline interruption before native enqueue');
  });
  const cold = new OrdinaryLocalCodexOwnedRuntime({
    ...f.f.dependencies,
    eventStore: events,
    nativeStore: f.f.native,
    commandId: request.clientMsgId,
    reservation: { ...f.f.reservation, id: f.adopted.id },
    launch: () => ({ ...f.f.rpc, close: vi.fn() }),
    dispatch,
  });
  cleanups.push(() => cold.close());
  await expect(
    events.withOrdinaryCommandWireAdmission(
      {
        sessionId: f.sessionId,
        commandId: request.clientMsgId,
        wireFingerprint: ordinaryWireFingerprint(f.pendingBody),
        bridge: captured.target,
      },
      captured.assertCurrentSync,
      () => cold.admitResume(request),
    ),
  ).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledOnce();
  cold.close();
  const originalReceipt = structuredClone(
    events.getOrdinaryLocalCommandExecutionAdmission(request.clientMsgId),
  );
  expect(originalReceipt?.state).toBe('uncertain');
  expect(f.f.native.commandStatus(f.sessionId, f.binding, request.clientMsgId)).toBeUndefined();
  expect(
    events.observePostAdoptionWireAdmission(
      request.clientMsgId,
      ordinaryWireFingerprint(f.pendingBody),
    ),
  ).toBeDefined();
  const before = f.f.native.commands(f.sessionId, f.binding);
  expect((await f.post('/api/chat/local-codex/continue/receipt', f.pendingBody)).status).toBe(409);
  expect(f.f.native.commands(f.sessionId, f.binding)).toEqual(before);
  const resumed = await f.post('/api/chat/local-codex/continue', f.pendingBody);
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(202);
  await f.complete(request.clientMsgId);
  expect(events.getOrdinaryLocalCommandExecutionAdmission(request.clientMsgId)).toEqual({
    ...originalReceipt,
    state: 'consumed',
  });
  expect(
    f.f.native
      .commands(f.sessionId, f.binding)
      .filter((command) => command.id === request.clientMsgId),
  ).toHaveLength(1);
}, 420000);
