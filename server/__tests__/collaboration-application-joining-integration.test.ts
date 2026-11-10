import { afterAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CollaborationApiClient, MitzoApiClient } from '@mitzo/client';
import { CollaborationSnapshotSchema, CollaborationSettingsSchema } from '@mitzo/protocol';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
const journey = createApplicationJourney();
const { state, loadApplication, restartApplication } = journey;
afterAll(() => journey.close());
it('reviews an actual prepared unused Local workspace through real app auth and survives the same-session restart without capacity', async () => {
  await loadApplication();
  state.events.upsertSession({ sessionId: 'existing-chat', conversationSource: 'mitzo' });
  const sourceBoundary = state.events.append('existing-chat', 'user_message', {
    messageId: 'selected-source',
    text: 'Synthetic design requirement',
    privateProviderIdentity: 'DO_NOT_LEAK',
  });
  const path = `/api/session-collaborations/${state.group}`;
  expect((await state.http!.request('GET', path + '/conversation')).status).toBe(401);
  const beginInput = { requestId: crypto.randomUUID(), sessionId: 'existing-chat' };
  expect((await state.http!.request('POST', path + '/begin', { body: beginInput })).status).toBe(
    401,
  );
  expect(
    (
      await state.http!.request('POST', path + '/begin', {
        headers: { cookie: state.cookie, origin: 'https://untrusted.invalid' },
        body: beginInput,
      })
    ).status,
  ).toBe(403);
  expect(state.events.getSessionCollaboration(state.group)).toBeNull();
  const sessionsBeforeBegin = state.events
    .listSessions()
    .map((row) => row.sessionId)
    .sort();
  let lostBeginResponses = 0;
  const associationRequests: string[] = [];
  state.api = new CollaborationApiClient(async (url, init) => {
    if (url.startsWith('/api/session-collaborations?')) associationRequests.push(url);
    const result = await state.http!.request(init?.method ?? 'GET', url, {
      headers: { cookie: state.cookie },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    // Lose only the first successful begin response after the actual server
    // commits. No route, store, authorization or receipt is substituted.
    if (url === path + '/begin' && result.status === 200 && lostBeginResponses === 0) {
      lostBeginResponses++;
      throw Error('Simulated committed begin response loss');
    }
    return new Response(JSON.stringify(result.body), { status: result.status });
  });
  // Keep compilation valid on accepted source without this new client method;
  // missing actual source/route/client dependencies remain required failures.
  const beginMethod = Reflect.get(state.api, 'begin');
  expect(typeof beginMethod).toBe('function');
  const begin = () => Reflect.apply(beginMethod, state.api, [state.group, beginInput]);
  await expect(begin()).rejects.toThrow('Simulated committed begin response loss');
  expect(lostBeginResponses).toBe(1);
  const [beginReceipt, concurrentRetry] = await Promise.all([begin(), begin()]);
  expect(beginReceipt).toEqual({
    version: 1,
    collaborationId: state.group,
    revision: 1,
    participantSessionIds: ['existing-chat'],
  });
  expect(concurrentRetry).toEqual(beginReceipt);
  expect(state.events.getSessionCollaboration(state.group)).toEqual(beginReceipt);
  expect(
    state.events
      .listSessions()
      .map((row) => row.sessionId)
      .sort(),
  ).toEqual(sessionsBeforeBegin);
  expect(state.events.getOrdinaryInitialCommandId('existing-chat')).toBeUndefined();
  // Read the existing association through the typed client and actual app mount;
  // this is metadata discovery, with no context read, allocation or command.
  const listMethod = Reflect.get(state.api, 'listForSession');
  expect(typeof listMethod).toBe('function');
  const listForSession = (after?: string) =>
    Reflect.apply(listMethod, state.api, ['existing-chat', after]);
  const sourceEventsBeforeList = state.events.getSessionEvents('existing-chat');
  expect(
    (await state.http!.request('GET', '/api/session-collaborations?sessionId=existing-chat'))
      .status,
  ).toBe(401);
  const associations = { collaborations: [beginReceipt], nextCursor: null };
  expect(await listForSession()).toEqual(associations);
  expect(associationRequests).toEqual(['/api/session-collaborations?sessionId=existing-chat']);
  expect(await listForSession(state.group)).toEqual({ collaborations: [], nextCursor: null });
  expect(associationRequests).toHaveLength(2);
  expect(associationRequests[1]).toBe(
    `/api/session-collaborations?sessionId=existing-chat&after=${state.group}`,
  );
  expect(state.events.getSessionEvents('existing-chat')).toEqual(sourceEventsBeforeList);
  expect(state.events.getOrdinaryInitialCommandId('existing-chat')).toBeUndefined();
  expect(state.events.listSessions()).toHaveLength(sessionsBeforeBegin.length);
  const view = await state.api.view(state.group);
  expect(view.joins).toEqual([]);
  expect(view.messages).toEqual([]);
  expect(view.participantSessionIds).toEqual(['existing-chat']);
  await state.api.setPolicy(state.group, {
    requestId: crypto.randomUUID(),
    expectedMembershipRevision: view.membershipRevision,
    expectedRevision: view.policies.find((row) => row.sessionId === 'existing-chat')?.revision ?? 0,
    sessionId: 'existing-chat',
    readsFutureDiscussion: true,
    repliesByDefault: true,
  });
  const retained = await state.api.view(state.group);
  const token = decodeURIComponent(state.cookie.slice(state.cookie.indexOf('=') + 1));
  const identity = await (await import('../auth.js')).authenticateToken(token);
  expect(identity).toBeTruthy();
  const internalToken = readFileSync(join(state.root!, 'internal-token'), 'utf8');
  const commandBefore = state.events.getOrdinaryInitialCommandId('existing-chat');
  const sessionsBefore = state.events.listSessions().length;
  await restartApplication();
  expect(await begin()).toEqual(beginReceipt);
  expect(await listForSession()).toEqual(associations);
  expect(associationRequests).toHaveLength(3);
  expect(state.events.getSessionEvents('existing-chat')).toEqual(sourceEventsBeforeList);
  expect(lostBeginResponses).toBe(1);
  expect(await state.api.view(state.group)).toEqual(retained);
  expect(await (await import('../auth.js')).authenticateToken(token)).toEqual(identity);
  expect(readFileSync(join(state.root!, 'internal-token'), 'utf8')).toBe(internalToken);
  expect(state.events.getOrdinaryInitialCommandId('existing-chat')).toBe(commandBefore);
  expect(state.events.listSessions()).toHaveLength(sessionsBefore);
  // Source acquisition goes through the actual app HTTP mounts and workspace
  // singleton. The prepared target is unused and distinct from existing-chat.
  const { ordinaryRepositoryRuntimeInventory } = await import('../ordinary-local-codex-entry.js');
  const inventory = ordinaryRepositoryRuntimeInventory('local', 'codex');
  const account = inventory.result.accounts.find(
    (row) => row.account.accountId === 'offline-personal',
  )!.account;
  const preview = await state.http!.request('POST', '/api/repository-workspaces/preview', {
    headers: { cookie: state.cookie },
    body: {
      accountId: 'offline-personal',
      model: 'fixture-model',
      connectionId: state.connections!.connectionId,
      repository: 'example/acceptance',
      ordinaryRuntime: {
        runOn: 'local',
        runtime: { account, harness: 'codex', targetId: 'offline-observation' },
      },
    },
  });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const previewId = z.object({ id: z.uuid() }).parse(preview.body).id;
  const prepared = await state.http!.request(
    'POST',
    `/api/repository-workspaces/${previewId}/prepare`,
    {
      headers: { cookie: state.cookie },
      body: { accountId: 'offline-personal', model: 'fixture-model' },
    },
  );
  expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
  expect(prepared.body).toMatchObject({ id: previewId, state: 'ready' });
  const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
  const targetBefore = getRepositoryWorkspaces(true).get(previewId);
  expect(targetBefore.conversationId).toBeUndefined();
  expect(targetBefore.ordinaryFirstReservation).toBeUndefined();
  const { getAgentLibrary } = await import('../agent-library-runtime.js');
  const library = getAgentLibrary();
  library.saveDraft('user', {
    profileId: 'acceptance-reviewer',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft',
    definition: {
      name: 'Reviewer',
      descriptor: 'Assistant',
      role: 'agent',
      instructions: 'Review the selected source.',
      expectedOutput: 'Findings',
      acceptanceCriteria: ['Cite evidence'],
      modelPolicyRole: 'agent',
    },
  });
  const published = library.publish('user', {
    profileId: 'acceptance-reviewer',
    expectedVersion: 1,
    idempotencyKey: 'publish',
  });
  const clientId = crypto.randomUUID();
  const bindTransport = async () => {
    const currentAuth = await (await import('../auth.js')).authenticateToken(token);
    expect(currentAuth).toEqual(identity);
    const { claimTransportConnection, releaseTransportConnection } =
      await import('../transport-auth-ownership.js');
    const { bindAgentLibraryTransport } = await import('../agent-library-transport.js');
    claimTransportConnection(clientId, currentAuth!.id);
    const unbind = bindAgentLibraryTransport(clientId, currentAuth!);
    state.releaseTransport = () => {
      unbind();
      releaseTransportConnection(clientId, currentAuth!.id);
    };
  };
  await bindTransport();
  const input = {
    clientId,
    selection: {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: retained.membershipRevision,
      sourceConversationId: 'existing-chat',
      boundary: { sequence: sourceBoundary, messageId: 'selected-source' },
      mode: 'selected',
      messageIds: ['selected-source'],
      artifacts: [],
      purpose: 'Review the selected design',
      joiningBrief: 'Edited brief retained exactly',
    },
    target: {
      runOn: 'local',
      accountId: 'offline-personal',
      model: 'fixture-model',
      reasoningEffort: 'low',
      agent: { profileId: published.profileId, revision: published.revision },
      repositoryWorkspaceId: previewId,
      permissionMode: 'ask',
    },
  };
  const legacy = await state.http!.request('POST', path + '/snapshots', {
    headers: { cookie: state.cookie },
    body: input.selection,
  });
  expect(legacy.status).toBe(503);
  // This must fail if actual app wiring omits its review owner. A hand-wired
  // router, fixture settings or a source workspace cannot satisfy it.
  const reviewed = await state.http!.request('POST', path + '/reviews', {
    headers: { cookie: state.cookie },
    body: input,
  });
  expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
  const result = z
    .object({ snapshot: CollaborationSnapshotSchema, settings: CollaborationSettingsSchema })
    .parse(reviewed.body);
  state.reviewedSnapshot = result.snapshot;
  state.reviewedSettings = result.settings;
  expect(state.reviewedSnapshot).toMatchObject({
    capacity: { status: 'unverified' },
    joiningBrief: input.selection.joiningBrief,
  });
  expect(state.reviewedSnapshot.messages[0]?.blocks[0]?.content).toBe(
    'Synthetic design requirement',
  );
  expect(JSON.stringify(reviewed.body)).not.toContain('DO_NOT_LEAK');
  expect(state.reviewedSettings).toMatchObject({
    repositoryWorkspaceId: previewId,
    selection: { permission: { mode: 'ask', revision: 0 } },
    binding: { account: { accountId: 'offline-personal' }, execution: { location: 'local' } },
  });
  // Resolve the real typed method at runtime so this test still compiles on
  // accepted source without the new contract, where required evidence stays red.
  const reviewMethod = Reflect.get(state.api, 'review');
  expect(typeof reviewMethod).toBe('function');
  const replay = await Reflect.apply(reviewMethod, state.api, [
    state.group,
    clientId,
    { selection: input.selection, target: input.target },
  ]);
  expect(replay).toEqual(reviewed.body);
  const projected = await state.api.view(state.group);
  expect(projected.joins).toEqual([]);
  expect(projected.messages).toEqual([]);
  // Reopen the same app/root/cookie after the first review response. Rebind
  // only the existing real interactive transport; do not recreate a workspace,
  // rewrite account/profile files or adopt a different operator.
  await restartApplication();
  await bindTransport();
  const recovered = await Reflect.apply(reviewMethod, state.api, [
    state.group,
    clientId,
    { selection: input.selection, target: input.target },
  ]);
  expect(recovered).toEqual(reviewed.body);
  const reopenedWorkspaces = (
    await import('../repository-workspace-runtime.js')
  ).getRepositoryWorkspaces(true);
  expect(reopenedWorkspaces.get(previewId)).toEqual(targetBefore);
  expect(readFileSync(join(state.root!, 'internal-token'), 'utf8')).toBe(internalToken);
  expect(state.events.listSessions()).toHaveLength(sessionsBefore);
  expect(state.events.getOrdinaryInitialCommandId('existing-chat')).toBe(commandBefore);
}, 20000);
it('reads exact completed durable source through actual production injection and typed client without restore or allocation', async () => {
  if (!state.http) throw Error('BLOCKED: actual app prerequisite failed');
  const sessionId = 'retained-durable-source';
  const userText = '\uFEFF  Selected π\r\n\t';
  const answerText = '  Finalized answer π\r\n';
  const privateText = 'PRIVATE_DURABLE_PROVIDER';
  state.events.upsertSession({ sessionId, conversationSource: 'mitzo' });
  const question = state.events.append(sessionId, 'user_message', {
    messageId: 'question',
    text: userText,
    credential: privateText,
  });
  state.events.append(sessionId, 'message_start', {
    messageId: 'answer',
    providerTurnId: privateText,
  });
  for (const [blockId, blockType, delta] of [
    ['reasoning', 'thinking', privateText],
    ['tool', 'tool_use', privateText],
    ['visible', 'text', answerText],
  ]) {
    state.events.append(sessionId, 'block_start', { messageId: 'answer', blockId, blockType });
    state.events.append(sessionId, 'block_delta', { messageId: 'answer', blockId, delta });
    state.events.append(sessionId, 'block_end', { messageId: 'answer', blockId });
  }
  const completed = state.events.append(sessionId, 'message_end', {
    messageId: 'answer',
    provider: privateText,
  });
  const expected = {
    sourceConversationId: sessionId,
    boundary: { sequence: completed, messageId: 'answer' },
    messages: [
      {
        conversationId: sessionId,
        messageId: 'question',
        sequence: question,
        author: 'operator',
        source: null,
        blocks: [
          {
            blockId: 'user-question',
            content: userText,
            sha256: createHash('sha256').update(userText).digest('hex'),
          },
        ],
      },
      {
        conversationId: sessionId,
        messageId: 'answer',
        sequence: completed,
        author: { sessionId },
        source: null,
        blocks: [
          {
            blockId: 'visible',
            content: answerText,
            sha256: createHash('sha256').update(answerText).digest('hex'),
          },
        ],
      },
    ],
  };
  const path = `/api/sessions/${sessionId}/messages?transcript=durable`;
  const requests: string[] = [];
  const durableApi = new MitzoApiClient(async (url, init) => {
    // A legacy/SDK restore request cannot satisfy this positive source check.
    expect(url).toBe(path);
    expect(init?.credentials).toBe('include');
    init?.signal?.throwIfAborted();
    requests.push(url);
    const result = await state.http!.request('GET', url, { headers: { cookie: state.cookie } });
    return new Response(JSON.stringify(result.body), { status: result.status });
  });
  const method = Reflect.get(durableApi, 'getDurableSessionTranscript');
  expect(typeof method).toBe('function');
  const read = () => Reflect.apply(method, durableApi, [sessionId]);
  const before = state.events.getSessionEvents(sessionId);
  const sessionsBefore = state.events
    .listSessions()
    .map((row) => row.sessionId)
    .sort();
  expect((await state.http.request('GET', path)).status).toBe(401);
  const replay = vi.spyOn(state.events, 'getSessionEvents');
  try {
    await expect(read()).resolves.toEqual(expected);
    expect(replay).not.toHaveBeenCalled();
  } finally {
    replay.mockRestore();
  }
  expect(requests).toEqual([path]);
  expect(state.events.getSessionEvents(sessionId)).toEqual(before);
  expect(
    state.events
      .listSessions()
      .map((row) => row.sessionId)
      .sort(),
  ).toEqual(sessionsBefore);
  expect(state.events.getOrdinaryInitialCommandId(sessionId)).toBeUndefined();
  expect(JSON.stringify(expected)).not.toContain(privateText);
  await restartApplication();
  await expect(read()).resolves.toEqual(expected);
  expect(requests).toEqual([path, path]);
  expect(state.events.getSessionEvents(sessionId)).toEqual(before);
  expect(
    state.events
      .listSessions()
      .map((row) => row.sessionId)
      .sort(),
  ).toEqual(sessionsBefore);
  expect(state.events.getOrdinaryInitialCommandId(sessionId)).toBeUndefined();
  state.events.hideSession(sessionId);
  const hidden = await state.http!.request('GET', path, { headers: { cookie: state.cookie } });
  expect(hidden).toMatchObject({ status: 500, body: { error: 'Session transcript unavailable' } });
  await expect(read()).rejects.toThrow('Session transcript unavailable');
  expect(requests).toEqual([path, path, path]);
}, 20000);
it('joins a reviewed fresh ordinary session without inference or native capacity and recovers the same allocation after restart', async () => {
  if (!state.reviewedSnapshot || !state.reviewedSettings || !state.http)
    throw Error('BLOCKED: actual app review prerequisite failed');
  const snapshot = state.reviewedSnapshot;
  const before = state.events.listSessions().length;
  const input = {
    requestId: crypto.randomUUID(),
    expectedMembershipRevision: (await state.api.view(state.group)).membershipRevision,
    name: 'Independent reviewer',
    settings: state.reviewedSettings,
    snapshot: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 },
  };
  const path = `/api/session-collaborations/${state.group}/joins`;
  expect((await state.http.request('POST', path, { body: input })).status).toBe(401);
  const joined = await state.api.prepareJoin(state.group, input);
  state.joinedSessionId = joined.sessionId ?? undefined;
  expect(joined.state).toBe('linked');
  expect(joined.sessionId).toBeTruthy();
  expect(state.events.listSessions()).toHaveLength(before + 1);
  expect(state.events.getOrdinaryInitialCommandId(joined.sessionId!)).toBeUndefined();
  expect(state.events.getSessionEvents(joined.sessionId!)).toEqual([]);
  expect(state.events.getOrdinarySessionPreparation(joined.allocationOperationId)?.sessionId).toBe(
    joined.sessionId,
  );
  expect(await state.api.prepareJoin(state.group, input)).toEqual(joined);
  await restartApplication();
  expect(await state.api.prepareJoin(state.group, input)).toEqual(joined);
  expect(await state.api.recoverJoin(state.group, joined.joinId)).toEqual(joined);
  expect((await state.api.view(state.group)).participantSessionIds).toContain(joined.sessionId);
  expect(state.events.listSessions()).toHaveLength(before + 1);
  expect(state.events.getOrdinaryInitialCommandId(joined.sessionId!)).toBeUndefined();
  expect(state.events.getSessionEvents(joined.sessionId!)).toEqual([]);
});
