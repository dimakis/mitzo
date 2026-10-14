import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { GoogleAuth } from 'google-auth-library';
import { ownedResponsesRuntimeFixture } from './fixtures/owned-local-responses-runtime.js';
import { OrdinaryLocalResponsesOwnedRuntime } from '../ordinary-local-responses-owned-runtime.js';
import { NativeResponsesStore } from '../native-responses-store.js';
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fixture() {
  const f = await ownedResponsesRuntimeFixture(cleanups, { gemini: true });
  const native = new NativeResponsesStore(join(f.root, 'native.db'));
  cleanups.push(() => native.close());
  const dispatch = vi.fn(async () => {});
  const create = (commandId: string = f.request.clientMsgId) => {
    const owner = new OrdinaryLocalResponsesOwnedRuntime({
      enabled: true,
      eventStore: f.events,
      library: f.library,
      workspace: f.workspace,
      reservation: f.reservation,
      nativeStore: native,
      commandId,
      operatorConnectionId: f.dependencies.operatorConnectionId,
      signal: f.signal.signal,
      env: f.dependencies.env,
      dispatch,
      dispatchContinuation: dispatch,
    });
    cleanups.push(() => owner.close());
    return owner;
  };
  return { f, native, dispatch, create };
}
it('binds Google ADC, project, region and original native thinking before admission and rejects changed continuation without a receipt', async () => {
  const { f, native, create } = await fixture();
  const owner = create();
  await expect(owner.admit(f.request)).resolves.toEqual({ dispatched: true });
  expect(
    native.readOrdinaryCustody(f.reservation.conversationId, f.reservation.binding),
  ).toMatchObject({
    credentialAuthority: { project: 'original-project', region: 'europe-west1' },
    nativeSelection: { model: 'gemini-2.5-pro', reasoningEffort: 'low' },
  });
  const changed = {
    ...f.request,
    clientMsgId: 'changed-model',
    selection: { ...f.request.selection, model: 'gemini-2.5-flash', thinking: 'high' },
  };
  await expect(owner.admitContinuation(changed)).rejects.toThrow(
    /original Gemini model and thinking/,
  );
  expect(f.events.getOrdinaryLocalResponsesCommandAdmission('changed-model')).toBeUndefined();
  expect(native.queue(f.reservation.conversationId, f.reservation.binding).queued).toEqual([
    f.request.clientMsgId,
  ]);
});
it('uses explicit parsed credentials without ambient auth and rechecks the retained ADC after asynchronous token resolution', async () => {
  const { f, create } = await fixture();
  const owner = create();
  await owner.admit(f.request);
  await owner.claimNextCommand();
  owner.assertStart(f.request.clientMsgId);
  const token = vi.spyOn(GoogleAuth.prototype, 'getAccessToken').mockImplementation(async function (
    this: GoogleAuth,
  ) {
    expect(this.jsonContent).toMatchObject({
      type: 'authorized_user',
      client_id: 'offline-client',
    });
    await writeFile(
      join(f.dependencies.privateRoot, 'google-adc.json'),
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'changed',
        client_secret: 'offline',
        refresh_token: 'offline',
      }),
      { mode: 0o600 },
    );
    return 'offline-token';
  });
  const gemini = owner.geminiOptions();
  await expect(gemini.getAccessToken()).rejects.toThrow(/credential authority unavailable/);
  expect(token).toHaveBeenCalledOnce();
});
it('retains independent repository workspace and native custody for a second Google task', async () => {
  const { f, native, create } = await fixture();
  const first = create();
  await first.admit(f.request);
  const preview = await f.workspace.preview(
    f.reservation.binding,
    'fixture-github',
    'example/repo',
    f.signal.signal,
  );
  const prepared = await f.workspace.prepare(preview.id, f.reservation.binding, f.signal.signal);
  const reservation = {
    ...f.reservation,
    id: prepared.id,
    conversationId: 'independent-google-task',
  };
  const reserved = await f.workspace.reserveHostTask({ ...reservation, signal: f.signal.signal });
  const dispatch = vi.fn(async () => {});
  const second = new OrdinaryLocalResponsesOwnedRuntime({
    enabled: true,
    eventStore: f.events,
    library: f.library,
    workspace: f.workspace,
    reservation,
    nativeStore: native,
    commandId: 'independent-command',
    operatorConnectionId: f.dependencies.operatorConnectionId,
    signal: f.signal.signal,
    env: f.dependencies.env,
    dispatch,
    dispatchContinuation: dispatch,
  });
  cleanups.push(() => second.close());
  await expect(
    second.admit({
      ...f.request,
      clientMsgId: 'independent-command',
      payload: { text: 'Independent task' },
    }),
  ).resolves.toEqual({ dispatched: true });
  const one = native.readOrdinaryCustody(f.reservation.conversationId, f.reservation.binding)!;
  const two = native.readOrdinaryCustody(reservation.conversationId, f.reservation.binding)!;
  expect(two.credentialAuthority).toEqual(one.credentialAuthority);
  expect(two.binding).toEqual(one.binding);
  expect(two.workspace).toEqual({ workspaceId: reservation.id, cwd: reserved.directory });
  expect(two.workspace.workspaceId).not.toBe(one.workspace.workspaceId);
  expect(two.workspace.cwd).not.toBe(one.workspace.cwd);
  expect(native.queue(f.reservation.conversationId, f.reservation.binding).queued).toEqual([
    f.request.clientMsgId,
  ]);
  expect(native.queue(reservation.conversationId, f.reservation.binding).queued).toEqual([
    'independent-command',
  ]);
});
it('refuses cold credential replacement before a new command receipt', async () => {
  const { f, create } = await fixture();
  const first = create();
  await first.admit(f.request);
  first.close();
  await writeFile(
    join(f.dependencies.privateRoot, 'google-adc.json'),
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'changed',
      client_secret: 'offline',
      refresh_token: 'offline',
    }),
    { mode: 0o600 },
  );
  expect(() => create('cold')).toThrow(/credential authority unavailable/);
  expect(f.events.getOrdinaryLocalResponsesCommandAdmission('cold')).toBeUndefined();
});
it('refuses a different original-login subject on cold admission without changing native custody', async () => {
  const { f, native, create } = await fixture();
  const first = create();
  await first.admit(f.request);
  first.close();
  const { bindAgentLibraryTransport } = await import('../agent-library-transport.js');
  const detach = bindAgentLibraryTransport('other-operator', { ...f.auth, id: 'other-login' });
  cleanups.push(detach);
  const other = new OrdinaryLocalResponsesOwnedRuntime({
    enabled: true,
    eventStore: f.events,
    library: f.library,
    workspace: f.workspace,
    reservation: f.reservation,
    nativeStore: native,
    commandId: 'wrong-cold',
    operatorConnectionId: 'other-operator',
    signal: f.signal.signal,
    env: f.dependencies.env,
    dispatch: vi.fn(async () => {}),
    dispatchContinuation: vi.fn(async () => {}),
  });
  cleanups.push(() => other.close());
  const before = native.readOrdinaryCustody(f.reservation.conversationId, f.reservation.binding);
  await expect(other.admitResume({ ...f.request, clientMsgId: 'wrong-cold' })).rejects.toThrow(
    /unavailable/,
  );
  expect(f.events.getOrdinaryLocalResponsesCommandAdmission('wrong-cold')).toBeUndefined();
  expect(native.readOrdinaryCustody(f.reservation.conversationId, f.reservation.binding)).toEqual(
    before,
  );
});
it('stops future Gemini admission when the original signed login is revoked', async () => {
  const { f, native, create } = await fixture();
  const owner = create();
  await owner.admit(f.request);
  const before = native.readOrdinaryCustody(f.reservation.conversationId, f.reservation.binding);
  const { revokeAuthSession } = await import('../auth.js');
  revokeAuthSession(f.auth);
  await expect(
    owner.admitContinuation({ ...f.request, clientMsgId: 'revoked-command' }),
  ).rejects.toThrow(/unavailable|revoked|aborted/);
  expect(f.events.getOrdinaryLocalResponsesCommandAdmission('revoked-command')).toBeUndefined();
  expect(native.readOrdinaryCustody(f.reservation.conversationId, f.reservation.binding)).toEqual(
    before,
  );
});
it.each(['GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT'])(
  'rejects ambient %s without authenticating or allocating another receipt',
  async (key) => {
    const { f, create } = await fixture();
    const owner = create();
    await owner.admit(f.request);
    await owner.claimNextCommand();
    owner.assertStart(f.request.clientMsgId);
    const token = vi.spyOn(GoogleAuth.prototype, 'getAccessToken').mockResolvedValue('offline');
    const gemini = owner.geminiOptions();
    vi.stubEnv(key, 'ambient-other-project');
    await expect(gemini.getAccessToken()).rejects.toThrow();
    expect(token).not.toHaveBeenCalled();
    await expect(
      owner.admitContinuation({ ...f.request, clientMsgId: 'ambient-command' }),
    ).rejects.toThrow();
    expect(f.events.getOrdinaryLocalResponsesCommandAdmission('ambient-command')).toBeUndefined();
  },
);
