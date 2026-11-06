import { afterEach, expect, it, vi } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ownedVertexRuntimeFixture } from './fixtures/owned-local-vertex-runtime.js';
import { ClaudeSubscriptionCustody } from '../claude-subscription-custody.js';
vi.mock('../claude-account-history.js', () => ({
  readClaudeAccountHistory: vi.fn(async (sessionId: string, cwd: string) => ({
    info: { sessionId, cwd },
    messages: [{ type: 'user', uuid: 'retained' }],
  })),
}));
import {
  OrdinaryLocalVertexOwnedRuntime,
  type OrdinaryLocalVertexOwnedDispatch,
} from '../ordinary-local-vertex-owned-runtime.js';
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  getSessionInfo: vi.fn(async (id: string, options: { dir: string }) => ({
    sessionId: id,
    cwd: options.dir,
    summary: 'Offline SDK history',
    lastModified: 1,
  })),
  getSessionMessages: vi.fn(async () => [
    { type: 'user', uuid: 'original-input', message: { role: 'user', content: 'retained input' } },
  ]),
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('shares admission, follow-ups and cold SDK continuation with a personal subscription and blocks lost sign-in', async () => {
  const f = await ownedVertexRuntimeFixture(cleanups, { personal: true });
  const capture = ClaudeSubscriptionCustody.capture;
  vi.spyOn(ClaudeSubscriptionCustody, 'capture').mockImplementation((env) =>
    capture(env, f.personalExecutable),
  );
  const verify = vi.spyOn(ClaudeSubscriptionCustody.prototype, 'verify').mockResolvedValue();
  const dispatch = vi.fn<(input: OrdinaryLocalVertexOwnedDispatch) => Promise<void>>(
    async () => {},
  );
  const create = (commandId = f.request.clientMsgId) => {
    const owner = new OrdinaryLocalVertexOwnedRuntime({
      enabled: true,
      eventStore: f.events,
      library: f.library,
      workspace: f.workspace,
      reservation: f.reservation,
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
  const owner = create();
  await expect(owner.admit(f.request)).resolves.toEqual({ dispatched: true });
  const custody = f.events.getOrdinaryLocalVertexCustody(f.reservation.conversationId)!;
  expect(custody.binding.account.provider).toBe('anthropic-claude');
  expect(custody.credentialAuthority).toMatchObject({
    kind: 'claude-host-login',
    email: 'person@example.test',
  });
  await expect(owner.admitContinuation({ ...f.request, clientMsgId: 'next' })).resolves.toEqual({
    dispatched: true,
  });
  owner.commandTerminal('next');
  owner.close();
  await expect(create('cold').admitResume({ ...f.request, clientMsgId: 'cold' })).resolves.toEqual({
    dispatched: true,
  });
  expect(f.events.getOrdinaryLocalVertexCustody(f.reservation.conversationId)).toEqual(custody);
  verify.mockRejectedValue(new Error('Claude subscription sign-in unavailable'));
  await expect(
    create('revoked').admitResume({ ...f.request, clientMsgId: 'revoked' }),
  ).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledTimes(3);
  expect(f.events.getSendCommand('revoked')).toBeUndefined();
});
async function fixture() {
  const f = await ownedVertexRuntimeFixture(cleanups);
  const dispatch = vi.fn<(input: OrdinaryLocalVertexOwnedDispatch) => Promise<void>>(
    async () => {},
  );
  const create = (commandId: string = f.request.clientMsgId) => {
    const owner = new OrdinaryLocalVertexOwnedRuntime({
      enabled: true,
      eventStore: f.events,
      library: f.library,
      workspace: f.workspace,
      reservation: f.reservation,
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
  return { f, dispatch, create };
}
it('uses the existing independent repository claim and immutable SDK/account/ADC custody across future and cold commands', async () => {
  const { f, create, dispatch } = await fixture();
  const owner = create();
  await expect(owner.admit(f.request)).resolves.toEqual({ dispatched: true });
  const custody = f.events.getOrdinaryLocalVertexCustody(f.reservation.conversationId);
  expect(custody?.binding.account.provider).toBe('anthropic-vertex');
  expect(custody?.sdkSessionId).toBe(f.reservation.conversationId);
  expect(custody?.authSessionId).toBe(f.auth.id);
  expect(dispatch.mock.calls[0][0].binding).toEqual(f.reservation.binding);
  const directory = dispatch.mock.calls[0][0].workspace.directory!;
  await writeFile(join(directory, 'retained.txt'), 'retained task edit');
  const next = {
    ...f.request,
    clientMsgId: 'future',
    selection: { ...f.request.selection, model: 'next-model', thinking: 'high' },
  };
  await expect(owner.admitContinuation(next)).resolves.toEqual({ dispatched: true });
  expect(f.events.getOrdinaryLocalVertexCustody(f.reservation.conversationId)).toEqual(custody);
  owner.commandTerminal('future');
  owner.close();
  const cold = create('cold');
  await expect(cold.admitResume({ ...next, clientMsgId: 'cold' })).resolves.toEqual({
    dispatched: true,
  });
  expect(await readFile(join(directory, 'retained.txt'), 'utf8')).toBe('retained task edit');
  expect(f.events.getOrdinaryLocalVertexCustody(f.reservation.conversationId)).toEqual(custody);
});
it('refuses changed ADC bytes and stale future settings without new workspace or provider dispatch', async () => {
  const { f, create, dispatch } = await fixture();
  const owner = create();
  await owner.admit(f.request);
  await writeFile(
    f.configuration[0].credentialRef,
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'offline',
      client_secret: 'offline',
      refresh_token: 'replacement',
    }),
    { mode: 0o600 },
  );
  await expect(owner.admitContinuation({ ...f.request, clientMsgId: 'changed' })).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(f.events.getSendCommand('changed')).toBeUndefined();
});
it('adopts the code-owned plain builtin through existing Library authority rather than the user namespace', async () => {
  const { PROFILE_BUILDER_ID, PROFILE_BUILDER_REVISION } = await import('@mitzo/protocol');
  const { f, create, dispatch } = await fixture();
  const request = {
    ...f.request,
    selection: {
      ...f.request.selection,
      agent: {
        kind: 'builtin' as const,
        profileId: PROFILE_BUILDER_ID,
        revision: PROFILE_BUILDER_REVISION,
      },
    },
  };
  await expect(create().admit(request)).resolves.toEqual({ dispatched: true });
  expect(dispatch.mock.calls[0][0].expected.selection.agent).toEqual(request.selection.agent);
  expect(dispatch.mock.calls[0][0].payload.systemPrompt).toContain('Profile');
  expect(f.events.getSession(f.reservation.conversationId)?.agentProfile).toMatchObject(
    request.selection.agent,
  );
});
