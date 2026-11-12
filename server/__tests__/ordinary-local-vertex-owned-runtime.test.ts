import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SkillRegistry } from '../skills.js';
import * as registries from '../skill-registry-runtime.js';
import { assembleCommandPrompt } from '../message-reply-context.js';
import { ownedVertexRuntimeFixture } from './fixtures/owned-local-vertex-runtime.js';
import { ClaudeSubscriptionCustody } from '../claude-subscription-custody.js';
import { revokeAuthSession } from '../auth.js';
import { captureAgentLibraryAuthorization } from '../agent-library-transport.js';
import { OrdinaryLocalCodexSelectionOwner } from '../ordinary-local-codex-selection-owner.js';
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
beforeEach(resetOfflineUserEnvironment);
const cleanups: Array<() => void | Promise<void>> = [];
const apiKeychain = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../keychain-rotation-credentials.js', () => ({
  KeychainRotationCredentials: class {
    read = apiKeychain.read;
  },
}));
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('consumes an exact silent preparation on the first explicit SDK command without fresh-session adoption or duplicate dispatch', async () => {
  const fingerprint = 'a'.repeat(64);
  const f = await ownedVertexRuntimeFixture(cleanups, { preparationFingerprint: fingerprint });
  const catalog = (
    await import('../ordinary-local-vertex-capabilities.js')
  ).localVertexCapabilities(
    (await import('../account-profiles.js')).loadAccountProfiles(),
    new (await import('../ordinary-local-vertex-capabilities.js')).OrdinaryLocalVertexTarget(
      f.dependencies.env,
    ),
    [f.agentProfile],
  );
  const resolved = catalog.resolve(f.request.runtime);
  expect(resolved.status).toBe('compatible');
  if (resolved.status !== 'compatible') throw Error('Offline SDK fixture unavailable');
  const meta = {
    sessionId: f.reservation.conversationId,
    repositoryWorkspaceId: f.reservation.id,
    cwd: f.reserved.directory!,
    accountBinding: f.reservation.binding,
    agentProfile: f.agentProfile,
    selectedModel: f.request.selection.model,
    reasoningEffort: f.request.selection.thinking,
    mode: 'agent' as const,
  };
  f.events.prepareOrdinarySession(meta, {
    allocationOperationId: 'silent-sdk',
    preparationFingerprint: fingerprint,
    settings: {
      binding: resolved.binding,
      selection: f.request.selection,
      repositoryWorkspaceId: f.reservation.id,
    },
  });
  expect(f.events.getSessionEvents(meta.sessionId)).toEqual([]);
  expect(f.events.getOrdinaryInitialCommandId(meta.sessionId)).toBeUndefined();
  const dispatch = vi.fn(async () => {});
  const owner = new OrdinaryLocalVertexOwnedRuntime({
    enabled: true,
    eventStore: f.events,
    library: f.library,
    workspace: f.workspace,
    reservation: f.reservation,
    commandId: f.request.clientMsgId,
    preparationOperationId: 'silent-sdk',
    operatorConnectionId: f.dependencies.operatorConnectionId,
    signal: f.signal.signal,
    env: f.dependencies.env,
    dispatch,
    dispatchContinuation: dispatch,
  });
  cleanups.push(() => owner.close());
  await expect(owner.admit(f.request)).resolves.toEqual({ dispatched: true });
  await expect(owner.admit(f.request)).resolves.toEqual({ dispatched: false });
  expect(dispatch).toHaveBeenCalledOnce();
  expect(f.events.getOrdinarySessionPreparation('silent-sdk')!.firstCommandId).toBe(
    f.request.clientMsgId,
  );
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
async function fixture(options: Parameters<typeof ownedVertexRuntimeFixture>[1] = {}) {
  const f = await ownedVertexRuntimeFixture(cleanups, options);
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
it('continues admitted SDK effects after login expiry while rejecting new client authority and revocation', async () => {
  const { f, create } = await fixture();
  vi.useFakeTimers();
  const owner = create();
  await owner.admit(f.request);
  await vi.advanceTimersByTimeAsync(60001);
  expect(owner.signal.aborted).toBe(false);
  await expect(owner.assertEffect(f.request.clientMsgId)).resolves.toBeUndefined();
  expect(() => captureAgentLibraryAuthorization(f.dependencies.operatorConnectionId)).toThrow();
  revokeAuthSession(f.auth);
  expect(owner.signal.aborted).toBe(true);
  await expect(owner.assertEffect(f.request.clientMsgId)).rejects.toThrow();
});
it('admits Messages accounts and blocks continuation after Keychain version drift', async () => {
  const { f, create, dispatch } = await fixture({ anthropicApi: true });
  apiKeychain.read.mockResolvedValue({
    value: 'offline-api-key',
    version: 'eec02914-ac1f-4369-ab86-8e4f130abc92',
    managed: true,
  });
  const owner = create();
  await expect(owner.admit(f.request)).resolves.toEqual({ dispatched: true });
  const custody = f.events.getOrdinaryLocalVertexCustody(f.reservation.conversationId)!;
  expect(custody.credentialAuthority).toMatchObject({
    kind: 'anthropic-api-key',
    credentialVersion: 'eec02914-ac1f-4369-ab86-8e4f130abc92',
  });
  expect(JSON.stringify(custody)).not.toContain('offline-api-key');
  owner.commandTerminal(f.request.clientMsgId);
  await expect(
    owner.admitContinuation({ ...f.request, clientMsgId: 'messages-next' }),
  ).resolves.toEqual({ dispatched: true });
  owner.commandTerminal('messages-next');
  apiKeychain.read.mockResolvedValue({
    value: 'replacement',
    version: 'eec02914-ac1f-4369-ab86-8e4f130abc93',
    managed: true,
  });
  await expect(
    owner.admitContinuation({ ...f.request, clientMsgId: 'messages-revoked' }),
  ).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(f.events.getSendCommand('messages-revoked')).toBeUndefined();
});
it('rechecks the exact peer sender guard after asynchronous selection and before durable continuation admission', async () => {
  const { f, create, dispatch } = await fixture();
  const owner = create();
  await owner.admit(f.request);
  owner.commandTerminal(f.request.clientMsgId);
  let allowed = true;
  const original = OrdinaryLocalCodexSelectionOwner.prototype.assertCurrent;
  vi.spyOn(OrdinaryLocalCodexSelectionOwner.prototype, 'assertCurrent').mockImplementation(
    async function (this: OrdinaryLocalCodexSelectionOwner, expected) {
      await original.call(this, expected);
      allowed = false;
    },
  );
  const guard = () => {
    if (!allowed) throw Error('Peer sender revoked');
  };
  await expect(
    owner.admitContinuation({ ...f.request, clientMsgId: 'revoked-peer' }, f.signal.signal, guard),
  ).rejects.toThrow('authority_unavailable');
  expect(f.events.getSendCommand('revoked-peer')).toBeUndefined();
  expect(dispatch).toHaveBeenCalledOnce();
});

it('freezes SDK skill input before first admission and retains it for later and cold dispatch', async () => {
  const { f, create, dispatch } = await fixture({ chatRoute: true });
  vi.spyOn(registries, 'buildSkillRegistry').mockReturnValue(
    new SkillRegistry({ bundledDir: join(process.cwd(), 'skills') }),
  );
  f.request.payload.text = '/mockup SDK dashboard';
  const owner = create();
  await owner.admit(f.request);
  const check = (id: string) => {
    const snapshot = dispatch.mock.calls.at(-1)![0];
    expect(snapshot.payload.text).toBe('/mockup SDK dashboard');
    expect(f.events.getOrdinarySkillContext(f.reservation.conversationId, id)?.prompt).toContain(
      'Create or refine a clickable mockup for SDK dashboard',
    );
    expect(
      assembleCommandPrompt(f.events, f.reservation.conversationId, id, snapshot.payload),
    ).toContain('Create or refine a clickable mockup for SDK dashboard');
  };
  check(f.request.clientMsgId);
  owner.commandTerminal(f.request.clientMsgId);
  await owner.admitContinuation({ ...f.request, clientMsgId: 'sdk-next' });
  check('sdk-next');
  owner.commandTerminal('sdk-next');
  owner.close();
  await create('sdk-cold').admitResume({ ...f.request, clientMsgId: 'sdk-cold' });
  check('sdk-cold');
});
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
  const adcPath = f.configuration[0].credentialRef;
  if (typeof adcPath !== 'string') throw Error('Expected the ADC fixture');
  await writeFile(
    adcPath,
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
