import { afterEach, expect, it, vi } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ownedVertexRuntimeFixture } from './fixtures/owned-local-vertex-runtime.js';
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
